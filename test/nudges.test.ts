/**
 * Nudges: the pace numbers, the pace macros, and nudge blocks in a prompt.
 */

import { describe, expect, test } from "bun:test";
import { fillMacros, type MacroEnv } from "../src/macros.ts";
import { latestUserPost, NUDGES, paceNote, paceOf } from "../src/nudges.ts";
import { assemblePrompt } from "../src/prompt.ts";
import type { Message, PromptBlock } from "../src/types.ts";

const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");

describe("pace", () => {
  test("counts words and paragraphs, rounds past 20, and sets the limit", () => {
    expect(paceOf("one two three")).toEqual({ words: 3, shownWords: 3, paragraphs: 1, limit: 60 });
    const long = `${words(64)}\n\n${words(60)}`;
    expect(paceOf(long)).toEqual({ words: 124, shownWords: 120, paragraphs: 2, limit: 186 });
  });

  test("the latest post is the run of your messages at the end", () => {
    const m = (role: string, content: string) => ({ role, content });
    expect(latestUserPost([m("user", "a"), m("assistant", "b"), m("user", "c"), m("user", "d")])).toBe("c\n\nd");
    expect(latestUserPost([m("user", "a"), m("assistant", "b")])).toBe("");
  });

  test("the note reads like Kinaera's, and is empty when the chat ends on a reply", () => {
    expect(paceNote("Hi there, Ada.")).toBe(
      "(OOC: My post was about 3 words, in one paragraph. Match my pace: keep yours about that long, 60 words at most. Say what matters and stop where I can respond; don't pad or repeat.)",
    );
    expect(paceNote("")).toBe("");
  });

  test("the macros", () => {
    const env: MacroEnv = { user: "Hana", char: "Ada", cast: ["Ada"], lastMessage: "", lastUserMessage: "", lastCharMessage: "", messageCount: 2, now: new Date(), vars: {}, globals: {}, lastUserPost: `${words(30)}\n\n${words(10)}` };
    expect(fillMacros("{{lastUserWords}} / {{lastUserParagraphs}} / {{paceLimit}}", env)).toBe("40 / 2 paragraphs / 60");
  });
});

describe("nudge blocks in a prompt", () => {
  const message = (i: number, role: "user" | "assistant", content: string): Message => ({ id: `m${i}`, chatId: "c", role, author: role === "user" ? "user" : "narrator", content, swipes: [content], swipeIndex: 0, profileId: "", model: "", createdAt: "", editedAt: null });
  const block = (id: string, extra: Partial<PromptBlock>): PromptBlock => ({ id, chatId: "c", kind: "text", cardId: null, fieldId: null, title: id, content: "", role: "system", enabled: true, depth: null, position: 0, offstage: false, ...extra });
  const blocks = [block("main", { kind: "main", content: "Main." }), block("pace", { ...NUDGES.pace!, depth: 0 }), block("restraint", { ...NUDGES.restraint! }), block("history", { kind: "history", role: "user" })];

  test("go right after your post, as you", () => {
    const prompt = assemblePrompt({ blocks, cards: new Map(), messages: [message(1, "user", "Hi."), message(2, "assistant", "Hello."), message(3, "user", "Long day?")] });
    expect(prompt.blocks.map((b) => b.label)).toEqual(["main", "User", "Narrator", "User", "Match my pace", "Scene restraint"]);
    expect(prompt.blocks.at(-2)!.content).toContain("about 2 words");
    expect(prompt.blocks.at(-1)!.content).toContain("where User could respond");
    expect(prompt.messages.at(-1)!.role).toBe("user");
  });

  test("the pace note drops out when the narrator is going on (the chat ends on a reply)", () => {
    const prompt = assemblePrompt({ blocks, cards: new Map(), messages: [message(1, "user", "Hi."), message(2, "assistant", "Hello.")] });
    expect(prompt.blocks.map((b) => b.label)).not.toContain("Match my pace");
  });
});
