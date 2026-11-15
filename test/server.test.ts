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
      "Old Town: Description",
      "The Night Market: Description",
      "Bo: Description",
      "Bo: Voice bank",
      "Cy: Description",
      "Hana: Description",
      "Ada Vale: Description",
      "Ada Vale: Advanced description",
      "Start (no messages yet):user",
    ].map((l) => (l.includes(":system") || l.includes(":user") ? l : `${l}:system`)));
    expect(preview.approxTokens).toBeGreaterThan(100);
  });

  test("without a profile, sending says to pick one", async () => {
    const chat = (await call("POST", "/api/chats", { name: "Empty" })).data;
    const sent = await call("POST", `/api/chats/${chat.id}/send`, { content: "Hi" });
    expect(sent.data.error).toContain("connection profile");
  });
});

describe("the prompts page", () => {
  test("a new chat's blocks: main prompt, each cast card's fields in cast order, then the history", async () => {
    const { chat } = await setUp();
    const blocks = (await call("GET", `/api/chats/${chat.id}/blocks`)).data;
    expect(blocks[0]).toMatchObject({ kind: "main", title: "Main prompt", role: "system" });
    expect(blocks.at(-1)).toMatchObject({ kind: "history", role: "user" });
    expect(blocks.filter((b: any) => b.kind === "field").length).toBe(3 * 2 + 3 + 1 + 3 + 3 + 3);
  });

  test("editing a linked block edits its source; the main prompt is shared", async () => {
    const { chat, cast } = await setUp();
    const blocks = (await call("GET", `/api/chats/${chat.id}/blocks`)).data;
    const adaDescription = blocks.find((b: any) => b.cardId === cast[5] && b.title === "Description");
    await call("PATCH", `/api/blocks/${adaDescription.id}`, { content: "Ada, edited from the prompts page." });
    const card = (await call("GET", "/api/state")).data.cards.find((c: any) => c.id === cast[5]);
    expect(card.fields[0].content).toBe("Ada, edited from the prompts page.");

    const main = blocks[0];
    await call("PATCH", `/api/blocks/${main.id}`, { content: "Shared main prompt." });
    expect((await call("GET", "/api/state")).data.settings.mainPrompt).toBe("Shared main prompt.");
    const other = (await call("POST", "/api/chats", { name: "Other" })).data;
    expect((await call("GET", `/api/chats/${other.id}/blocks`)).data[0].content).toBe("Shared main prompt.");
  });

  test("own blocks: add, role, depth, switch off, reorder, delete; what's sent follows", async () => {
    const { chat } = await setUp();
    await call("POST", `/api/chats/${chat.id}/send`, { content: "Hi." });
    const note = (await call("POST", `/api/chats/${chat.id}/blocks`, { title: "Pace", content: "(Short, {{user}}.)" })).data;
    await call("PATCH", `/api/blocks/${note.id}`, { role: "user", depth: 0 });
    await call("POST", `/api/chats/${chat.id}/send`, { content: "Again." });
    const sent = received.at(-1)!.messages;
    expect(sent.at(-1)).toEqual({ role: "user", content: "(Short, Hana.)" });
    expect(sent.at(-2)).toEqual({ role: "user", content: "Again." });

    await call("PATCH", `/api/blocks/${note.id}`, { enabled: false });
    const off = (await call("GET", `/api/chats/${chat.id}/preview`)).data;
    expect(off.blocks.some((b: any) => b.label === "Pace")).toBe(false);

    // Move the history to the top: everything else follows it.
    const blocks = (await call("GET", `/api/chats/${chat.id}/blocks`)).data;
    const history = blocks.find((b: any) => b.kind === "history");
    const ids = [history.id, ...blocks.filter((b: any) => b !== history && b.id !== history.id).map((b: any) => b.id)];
    expect((await call("PUT", `/api/chats/${chat.id}/blocks`, { ids })).data[0].kind).toBe("history");
    expect((await call("PUT", `/api/chats/${chat.id}/blocks`, { ids: ids.slice(1) })).status).toBe(400);

    expect((await call("DELETE", `/api/blocks/${history.id}`)).status).toBe(400);
    expect((await call("DELETE", `/api/blocks/${note.id}`)).status).toBe(200);
  });

  test("cast changes: a new card's fields go before the history, a removed card's go, a new field joins its card", async () => {
    const { chat, cast } = await setUp();
    const extra = (await call("POST", "/api/cards", { name: "Bobby", fields: [{ key: "description", content: "The manager." }] })).data;
    await call("PATCH", `/api/chats/${chat.id}`, { cast: [...cast.filter((id) => id !== cast[2]), extra.id] });
    let blocks = (await call("GET", `/api/chats/${chat.id}/blocks`)).data;
    expect(blocks.at(-2)).toMatchObject({ cardId: extra.id, title: "System prompt" });
    expect(blocks.some((b: any) => b.cardId === cast[2])).toBe(false);

    const ada = (await call("GET", "/api/state")).data.cards.find((c: any) => c.id === cast[5]);
    await call("PATCH", `/api/cards/${ada.id}`, { fields: [...ada.fields, { key: "custom", title: "Voice bank", content: "Dry." }] });
    blocks = (await call("GET", `/api/chats/${chat.id}/blocks`)).data;
    const adaBlocks = blocks.map((b: any, i: number) => [b, i]).filter(([b]: any) => b.cardId === ada.id);
    expect(adaBlocks.at(-1)[0].title).toBe("Voice bank");
    // Right after Ada's other fields, not at the end.
    expect(adaBlocks.at(-1)[1]).toBe(adaBlocks.at(-2)[1] + 1);
  });

  test("setvar sticks only when a prompt is really sent, not on preview", async () => {
    const { chat } = await setUp();
    const note = (await call("POST", `/api/chats/${chat.id}/blocks`, { content: "{{incvar::turn}}Turn {{getvar::turn}}." })).data;
    void note;
    await call("GET", `/api/chats/${chat.id}/preview`);
    await call("GET", `/api/chats/${chat.id}/preview`);
    await call("POST", `/api/chats/${chat.id}/send`, { content: "One." });
    await call("POST", `/api/chats/${chat.id}/send`, { content: "Two." });
    expect(received.at(-1)!.messages[0]!.content).toContain("Turn 2.");
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

  test("fields can be reordered, base fields included; a chat's folder follows, a field moved out stays", async () => {
    const card = (await call("POST", "/api/cards", { name: "Rumi", fields: [{ key: "custom", title: "Voice bank", content: "Dry." }] })).data;
    const chat = (await call("POST", "/api/chats", { cast: [card.id] })).data;
    let blocks = (await call("GET", `/api/chats/${chat.id}/blocks`)).data;
    // Move the voice bank out of the folder, after the history.
    const voice = blocks.find((b: any) => b.title === "Voice bank");
    const ids = blocks.map((b: any) => b.id).filter((id: string) => id !== voice.id);
    await call("PUT", `/api/chats/${chat.id}/blocks`, { ids: [...ids, voice.id] });
    const [desc, adv, sys, custom] = card.fields;
    const moved = (await call("PATCH", `/api/cards/${card.id}`, { fields: [sys, desc, custom, adv] })).data;
    expect(moved.fields.map((f: any) => f.key)).toEqual(["system", "description", "custom", "advanced"]);
    blocks = (await call("GET", `/api/chats/${chat.id}/blocks`)).data;
    expect(blocks.map((b: any) => b.title)).toEqual(["Main prompt", "System prompt", "Description", "Advanced description", "Chat history", "Voice bank"]);
  });

  test("a card's colour is a preset or a hex, and a custom colour is remembered", async () => {
    const card = (await call("POST", "/api/cards", { name: "Rumi" })).data;
    expect(card.colour).toBe("violet");
    const custom = (await call("PATCH", `/api/cards/${card.id}`, { colour: "ffb547" })).data;
    expect(custom).toMatchObject({ colour: "#FFB547", customColour: "#FFB547" });
    const back = (await call("PATCH", `/api/cards/${card.id}`, { colour: "pink" })).data;
    expect(back).toMatchObject({ colour: "pink", customColour: "#FFB547" });
    expect((await call("PATCH", `/api/cards/${card.id}`, { colour: "teal" })).status).toBe(400);
  });

  test("deleting a card takes it out of casts", async () => {
    const card = (await call("POST", "/api/cards", { name: "Rumi" })).data;
    const chat = (await call("POST", "/api/chats", { cast: [card.id] })).data;
    await call("DELETE", `/api/cards/${card.id}`);
    expect((await call("GET", `/api/chats/${chat.id}`)).data.chat.cast).toEqual([]);
  });
});

describe("settings", () => {
  test("background settings are checked and kept", async () => {
    const start = (await call("GET", "/api/state")).data.settings.background;
    expect(start).toEqual({ photo: "crossing", finish: "tamenuri", tint: 0.6, dim: 0.3, window: null });
    const changed = (await call("PATCH", "/api/settings", { background: { photo: "downpour", dim: 0.1, window: 0.5 } })).data.background;
    expect(changed).toEqual({ photo: "downpour", finish: "tamenuri", tint: 0.6, dim: 0.1, window: 0.5 });
    expect((await call("PATCH", "/api/settings", { background: { dim: 0.9 } })).status).toBe(400);
    expect((await call("PATCH", "/api/settings", { background: { photo: "moon" } })).status).toBe(400);
    expect((await call("PATCH", "/api/settings", { background: { window: null } })).data.background.window).toBeNull();
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
