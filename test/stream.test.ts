/** Reading a streamed reply: `<think>` tags as they arrive, and asking Gemini on Vertex AI for its thoughts. */

import { expect, test } from "bun:test";
import { askForThoughts, liveReply, requestBody } from "../src/nanogpt.ts";

test("a reply so far: <think> and <thought> become reasoning, and half a tag never shows", () => {
  expect(liveReply("Hello <th", "")).toEqual({ reasoning: "", content: "Hello" });
  expect(liveReply("<think>Plan", "")).toEqual({ reasoning: "Plan", content: "" });
  expect(liveReply("<think>Plan</think>Hi", "")).toEqual({ reasoning: "Plan", content: "Hi" });
  expect(liveReply("Plan</think>Hi", "")).toEqual({ reasoning: "Plan", content: "Hi" });
  expect(liveReply("<thought>Hm</thought>Yes", "")).toEqual({ reasoning: "Hm", content: "Yes" });
  // Reasoning sent apart from the text wins, as for a whole reply.
  expect(liveReply("Hi", " Thinking. ")).toEqual({ reasoning: "Thinking.", content: "Hi" });
});

test("Vertex AI: Gemini is asked for its thoughts, unless thinking is off or the profile already says", () => {
  const base = { model: "gemini-2.5-pro", messages: [], temperature: 1, maxTokens: 100, provider: "vertex" as const };
  expect(askForThoughts(requestBody(base), base)).toMatchObject({ extra_body: { google: { thinking_config: { include_thoughts: true } } } });
  // the profile's own thinking settings are kept beside it
  const budget = { ...base, extraParams: { extra_body: { google: { thinking_config: { thinking_budget: 512 } } } } };
  expect(askForThoughts(requestBody(budget), budget)).toMatchObject({ extra_body: { google: { thinking_config: { thinking_budget: 512, include_thoughts: true } } } });
  const off = { ...base, extraParams: { extra_body: { google: { thinking_config: { include_thoughts: false } } } } };
  expect(askForThoughts(requestBody(off), off)).toBeNull();
  expect(askForThoughts(requestBody({ ...base, reasoningEffort: "none" }), { ...base, reasoningEffort: "none" })).toBeNull();
});
