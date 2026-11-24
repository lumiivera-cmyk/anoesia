/**
 * A small client for nanoGPT's API.
 *
 * nanoGPT gives one API key access to many models (DeepSeek, GLM, Kimi, ...)
 * and speaks the same "chat completions" format as OpenAI. A request is a
 * plain HTTPS POST with a JSON body:
 *
 *   POST https://nano-gpt.com/api/v1/chat/completions
 *   Authorization: Bearer <your key>
 *   { "model": "...", "messages": [...], "temperature": 0.9, "max_tokens": 1024 }
 *
 * and the reply is JSON with the generated text at
 * `choices[0].message.content`.
 *
 * Google Vertex AI speaks the same format (its OpenAI-style endpoint), so a
 * profile set to Vertex goes through this client too: only the address,
 * the sign-in (a token from a service account key, see `vertex.ts`), the
 * `google/` model names and a few error messages differ.
 *
 * Lifted from Amaedori as it stands (web search left out).
 *
 * This file uses the built-in `fetch`, so there is no SDK to install.
 */

import type { AgentApiMessage, ApiMessage, ProviderId, ReasoningEffort } from "./types.ts";
import { isGeminiModel, scrubVertex, vertexModel, vertexToken, type VertexOptions } from "./vertex.ts";

/** What the client needs to know to reach the API. */
export interface ApiOptions {
  /** The nanoGPT key; for Vertex AI (`provider: "vertex"`), the path to its service account key file. */
  apiKey: string;
  /** e.g. `https://nano-gpt.com/api/v1` (no trailing slash). */
  baseUrl: string;
  /** Give up after this many milliseconds. */
  timeoutMs: number;
  /** Where Vertex AI is, for profiles set to it ("" fields when it isn't set up in .env). */
  vertex?: VertexOptions;
  /** Which provider `apiKey` and `baseUrl` are for. Left out: nanoGPT. */
  provider?: ProviderId;
  /**
   * Told how each chat completion went at the provider: answered (and how
   * fast) or failed (and why). Settings shows it as the connection's status.
   */
  onResult?: (provider: ProviderId, outcome: { ok: boolean; ms: number | null; status?: number | null; message?: string }) => void;
}

/** Request fields Vertex AI doesn't take, left out of every request to it. */
const VERTEX_UNSUPPORTED = ["min_p"];

/** How the app names a provider, in error messages. */
function providerName(options: Pick<ApiOptions, "provider">): string {
  return options.provider === "vertex" ? "Google Vertex AI" : "nanoGPT";
}

/**
 * The options for one provider: `options` itself for nanoGPT, or Vertex
 * AI's address and key file. Throws when the provider isn't set up.
 */
export function optionsFor(options: ApiOptions, provider: ProviderId | undefined): ApiOptions {
  if (provider !== "vertex") {
    if (!options.apiKey) {
      throw new ApiError("No nanoGPT API key is set. Add one in Settings → Connections.");
    }
    return options;
  }
  const vertex = options.vertex;
  if (!vertex?.keyFile || !vertex.baseUrl) {
    throw new ApiError(
      "Google Vertex AI isn't set up. Add its project and service account key in Settings → Connections.",
    );
  }
  return { apiKey: vertex.keyFile, baseUrl: vertex.baseUrl, timeoutMs: options.timeoutMs, vertex, provider: "vertex", onResult: options.onResult };
}

/** A tool the model may call, in the API's format (see `src/tools.ts`). */
export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** A tool call the model asked for, as returned by the API. */
export interface NativeToolCall {
  id: string;
  name: string;
  /** The arguments as the model wrote them: JSON text, which may be broken. */
  arguments: string;
  /** Provider-specific metadata that must be replayed verbatim (Gemini thought signatures). */
  extraContent?: Record<string, unknown>;
}

/** The parameters of one generation request. */
/** A user message with a picture in it, for a vision model (src/images.ts). */
export type VisionMessage = { role: "user"; content: ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[] };

export interface CompletionRequest {
  model: string;
  messages: (ApiMessage | VisionMessage | AgentApiMessage)[];
  temperature: number;
  maxTokens: number;
  /** Nucleus sampling. Left out of the request when not set. */
  topP?: number | null;
  /** Min P sampling. Left out of the request when not set. */
  minP?: number | null;
  /** How hard a reasoning model thinks. Left out when not set. */
  reasoningEffort?: ReasoningEffort | null;
  /** More request fields, sent as they are (a profile's extra parameters). */
  extraParams?: Record<string, unknown>;
  /** Where the model is (the profile's provider). Left out: nanoGPT. */
  provider?: ProviderId;
  /** Tools the model may call. Left out when empty. */
  tools?: ToolSpec[];
  /**
   * "required": the model must call a tool this round (after a reflex
   * reminder: act, or choose not to). "none": the tools are sent, but it
   * can't call them (a turn's last round). Default "auto". Some providers
   * ignore it, so the caller still handles a reply with or without calls.
   */
  toolChoice?: "auto" | "required" | "none";
  /**
   * Accept a reply with no text and no tool calls instead of treating it as
   * an error. Used after tool calls, when the model may have nothing more
   * to say.
   */
  allowEmpty?: boolean;
  /**
   * Lets the caller stop the request early (the Stop button). When this
   * signal fires, the request is abandoned and `CancelledError` is thrown.
   */
  signal?: AbortSignal;
  /**
   * Streaming: this model has been seen sending its reply as "reasoning"
   * too (see `echoes`). While only reasoning has arrived, show it as the
   * reply's text, not in the thinking fold; the end corrects it if it was
   * real reasoning after all.
   */
  reasoningEchoes?: boolean;
}

