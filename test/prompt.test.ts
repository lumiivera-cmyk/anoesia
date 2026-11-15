/** Putting the prompt together (src/prompt.ts). */

import { describe, expect, test } from "bun:test";
import { assemblePrompt, fillMacros, listNames, macroContext } from "../src/prompt.ts";
import type { Card, Message } from "../src/types.ts";

function card(name: string, description: string, extra: Partial<Card> = {}): Card {
  return {
    id: name.toLowerCase(),
    name,
    isPersona: false,
    isCharacter: true,
    fields: [{ id: `${name}-d`, key: "description", title: "Description", content: description, position: 0 }],
    createdAt: "",
    updatedAt: "",
    ...extra,
  };
}

function message(role: "user" | "assistant", content: string): Message {
  return { id: content, chatId: "c", role, author: role === "user" ? "user" : "narrator", content, swipes: [content], swipeIndex: 0, profileId: "", model: "", createdAt: "", editedAt: null };
}

const seoul = card("Seoul", "A city.", { isCharacter: false });
const mira = card("Mira", "{{char}} dances.");
const zoey = card("Zoey", "Raps.");
const me = card("Hana", "{{user}} is new in town.", { isPersona: true });
const rumi = card("Rumi", "Sings for {{user}}.");

describe("macros", () => {
  test("names lists read naturally", () => {
    expect(listNames(["Rumi"])).toBe("Rumi");
    expect(listNames(["Rumi", "Mira", "Zoey"])).toBe("Rumi, Mira and Zoey");
  });

  test("{{user}} is the persona; {{cast}} lists characters, not worlds or the persona", () => {
    const ctx = macroContext([seoul, mira, zoey, me, rumi]);
    expect(ctx.user).toBe("Hana");
    expect(ctx.cast).toBe("Mira, Zoey and Rumi");
  });

  test("comments go, unknown macros stay visible", () => {
    const ctx = macroContext([rumi]);
    expect(fillMacros("Hi {{// note }}{{user}} {{mystery}}", ctx)).toBe("Hi User {{mystery}}");
  });
});

describe("assemblePrompt", () => {
  test("main prompt, then cards in cast order, then history; system blocks sent as one message", () => {
    const prompt = assemblePrompt({ mainPrompt: "Narrate for {{user}}: {{cast}}.", cast: [seoul, mira, zoey, me, rumi], messages: [message("user", "Hello"), message("assistant", "Rumi looks up.")] });
    expect(prompt.blocks.map((b) => b.label)).toEqual(["Main prompt", "Seoul (card)", "Mira (card)", "Zoey (card)", "Hana (persona)", "Rumi (card)", "Hana", "Narrator"]);
    expect(prompt.messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    const system = prompt.messages[0]!.content;
    expect(system).toStartWith("Narrate for Hana: Mira, Zoey and Rumi.");
    expect(system.indexOf("## Seoul")).toBeLessThan(system.indexOf("## Rumi"));
    // {{char}} in a card is that card.
    expect(system).toContain("Mira dances.");
    expect(system).toContain("## Hana (played by the user)");
    expect(system).toContain("Sings for Hana.");
  });

  test("with no messages yet, a visible start block asks the model to begin", () => {
    const prompt = assemblePrompt({ mainPrompt: "Go.", cast: [rumi], messages: [] });
    expect(prompt.blocks.at(-1)).toMatchObject({ label: "Start (no messages yet)", role: "user" });
    expect(prompt.messages.at(-1)).toEqual({ role: "user", content: "(Begin the scene.)" });
  });

  test("custom fields go in with their titles", () => {
    const voiced = { ...rumi, fields: [...rumi.fields, { id: "v", key: "custom" as const, title: "Voice bank", content: '"Three minutes."', position: 1 }] };
    const prompt = assemblePrompt({ mainPrompt: "", cast: [voiced], messages: [message("user", "Hi")] });
    expect(prompt.messages[0]!.content).toContain('### Voice bank\n"Three minutes."');
  });
});
