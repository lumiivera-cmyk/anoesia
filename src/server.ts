/**
 * The web server: the app's files from `public/`, and a small JSON API
 * under `/api/`. Start it with `bun start`.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { parseCards } from "./cards.ts";
import { loadConfig, type Config } from "./config.ts";
import { openDatabase } from "./db.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import { addressOf, cookieFor, isPublicPath, Login, overHttps, tokenOf } from "./login.ts";
import { ApiError, CancelledError, createChatCompletion, listModels, streamChatCompletion, type ApiOptions, type LiveReply } from "./nanogpt.ts";
import { KNOWN_MACROS } from "./macros.ts";
import { assemblePrompt, cleanReply } from "./prompt.ts";
import { NUDGES } from "./nudges.ts";
import { runTurn } from "./agent.ts";
import { AgentStore } from "./agentstore.ts";
import { compactDiff, diff } from "./diff.ts";
import { ConflictError, Workspace } from "./workspace.ts";
import { PHOTO_TYPES, Store } from "./store.ts";
import { Providers, VERTEX_REGIONS } from "./providers.ts";
import type { AgentEdit, Message, ProviderId } from "./types.ts";

export interface App {
  fetch: (request: Request) => Promise<Response>;
  store: Store;
  agent: AgentStore;
  close: () => void;
}

type Json = Record<string, unknown>;

export function createApp(config: Config): App {
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDatabase(join(config.dataDir, "anoesia.db"));
  const store = new Store(db);
  const agent = new AgentStore(db);
  const ws = new Workspace(store, agent);
  const agentRunning = new Map<string, AbortController>();
  const login = new Login(config.dataDir);
  const photoDir = join(config.dataDir, "photos");
  mkdirSync(photoDir, { recursive: true });
  const api: ApiOptions = { apiKey: config.apiKey, baseUrl: config.apiBaseUrl, timeoutMs: config.requestTimeoutMs, vertex: config.vertex };
  // Keys saved in Settings override .env's, and every request reports how the provider answered.
  const providers = new Providers(config, api);
  /**
   * Models seen sending their reply as "reasoning" too (provider:model),
   * so their next replies stream as text from the start. Kept in the data
   * folder; a model that sends real reasoning comes off the list.
   */
  const echoFile = join(config.dataDir, "reasoning-echoes.json");
  const echoModels = new Set<string>(readEchoModels(echoFile));
  function noteEcho(key: string, echoed: boolean | undefined): void {
    if (echoed === undefined || echoed === echoModels.has(key)) return;
    if (echoed) echoModels.add(key);
    else echoModels.delete(key);
    try {
      writeFileSync(echoFile, JSON.stringify([...echoModels], null, 2));
    } catch (error) {
      console.error(error);
    }
  }

  /** The reply being written in each chat, so Stop can end it, a second one can't start, and the page can watch it arrive. */
  const running = new Map<string, Live>();

  /**
   * Start writing a reply in a chat: after your message (`text`, saved first
   * when there is one), or as a new version of the last reply
   * (`regenerate`). Checks that it can start (throws `ValidationError` if
   * not), then writes in the background: the reply is saved when it's done,
   * whether or not anyone is still watching, and `finished` says how it went.
   */
  function startReply(chatId: string, mode: { regenerate: true } | { regenerate: false; text: string }): Live {
    store.chat(chatId);
    if (running.has(chatId)) throw new ValidationError("A reply is already being written in this chat.");
    let history: Message[] | undefined;
    let last: Message | undefined;
    if (mode.regenerate) {
      const messages = store.messages(chatId);
      last = messages.at(-1);
      if (!last || last.role !== "assistant") throw new ValidationError("There's no reply at the end of the chat to regenerate.");
      // Written from everything before the last reply, then added to it as a new version.
      history = messages.slice(0, -1);
    } else if (mode.text) {
      store.addMessage({ chatId, role: "user", author: "user", content: mode.text });
    }
    const live: Live = { controller: new AbortController(), reply: { reasoning: "", content: "" }, watchers: new Set(), finished: Promise.resolve({}) };
    running.set(chatId, live);
    live.finished = (async () => {
      let outcome: { error?: string } = {};
      try {
        const reply = await generate(chatId, live, history);
        if (last) store.addSwipe(last.id, reply.content, reply.profileId, reply.model, reply.reasoning);
        else store.addMessage({ chatId, role: "assistant", author: "narrator", ...reply });
      } catch (error) {
        if (!(error instanceof ApiError || error instanceof ValidationError || error instanceof CancelledError)) console.error(error);
        outcome = { error: errorMessage(error) };
      } finally {
        running.delete(chatId);
      }
      tell(live, { type: "done", ...chatView(chatId), ...outcome });
      return outcome;
    })();
    return live;
  }

  /**
   * Ask the RP profile for the next reply in a chat, from `history` (default:
   * its messages as they are now), streamed into `live`. Stopped partway, it
   * keeps what was written (if anything was).
   */
  async function generate(chatId: string, live: Live, history?: Message[]): Promise<{ content: string; reasoning: string; profileId: string; model: string }> {
    const settings = store.settings();
    if (!settings.rpProfileId) throw new ValidationError("Pick a connection profile first (Settings → Connections).");
    const profile = store.profile(settings.rpProfileId);
    if (!profile.model) throw new ValidationError(`The profile "${profile.name}" has no model yet.`);
    const prompt = buildPrompt(chatId, history);
    let content: string;
    let reasoning: string;
    let model = profile.model;
    const echoKey = `${profile.provider}:${profile.model}`;
    try {
      const result = await streamChatCompletion(
        api,
        {
          model: profile.model,
          provider: profile.provider,
          messages: prompt.messages,
          temperature: profile.temperature,
          maxTokens: profile.maxTokens,
          topP: profile.topP,
          minP: profile.minP,
          reasoningEffort: profile.reasoningEffort,
          extraParams: profile.extraParams ? (JSON.parse(profile.extraParams) as Json) : undefined,
          signal: live.controller.signal,
          reasoningEchoes: echoModels.has(echoKey),
        },
        (next) => update(live, next),
      );
      noteEcho(echoKey, result.reasoningEchoed);
      content = cleanReply(result.content);
      reasoning = result.reasoning;
      model = result.model;
    } catch (error) {
      // Stopped: keep the words that had arrived, like a reply that ended there.
      if (!(error instanceof CancelledError) || !cleanReply(error.partial.content)) throw error;
      content = cleanReply(error.partial.content);
      reasoning = error.partial.reasoning;
    }
    if (!content) throw new ApiError("The model returned an empty reply.");
    // The prompt was really sent: keep what its macros did to the variables.
    store.saveVars(chatId, prompt.vars);
    store.saveVars("global", prompt.globals);
    return { content, reasoning, profileId: profile.id, model };
  }

  /** Tell everyone watching a reply what's new: the added words, or the whole reply when it changed shape (a `<think>` tag closed). */
  function update(live: Live, next: LiveReply): void {
    const before = live.reply;
    live.reply = next;
    if (next.reasoning.startsWith(before.reasoning) && next.content.startsWith(before.content)) {
      const reasoning = next.reasoning.slice(before.reasoning.length);
      const content = next.content.slice(before.content.length);
      if (reasoning || content) tell(live, { type: "more", reasoning, content });
    } else {
      tell(live, { type: "reply", ...next });
    }
  }

  function tell(live: Live, event: Json): void {
    for (const watcher of live.watchers) watcher(event);
  }

  /**
   * A reply arriving, as server-sent events: "start" (the chat as it is now,
   * and the reply so far), then "more" (words added to the reasoning or the
   * text) or "reply" (the whole reply again), then "done" (the chat with the
   * reply saved, and `error` if it failed). With no reply being written,
   * just "done". Leaving early doesn't stop the reply; Stop does.
   */
  function watch(chatId: string, live: Live | undefined): Response {
    const encoder = new TextEncoder();
    let stopWatching = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: Json) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            stopWatching();
          }
        };
        if (!live) {
          send({ type: "done", ...chatView(chatId) });
          controller.close();
          return;
        }
        // A comment now and then, so nothing between here and the browser gives up on a quiet model.
        const beat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": still here\n\n"));
          } catch {
            stopWatching();
          }
        }, 15000);
        const watcher = (event: Json) => {
          send(event);
          if (event.type === "done") {
            stopWatching();
            try {
              controller.close();
            } catch {
              // already gone
            }
          }
        };
        stopWatching = () => {
          clearInterval(beat);
          live.watchers.delete(watcher);
        };
        live.watchers.add(watcher);
        send({ type: "start", ...chatView(chatId), live: live.reply });
      },
      cancel() {
        stopWatching();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
  }

  /** Send a profile one tiny request: does it answer, and how fast. A failure is a result here, not an error. */
  async function testProfile(id: string): Promise<{ ok: boolean; ms: number | null; message: string }> {
    const profile = store.profile(id);
    if (!profile.model) throw new ValidationError("Choose a model for this profile first.");
    const started = Date.now();
    try {
      await createChatCompletion(api, {
        model: profile.model,
        provider: profile.provider,
        messages: [{ role: "user", content: "Reply with the single word: ready" }],
        temperature: profile.temperature,
        // Enough room for a reasoning model to think a little and still answer.
        maxTokens: Math.min(profile.maxTokens, 400),
        reasoningEffort: profile.reasoningEffort,
        allowEmpty: true,
      });
      return { ok: true, ms: Date.now() - started, message: "" };
    } catch (error) {
      if (error instanceof ApiError) return { ok: false, ms: null, message: error.message };
      throw error;
    }
  }

  /** A chat's prompt as it would be sent now, from its blocks (or from `history` in place of its messages). */
  function buildPrompt(chatId: string, history?: Message[]) {
    const blocks = store.blocks(chatId);
    const cards = new Map(store.cards().map((c) => [c.id, c]));
    return assemblePrompt({ blocks, cards, messages: history ?? store.messages(chatId), vars: store.vars(chatId), globals: store.vars("global") });
  }

  function editView(e: AgentEdit) {
    const path = e.target.startsWith("file:") ? ws.displayFilePath(e.target.slice(5)) : e.path;
    return { ...e, path, diff: compactDiff(diff(e.before ?? "", e.after ?? "")) };
  }

  function sessionView(id: string) {
    return { session: agent.session(id), messages: agent.messages(id), edits: agent.edits({ sessionId: id }).map(editView), busy: agentRunning.has(id) };
  }

  function filesView() {
    return agent.files().map((f) => ({ path: f.path, display: ws.displayFilePath(f.path), size: f.content.length, updatedAt: f.updatedAt }));
  }

  function chatView(chatId: string) {
    return { chat: store.chat(chatId), messages: store.messages(chatId), busy: running.has(chatId) };
  }

  /** A reply's answer to a plain (not streamed) request: the chat once the reply is saved, or with the error. */
  async function settled(chatId: string, live: Live): Promise<Response> {
    const outcome = await live.finished;
    return json({ ...chatView(chatId), ...outcome });
  }

  async function route(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const method = request.method;
    const body = async (): Promise<Json> => {
      try {
        const parsed = (await request.json()) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
        return parsed as Json;
      } catch {
        throw new ValidationError("The request wasn't valid JSON.");
      }
    };
    const m = (pattern: string) => {
      const re = new RegExp(`^${pattern.replace(/:\w+/g, "([^/]+)")}$`);
      return re.exec(path)?.slice(1);
    };
    let p: string[] | undefined;

    if (path === "/api/state" && method === "GET") {
      const pv = providers.views();
      return json({ settings: store.settings(), profiles: store.profiles(), cards: store.cards(), chats: store.chats(), vertexReady: pv.vertex.set, apiKeySet: pv.nanogpt.set, providers: pv, regions: VERTEX_REGIONS, macros: KNOWN_MACROS, photos: store.photos() });
    }

    // Background photos: the image itself as the body, its name, tint and framing in the query.
    if (path === "/api/photos" && method === "POST") {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length > MAX_PHOTO_BYTES) throw new ValidationError("That photo is over 15 MB. Try a smaller one.");
      const ext = imageType(bytes);
      if (!ext) throw new ValidationError("That isn't a JPEG, PNG or WebP image.");
      const q = url.searchParams;
      const photo = store.addPhoto({ name: q.get("name"), ext, tint: q.get("tint"), position: q.get("position") });
      await Bun.write(join(photoDir, `${photo.id}.${ext}`), bytes);
      return json(photo);
    }
    if ((p = m("/api/photos/:id")) && method === "DELETE") {
      const { ext } = store.deletePhoto(p[0]!);
      rmSync(join(photoDir, `${p[0]}.${ext}`), { force: true });
      return json({ ok: true, settings: store.settings() });
    }
    if (path === "/api/settings" && method === "PATCH") return json(store.updateSettings(await body()));

    // Connections
    if (path === "/api/profiles" && method === "POST") return json(store.createProfile(await body()));
    if ((p = m("/api/profiles/:id"))) {
      if (method === "PATCH") return json(store.updateProfile(p[0]!, await body()));
      if (method === "DELETE") return (store.deleteProfile(p[0]!), json({ ok: true }));
    }
    // Providers: the nanoGPT key, Vertex AI's project, region and key file, and a test of each.
    if (path === "/api/providers" && method === "GET") return json(providers.views());
    if ((p = m("/api/providers/:id"))) {
      const id = providerId(p[0]!);
      if (method === "PUT") {
        const b = await body();
        if (id === "nanogpt") providers.setNanogptKey(b.key);
        else providers.setVertex(b);
        return json(providers.views());
      }
      if (method === "DELETE") return (providers.clear(id), json(providers.views()));
    }
    if ((p = m("/api/providers/:id/test")) && method === "POST") {
      const id = providerId(p[0]!);
      const settings = store.settings();
      const using = store.profiles().filter((x) => x.provider === id && x.model);
      // Test with the profile that writes replies or runs the agent if it's on this provider, else any with a model.
      const profile = using.find((x) => x.id === settings.rpProfileId) ?? using.find((x) => x.id === settings.agentProfileId) ?? using[0];
      if (!profile) throw new ValidationError(`No profile uses ${id === "vertex" ? "Vertex AI" : "nanoGPT"} with a model yet, so there's nothing to test it with. Make one, then test again.`);
      const result = await testProfile(profile.id);
      return json({ ...result, providers: providers.views() });
    }
    if ((p = m("/api/profiles/:id/test")) && method === "POST") return json({ ...(await testProfile(p[0]!)), providers: providers.views() });
    if (path === "/api/models" && method === "GET") {
      const provider = (url.searchParams.get("provider") ?? "nanogpt") as ProviderId;
      return json(await listModels(api, provider === "vertex" ? "vertex" : "nanogpt"));
    }

    // Cards
    if (path === "/api/cards" && method === "POST") return json(store.createCard(await body()));
    if (path === "/api/cards/import" && method === "POST") {
      const b = await body();
      if (typeof b.text !== "string") throw new ValidationError("Paste the cards' markdown to import.");
      const parsed = parseCards(b.text);
      if (b.dryRun === true) return json({ cards: parsed });
      return json({ cards: store.importCards(parsed) });
    }
    if ((p = m("/api/cards/:id"))) {
      if (method === "PATCH") return json(store.updateCard(p[0]!, await body()));
      if (method === "DELETE") return (store.deleteCard(p[0]!), json({ ok: true }));
    }

    // Chats
    if (path === "/api/chats" && method === "POST") return json(store.createChat(await body()));
    if ((p = m("/api/chats/:id"))) {
      if (method === "GET") return json(chatView(p[0]!));
      if (method === "PATCH") return json(store.updateChat(p[0]!, await body()));
      if (method === "DELETE") return (store.deleteChat(p[0]!), json({ ok: true }));
    }
    if ((p = m("/api/chats/:id/preview")) && method === "GET") {
      return json(buildPrompt(p[0]!));
    }
    // The prompts page: a chat's blocks.
    if ((p = m("/api/chats/:id/blocks"))) {
      if (method === "GET") return json(store.blocks(p[0]!));
      if (method === "POST") {
        const b = await body();
        // A nudge: a ready-made block (src/nudges.ts).
        if (b.preset !== undefined) {
          const preset = typeof b.preset === "string" ? NUDGES[b.preset] : undefined;
          if (!preset) throw new ValidationError(`There's no nudge called ${String(b.preset)}.`);
          return json(store.createBlock(p[0]!, { ...preset }));
        }
        return json(store.createBlock(p[0]!, b));
      }
      if (method === "PUT") return json(store.orderBlocks(p[0]!, (await body()).ids));
    }
    if ((p = m("/api/blocks/:id"))) {
      if (method === "PATCH") return json(store.updateBlock(p[0]!, await body()));
      if (method === "DELETE") return (store.deleteBlock(p[0]!), json({ ok: true }));
    }
    // Send: save your message (if any), then write the reply. With ?stream=1 the reply
    // arrives as it's written (see `watch`); without, the answer waits for it.
    if ((p = m("/api/chats/:id/send")) && method === "POST") {
      const chatId = p[0]!;
      const b = await body();
      const live = startReply(chatId, { regenerate: false, text: typeof b.content === "string" ? b.content.trim() : "" });
      return url.searchParams.get("stream") === "1" ? watch(chatId, live) : settled(chatId, live);
    }
    // Regenerate: a new version of the last reply, written from everything before it.
    if ((p = m("/api/chats/:id/regenerate")) && method === "POST") {
      const chatId = p[0]!;
      const live = startReply(chatId, { regenerate: true });
      return url.searchParams.get("stream") === "1" ? watch(chatId, live) : settled(chatId, live);
    }
    // Watch the reply being written (after the page was reloaded, or the phone slept).
    if ((p = m("/api/chats/:id/live")) && method === "GET") {
      store.chat(p[0]!);
      return watch(p[0]!, running.get(p[0]!));
    }
    // Rewind: keep the chat up to this message, and let everything after it go.
    if ((p = m("/api/chats/:id/rewind")) && method === "POST") {
      const chatId = p[0]!;
      const b = await body();
      store.chat(chatId);
      if (running.has(chatId)) throw new ValidationError("A reply is still being written. Stop it first, then rewind.");
      const removed = store.rewindChat(chatId, b.messageId);
      return json({ ...chatView(chatId), removed });
    }
    if ((p = m("/api/chats/:id/stop")) && method === "POST") {
      running.get(p[0]!)?.controller.abort();
      return json({ ok: true });
    }

    // The agent: its sessions, messages, tools, files and reversible change log.
    if (path === "/api/agent" && method === "GET") return json({ sessions: agent.sessions(), files: filesView() });
    if (path === "/api/agent/sessions" && method === "POST") return json(agent.createSession(await body()));
    if ((p = m("/api/agent/sessions/:id"))) {
      if (method === "GET") return json(sessionView(p[0]!));
      if (method === "PATCH") return json(agent.updateSession(p[0]!, await body()));
      if (method === "DELETE") return (agent.deleteSession(p[0]!), json({ ok: true }));
    }
    if ((p = m("/api/agent/sessions/:id/send")) && method === "POST") {
      const id = p[0]!;
      const b = await body();
      agent.session(id);
      if (agentRunning.has(id)) throw new ValidationError("The agent is still working on your last message.");
      const controller = new AbortController();
      agentRunning.set(id, controller);
      try {
        await runTurn({ store, agent, ws, api }, { sessionId: id, text: typeof b.content === "string" ? b.content : "", chatId: typeof b.chatId === "string" ? b.chatId : null, signal: controller.signal });
      } catch (error) {
        if (error instanceof ValidationError && !agent.messages(id).length) throw error;
        return json({ ...sessionView(id), busy: false, error: errorMessage(error) });
      } finally {
        agentRunning.delete(id);
      }
      return json(sessionView(id));
    }
    if ((p = m("/api/agent/sessions/:id/stop")) && method === "POST") {
      agentRunning.get(p[0]!)?.abort();
      return json({ ok: true });
    }
    if (path === "/api/agent/edits" && method === "GET") return json(agent.edits({ limit: Number(url.searchParams.get("limit")) || 200 }).map(editView));
    if ((p = m("/api/agent/edits/:id/revert")) && method === "POST") return json(editView(ws.revert(p[0]!, (await body()).force === true)));
    if ((p = m("/api/agent/turns/:id/revert")) && method === "POST") return json(ws.revertTurn(p[0]!, (await body()).force === true).map(editView));
    if (path === "/api/agent/files") {
      if (method === "GET") {
        const filePath = url.searchParams.get("path");
        if (!filePath) return json(filesView());
        const file = agent.file(filePath);
        if (!file) throw new NotFoundError("file");
        return json({ ...file, display: ws.displayFilePath(file.path) });
      }
      if (method === "PUT") {
        const b = await body();
        const file = agent.writeFile(b.path, b.content);
        return json({ ...file, display: ws.displayFilePath(file.path) });
      }
      if (method === "DELETE") return (agent.deleteFile(url.searchParams.get("path") ?? ""), json({ ok: true }));
    }

    // Messages
    if ((p = m("/api/messages/:id"))) {
      if (method === "PATCH") {
        const b = await body();
        if (b.swipeIndex !== undefined) return json(store.showSwipe(p[0]!, b.swipeIndex));
        return json(store.editMessage(p[0]!, b.content));
      }
      if (method === "DELETE") return (store.deleteMessage(p[0]!), json({ ok: true }));
    }

    throw new NotFoundError("page");
  }

  /**
   * The login (src/login.ts, lifted from Amaedori): its page and API, and,
   * once a password is set, "log in first" for everything else. `null` lets
   * the request through. Redirects are relative, so the app also works
   * under a path like yourdomain/rp.
   */
  async function loginGate(request: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    const secure = overHttps(request);
    const redirect = (to: string) => new Response(null, { status: 303, headers: { Location: to } });
    if (path === "/login" && request.method === "GET") {
      if (!login.enabled() || login.check(tokenOf(request))) return redirect("./");
      return new Response(Bun.file(join(config.publicDir, "login.html")), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (path === "/api/login") {
      if (request.method === "GET") return json({ enabled: login.enabled(), loggedIn: login.check(tokenOf(request)) });
      if (request.method === "DELETE") {
        login.logOut(tokenOf(request));
        return new Response(null, { status: 204, headers: { "Set-Cookie": cookieFor(null, secure) } });
      }
      if (request.method === "POST") {
        if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) return json({ error: "Send the password as JSON." }, 415);
        const origin = request.headers.get("origin");
        if (origin && URL.parse(origin)?.host !== (request.headers.get("host") ?? url.host)) return json({ error: "Log in from Anoesia's own page." }, 403);
        let password = "";
        try {
          password = String(((await request.json()) as { password?: unknown }).password ?? "");
        } catch {
          return json({ error: "Send the password as JSON." }, 400);
        }
        const result = await login.logIn(password, addressOf(request), request.headers.get("user-agent") ?? "");
        if (!result.ok) return json({ error: result.error }, result.status);
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json", "Set-Cookie": cookieFor(result.token, secure) } });
      }
    }
    // On a server, no password means nobody gets in, rather than everybody.
    if (config.hosted && !login.enabled()) {
      return new Response("Anoesia has no password yet. On the server, run: bun run set-password", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    if (!login.enabled() || isPublicPath(path) || login.check(tokenOf(request))) return null;
    const page = request.method === "GET" && !path.startsWith("/api/") && (request.headers.get("accept") ?? "").includes("text/html");
    if (page) return redirect("login");
    return json({ error: "Log in first.", login: true }, 401);
  }

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!allowedHost(url.hostname, config)) return new Response("This address isn't allowed. Add it to ALLOWED_HOSTS in .env.", { status: 403 });
    try {
      const gate = await loginGate(request, url);
      if (gate) return gate;
      if (url.pathname.startsWith("/api/")) return await route(request, url);
      const media = /^\/media\/([\w-]+)\.(jpg|png|webp)$/.exec(url.pathname);
      if (media) {
        const file = Bun.file(join(photoDir, `${media[1]}.${media[2]}`));
        if (!(await file.exists())) throw new NotFoundError("photo");
        return new Response(file, { headers: { "Content-Type": PHOTO_TYPES[media[2]!]!, "Cache-Control": "private, max-age=31536000, immutable" } });
      }
      return await staticFile(config.publicDir, url.pathname);
    } catch (error) {
      const status = error instanceof NotFoundError ? 404 : error instanceof ConflictError ? 409 : error instanceof ValidationError ? 400 : error instanceof ApiError ? 502 : 500;
      if (status === 500) console.error(error);
      return json({ error: errorMessage(error) }, status);
    }
  }

  return { fetch, store, agent, close: () => db.close() };
}