/** A successful generation. */
export interface CompletionResult {
  /** The generated text, with any `<think>` reasoning removed. May be "" if the model only called tools. */
  content: string;
  /** Tool calls the model asked for through the API (not ones written as text). */
  toolCalls: NativeToolCall[];
  /** The model that actually answered, as reported by the API. */
  model: string;
  /** Why generation stopped: `"stop"` is normal, `"length"` means it hit `maxTokens`. */
  finishReason: string | null;
  /**
   * The model's reasoning before it answered, for a thinking model: from the
   * API's reasoning field, or the `<think>` text removed from `content`.
   * "" when there was none (most models, or a provider that hides it).
   */
  reasoning: string;
  /**
   * Streaming: whether the reasoning field only repeated the reply (true),
   * carried real reasoning (false), or was empty (left out).
   */
  reasoningEchoed?: boolean;
}

/**
 * An error from the API, carrying the HTTP status when there is one.
 * The message is written to be shown to you directly in the app.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Thrown when a request was stopped on purpose, through its `signal`. */
export class CancelledError extends Error {
  /**
   * What a streamed reply had written before it was stopped (both "" when
   * nothing had arrived, or the request wasn't streamed).
   */
  readonly partial: { content: string; reasoning: string };
  constructor(partial: { content: string; reasoning: string } = { content: "", reasoning: "" }) {
    super("The reply was stopped.");
    this.name = "CancelledError";
    this.partial = partial;
  }
}

/**
 * Ask the model for one reply.
 *
 * Throws `CancelledError` if `request.signal` fires, and `ApiError` if the
 * key is missing, the network fails, the request times out, the API returns
 * an error, or the reply is empty.
 */
export async function createChatCompletion(
  options: ApiOptions,
  request: CompletionRequest,
): Promise<CompletionResult> {
  const target = optionsFor(options, request.provider);
  if (target.provider === "vertex" && !isGeminiModel(request.model)) {
    throw new ApiError("Only Gemini models can be used through Google Vertex AI. Pick a Gemini model for this profile.");
  }

  // The request body. Note the API uses snake_case (`max_tokens`), while
  // our own code uses camelCase (`maxTokens`).
  const body = requestBody(request);
  const started = Date.now();
  const provider = target.provider ?? "nanogpt";
  let json: unknown;
  try {
    json = await postJson(target, "/chat/completions", body, request.signal);
  } catch (error) {
    if (error instanceof ApiError) target.onResult?.(provider, { ok: false, ms: null, status: error.status ?? null, message: error.message });
    throw error;
  }
  target.onResult?.(provider, { ok: true, ms: Date.now() - started });

  return readCompletion(json, target, request);
}

/** A whole (not streamed) reply's text, tool calls and reasoning, every shape checked. */
function readCompletion(json: unknown, target: ApiOptions, request: CompletionRequest): CompletionResult {
  const name = providerName(target);
  // Dig the text out of the response. Everything is checked because a model
  // provider having a bad day can return all sorts of shapes.
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new ApiError(`${name} sent back a reply with nothing in it.`);
  }
  // Some providers send an error with HTTP 200: never mistake it for an empty reply.
  const error = (json as { error?: { message?: unknown } | string }).error;
  if (error && !(json as { choices?: unknown }).choices) {
    const detail = typeof error === "string" ? error : typeof error.message === "string" ? error.message : "";
    throw new ApiError(clean(target, `${name} returned an error${detail ? ` (${detail})` : "."}`));
  }
  const choice = (json as { choices?: unknown[] })?.choices?.[0] as
    | { message?: { content?: unknown; tool_calls?: unknown } & ReasoningFields; finish_reason?: string }
    | undefined;
  const rawContent = choice?.message?.content;
  const toolCalls = readToolCalls(choice?.message?.tool_calls);
  // With tool calls, content is often `null`: the model only acted.
  if (typeof rawContent !== "string" && toolCalls.length === 0 && !request.allowEmpty) {
    throw new ApiError("The model's reply didn't contain any text.");
  }

  const content = typeof rawContent === "string" ? stripReasoning(rawContent) : "";
  const reasoning = readReasoning(choice?.message, typeof rawContent === "string" ? rawContent : "");
  if (content === "" && toolCalls.length === 0 && !request.allowEmpty) {
    throw new ApiError(
      choice?.finish_reason === "length"
        ? "The model ran out of tokens before writing anything. Try raising Max tokens."
        : "The model returned an empty reply.",
    );
  }

  return {
    content,
    toolCalls,
    model: typeof (json as { model?: unknown }).model === "string" ? (json as { model: string }).model : request.model,
    finishReason: choice?.finish_reason ?? null,
    reasoning: echoes(reasoning, content) ? "" : reasoning,
  };
}

