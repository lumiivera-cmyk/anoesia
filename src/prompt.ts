/**
 * Putting the prompt together.
 *
 * Step 1 builds it in a fixed order:
 *
 *   1. the main prompt (system)
 *   2. one block per card in the chat's cast, in cast order (system)
 *   3. the chat history (user / assistant)
 *
 * Every piece is a labelled block, so the preview shows exactly where each
 * part of the prompt came from. Step 2 (the prompts page) makes the order,
 * the roles and the depth of each block yours to set.
 *
 * Adjacent system blocks are sent as one system message, because some
 * models only accept one.
 */

import type { Card, ChatMessage, Message } from "./types.ts";

export const DEFAULT_MAIN_PROMPT = `This is a roleplay between {{user}} and you, the narrator. You write the world and everyone in it: {{cast}}. {{user}} is written only by the user: never write their words, actions or thoughts.`;

/** One piece of the prompt, as the preview shows it. */
export interface Block {
  /** What it is, e.g. "Main prompt", "Rumi Kang (card)", "Chat history". */
  label: string;
  /** Where its text lives, e.g. "settings", "card:<id>", "message:<id>". */
  source: string;
  role: ChatMessage["role"];
  content: string;
}

export interface AssembledPrompt {
  blocks: Block[];
  /** What's sent: the blocks, with adjacent system blocks joined. */
  messages: ChatMessage[];
  /** A rough count (about four characters a token). */
  approxTokens: number;
}

export interface PromptInput {
  mainPrompt: string;
  /** The chat's cast, in order. */
  cast: Card[];
  messages: Message[];
  now?: Date;
}

// ---------------------------------------------------------------- macros

export interface MacroContext {
  user: string;
  char: string;
  cast: string;
  now: Date;
}

/**
 * The step 1 macros: `{{user}}`, `{{char}}`, `{{cast}}`, `{{date}}`,
 * `{{time}}`, and `{{// comments}}`, which are removed. Names match
 * SillyTavern's and Lumiverse's, so cards keep working. Unknown macros are
 * left as they are, so you can see them in the preview.
 */
export function fillMacros(text: string, ctx: MacroContext): string {
  return text
    .replace(/\{\{\/\/[\s\S]*?\}\}/g, "")
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) => {
      switch (name.toLowerCase()) {
        case "user":
          return ctx.user;
        case "char":
          return ctx.char;
        case "cast":
          return ctx.cast;
        case "date":
          return ctx.now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
        case "time":
          return ctx.now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        default:
          return whole;
      }
    });
}

/** "Rumi", "Rumi and Mira", "Rumi, Mira and Zoey". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The macro values for a cast: the first persona is `{{user}}`; characters that aren't personas are `{{cast}}`. */
export function macroContext(cast: Card[], now = new Date()): MacroContext {
  const persona = cast.find((c) => c.isPersona);
  const characters = cast.filter((c) => !c.isPersona && c.isCharacter).map((c) => c.name);
  return { user: persona?.name ?? "User", char: characters[0] ?? "", cast: listNames(characters) || "the characters of the story", now };
}

// -------------------------------------------------------------- assembly

/** A card as one block of text: its name, then each field with content. */
export function cardText(card: Card): string {
  const heading = card.isPersona ? `## ${card.name} (played by the user)` : `## ${card.name}`;
  const parts = [heading];
  for (const f of card.fields) {
    const text = f.content.trim();
    if (!text) continue;
    parts.push(f.key === "custom" ? `### ${f.title}\n${text}` : text);
  }
  return parts.join("\n\n");
}

export function assemblePrompt(input: PromptInput): AssembledPrompt {
  const ctx = macroContext(input.cast, input.now);
  const blocks: Block[] = [];
  const main = fillMacros(input.mainPrompt, ctx).trim();
  if (main) blocks.push({ label: "Main prompt", source: "settings", role: "system", content: main });

  for (const card of input.cast) {
    const content = fillMacros(cardText(card), { ...ctx, char: card.isPersona ? ctx.char : card.name }).trim();
    if (content) blocks.push({ label: `${card.name} (${card.isPersona ? "persona" : "card"})`, source: `card:${card.id}`, role: "system", content });
  }

  for (const m of input.messages) {
    if (!m.content.trim()) continue;
    blocks.push({ label: m.role === "user" ? `${ctx.user}` : "Narrator", source: `message:${m.id}`, role: m.role, content: m.content });
  }

  // Most models need something after the system prompt to answer. With no
  // messages yet, this says so out loud instead of sending a hidden nudge.
  if (!input.messages.some((m) => m.content.trim())) {
    blocks.push({ label: "Start (no messages yet)", source: "start", role: "user", content: "(Begin the scene.)" });
  }

  const messages: ChatMessage[] = [];
  for (const b of blocks) {
    const last = messages.at(-1);
    if (b.role === "system" && last?.role === "system") last.content += `\n\n${b.content}`;
    else messages.push({ role: b.role, content: b.content });
  }
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  return { blocks, messages, approxTokens: Math.round(chars / 4) };
}

/**
 * A reply cleaned for saving: trimmed, and with a leading "Narrator:" label
 * taken off (models sometimes copy the speaker label).
 */
export function cleanReply(text: string): string {
  return text.trim().replace(/^narrator:\s*/i, "").trim();
}
