/** HTML visuals in story replies (public/js/visuals.js) and what the prompt sends of them. */

import { describe, expect, test } from "bun:test";
import { cleanStyle, hasVisual, shortenVisuals, splitVisuals, visualWords } from "../public/js/visuals.js";
import { assemblePrompt } from "../src/prompt.ts";
import { foldMessages } from "../src/summary.ts";
import type { Message, PromptBlock } from "../src/types.ts";

const MAP = `<div style="max-width:540px;padding:12px;background:#0f1117;"><div style="display:flex;"><span style="font-weight:700;">CHECK // REACH</span><span>BOOT ONLY</span></div><div style="position:relative;height:240px;"><div style="position:absolute;left:4%;top:48px;">A</div></div><div style="color:#fca5a5;">&#9679; <b>Hands:</b> out of reach &amp; short.</div></div>`;

describe("finding visuals", () => {
  test("a div that starts a line runs to its matching close", () => {
    const parts = splitVisuals(`She looked down.\n\n${MAP}\n\nNobody was watching.`);
    expect(parts.map((p) => p.kind)).toEqual(["text", "visual", "text"]);
    expect(parts[1]!.text).toBe(MAP);
    expect(parts[1]!.closed).toBe(true);
    expect(parts[2]!.text).toBe("\n\nNobody was watching.");
  });

  test("a tag mid-sentence is still text", () => {
    expect(hasVisual("She typed <div> into the terminal.")).toBe(false);
    expect(hasVisual("Plain words.")).toBe(false);
  });

  test("an unclosed visual (still streaming) runs to the end", () => {
    const parts = splitVisuals(`Words.\n<div style="color:red"><div>half`);
    expect(parts.at(-1)).toEqual({ kind: "visual", text: `<div style="color:red"><div>half`, closed: false });
  });

  test("a ```html fence is a visual too, without the fence", () => {
    const parts = splitVisuals("Here.\n```html\n<table><tr><td>1</td></tr></table>\n```\nAfter.");
    expect(parts.map((p) => p.kind)).toEqual(["text", "visual", "text"]);
    expect(parts[1]!.text).toBe("<table><tr><td>1</td></tr></table>");
    expect(parts[2]!.text).toBe("\nAfter.");
  });

  test("svg and two visuals in one reply", () => {
    const parts = splitVisuals(`<svg viewBox="0 0 10 10"><circle r="4"/></svg>\nmiddle\n<table><tr><td>x</td></tr></table>`);
    expect(parts.map((p) => p.kind)).toEqual(["visual", "text", "visual"]);
  });
});

describe("words and styles", () => {
  test("a visual's words keep what it says", () => {
    expect(visualWords(MAP)).toBe("CHECK // REACH BOOT ONLY / A / ● Hands: out of reach & short.");
  });

  test("styles that could load or pin something are dropped", () => {
    expect(cleanStyle("color:red;background:url(https://x.test/a.png);position:absolute")).toBe("color:red;position:absolute");
    expect(cleanStyle("position:fixed;top:0;background-image:image-set('a.png' 1x)")).toBe("top:0");
    expect(cleanStyle("width:\\75rl(x);color:blue")).toBe("color:blue");
  });

  test("shortening swaps visuals for their words, or keeps the last", () => {
    const text = `One.\n<div>first</div>\nTwo.\n<div>second</div>`;
    expect(shortenVisuals(text)).toBe("One.\n[visual: first]\nTwo.\n[visual: second]");
    expect(shortenVisuals(text, { keepLast: true })).toBe("One.\n[visual: first]\nTwo.\n<div>second</div>");
    expect(shortenVisuals("No visuals.")).toBe("No visuals.");
  });
});

let seq = 0;
function message(role: "user" | "assistant", content: string): Message {
  return { id: `m${++seq}`, chatId: "c", seq, role, author: role === "user" ? "user" : "narrator", content, swipes: [content], swipeIndex: 0, reasoning: "", profileId: "", model: "", createdAt: "", editedAt: null, storySaved: false };
}
const history: PromptBlock = { id: "h", chatId: "c", kind: "history", cardId: null, fieldId: null, title: "Chat history", content: "", role: "user", enabled: true, depth: null, position: 1, offstage: false, nudge: false };

describe("the prompt", () => {
  test("only the latest visual goes whole; older ones go as words", () => {
    const old = message("assistant", `Before.\n<div style="color:red">old map</div>`);
    const ask = message("user", "Show it again.");
    const latest = message("assistant", `Again.\n${MAP}`);
    const prompt = assemblePrompt({ blocks: [history], cards: new Map(), messages: [old, ask, latest, message("user", "Kick it.")] });
    const sent = prompt.messages.map((m) => m.content).join("\n");
    expect(sent).toContain("[visual: old map]");
    expect(sent).not.toContain("color:red");
    expect(sent).toContain(MAP);
  });

  test("the Story so far fold reads words, never markup", () => {
    const fold = foldMessages({ summary: "", batch: [message("assistant", `She stretched.\n${MAP}`)], userName: "Hana", cast: [] });
    const text = fold.map((m) => m.content).join("\n");
    expect(text).toContain("[visual: CHECK // REACH BOOT ONLY");
    expect(text).not.toContain("<div");
  });
});