/** A streamed reply as it stands so far: its reasoning and its text, `<think>` tags already sorted out. */
export interface LiveReply {
  reasoning: string;
  content: string;
}

/**
 * Ask the model for one reply, streamed: `onUpdate` is told the reply so
 * far (reasoning and text) each time more of it arrives, and the whole
 * reply is returned at the end, read the same way as `createChatCompletion`.
 *
 * A provider that answers with a plain JSON reply instead of a stream is
 * read as one, so nothing breaks when a model can't stream. For Vertex AI
 * the request asks Gemini for its thought summaries (`include_thoughts`),
 * unless the profile's extra parameters already decide that; if Google
 * refuses the field, it asks once more without it.
 *
 * The timeout is a quiet limit here: it's how long the model may go without
 * sending anything (a long reply that keeps coming isn't cut off).
 *
 * Throws like `createChatCompletion`. A stop through `request.signal`
 * throws `CancelledError` carrying what had arrived (`partial`).
 */
export async function streamChatCompletion(
  options: ApiOptions,
  request: CompletionRequest,
  onUpdate: (live: LiveReply) => void,
): Promise<CompletionResult> {
  const target = optionsFor(options, request.provider);
  if (target.provider === "vertex" && !isGeminiModel(request.model)) {
    throw new ApiError("Only Gemini models can be used through Google Vertex AI. Pick a Gemini model for this profile.");
  }
  const provider = target.provider ?? "nanogpt";
  const started = Date.now();
  const fail = (error: unknown) => {
    if (error instanceof ApiError) target.onResult?.(provider, { ok: false, ms: null, status: error.status ?? null, message: error.message });
    return error;
  };

  const plain = { ...requestBody(request), stream: true };
  // Vertex AI: ask Gemini for its thoughts, in the forms Google may take, best first (see `thoughtsBodies`).
  const tries = target.provider === "vertex" ? [...thoughtsBodies(plain, request), plain] : [plain];
  /** What happened to the thoughts request, for the server's log (Vertex AI only). */
  const refusals: string[] = [];
  let response!: Response;
  let idle!: Idle;
  try {
    for (const [i, body] of tries.entries()) {
      ({ response, idle } = await openStream(target, body, request.signal));
      if (i === tries.length - 1 || response.status !== 400) break;
      // Google refused this form of the thoughts request: say why in the log, then try the next.
      const text = await idle.read(response.text());
      idle.done();
      if (!/include_thoughts|thinking|extra_body|reasoning_effort/i.test(text)) {
        throw new ApiError(clean(target, describeHttpError(400, text, target)), 400);
      }
      refusals.push(clean(target, text.replace(/\s+/g, " ").slice(0, 300)));
    }
  } catch (error) {
    throw fail(error);
  }
  const used = refusals.length;

  try {
    if (!response.ok) {
      const text = await idle.read(response.text());
      throw new ApiError(clean(target, describeHttpError(response.status, text, target)), response.status);
    }
    // Not a stream after all: a whole reply.
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const text = await idle.read(response.text());
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ApiError(`${providerName(target)} sent back something that isn't JSON.`, response.status);
      }
      const result = readCompletion(json, target, request);
      onUpdate({ reasoning: result.reasoning, content: result.content });
      target.onResult?.(provider, { ok: true, ms: Date.now() - started });
      return result;
    }

    const acc: StreamAcc = { raw: "", fieldReasoning: "", detailsReasoning: "", model: "", finishReason: null, fields: new Set<string>(), calls: [] };
    const live = (): LiveReply => liveReply(acc.raw, acc.fieldReasoning, acc.detailsReasoning, request.reasoningEchoes);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;
    try {
      while (!finished) {
        const { value, done } = await idle.read(reader.read());
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        let changed = false;
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            finished = true;
            break;
          }
          if (readChunk(data, acc, target)) changed = true;
        }
        if (changed) onUpdate(live());
      }
    } catch (error) {
      if (error instanceof CancelledError) throw new CancelledError(live());
      throw error;
    } finally {
      reader.cancel().catch(() => {});
    }

    const final = live();
    const field = acc.fieldReasoning.trim();
    const reasoningEchoed = field ? echoes(field, final.content) || echoes(field, acc.raw.trim()) || (!final.content && Boolean(request.reasoningEchoes)) : undefined;
    const toolCalls = streamedToolCalls(acc);
    if (!final.content && toolCalls.length === 0 && !request.allowEmpty) {
      throw new ApiError(
        acc.finishReason === "length"
          ? "The model ran out of tokens before writing anything. Try raising Max tokens."
          : "The model returned an empty reply.",
      );
    }
    target.onResult?.(provider, { ok: true, ms: Date.now() - started });
    // One line per reply, so a missing or odd reasoning fold can be traced from the server's log (journalctl -u anoesia).
    const echoed = [acc.fieldReasoning, acc.detailsReasoning].some((r) => echoes(r, final.content) || echoes(r, acc.raw.trim()));
    const asked = target.provider !== "vertex" ? "" : `; thoughts ${used < tries.length - 1 ? `asked (form ${used + 1} of ${tries.length - 1})` : tries.length > 1 ? "refused" : "not asked"}`;
    console.log(
      `${providerName(target)} reply: ${acc.model || request.model}${asked}; ${final.reasoning.length} characters of reasoning, ${final.content.length} of text${echoed ? " (a reasoning field only repeated the text, so it was dropped)" : ""}; fields seen: ${[...acc.fields].join(", ") || "none"}${refusals.length ? `; Google said: ${refusals.join(" | ")}` : ""}`,
    );
    return { content: final.content, toolCalls, model: acc.model || request.model, finishReason: acc.finishReason, reasoning: final.reasoning, ...(reasoningEchoed === undefined ? {} : { reasoningEchoed }) };
  } catch (error) {
    throw fail(error);
  } finally {
    idle.done();
  }
}

