/**
 * Which way of asking gets a model's reasoning back from nanoGPT.
 *
 *   cd /opt/anoesia && sudo -u anoesia bun run scripts/probe-reasoning.ts [model id] [provider]
 *
 * With a provider (an id from the list it prints first, e.g. siliconflow),
 * every request is pinned to that provider (nanoGPT's `provider` field).
 * That's always pay-as-you-go: turn on "Enable paid models on API" in your
 * nanoGPT settings first, or nanoGPT refuses it without charging.
 *
 * Without a model id it uses the story profile's model (Settings →
 * Connections). It sends one short question several ways, streamed and
 * not, with each of nanoGPT's documented reasoning switches, and prints one
 * line per way: how much reasoning and text came back, in which fields, and
 * whether the "reasoning" was only the reply again. Nothing is saved, and
 * the key is never printed. Each way is one small request on your account.
 */

import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db.ts";
import { echoes, type ApiOptions } from "../src/nanogpt.ts";
import { Providers } from "../src/providers.ts";
import { Store } from "../src/store.ts";

const config = loadConfig();
const api: ApiOptions = { apiKey: config.apiKey, baseUrl: config.apiBaseUrl, timeoutMs: 120_000, vertex: config.vertex };
new Providers(config, api);
if (!api.apiKey) {
  console.log("No nanoGPT key is set (Settings → Connections).");
  process.exit(1);
}

let model = process.argv[2]?.trim() ?? "";
const provider = process.argv[3]?.trim() ?? "";
let effort: string | null = "high";
if (!model) {
  const store = new Store(openDatabase(join(config.dataDir, "anoesia.db")));
  const id = store.settings().rpProfileId;
  const profile = id ? store.profile(id) : null;
  if (!profile?.model || profile.provider !== "nanogpt") {
    console.log("Give a model id: bun run scripts/probe-reasoning.ts deepseek-ai/DeepSeek-V3.1-Terminus");
    process.exit(1);
  }
  model = profile.model;
  effort = profile.reasoningEffort && profile.reasoningEffort !== "none" ? profile.reasoningEffort : "high";
}

const base = {
  model,
  ...(provider ? { provider } : {}),
  messages: [{ role: "user", content: "A train leaves at 3:40 and the trip takes 2 h 35 min. When does it arrive? Answer in one sentence." }],
  temperature: 0.6,
  max_tokens: 1500,
};

const ways: [string, Record<string, unknown>][] = [
  ["whole reply, reasoning_effort (as Kinaera asks)", { reasoning_effort: effort, stream: false }],
  ["streamed, reasoning_effort (as Anoesia asks)", { reasoning_effort: effort, stream: true }],
  ["streamed, include_reasoning", { reasoning_effort: effort, include_reasoning: true, stream: true }],
  ["streamed, reasoning.enabled", { reasoning: { enabled: true, effort }, stream: true }],
  ["streamed, thinking.type enabled", { thinking: { type: "enabled" }, stream: true }],
  ["streamed, chat_template_kwargs thinking", { reasoning_effort: effort, chat_template_kwargs: { thinking: true }, stream: true }],
];

console.log(`Model: ${model}${provider ? `, provider ${provider} (pay-as-you-go)` : ""}`);
console.log(`Providers: ${await providers(model)}\n`);
for (const [name, extra] of ways) {
  try {
    console.log(`${name}: ${await probe({ ...base, ...extra })}`);
  } catch (error) {
    console.log(`${name}: failed (${(error as Error).message.slice(0, 200)})`);
  }
}

async function probe(body: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${api.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${api.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) return `HTTP ${response.status}: ${(await response.text()).replace(/\s+/g, " ").slice(0, 200)}`;
  const got: Record<string, string> = {};
  const add = (key: string, text: unknown) => {
    if (typeof text === "string" && text) got[key] = (got[key] ?? "") + text;
  };
  const read = (part: Record<string, any> | undefined) => {
    if (!part) return;
    add("content", part.content);
    add("reasoning", part.reasoning);
    add("reasoning_content", part.reasoning_content);
    if (Array.isArray(part.reasoning_details)) for (const d of part.reasoning_details) add("reasoning_details", d?.text ?? d?.summary);
  };
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const line of (await response.text()).split(/\r?\n/)) {
      if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
      try {
        read(JSON.parse(line.slice(5)).choices?.[0]?.delta);
      } catch {
        // skip
      }
    }
  } else {
    read(((await response.json()) as any).choices?.[0]?.message);
  }
  const content = got.content ?? "";
  const think = /<think>([\s\S]*?)<\/think>/i.exec(content)?.[1] ?? "";
  const parts = Object.entries(got).map(([k, v]) => `${k} ${v.length}${k !== "content" && echoes(v, content.replace(/<think>[\s\S]*?<\/think>/i, "")) ? " (only the reply again)" : ""}`);
  if (think) parts.push(`<think> in content ${think.length}`);
  const sample = (got.reasoning ?? got.reasoning_content ?? got.reasoning_details ?? think).replace(/\s+/g, " ").slice(0, 70);
  return `${parts.join(", ") || "nothing"}${sample ? ` | reasoning starts: "${sample}"` : ""}`;
}

/** The providers nanoGPT can route this model to (its provider list; not under /api/v1). */
async function providers(id: string): Promise<string> {
  try {
    const origin = new URL(api.baseUrl).origin;
    const canonical = id.replace(/:[^/]*$/, "");
    const response = await fetch(`${origin}/api/models/${encodeURIComponent(canonical)}/providers`, { headers: { Authorization: `Bearer ${api.apiKey}` }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return `couldn't list them (HTTP ${response.status})`;
    const json = (await response.json()) as { supportsProviderSelection?: boolean; providers?: { provider?: string; available?: boolean }[] };
    const list = (json.providers ?? []).map((p) => `${p.provider}${p.available === false ? " (unavailable)" : ""}`).join(", ");
    return `${list || "none listed"}${json.supportsProviderSelection === false ? " (this model can't be pinned to one)" : ""}`;
  } catch (error) {
    return `couldn't list them (${(error as Error).message})`;
  }
}
