/** Macros (src/macros.ts), with Lumiverse's names and syntax. */

import { describe, expect, test } from "bun:test";
import { fillMacros, listNames, type MacroEnv } from "../src/macros.ts";

function env(over: Partial<MacroEnv> = {}): MacroEnv {
  return {
    user: "Hana",
    char: "Rumi",
    cast: ["Rumi", "Mira", "Zoey"],
    lastMessage: "Two more minutes.",
    lastUserMessage: "Rumi?",
    lastCharMessage: "Two more minutes.",
    messageCount: 2,
    now: new Date(2026, 10, 14, 19, 5),
    vars: {},
    globals: {},
    random: () => 0,
    ...over,
  };
}

describe("macros", () => {
  test("names, with aliases", () => {
    expect(fillMacros("{{user}} / {{char}} / {{charName}} / {{cast}} / {{group}}", env())).toBe("Hana / Rumi / Rumi / Rumi, Mira and Zoey / Rumi, Mira and Zoey");
    expect(listNames(["A", "B"])).toBe("A and B");
  });

  test("the chat", () => {
    expect(fillMacros("{{lastMessage}}|{{lastUserMessage}}|{{last_char_message}}|{{messageCount}}", env())).toBe("Two more minutes.|Rumi?|Two more minutes.|2");
  });

  test("time", () => {
    expect(fillMacros("{{date}}, {{weekday}}, {{isodate}} {{isotime}}", env())).toBe("November 14, 2026, Saturday, 2026-11-14 19:05");
  });

  test("random, pick and roll, in every form", () => {
    const last = env({ random: () => 0.999 });
    expect(fillMacros("{{random::1::10}} {{random::calm::tense}} {{random:a,b,c}} {{pick::x::y}} {{roll::2d6}} {{roll:1d20}} {{roll d4}}", last)).toBe("10 tense c y 12 20 4");
    expect(fillMacros("{{pick::x::y}} {{roll::3d6}}", env())).toBe("x 3");
  });

  test("variables, nested macros, chat and global", () => {
    const e = env();
    expect(fillMacros("{{setvar::mood::{{pick::calm::tense}}}}Mood: {{getvar::mood}}", e)).toBe("Mood: calm");
    expect(fillMacros("{{incvar::turns}}{{incvar::turns}}{{addvar::turns::3}}{{getvar::turns}} {{hasvar::turns}} {{hasvar::nope}}", e)).toBe("5 true false");
    fillMacros("{{deletevar::turns}}{{setgvar::season::winter}}", e);
    expect(e.vars).toEqual({ mood: "calm" });
    expect(e.globals).toEqual({ season: "winter" });
    expect(fillMacros("{{getglobalvar::season}}", e)).toBe("winter");
  });

  test("comments and text helpers; unknown macros stay visible", () => {
    expect(fillMacros("a{{// note to self }}b{{comment::hidden}}{{newline}}c{{space}}d{{noop}} {{mystery}} {{also::unknown}}", env())).toBe("ab\nc d {{mystery}} {{also::unknown}}");
  });
});