/**
 * Vertex AI's body with Gemini asked for its thought summaries
 * (`extra_body.google.thinking_config.include_thoughts`), in the forms to
 * try, best first; none when that isn't wanted (thinking is off, or the
 * profile's extra parameters already say whether to include thoughts).
 *
 * Google won't take `reasoning_effort` beside a thinking budget or level,
 * and may not beside `include_thoughts` either. So with a reasoning
 * setting, the second form says it in Gemini's own words instead: a
 * thinking budget for Gemini 2.5 (low 1,024, medium 8,192, high 24,576
 * tokens, as Google maps it), a thinking level for later models.
 */
export function thoughtsBodies(body: Record<string, unknown>, request: CompletionRequest): Record<string, unknown>[] {
  if (request.reasoningEffort === "none") return [];
  const extra = isRecord(body.extra_body) ? body.extra_body : {};
  const google = isRecord(extra.google) ? extra.google : {};
  const thinking = isRecord(google.thinking_config) ? google.thinking_config : {};
  if ("include_thoughts" in thinking) return [];
  const withConfig = (b: Record<string, unknown>, config: Record<string, unknown>) => ({ ...b, extra_body: { ...extra, google: { ...google, thinking_config: { ...thinking, ...config, include_thoughts: true } } } });
  const forms = [withConfig(body, {})];
  const effort = request.reasoningEffort;
  if (effort && !("thinking_budget" in thinking) && !("thinking_level" in thinking)) {
    const { reasoning_effort: _dropped, ...rest } = body;
    const config = /gemini-2\.5/i.test(request.model) ? { thinking_budget: { low: 1024, medium: 8192, high: 24576 }[effort] } : { thinking_level: effort === "low" ? "low" : "high" };
    forms.push(withConfig(rest, config));
  }
  return forms;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read one streamed chunk into `acc`. Returns whether the reply changed. */
/** A streamed reply as its chunks arrive. Reasoning fields and reasoning_details are kept apart, as one may only echo the reply. */
interface StreamAcc {
  raw: string;
  fieldReasoning: string;
  detailsReasoning: string;
  model: string;
  finishReason: string | null;
  /** The delta fields seen, for the log. */
  fields: Set<string>;
  /** Tool calls as they arrive, in pieces, by their index. */
  calls: { id: string; name: string; arguments: string; extraContent?: Record<string, unknown> }[];
}

/** The tool calls a streamed reply asked for, whole. */
function streamedToolCalls(acc: StreamAcc): NativeToolCall[] {
  return acc.calls.flatMap((c, index) =>
    c && c.name ? [{ id: c.id || `call_${index}`, name: c.name, arguments: c.arguments || "{}", ...(c.extraContent ? { extraContent: c.extraContent } : {}) }] : [],
  );
}

function readChunk(data: string, acc: StreamAcc, target: ApiOptions): boolean {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return false; // a keep-alive or a broken line: skip it
  }
  if (!isRecord(json)) return false;
  const error = json.error as { message?: unknown } | string | undefined;
  if (error) {
    const detail = typeof error === "string" ? error : typeof error.message === "string" ? error.message : "";
    throw new ApiError(clean(target, `${providerName(target)} stopped with an error${detail ? ` (${detail})` : "."}`));
  }
  if (typeof json.model === "string" && json.model) acc.model = json.model;
  const choice = (Array.isArray(json.choices) ? json.choices[0] : undefined) as
    | { delta?: { content?: unknown; tool_calls?: unknown; extra_content?: { google?: { thought?: unknown } } } & ReasoningFields; finish_reason?: unknown }
    | undefined;
  if (typeof choice?.finish_reason === "string") acc.finishReason = choice.finish_reason;
  const delta = choice?.delta;
  if (!delta) return false;
  for (const [key, value] of Object.entries(delta)) {
    if (value === null || value === "" || key === "role") continue;
    acc.fields.add(isRecord(value) ? `${key}{${Object.keys(value).join(",")}}` : key);
  }
  const size = () => acc.raw.length + acc.fieldReasoning.length + acc.detailsReasoning.length;
  const before = size();
  const thought = delta.extra_content?.google?.thought === true;
  const field = [delta.reasoning, delta.reasoning_content].find((v) => typeof v === "string" && v !== "");
  if (typeof field === "string") acc.fieldReasoning += field;
  if (Array.isArray(delta.reasoning_details)) {
    for (const d of delta.reasoning_details) {
      const t = (d as { text?: unknown })?.text ?? (d as { summary?: unknown })?.summary;
      if (typeof t === "string") acc.detailsReasoning += t;
    }
  }
  if (typeof delta.content === "string") {
    if (thought) acc.fieldReasoning += delta.content;
    else acc.raw += delta.content;
  }
  // Tool calls come in pieces: the id and name first, then the arguments a bit at a time, matched by index.
  let called = false;
  if (Array.isArray(delta.tool_calls)) {
    for (const [i, raw] of delta.tool_calls.entries()) {
      if (!isRecord(raw)) continue;
      const index = typeof raw.index === "number" ? raw.index : i;
      const call = (acc.calls[index] ??= { id: "", name: "", arguments: "" });
      if (typeof raw.id === "string" && raw.id) call.id = raw.id;
      const fn = isRecord(raw.function) ? raw.function : {};
      if (typeof fn.name === "string" && fn.name) call.name = fn.name.startsWith(call.name) ? fn.name : call.name + fn.name; // whole each time, or in pieces
      if (typeof fn.arguments === "string") call.arguments += fn.arguments;
      else if (isRecord(fn.arguments)) call.arguments = JSON.stringify(fn.arguments);
      if (isRecord(raw.extra_content)) call.extraContent = raw.extra_content;
      called = true;
    }
  }
  return size() !== before || called;
}

