/**
 * Putting the prompt together from a chat's blocks (the prompts page).
 *
 * The blocks go in the order shown. The chat history block stands for the
 * messages, and a block with a depth goes inside the history instead,
 * that many messages from the end (0 = after the last message). Switched
 * off blocks and empty ones are left out.
 *
 * A card's fields are separate blocks. The first of a run of one card's
 * blocks gets a `## Name` heading, so the model can tell whose text it is
 * even when you move a field away from the rest of its card. Custom fields
 * get a `### Title` heading of their own.
 *
 * Macros are filled in the order the blocks are sent, so `{{setvar}}` in
 * an early block is seen by `{{getvar}}` in a later one.
 *
 * Adjacent system blocks are sent as one system message, because some
 * models only accept one.
 *
 * A cast member can be offstage in a chat: then only its Description goes
 * in, its other fields stay on the prompts page as inactive, and
 * `{{cast}}` (and `{{char}}`) skip it, so nothing invites someone who
 * isn't in the scene.
 *
 * Each chat has two notes of its own, "Right now" (where the story stands)
 * and "Who knows what" (one line per secret). They are blocks like any
 * other, sent under a `## Title` heading, and nothing when empty.
 */

import { fillMacros, type MacroEnv } from "./macros.ts";
import { latestUserPost } from "./nudges.ts";
import type { Card, ChatMessage, Message, PromptBlock } from "./types.ts";

export { listNames } from "./macros.ts";

export const DEFAULT_MAIN_PROMPT = `This is a roleplay between {{user}} and you, the narrator. You write the world and everyone in it: {{cast}}. {{user}} is written only by the user: never write their words, actions or thoughts.`;

/** The chat notes every chat has, in the order a new chat gets them. */
export const CHAT_NOTES = ["Right now", "Who knows what"] as const;

/** Whether a block is left out because its card is offstage: every field but the Description. */
export function heldBack(block: PromptBlock, cards: Map<string, Card>): boolean {
  if (block.kind !== "field" || !block.offstage) return false;
  const field = cards.get(block.cardId ?? "")?.fields.find((f) => f.id === block.fieldId);
  return field?.key !== "description";
}

/** One piece of the prompt, as the preview shows it. */
export interface SentBlock {
  /** What it is, e.g. "Main prompt", "Rumi Kang: Description", "Hana". */
  label: string;
  /** Where its text lives, e.g. "settings", "card:<id>", "block:<id>", "message:<id>". */
  source: string;
  role: ChatMessage["role"];
  /** With macros filled and any heading added: exactly what's sent. */
  content: string;
  /** For a block placed inside the history: its depth. */
  depth?: number;
}

export interface AssembledPrompt {
  blocks: SentBlock[];
  /** What's sent: the blocks, with adjacent system blocks joined. */
  messages: ChatMessage[];
  /** A rough count (about four characters a token). */
  approxTokens: number;
  /** The variables after this prompt's macros ran (saved only when the prompt is actually sent). */
  vars: Record<string, string>;
  globals: Record<string, string>;
}

export interface PromptInput {
  blocks: PromptBlock[];
  /** Every card a block points at, by id. */
  cards: Map<string, Card>;
  messages: Message[];
  vars?: Record<string, string>;
  globals?: Record<string, string>;
  now?: Date;
  random?: () => number;
}

/** Who's who, from the cards in the blocks, in block order. `characters` is the onstage ones only. */
export function castOf(blocks: PromptBlock[], cards: Map<string, Card>): { persona: Card | null; characters: Card[] } {
  const seen: Card[] = [];
  const offstage = new Set<Card>();
  for (const b of blocks) {
    const card = b.cardId ? cards.get(b.cardId) : undefined;
    if (!card) continue;
    if (!seen.includes(card)) seen.push(card);
    if (b.offstage) offstage.add(card);
  }
  return { persona: seen.find((c) => c.isPersona) ?? null, characters: seen.filter((c) => !c.isPersona && c.isCharacter && !offstage.has(c)) };
}

/** An item in send order, before macros. */
interface Item {
  label: string;
  source: string;
  role: ChatMessage["role"];
  text: string;
  card?: Card;
  depth?: number;
  /** For a field block: the card it belongs to, for headings. */
  runCard?: Card;
}

