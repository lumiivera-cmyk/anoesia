/** Putting the prompt together from blocks (src/prompt.ts). */

import { describe, expect, test } from "bun:test";
import { assemblePrompt } from "../src/prompt.ts";
import type { Card, Message, PromptBlock } from "../src/types.ts";

function card(name: string, fields: [string, string][], extra: Partial<Card> = {}): Card {
  return {
    id: name.toLowerCase(),
    name,
    isPersona: false,
    isCharacter: true,
    colour: "violet",
    customColour: "",
    fields: fields.map(([key, content], i) => ({ id: `${name}-${key}`, key: key === "voice" ? "custom" : (key as "description"), title: key === "voice" ? "Voice bank" : key, content, position: i })),
    createdAt: "",
    updatedAt: "",
    ...extra,
  };
}

let n = 0;
function block(kind: PromptBlock["kind"], over: Partial<PromptBlock> = {}): PromptBlock {
  return { id: `b${n++}`, chatId: "c", kind, cardId: null, fieldId: null, title: kind === "main" ? "Main prompt" : kind === "history" ? "Chat history" : "Note", content: "", role: kind === "history" ? "user" : "system", enabled: true, depth: null, position: n, ...over };
}

function fieldBlocks(c: Card): PromptBlock[] {
  return c.fields.map((f) => block("field", { cardId: c.id, fieldId: f.id, title: f.key === "custom" ? f.title : f.key, content: f.content }));
}

function message(role: "user" | "assistant", content: string): Message {
  return { id: content, chatId: "c", role, author: role === "user" ? "user" : "narrator", content, swipes: [content], swipeIndex: 0, profileId: "", model: "", createdAt: "", editedAt: null };
}

const seoul = card("Seoul", [["description", "A city."]], { isCharacter: false });
const mira = card("Mira", [["description", "{{char}} dances."]]);
const me = card("Hana", [["description", "{{user}} is new."]], { isPersona: true });
const rumi = card("Rumi", [["description", "Sings for {{user}}."], ["advanced", "Hides her arms."], ["voice", '"Three minutes."']]);
const cards = new Map([seoul, mira, me, rumi].map((c) => [c.id, c]));

describe("assemblePrompt", () => {
  test("blocks in order, a heading per card run, history where its block is, system blocks joined", () => {
    const blocks = [block("main", { content: "Narrate for {{user}}: {{cast}}." }), ...fieldBlocks(seoul), ...fieldBlocks(mira), ...fieldBlocks(me), ...fieldBlocks(rumi), block("history")];
    const prompt = assemblePrompt({ blocks, cards, messages: [message("user", "Hello"), message("assistant", "Rumi looks up.")] });
    expect(prompt.blocks.map((b) => b.label)).toEqual(["Main prompt", "Seoul: description", "Mira: description", "Hana: description", "Rumi: description", "Rumi: advanced", "Rumi: Voice bank", "Hana", "Narrator"]);
    expect(prompt.messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    const system = prompt.messages[0]!.content;
    expect(system).toStartWith("Narrate for Hana: Mira and Rumi.");
    expect(system).toContain("## Mira\n\nMira dances.");
    expect(system).toContain("## Hana (played by the user)\n\nHana is new.");
    expect(system).toContain("## Rumi\n\nSings for Hana.\n\nHides her arms.\n\n### Voice bank\n\"Three minutes.\"");
    expect(system.match(/## Rumi/g)).toHaveLength(1);
  });

  test("a block with a depth goes inside the chat, that many messages from the end", () => {
    const nudge = block("text", { title: "Nudge", content: "(Keep it short.)", role: "user", depth: 0 });
    const early = block("text", { title: "Early", content: "Earlier note.", depth: 2 });
    const tooDeep = block("text", { title: "Deep", content: "Before everything.", depth: 99 });
    const messages = [message("user", "One"), message("assistant", "Two"), message("user", "Three")];
    const prompt = assemblePrompt({ blocks: [block("main", { content: "Main." }), nudge, early, tooDeep, block("history")], cards, messages });
    expect(prompt.blocks.map((b) => b.label)).toEqual(["Main prompt", "Deep", "User", "Early", "Narrator", "User", "Nudge"]);
    expect(prompt.blocks.at(-1)).toMatchObject({ role: "user", depth: 0, content: "(Keep it short.)" });
    // "Deep" lands right after the main prompt, so the two system blocks join.
    expect(prompt.messages[0]).toEqual({ role: "system", content: "Main.\n\nBefore everything." });
  });

  test("a card field moved away from its card gets its own heading; off and empty blocks are left out", () => {
    const [desc, adv] = fieldBlocks(rumi);
    const blocks = [block("main", { content: "Main." }), desc!, block("text", { content: "Between." }), adv!, block("text", { content: "Off.", enabled: false }), block("text", { content: "  " }), block("history")];
    const prompt = assemblePrompt({ blocks, cards, messages: [message("user", "Hi")] });
    expect(prompt.messages[0]!.content).toBe("Main.\n\n## Rumi\n\nSings for User.\n\nBetween.\n\n## Rumi\n\nHides her arms.");
  });

  test("roles are the block's own: a user-role block is sent as a user message", () => {
    const prompt = assemblePrompt({ blocks: [block("main", { content: "Main." }), block("text", { content: "OOC note", role: "user" }), block("history")], cards, messages: [message("user", "Hi")] });
    expect(prompt.messages).toEqual([
      { role: "system", content: "Main." },
      { role: "user", content: "OOC note" },
      { role: "user", content: "Hi" },
    ]);
  });

  test("with no messages yet, a visible start block asks the model to begin", () => {
    const prompt = assemblePrompt({ blocks: [block("main", { content: "Go." }), block("history")], cards, messages: [] });
    expect(prompt.blocks.at(-1)).toMatchObject({ label: "Start (no messages yet)", role: "user" });
  });

  test("macro variables flow in send order and come back changed", () => {
    const blocks = [block("main", { content: "{{setvar::scene::the rooftop}}Main." }), block("history"), block("text", { content: "We're on {{getvar::scene}}. Turn {{incvar::turn}}{{getvar::turn}}.", depth: 0 })];
    const prompt = assemblePrompt({ blocks, cards, messages: [message("user", "Hi")], vars: { turn: "4" } });
    expect(prompt.blocks.at(-1)!.content).toBe("We're on the rooftop. Turn 5.");
    expect(prompt.vars).toEqual({ scene: "the rooftop", turn: "5" });
  });
});