/**
 * The reply so far, from the text that has arrived (which may hold
 * `<think>`/`<thought>` reasoning) and the reasoning sent apart from it. A
 * tag half arrived at the very end is held back, so it never flashes up as
 * text.
 */
export function liveReply(raw: string, fieldReasoning: string, detailsReasoning = "", echoMode = false): LiveReply {
  const parts = thinkParts(holdBackTag(raw));
  // A model known to send its reply as reasoning, with no text yet: that "reasoning" is the reply arriving.
  // Read it as the text itself, so <think> tags in it (a model asked to think in its reply) still fold away.
  if (echoMode && !raw.trim() && fieldReasoning.trim()) {
    const asText = liveReply(fieldReasoning, "");
    return { reasoning: asText.reasoning || detailsReasoning.trim(), content: asText.content };
  }
  // The first that has something and isn't the reply again (with or without its <think> part):
  // the reasoning field, its details, then <think> text.
  const whole = raw.trim();
  const isEcho = (r: string) => echoes(r, parts.rest) || echoes(r, whole);
  const sent = [fieldReasoning, detailsReasoning].map((r) => r.trim()).find((r) => r && !isEcho(r));
  const tagged = parts.reasoning.join("\n\n");
  const reasoning = sent ?? (echoes(tagged, parts.rest) ? "" : tagged);
  return { reasoning, content: parts.rest };
}

/** The tags a model's reasoning can come in: `<think>` (DeepSeek, Qwen...), `<thought>` (Gemini), and `<thinking>`/`<reasoning>` for a model asked to think in its reply. */
const THINK_TAGS = ["thinking", "thought", "think", "reasoning"];

/** The text without a reasoning tag half arrived at its very end, so it never flashes up as text. */
function holdBackTag(text: string): string {
  const m = /<\/?([a-z]*)$/i.exec(text);
  if (!m) return text;
  const name = m[1]!.toLowerCase();
  return THINK_TAGS.some((t) => t.startsWith(name)) ? text.slice(0, m.index) : text;
}

/**
 * Whether a "reasoning" is only the reply again. Some providers fill the
 * reasoning field with the reply's own text when the model didn't think
 * (seen with DeepSeek V3.1 Terminus on nanoGPT); that isn't reasoning, so
 * it isn't shown or kept. As it streams, one may be ahead of the other, so
 * either starting with the other counts.
 */