export function assemblePrompt(input: PromptInput): AssembledPrompt {
  const { persona, characters } = castOf(input.blocks, input.cards);
  const history = input.messages.filter((m) => m.content.trim());
  const userName = persona?.name ?? "User";
  const lastOf = (role?: Message["role"]) => [...history].reverse().find((m) => !role || m.role === role)?.content ?? "";
  const env: MacroEnv = {
    user: userName,
    char: characters[0]?.name ?? "",
    cast: characters.map((c) => c.name),
    lastMessage: lastOf(),
    lastUserMessage: lastOf("user"),
    lastCharMessage: lastOf("assistant"),
    messageCount: history.length,
    lastUserPost: latestUserPost(history),
    now: input.now ?? new Date(),
    vars: { ...input.vars },
    globals: { ...input.globals },
    random: input.random,
  };

  const blockItem = (b: PromptBlock): Item | null => {
    if (!b.enabled || b.kind === "history" || !b.content.trim() || heldBack(b, input.cards)) return null;
    if (b.kind === "note") return { label: b.title, source: `block:${b.id}`, role: b.role, text: `## ${b.title}\n\n${b.content.trim()}`, depth: b.depth ?? undefined };
    if (b.kind === "field") {
      const card = input.cards.get(b.cardId ?? "");
      if (!card) return null;
      const field = card.fields.find((f) => f.id === b.fieldId);
      const text = field?.key === "custom" ? `### ${b.title}\n${b.content.trim()}` : b.content.trim();
      return { label: `${card.name}: ${b.title}`, source: `card:${card.id}`, role: b.role, text, card, runCard: card, depth: b.depth ?? undefined };
    }
    return { label: b.title, source: b.kind === "main" ? "settings" : `block:${b.id}`, role: b.role, text: b.content.trim(), depth: b.depth ?? undefined };
  };

  // Blocks with a depth go inside the history: gaps[g] holds what comes before message g (gaps[n] after the last).
  const gaps: Item[][] = Array.from({ length: history.length + 1 }, () => []);
  for (const b of input.blocks) {
    if (b.depth === null || b.kind === "history") continue;
    const item = blockItem(b);
    if (item) gaps[Math.max(0, history.length - b.depth)]!.push(item);
  }

  const items: Item[] = [];
  for (const b of input.blocks) {
    if (b.kind === "history") {
      history.forEach((m, i) => {
        items.push(...gaps[i]!);
        items.push({ label: m.role === "user" ? userName : "Narrator", source: `message:${m.id}`, role: m.role, text: m.content });
      });
      items.push(...gaps[history.length]!);
      continue;
    }
    if (b.depth !== null) continue;
    const item = blockItem(b);
    if (item) items.push(item);
  }

  // Most models need something after the system prompt to answer. With no
  // messages yet, this says so out loud instead of sending a hidden nudge.
  if (history.length === 0) items.push({ label: "Start (no messages yet)", source: "start", role: "user", text: "(Begin the scene.)" });

  // Headings, then macros, in send order.
  const sent: SentBlock[] = [];
  let previousCard: Card | undefined;
  for (const item of items) {
    let text = item.text;
    if (item.runCard && item.runCard !== previousCard) {
      text = `${item.runCard.isPersona ? `## ${item.runCard.name} (played by the user)` : `## ${item.runCard.name}`}\n\n${text}`;
    }
    previousCard = item.runCard;
    const content = fillMacros(text, { ...env, char: item.card && !item.card.isPersona ? item.card.name : env.char }).trim();
    if (!content) continue;
    sent.push({ label: item.label, source: item.source, role: item.role, content, ...(item.depth !== undefined ? { depth: item.depth } : {}) });
  }

  const messages: ChatMessage[] = [];
  for (const b of sent) {
    const last = messages.at(-1);
    if (b.role === "system" && last?.role === "system") last.content += `\n\n${b.content}`;
    else messages.push({ role: b.role, content: b.content });
  }
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  return { blocks: sent, messages, approxTokens: Math.round(chars / 4), vars: env.vars, globals: env.globals };
}

/**
 * A reply cleaned for saving: trimmed, and with a leading "Narrator:" label
 * taken off (models sometimes copy the speaker label).
 */
export function cleanReply(text: string): string {
  return text.trim().replace(/^narrator:\s*/i, "").trim();
}