/** A reply being written: its stop switch, what it has written so far, who's watching, and how it ended. */
interface Live {
  controller: AbortController;
  reply: LiveReply;
  watchers: Set<(event: Json) => void>;
  finished: Promise<{ error?: string }>;
}

function readEchoModels(file: string): string[] {
  try {
    const list = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(list) ? list.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

function providerId(raw: string): ProviderId {
  if (raw !== "nanogpt" && raw !== "vertex") throw new NotFoundError("provider");
  return raw;
}

function errorMessage(error: unknown): string {
  if (error instanceof CancelledError) return "Stopped.";
  if (error instanceof NotFoundError || error instanceof ConflictError || error instanceof ValidationError || error instanceof ApiError) return error.message;
  return "Something went wrong on the server. The details are in the server's log.";
}

const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

/** A photo's type from its first bytes, not from what the browser says it is. */
function imageType(b: Uint8Array): "jpg" | "png" | "webp" | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "webp";
  return null;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

/**
 * Only localhost, IP addresses and ALLOWED_HOSTS may open the app, so a web
 * page elsewhere can't reach it through a made-up name (DNS rebinding).
 */
function allowedHost(hostname: string, config: Config): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return true;
  return config.allowedHosts.includes(host);
}

async function staticFile(publicDir: string, pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const full = normalize(join(publicDir, rel));
  if (!full.startsWith(publicDir)) throw new NotFoundError("page");
  const file = Bun.file(full);
  if (!(await file.exists())) throw new NotFoundError("page");
  return new Response(file, { headers: { "Cache-Control": "no-cache" } });
}

// Started directly (`bun start`): serve.
if (import.meta.main) {
  const config = loadConfig();
  const app = createApp(config);
  const server = Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch, idleTimeout: 0 });
  console.log(`Anoesia is running at http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${server.port}`);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(config.host);
  if (!loopback && !Bun.file(join(config.dataDir, "login.json")).size) {
    console.warn(`Warning: listening on ${config.host} with no password. Anyone who can reach it can open your chats. Set one with \`bun run set-password\`.`);
  }
  if (!config.apiKey) console.log("No NANOGPT_API_KEY in .env: add a key in Settings → Connections if you haven't.");
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      app.close();
      process.exit(0);
    });
  }
}