export function echoes(reasoning: string, content: string): boolean {
  const r = reasoning.replace(/\s+/g, " ").trim();
  const c = content.replace(/\s+/g, " ").trim();
  if (!r || !c) return false;
  return c.startsWith(r) || r.startsWith(c);
}

/** Stops a streamed request when it goes quiet for too long. */
interface Idle {
  /** Wait for `step`, failing with the right error if the request is stopped or goes quiet. */
  read<T>(step: Promise<T>): Promise<T>;
  /** Stop the clock. */
  done(): void;
}

/** POST a streamed request; returns the response once its headers arrive, and the quiet clock that keeps watching it. */
async function openStream(options: ApiOptions, body: unknown, signal?: AbortSignal): Promise<{ response: Response; idle: Idle }> {
  const auth = await authorization(options);
  const quiet = new AbortController();
  const stop = signal ? AbortSignal.any([quiet.signal, signal]) : quiet.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => quiet.abort(), options.timeoutMs);
  };
  const why = (error: unknown): Error => {
    if (signal?.aborted) return new CancelledError();
    if (quiet.signal.aborted) return new ApiError(`The model went ${Math.round(options.timeoutMs / 1000)} seconds without sending anything.`);
    if (error instanceof ApiError || error instanceof CancelledError) return error;
    return new ApiError(clean(options, `Lost the connection to ${providerName(options)}: ${(error as Error).message}`));
  };
  const idle: Idle = {
    async read(step) {
      try {
        const value = await step;
        arm();
        return value;
      } catch (error) {
        throw why(error);
      }
    },
    done: () => clearTimeout(timer),
  };
  arm();
  try {
    const response = await fetch(`${options.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: auth },
      body: JSON.stringify(body),
      signal: stop,
    });
    arm();
    return { response, idle };
  } catch (error) {
    idle.done();
    if (signal?.aborted || quiet.signal.aborted) throw why(error);
    throw new ApiError(clean(options, `Couldn't reach ${providerName(options)}: ${(error as Error).message}`));
  }
}

/** Where providers put a thinking model's reasoning in a reply's message. */
interface ReasoningFields {
  reasoning?: unknown;
  reasoning_content?: unknown;
  reasoning_details?: unknown;
}

/**
 * A thinking model's reasoning, wherever the reply carries it. nanoGPT
 * sends it as `message.reasoning` (`reasoning_content` on its legacy
 * endpoint), some providers only as `reasoning_details` pieces, and some
 * models write it into the text inside `<think>` tags.
 */
export function readReasoning(message: ReasoningFields | undefined, rawContent: string): string {
  const field = [message?.reasoning, message?.reasoning_content].find((v) => typeof v === "string" && v.trim() !== "");
  if (typeof field === "string") return field.trim();
  if (Array.isArray(message?.reasoning_details)) {
    const pieces = message.reasoning_details
      .map((d) => (d as { text?: unknown; summary?: unknown })?.text ?? (d as { summary?: unknown })?.summary)
      .filter((t): t is string => typeof t === "string" && t.trim() !== "");
    if (pieces.length) return pieces.join("\n\n").trim();
  }
  return thinkParts(rawContent).reasoning.join("\n\n");
}

/**
 * A reply's text split into its `<think>` reasoning and the rest. Besides
 * whole `<think>...</think>` pairs: a reply with only the closing tag (the
 * provider ate the opening one) thinks up to it, and an opening tag never
 * closed (cut off at Max tokens) thinks to the end.
 */
function thinkParts(text: string): { reasoning: string[]; rest: string } {
  // Only reasoning at the start counts: a model thinks before it writes. A tag
  // later in the reply is the reply talking about tags (explaining how a
  // reasoning block works, say), so it stays as text.
  const reasoning: string[] = [];
  let rest = text;
  const lead = /^\s*<(thinking|thought|think|reasoning)>([\s\S]*?)<\/\1>/i;
  for (let m = lead.exec(rest); m; m = lead.exec(rest)) {
    reasoning.push(m[2]!);
    rest = rest.slice(m[0].length);
  }
  // A closing tag with no opening one before it: the opening tag was dropped
  // (DeepSeek sends <think> as a special token), so what comes first is reasoning.
  const close = /<\/(thinking|thought|think|reasoning)>/i.exec(rest);
  if (close && !/<(thinking|thought|think|reasoning)>/i.test(rest.slice(0, close.index))) {
    reasoning.push(rest.slice(0, close.index));
    rest = rest.slice(close.index + close[0].length);
  }
  // Still thinking (a reply cut short, or one arriving): an opening tag at the start with no end yet.
  const open = /^\s*<(thinking|thought|think|reasoning)>/i.exec(rest);
  if (open) {
    reasoning.push(rest.slice(open[0].length));
    rest = "";
  }
  return { reasoning: reasoning.map((r) => r.trim()).filter(Boolean), rest: rest.trim() };
}

