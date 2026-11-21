/** Reading a streamed reply: `<think>` tags as they arrive, and asking Gemini on Vertex AI for its thoughts. */

import { expect, test } from "bun:test";
import { echoes, liveReply, requestBody, thoughtsBodies } from "../src/nanogpt.ts";

test("a reply so far: <think> and <thought> become reasoning, and half a tag never shows", () => {
  expect(liveReply("Hello <th", "")).toEqual({ reasoning: "", content: "Hello" });
  expect(liveReply("<think>Plan", "")).toEqual({ reasoning: "Plan", content: "" });
  expect(liveReply("<think>Plan</think>Hi", "")).toEqual({ reasoning: "Plan", content: "Hi" });
  expect(liveReply("Plan</think>Hi", "")).toEqual({ reasoning: "Plan", content: "Hi" });
  expect(liveReply("<thought>Hm</thought>Yes", "")).toEqual({ reasoning: "Hm", content: "Yes" });
  // Reasoning sent apart from the text wins, as for a whole reply.
  expect(liveReply("Hi", " Thinking. ")).toEqual({ reasoning: "Thinking.", content: "Hi" });
});

test("a reasoning that's only the reply again isn't reasoning", () => {
  expect(echoes("She said hi.", "She said hi.")).toBe(true);
  expect(echoes("She said", "She said hi.")).toBe(true); // streaming, one ahead of the other
  expect(echoes("She  said\nhi.", "She said hi.")).toBe(true);
  expect(echoes("Keep it short.", "She said hi.")).toBe(false);
  expect(liveReply("She said hi.", "She said hi.")).toEqual({ reasoning: "", content: "She said hi." });
  // reasoning that arrived before any text still shows while it's alone
  expect(liveReply("", "She said")).toEqual({ reasoning: "She said", content: "" });
});

test("Vertex AI: Gemini is asked for its thoughts, unless thinking is off or the profile already says", () => {
  const base = { model: "gemini-2.5-pro", messages: [], temperature: 1, maxTokens: 100, provider: "vertex" as const };
  const forms = (r: typeof base & Record<string, unknown>) => thoughtsBodies(requestBody(r), r);
  expect(forms(base)).toEqual([expect.objectContaining({ extra_body: { google: { thinking_config: { include_thoughts: true } } } })]);
  // the profile's own thinking settings are kept beside it
  const budget = { ...base, extraParams: { extra_body: { google: { thinking_config: { thinking_budget: 512 } } } } };
  expect(forms(budget)[0]).toMatchObject({ extra_body: { google: { thinking_config: { thinking_budget: 512, include_thoughts: true } } } });
  const off = { ...base, extraParams: { extra_body: { google: { thinking_config: { include_thoughts: false } } } } };
  expect(forms(off)).toEqual([]);
  expect(forms({ ...base, reasoningEffort: "none" })).toEqual([]);
});

test("Vertex AI with a reasoning setting: then the same in Gemini's own words, without reasoning_effort", () => {
  const base = { model: "google/gemini-2.5-pro", messages: [], temperature: 1, maxTokens: 100, provider: "vertex" as const, reasoningEffort: "high" as const };
  const [first, second] = thoughtsBodies(requestBody(base), base);
  expect(first).toMatchObject({ reasoning_effort: "high", extra_body: { google: { thinking_config: { include_thoughts: true } } } });
  expect(second).toMatchObject({ extra_body: { google: { thinking_config: { thinking_budget: 24576, include_thoughts: true } } } });
  expect(second).not.toHaveProperty("reasoning_effort");
  const three = { ...base, model: "gemini-3-pro-preview", reasoningEffort: "low" as const };
  expect(thoughtsBodies(requestBody(three), three)[1]).toMatchObject({ extra_body: { google: { thinking_config: { thinking_level: "low", include_thoughts: true } } } });
});

test("Vertex AI: when Google refuses reasoning_effort beside the thoughts request, the reply still comes, with its thoughts", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { streamChatCompletion } = await import("../src/nanogpt.ts");
  const { forgetVertexTokens } = await import("../src/vertex.ts");
  const sent: Record<string, any>[] = [];
  const fake = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/token") return Response.json({ access_token: "t", expires_in: 3600 });
      const body = (await request.json()) as Record<string, any>;
      sent.push(body);
      if (body.reasoning_effort && body.extra_body) return Response.json([{ error: { code: 400, message: "reasoning_effort and thinking_config can't be used together" } }], { status: 400 });
      const chunks = [{ content: "<thought>Short" }, { content: " and kind.</thought>Hi." }];
      const text = chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c.content } }] })}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(text, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  try {
    const dir = mkdtempSync(join(tmpdir(), "anoesia-vertex-"));
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keyFile = join(dir, "key.json");
    writeFileSync(keyFile, JSON.stringify({ client_email: "a@b.iam", private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: `http://127.0.0.1:${fake.port}/token` }));
    forgetVertexTokens();
    const vertex = { keyFile, baseUrl: `http://127.0.0.1:${fake.port}/v1`, project: "my-project" };
    const result = await streamChatCompletion(
      { apiKey: "", baseUrl: "", timeoutMs: 5000, vertex },
      { model: "gemini-2.5-flash", messages: [{ role: "user", content: "Hi" }], temperature: 1, maxTokens: 100, provider: "vertex", reasoningEffort: "medium" },
      () => {},
    );
    expect(result).toMatchObject({ content: "Hi.", reasoning: "Short and kind." });
    expect(sent.length).toBe(2);
    expect(sent[1]).toMatchObject({ extra_body: { google: { thinking_config: { thinking_budget: 8192, include_thoughts: true } } } });
    expect(sent[1]).not.toHaveProperty("reasoning_effort");
  } finally {
    fake.stop(true);
  }
});
