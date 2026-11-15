/**
 * The server end to end, against a stand-in for nanoGPT on this machine:
 * import cards, make a chat with a cast, send, regenerate, switch
 * versions, edit, delete, preview, and the login.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { Login } from "../src/login.ts";
import { createApp, type App } from "../src/server.ts";

let dir: string;
let app: App;
let fake: ReturnType<typeof Bun.serve>;
/** What the stand-in model received, newest last. */
let received: { model: string; messages: { role: string; content: string }[] }[];
let reply: string;

function start(env: Record<string, string> = {}) {
  app = createApp(loadConfig({ DATA_DIR: dir, NANOGPT_API_KEY: "test-key", NANOGPT_BASE_URL: `http://127.0.0.1:${fake.port}/v1`, ...env }));
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await app.fetch(
    new Request(`http://127.0.0.1${path}`, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }),
  );
  const text = await response.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, data, response };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anoesia-"));
  received = [];
  reply = "Ada glances up from the setlist.";
  fake = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as (typeof received)[number];
      received.push(body);
      return Response.json({ model: body.model, choices: [{ message: { content: reply }, finish_reason: "stop" }] });
    },
  });
  start();
});

afterEach(() => {
  app.close();
  fake.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

async function setUp() {
  await call("POST", "/api/profiles", { name: "Test", model: "test/model", temperature: 0.8 });
  const text = readFileSync(join(import.meta.dir, "fixtures", "sample-cards.md"), "utf8");
  const imported = (await call("POST", "/api/cards/import", { text })).data.cards as { id: string; name: string }[];
  const byName = (n: string) => imported.find((c) => c.name.startsWith(n))!.id;
  await call("PATCH", `/api/cards/${byName("Old Town")}`, { isCharacter: false });
  await call("PATCH", `/api/cards/${byName("The Night Market")}`, { isCharacter: false });
  const me = (await call("POST", "/api/cards", { name: "Hana", isPersona: true, fields: [{ key: "description", content: "A new trainee." }] })).data;
  // World first, then the other characters, you, and the lead last.
  const cast = [byName("Old Town"), byName("The Night Market"), byName("Bo"), byName("Cy"), me.id, byName("Ada")];
  const chat = (await call("POST", "/api/chats", { name: "Backstage", cast })).data;
  return { chat, cast, me };
}

describe("a scene", () => {
  test("send, regenerate, switch versions, edit, delete", async () => {
    const { chat } = await setUp();

    const sent = await call("POST", `/api/chats/${chat.id}/send`, { content: "*Hana knocks on the green room door.*" });
    expect(sent.status).toBe(200);
    expect(sent.data.error).toBeUndefined();
    expect(sent.data.messages.map((m: any) => [m.role, m.author, m.content])).toEqual([
      ["user", "user", "*Hana knocks on the green room door.*"],
      ["assistant", "narrator", "Ada glances up from the setlist."],
    ]);

    // What the model got: one system message (main prompt + cards in cast order), then the history.
    const got = received[0]!;
    expect(got.model).toBe("test/model");
    expect(got.messages.map((m) => m.role)).toEqual(["system", "user"]);
    const system = got.messages[0]!.content;
    expect(system).toContain("between Hana and you, the narrator");
    expect(system).toContain("Bo, Cy and Ada Vale");
    const order = ["## Old Town", "## The Night Market", "## Bo", "## Cy", "## Hana (played by the user)", "## Ada Vale"].map((h) => system.indexOf(h));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!))).toBe(true);

    // Regenerate: written from everything before the reply, added as version 2.
    reply = "Ada tugs her sleeve down.";
    const regen = await call("POST", `/api/chats/${chat.id}/regenerate`);
    const last = regen.data.messages.at(-1);
    expect(last.swipes).toEqual(["Ada glances up from the setlist.", "Ada tugs her sleeve down."]);
    expect(last.content).toBe("Ada tugs her sleeve down.");
    expect(received[1]!.messages.at(-1)!.role).toBe("user");

    const back = await call("PATCH", `/api/messages/${last.id}`, { swipeIndex: 0 });
    expect(back.data.content).toBe("Ada glances up from the setlist.");

    const edited = await call("PATCH", `/api/messages/${last.id}`, { content: "Ada waves." });
    expect(edited.data.content).toBe("Ada waves.");
    expect(edited.data.editedAt).not.toBeNull();

    await call("DELETE", `/api/messages/${last.id}`);
    const view = await call("GET", `/api/chats/${chat.id}`);
    expect(view.data.messages).toHaveLength(1);
  });

  test("send with an empty box lets the narrator go on (or begin)", async () => {
    const { chat } = await setUp();
    const sent = await call("POST", `/api/chats/${chat.id}/send`, { content: "" });
    expect(sent.data.messages).toHaveLength(1);
    expect(received[0]!.messages.at(-1)).toEqual({ role: "user", content: "(Begin the scene.)" });
  });

  test("a model error keeps your message and says what went wrong", async () => {
    const { chat } = await setUp();
    fake.reload({ fetch: () => Response.json({ error: { message: "no credit" } }, { status: 402 }) });
    const sent = await call("POST", `/api/chats/${chat.id}/send`, { content: "Hello?" });
    expect(sent.data.messages).toHaveLength(1);
    expect(sent.data.error).toContain("balance is too low");
  });

  test("the preview shows every block with its role", async () => {
    const { chat } = await setUp();
    const preview = (await call("GET", `/api/chats/${chat.id}/preview`)).data;
    expect(preview.blocks.map((b: any) => `${b.label}:${b.role}`)).toEqual([
      "Main prompt:system",
      "Old Town (card):system",
      "The Night Market (card):system",
      "Bo (card):system",
      "Cy (card):system",
      "Hana (persona):system",
      "Ada Vale (card):system",
      "Start (no messages yet):user",
    ]);
    expect(preview.approxTokens).toBeGreaterThan(100);
  });

  test("without a profile, sending says to pick one", async () => {
    const chat = (await call("POST", "/api/chats", { name: "Empty" })).data;
    const sent = await call("POST", `/api/chats/${chat.id}/send`, { content: "Hi" });
    expect(sent.data.error).toContain("connection profile");
  });
});

