/**
 * The web server: the app's files from `public/`, and a small JSON API
 * under `/api/`. Start it with `bun start`.
 */

import { mkdirSync } from "node:fs";
import { join, normalize } from "node:path";
import { parseCards } from "./cards.ts";
import { loadConfig, type Config } from "./config.ts";
import { openDatabase } from "./db.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import { addressOf, cookieFor, isPublicPath, Login, overHttps, tokenOf } from "./login.ts";
import { ApiError, CancelledError, createChatCompletion, listModels, type ApiOptions } from "./nanogpt.ts";
import { KNOWN_MACROS } from "./macros.ts";
import { assemblePrompt, cleanReply } from "./prompt.ts";
import { Store } from "./store.ts";
import type { Message, ProviderId } from "./types.ts";

export interface App {
  fetch: (request: Request) => Promise<Response>;
  store: Store;
  close: () => void;
}

type Json = Record<string, unknown>;

export function createApp(config: Config): App {
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDatabase(join(config.dataDir, "anoesia.db"));
  const store = new Store(db);
  const login = new Login(config.dataDir);
  const api: ApiOptions = { apiKey: config.apiKey, baseUrl: config.apiBaseUrl, timeoutMs: config.requestTimeoutMs, vertex: config.vertex };
  /** The reply being written in each chat, so Stop can end it and a second one can't start. */
  const running = new Map<string, AbortController>();

  /** Ask the RP profile for the next reply in a chat, from `history` (default: its messages as they are now). */
  async function generate(chatId: string, history?: Message[]): Promise<{ content: string; profileId: string; model: string }> {
    const settings = store.settings();
    if (!settings.rpProfileId) throw new ValidationError("Pick a connection profile first (Settings → Connections).");
    const profile = store.profile(settings.rpProfileId);
    if (!profile.model) throw new ValidationError(`The profile "${profile.name}" has no model yet.`);
    if (running.has(chatId)) throw new ValidationError("A reply is already being written in this chat.");
    const prompt = buildPrompt(chatId, history);
    const controller = new AbortController();
    running.set(chatId, controller);
    try {
      const result = await createChatCompletion(api, {
        model: profile.model,
        provider: profile.provider,
        messages: prompt.messages,
        temperature: profile.temperature,
        maxTokens: profile.maxTokens,
        topP: profile.topP,
        minP: profile.minP,
        reasoningEffort: profile.reasoningEffort,
        extraParams: profile.extraParams ? (JSON.parse(profile.extraParams) as Json) : undefined,
        signal: controller.signal,
      });
      const content = cleanReply(result.content);
      if (!content) throw new ApiError("The model returned an empty reply.");
      // The prompt was really sent: keep what its macros did to the variables.
      store.saveVars(chatId, prompt.vars);
      store.saveVars("global", prompt.globals);
      return { content, profileId: profile.id, model: result.model };
    } finally {
      running.delete(chatId);
    }
  }

  /** A chat's prompt as it would be sent now, from its blocks (or from `history` in place of its messages). */
  function buildPrompt(chatId: string, history?: Message[]) {
    const blocks = store.blocks(chatId);
    const cards = new Map(store.cards().map((c) => [c.id, c]));
    return assemblePrompt({ blocks, cards, messages: history ?? store.messages(chatId), vars: store.vars(chatId), globals: store.vars("global") });
  }

  function chatView(chatId: string) {
    return { chat: store.chat(chatId), messages: store.messages(chatId), busy: running.has(chatId) };
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
      return json({ settings: store.settings(), profiles: store.profiles(), cards: store.cards(), chats: store.chats(), vertexReady: Boolean(config.vertex.keyFile), apiKeySet: Boolean(config.apiKey), macros: KNOWN_MACROS });
    }
    if (path === "/api/settings" && method === "PATCH") return json(store.updateSettings(await body()));

    // Connections
    if (path === "/api/profiles" && method === "POST") return json(store.createProfile(await body()));
    if ((p = m("/api/profiles/:id"))) {
      if (method === "PATCH") return json(store.updateProfile(p[0]!, await body()));
      if (method === "DELETE") return (store.deleteProfile(p[0]!), json({ ok: true }));
    }
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
      if (method === "POST") return json(store.createBlock(p[0]!, await body()));
      if (method === "PUT") return json(store.orderBlocks(p[0]!, (await body()).ids));
    }
    if ((p = m("/api/blocks/:id"))) {
      if (method === "PATCH") return json(store.updateBlock(p[0]!, await body()));
      if (method === "DELETE") return (store.deleteBlock(p[0]!), json({ ok: true }));
    }
    // Send: save your message (if any), then write the reply.
    if ((p = m("/api/chats/:id/send")) && method === "POST") {
      const chatId = p[0]!;
      const b = await body();
      const text = typeof b.content === "string" ? b.content.trim() : "";
      store.chat(chatId);
      if (running.has(chatId)) throw new ValidationError("A reply is already being written in this chat.");
      if (text) store.addMessage({ chatId, role: "user", author: "user", content: text });
      try {
        const reply = await generate(chatId);
        store.addMessage({ chatId, role: "assistant", author: "narrator", ...reply });
      } catch (error) {
        return json({ ...chatView(chatId), error: errorMessage(error) });
      }
      return json(chatView(chatId));
    }
    // Regenerate: a new version of the last reply, written from everything before it.
    if ((p = m("/api/chats/:id/regenerate")) && method === "POST") {
      const chatId = p[0]!;
      const messages = store.messages(chatId);
      const last = messages.at(-1);
      if (!last || last.role !== "assistant") throw new ValidationError("There's no reply at the end of the chat to regenerate.");
      // Generate from everything before the last reply, then add the result to it as a new version.
      try {
        const reply = await generate(chatId, messages.slice(0, -1));
        store.addSwipe(last.id, reply.content, reply.profileId, reply.model);
      } catch (error) {
        return json({ ...chatView(chatId), error: errorMessage(error) });
      }
      return json(chatView(chatId));
    }
    if ((p = m("/api/chats/:id/stop")) && method === "POST") {
      running.get(p[0]!)?.abort();
      return json({ ok: true });
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
      return await staticFile(config.publicDir, url.pathname);
    } catch (error) {
      const status = error instanceof NotFoundError ? 404 : error instanceof ValidationError ? 400 : error instanceof ApiError ? 502 : 500;
      if (status === 500) console.error(error);
      return json({ error: errorMessage(error) }, status);
    }
  }

  return { fetch, store, close: () => db.close() };
}

function errorMessage(error: unknown): string {
  if (error instanceof CancelledError) return "Stopped.";
  if (error instanceof NotFoundError || error instanceof ValidationError || error instanceof ApiError) return error.message;
  return "Something went wrong on the server. The details are in the server's log.";
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
  if (!config.apiKey) console.log("No NANOGPT_API_KEY in .env yet: replies need it (or a Vertex AI profile).");
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      app.close();
      process.exit(0);
    });
  }
}