/**
 * The JSON body for a request. Optional settings are only sent when they're
 * set, because some models reject parameters they don't know.
 */
export function requestBody(request: CompletionRequest): Record<string, unknown> {
  const vertex = request.provider === "vertex";
  const body: Record<string, unknown> = {
    // A profile's extra fields go first, so the app's own fields win.
    ...request.extraParams,
    model: vertex ? vertexModel(request.model) : request.model,
    messages: request.messages,
    temperature: request.temperature,
    max_tokens: request.maxTokens,
    ...(request.topP != null ? { top_p: request.topP } : {}),
    ...(request.minP != null ? { min_p: request.minP } : {}),
    ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
    ...(request.tools && request.tools.length > 0 ? { tools: request.tools, tool_choice: request.toolChoice ?? "auto" } : {}),
    // The whole reply at once; streamChatCompletion turns this on.
    stream: false,
  };
  if (vertex) for (const field of VERTEX_UNSUPPORTED) delete body[field];
  return body;
}

/**
 * Read `message.tool_calls` from a response, tolerating the variations
 * between providers: arguments sent as an object instead of JSON text, or a
 * missing id.
 */
function readToolCalls(value: unknown): NativeToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, index) => {
    const call = raw as { id?: unknown; extra_content?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const name = call?.function?.name;
    if (typeof name !== "string" || name === "") return [];
    const args = call.function?.arguments;
    return [
      {
        id: typeof call.id === "string" && call.id ? call.id : `call_${index}`,
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
        ...(typeof call.extra_content === "object" && call.extra_content !== null && !Array.isArray(call.extra_content)
          ? { extraContent: call.extra_content as Record<string, unknown> }
          : {}),
      },
    ];
  });
}

/**
 * What nanoGPT says a model can do (its `capabilities` and limits, from
 * `GET /models?detailed=true`). A field is left out when the API didn't
 * say, so "unknown" never reads as "can't". The API says nothing about
 * sampling settings (temperature, Top P, Min P), so those aren't here.
 */
export interface ModelInfo {
  id: string;
  /** It can think before answering, so the reasoning setting applies. */
  reasoning?: boolean;
  /** It can call tools. */
  toolCalling?: boolean;
  /** The most tokens it can write in one reply. */
  maxOutputTokens?: number;
  /** The most tokens it can read: prompt and reply together. */
  contextLength?: number;
}

/**
 * List the models available to your key, for the settings panel, with what
 * each one supports. Sorted alphabetically by id. For Vertex AI, only its
 * Gemini models (see `listVertexModels`).
 */