describe("cards", () => {
  test("custom fields are added, kept and removed; default fields always stay", async () => {
    const card = (await call("POST", "/api/cards", { name: "Rumi" })).data;
    expect(card.fields.map((f: any) => f.key)).toEqual(["description", "advanced", "system"]);
    const withVoice = (await call("PATCH", `/api/cards/${card.id}`, { fields: [{ key: "description", content: "Singer." }, { key: "custom", title: "Voice bank", content: "Dry." }] })).data;
    expect(withVoice.fields.map((f: any) => [f.key, f.title, f.content])).toEqual([
      ["description", "Description", "Singer."],
      ["advanced", "Advanced description", ""],
      ["system", "System prompt", ""],
      ["custom", "Voice bank", "Dry."],
    ]);
    const voiceId = withVoice.fields[3].id;
    const renamed = (await call("PATCH", `/api/cards/${card.id}`, { fields: [{ key: "custom", id: voiceId, title: "Voice", content: "Drier." }] })).data;
    expect(renamed.fields[3]).toMatchObject({ id: voiceId, title: "Voice", content: "Drier." });
    expect(renamed.fields[0].content).toBe("Singer.");
    const removed = (await call("PATCH", `/api/cards/${card.id}`, { fields: [] })).data;
    expect(removed.fields).toHaveLength(3);
  });

  test("deleting a card takes it out of casts", async () => {
    const card = (await call("POST", "/api/cards", { name: "Rumi" })).data;
    const chat = (await call("POST", "/api/chats", { cast: [card.id] })).data;
    await call("DELETE", `/api/cards/${card.id}`);
    expect((await call("GET", `/api/chats/${chat.id}`)).data.chat.cast).toEqual([]);
  });
});

describe("the login", () => {
  test("with a password set, the API wants a login, and a right password gets a cookie", async () => {
    app.close();
    await new Login(dir).setPassword("correct horse battery");
    start();
    expect((await call("GET", "/api/state")).status).toBe(401);
    const page = await call("GET", "/", undefined, { Accept: "text/html" });
    expect(page.status).toBe(303);
    expect(page.response.headers.get("location")).toBe("login");
    expect((await call("POST", "/api/login", { password: "wrong password" })).status).toBe(401);
    const ok = await call("POST", "/api/login", { password: "correct horse battery" });
    const cookie = ok.response.headers.get("set-cookie")!.split(";")[0]!;
    expect(cookie).toStartWith("anoesia_login=");
    expect((await call("GET", "/api/state", undefined, { Cookie: cookie })).status).toBe(200);
  });

  test("hosted with no password: nobody gets in", async () => {
    app.close();
    start({ ANOESIA_HOSTED: "1" });
    expect((await call("GET", "/api/state")).status).toBe(503);
  });

  test("unknown host names are refused", async () => {
    const response = await app.fetch(new Request("http://evil.example/api/state"));
    expect(response.status).toBe(403);
  });
});