export async function listModels(options: ApiOptions, provider: ProviderId = "nanogpt"): Promise<ModelInfo[]> {
  const target = optionsFor(options, provider);
  if (target.provider === "vertex") return listVertexModels(target);
  const json = await request(target, "/models?detailed=true", { method: "GET" });
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .flatMap((raw) => {
      const entry = raw as { id?: unknown; capabilities?: Record<string, unknown>; max_output_tokens?: unknown; context_length?: unknown };
      if (typeof entry?.id !== "string") return [];
      const info: ModelInfo = { id: entry.id };
      const caps = entry.capabilities;
      if (typeof caps?.reasoning === "boolean") info.reasoning = caps.reasoning;
      if (typeof caps?.tool_calling === "boolean") info.toolCalling = caps.tool_calling;
      const max = entry.max_output_tokens;
      if (typeof max === "number" && Number.isFinite(max) && max > 0) info.maxOutputTokens = max;
      const context = entry.context_length;
      if (typeof context === "number" && Number.isFinite(context) && context > 0) info.contextLength = context;
      return [info];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Model ids that aren't for chat, left out of Vertex AI's list. */
const NOT_CHAT = /embedding|imagen|veo|aqa|tts|image-generation|native-audio/i;

/**
 * Vertex AI's OpenAI-style endpoint has no model list, so Google's own
 * models come from its Model Garden list instead
 * (`publishers/google/models`), written `publishers/google/models/gemini-2.5-pro`
 * and named `google/gemini-2.5-pro` in requests. Only Gemini chat models
 * are kept: Google Cloud's trial credit doesn't pay for partner models.
 */
async function listVertexModels(options: ApiOptions): Promise<ModelInfo[]> {
  const origin = { ...options, baseUrl: new URL(options.baseUrl).origin };
  const ids = new Set<string>();
  let page = "";
  for (let i = 0; i < 10; i++) {
    const json = (await request(origin, `/v1beta1/publishers/google/models?pageSize=100${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`, { method: "GET" })) as {
      publisherModels?: { name?: unknown }[];
      nextPageToken?: unknown;
    };
    for (const entry of json?.publisherModels ?? []) {
      const id = typeof entry?.name === "string" ? entry.name.replace(/^publishers\/google\/models\//, "") : "";
      if (id.startsWith("gemini") && !NOT_CHAT.test(id)) ids.add(`google/${id}`);
    }
    if (typeof json?.nextPageToken !== "string" || !json.nextPageToken) break;
    page = json.nextPageToken;
  }
  return [...ids].sort().map((id) => ({ id }));
}

/**
 * Remove "thinking" text from a reply.
 *
 * Some reasoning models put their private reasoning inside
 * `<think>...</think>` tags at the start of the reply. That's not part of the
 * post, so it's removed (a lone closing tag, or an opening tag never closed,
 * too: see `thinkParts`). (It's kept apart as the reply's `reasoning`; see
 * `readReasoning`.)
 */
export function stripReasoning(text: string): string {
  return thinkParts(text).rest;
}

// ------------------------------------------------------------------ helpers

function postJson(options: ApiOptions, path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  return request(
    options,
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    signal,
  );
}

/**
 * Send one request and return the parsed JSON response, turning every kind
 * of failure into an `ApiError` (or `CancelledError`) with a readable message.
 *
 * @param signal  Optional: stops the request early when it fires.
 */
async function request(options: ApiOptions, path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  // Stop the request when *either* the timeout runs out or the caller's
  // signal fires, whichever comes first.
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const stop = signal ? AbortSignal.any([timeout, signal]) : timeout;
  const name = providerName(options);
  const auth = await authorization(options);

  let response: Response;
  let text: string;
  // Both steps are inside the try: the model can stall before the reply
  // starts *or* halfway through sending it, and either must be caught.
  try {
    response = await fetch(`${options.baseUrl}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: auth },
      signal: stop,
    });
    text = await response.text();
  } catch (error) {
    if (signal?.aborted) throw new CancelledError();
    if (timeout.aborted) {
      throw new ApiError(`The model took longer than ${Math.round(options.timeoutMs / 1000)} seconds to reply.`);
    }
    throw new ApiError(clean(options, `Couldn't reach ${name}: ${(error as Error).message}`));
  }

  if (!response.ok) {
    throw new ApiError(clean(options, describeHttpError(response.status, text, options)), response.status);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(`${name} sent back something that isn't JSON.`, response.status);
  }
}

/** The `Authorization` header: the key itself, or for Vertex AI a token signed in with its key file. */
async function authorization(options: ApiOptions): Promise<string> {
  if (options.provider !== "vertex") return `Bearer ${options.apiKey}`;
  try {
    return `Bearer ${await vertexToken(options.apiKey, options.timeoutMs)}`;
  } catch (error) {
    if (error instanceof ApiError) throw new ApiError(clean(options, error.message), error.status);
    throw error;
  }
}

/** For Vertex AI, a message with the settings from .env taken out (see `scrubVertex`). */
function clean(options: ApiOptions, message: string): string {
  return options.provider === "vertex" && options.vertex ? scrubVertex(message, options.vertex) : message;
}

/** A friendly explanation for an HTTP error status, plus the API's own message if it sent one. */
function describeHttpError(status: number, body: string, options: ApiOptions): string {
  const hints: Record<number, string> =
    options.provider === "vertex"
      ? {
          401: "Google Vertex AI didn't accept the sign-in token. Check the service account key in Settings → Connections is a current one.",
          403: 'Google Vertex AI refused the service account. In Google Cloud, give it the "Agent Platform User" role (IAM), and check the "Agent Platform API" is enabled for GOOGLE_CLOUD_PROJECT.',
          404: "Google Vertex AI doesn't recognise that model id, or it isn't offered in GOOGLE_CLOUD_LOCATION. Model ids look like google/gemini-2.5-pro.",
          429: "Google Vertex AI says you're over your quota or out of credit. Wait a moment and try again, or check billing in Google Cloud.",
        }
      : {
          401: "nanoGPT rejected the API key: it's invalid or revoked.",
          402: "nanoGPT says your balance is too low.",
          404: "nanoGPT doesn't recognise that model id. Check the model in settings.",
          429: "nanoGPT is rate-limiting you. Wait a moment and try again.",
        };
  const hint = hints[status] ?? `${providerName(options)} returned an error (HTTP ${status}).`;

  // Error bodies are usually `{ "error": { "message": "..." } }`; Google
  // sometimes wraps that in a list.
  let detail = "";
  try {
    const json = JSON.parse(body) as unknown;
    const parsed = (Array.isArray(json) ? json[0] : json) as { error?: { message?: unknown } | string };
    const err = parsed?.error;
    detail = typeof err === "string" ? err : typeof err?.message === "string" ? err.message : "";
  } catch {
    detail = body.slice(0, 200);
  }
  return detail ? `${hint} (${detail})` : hint;
}
