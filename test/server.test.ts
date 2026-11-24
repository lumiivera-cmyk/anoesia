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
      // A key saved as "bad" is refused, like a revoked one.
      if (request.headers.get("authorization") === "Bearer bad") return Response.json({ error: { message: "Invalid API key" } }, { status: 401 });
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

  test("rewind keeps the chat up to a message and lets the rest go", async () => {
    const { chat } = await setUp();
    await call("POST", `/api/chats/${chat.id}/send`, { content: "One." });
    await call("POST", `/api/chats/${chat.id}/send`, { content: "Two." });
    const all = (await call("GET", `/api/chats/${chat.id}`)).data.messages;
    expect(all).toHaveLength(4);
    const rewound = await call("POST", `/api/chats/${chat.id}/rewind`, { messageId: all[1].id });
    expect(rewound.status).toBe(200);
    expect(rewound.data.removed).toBe(2);
    expect(rewound.data.storyRestored).toBe(true);
    expect(rewound.data.messages.map((m: any) => m.id)).toEqual([all[0].id, all[1].id]);
    // Sending again carries on from there.
    const next = await call("POST", `/api/chats/${chat.id}/send`, { content: "Three." });
    expect(next.data.messages).toHaveLength(4);
    // A message from another chat, or none at all, is refused.
    const other = (await call("POST", "/api/chats", { name: "Other" })).data;
    expect((await call("POST", `/api/chats/${other.id}/rewind`, { messageId: all[0].id })).status).toBe(404);
    expect((await call("POST", `/api/chats/${chat.id}/rewind`, {})).status).toBe(400);
  });

  test("branch copies the story up to a message, with its cast, notes and blocks", async () => {
    const { chat, cast } = await setUp();
    await call("PATCH", `/api/chats/${chat.id}`, { offstage: [cast[2]] });
    const blocks = (await call("GET", `/api/chats/${chat.id}/blocks`)).data;
    const note = blocks.find((b: any) => b.title === "Right now");
    await call("PATCH", `/api/blocks/${note.id}`, { content: "The green room." });
    const own = (await call("POST", `/api/chats/${chat.id}/blocks`, { title: "Tone", content: "Quiet." })).data;
    await call("PATCH", `/api/blocks/${own.id}`, { enabled: false });
    await call("PUT", "/api/agent/files", { path: `chats/${chat.id}/notebook.md`, content: "Ada hides the wrist." });
    await call("POST", `/api/chats/${chat.id}/send`, { content: "One." });
    await call("POST", `/api/chats/${chat.id}/regenerate`);
    await call("POST", `/api/chats/${chat.id}/send`, { content: "Two." });
    const all = (await call("GET", `/api/chats/${chat.id}`)).data.messages;

    const branched = await call("POST", `/api/chats/${chat.id}/branch`, { messageId: all[1].id });
    expect(branched.status).toBe(200);
    const b = branched.data;
    expect(b.chat.id).not.toBe(chat.id);
    expect(b.chat.name).toBe("Backstage · branch");
    expect(b.chat.cast).toEqual(cast);
    expect(b.chat.offstage).toEqual([cast[2]]);
    expect(b.messages.map((m: any) => m.content)).toEqual(["One.", all[1].content]);
    expect(b.messages[1].swipes).toHaveLength(2);
    const copied = (await call("GET", `/api/chats/${b.chat.id}/blocks`)).data;
    expect(copied.map((x: any) => [x.kind, x.title, x.content, x.enabled])).toEqual(
      (await call("GET", `/api/chats/${chat.id}/blocks`)).data.map((x: any) => [x.kind, x.title, x.content, x.enabled]),
    );
    expect((await call("GET", `/api/agent/files?path=${encodeURIComponent(`chats/${b.chat.id}/notebook.md`)}`)).data.content).toBe("Ada hides the wrist.");

    // Each goes its own way: the branch's notes and messages are its own.
    await call("PATCH", `/api/blocks/${copied.find((x: any) => x.title === "Right now").id}`, { content: "The alley." });
    await call("POST", `/api/chats/${b.chat.id}/send`, { content: "Elsewhere." });
    expect((await call("GET", `/api/chats/${chat.id}/blocks`)).data.find((x: any) => x.title === "Right now").content).toBe("The green room.");
    expect((await call("GET", `/api/chats/${chat.id}`)).data.messages).toHaveLength(4);

    // A second branch gets the next name; a message from another chat is refused.
    expect((await call("POST", `/api/chats/${chat.id}/branch`, { messageId: all[0].id })).data.chat.name).toBe("Backstage · branch 2");
    expect((await call("POST", `/api/chats/${b.chat.id}/branch`, { messageId: all[0].id })).status).toBe(404);
  });

  test("rewind and branch take the notes and cast switches back to how they stood at that message", async () => {
    const { chat, cast } = await setUp();
    const note = async (id: string) => (await call("GET", `/api/chats/${id}/blocks`)).data.find((b: any) => b.title === "Right now");
    const setNote = async (id: string, content: string) => call("PATCH", `/api/blocks/${(await note(id)).id}`, { content });
    await setNote(chat.id, "The green room.");
    await call("POST", `/api/chats/${chat.id}/send`, { content: "One." }); // 1, 2
    await setNote(chat.id, "The green room, after the setlist.");
    await call("POST", `/api/chats/${chat.id}/send`, { content: "Two." }); // 3, 4
    await setNote(chat.id, "The alley.");
    await call("PATCH", `/api/chats/${chat.id}`, { offstage: [cast[5]] });
    const all = (await call("GET", `/api/chats/${chat.id}`)).data.messages;
    expect(all.map((m: any) => m.storySaved)).toEqual([true, true, true, false]);

    // Branch from reply 2: the notes as they stood then, everyone onstage.
    const b = (await call("POST", `/api/chats/${chat.id}/branch`, { messageId: all[1].id })).data;
    expect((await note(b.chat.id)).content).toBe("The green room, after the setlist.");
    expect(b.chat.offstage).toEqual([]);
    expect(b.messages.at(-1).storySaved).toBe(false);

    // Rewind to reply 2: the same, in place.
    const r = (await call("POST", `/api/chats/${chat.id}/rewind`, { messageId: all[1].id })).data;
    expect(r.storyRestored).toBe(true);
    expect(r.chat.offstage).toEqual([]);
    expect((await note(chat.id)).content).toBe("The green room, after the setlist.");
    expect(r.messages.at(-1).storySaved).toBe(false);

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
    // Just before the history, ahead of the chat's notes.
    expect(blocks.slice(-4).map((b: any) => b.title)).toEqual(["System prompt", "Right now", "Who knows what", "Chat history"]);
    expect(blocks.at(-4)).toMatchObject({ cardId: extra.id });
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

describe("cast presence", () => {
  test("offstage: only the Description goes in, {{cast}} skips them, and the blocks say so", async () => {
    const { chat, cast } = await setUp();
    const [, , bo, cy, , ada] = cast;
    const changed = (await call("PATCH", `/api/chats/${chat.id}`, { offstage: [bo, cy] })).data;
    expect(changed.offstage).toEqual([bo, cy]);
    const preview = (await call("GET", `/api/chats/${chat.id}/preview`)).data;
    const labels = preview.blocks.map((b: any) => b.label);
    // Ada (onstage) keeps her whole card; Bo and Cy send their Description only.
    expect(labels).toContain("Ada Vale: Advanced description");
    expect(labels).toContain("Bo: Description");
    expect(labels).not.toContain("Bo: Voice bank");
    expect(labels).toContain("Cy: Description");
    expect(preview.blocks[0].content).toContain("everyone in it: Ada Vale.");
    const blocks = (await call("GET", `/api/chats/${chat.id}/blocks`)).data;
    expect(blocks.filter((b: any) => b.offstage).map((b: any) => b.cardId)).toEqual(expect.arrayContaining([bo, cy]));
    expect(blocks.some((b: any) => b.cardId === ada && b.offstage)).toBe(false);

    // Reordering the cast keeps who's offstage; leaving the cast forgets it.
    const reordered = (await call("PATCH", `/api/chats/${chat.id}`, { cast: [...cast].reverse() })).data;
    expect(reordered.offstage.sort()).toEqual([bo, cy].sort());
    const fewer = (await call("PATCH", `/api/chats/${chat.id}`, { cast: cast.filter((id) => id !== bo) })).data;
    expect(fewer.offstage).toEqual([cy]);
    const back = (await call("PATCH", `/api/chats/${chat.id}`, { cast })).data;
    expect(back.offstage).toEqual([cy]);
    expect((await call("PATCH", `/api/chats/${chat.id}`, { offstage: ["not-in-cast"] })).status).toBe(400);
  });
});

describe("chat notes", () => {
  test("a new chat has both notes, empty and left out of the preview; filled, one is sent", async () => {
    const { chat } = await setUp();
    const blocks = (await call("GET", `/api/chats/${chat.id}/blocks`)).data;
    const notes = blocks.filter((b: any) => b.kind === "note");
    expect(notes.map((b: any) => [b.title, b.content, b.role])).toEqual([
      ["Right now", "", "system"],
      ["Who knows what", "", "system"],
    ]);
    expect(blocks.at(-2).title).toBe("Who knows what");
    let preview = (await call("GET", `/api/chats/${chat.id}/preview`)).data;
    expect(preview.blocks.some((b: any) => b.label === "Right now" || b.label === "Who knows what")).toBe(false);

    await call("PATCH", `/api/blocks/${notes[0].id}`, { content: "Backstage after the show. {{user}} has the setlist." });
    preview = (await call("GET", `/api/chats/${chat.id}/preview`)).data;
    expect(preview.blocks.find((b: any) => b.label === "Right now").content).toBe("## Right now\n\nBackstage after the show. Hana has the setlist.");
    expect(preview.blocks.some((b: any) => b.label === "Who knows what")).toBe(false);

    expect((await call("DELETE", `/api/blocks/${notes[0].id}`)).status).toBe(400);
    expect((await call("PATCH", `/api/blocks/${notes[0].id}`, { title: "Mine" })).status).toBe(400);
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
    expect(blocks.map((b: any) => b.title)).toEqual(["Main prompt", "System prompt", "Description", "Advanced description", "Right now", "Who knows what", "Chat history", "Voice bank"]);
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
    expect(start).toEqual({ photo: "none", finish: "tamenuri", tint: 0.6, dim: 0.3, window: null });
    const changed = (await call("PATCH", "/api/settings", { background: { finish: "roiro", dim: 0.1, window: 0.5 } })).data.background;
    expect(changed).toEqual({ photo: "none", finish: "roiro", tint: 0.6, dim: 0.1, window: 0.5 });
    // selenite is retired: a material from an old page is ignored
    expect((await call("PATCH", "/api/settings", { background: { material: "selenite" } })).data.background).toEqual(changed);
    expect((await call("PATCH", "/api/settings", { background: { dim: 0.9 } })).status).toBe(400);
    expect((await call("PATCH", "/api/settings", { background: { photo: "moon" } })).status).toBe(404);
    expect((await call("PATCH", "/api/settings", { background: { window: null } })).data.background.window).toBeNull();
  });

  test("a background saved in selenite comes back as lacquer", async () => {
    const save = (bg: unknown) => app.store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('background', ?)", [JSON.stringify(bg)]);
    save({ material: "selenite", photo: "none", finish: "shunkei", tint: 0.6, dim: 0.35, window: null });
    expect((await call("GET", "/api/state")).data.settings.background).toEqual({ photo: "none", finish: "shunkei", tint: 0.6, dim: 0.3, window: null });
    // a dim picked by hand is kept
    save({ material: "selenite", photo: "none", finish: "tamenuri", tint: 0.6, dim: 0.5, window: null });
    expect((await call("GET", "/api/state")).data.settings.background.dim).toBe(0.5);
  });

  test("photos are uploaded, shown, picked and deleted", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const upload = (bytes: Uint8Array, query = "") => app.fetch(new Request(`http://127.0.0.1/api/photos${query}`, { method: "POST", body: bytes }));
    const added = (await (await upload(jpeg, "?name=Rain&tint=%23111a26&position=40%25%2050%25")).json()) as { id: string; url: string };
    expect(added).toMatchObject({ name: "Rain", tint: "#111A26", position: "40% 50%", url: `media/${added.id}.jpg` });
    expect((await upload(new TextEncoder().encode("<svg onload=alert(1)>"))).status).toBe(400);
    const image = await app.fetch(new Request(`http://127.0.0.1/${added.url}`));
    expect(image.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(jpeg);
    expect((await call("GET", "/api/state")).data.photos.map((p: { id: string }) => p.id)).toEqual([added.id]);
    expect((await call("PATCH", "/api/settings", { background: { photo: added.id } })).data.background.photo).toBe(added.id);
    // Deleting the photo on show puts the background back to none, and the file goes.
    expect((await call("DELETE", `/api/photos/${added.id}`)).data.settings.background.photo).toBe("none");
    expect((await app.fetch(new Request(`http://127.0.0.1/${added.url}`))).status).toBe(404);
  });

  test("the Enter key setting is kept", async () => {
    expect((await call("GET", "/api/state")).data.settings.enterSends).toBe(true);
    expect((await call("PATCH", "/api/settings", { enterSends: false })).data.enterSends).toBe(false);
    expect((await call("PATCH", "/api/settings", { enterSends: "yes" })).status).toBe(400);
  });
});

describe("connections", () => {
  test("a nanoGPT key saved in settings wins over .env, is kept, and is never sent back", async () => {
    let providers = (await call("GET", "/api/state")).data.providers;
    expect(providers.nanogpt).toMatchObject({ set: true, source: "env", last4: "-key", health: null });
    const saved = (await call("PUT", "/api/providers/nanogpt", { key: "  sk-new-secret-1234 " })).data;
    expect(saved.nanogpt).toMatchObject({ set: true, source: "app", last4: "1234" });
    expect(JSON.stringify(saved)).not.toContain("secret");
    expect((await call("PUT", "/api/providers/nanogpt", { key: "has spaces in it" })).status).toBe(400);
    // It's what requests use now, and it outlives a restart.
    app.close();
    start();
    providers = (await call("GET", "/api/providers")).data;
    expect(providers.nanogpt).toMatchObject({ source: "app", last4: "1234" });
    expect(readFileSync(join(dir, "providers.json"), "utf8")).toContain("sk-new-secret-1234");
    // Forgetting it goes back to .env's.
    expect((await call("DELETE", "/api/providers/nanogpt")).data.nanogpt).toMatchObject({ source: "env", last4: "-key" });
  });

  test("a rejected key shows as failing on the provider, until a reply gets through", async () => {
    await setUp();
    await call("PUT", "/api/providers/nanogpt", { key: "bad" });
    const test1 = (await call("POST", "/api/providers/nanogpt/test", {})).data;
    expect(test1).toMatchObject({ ok: false });
    expect(test1.providers.nanogpt.health).toMatchObject({ ok: false, status: 401, failures: 1 });
    const test2 = (await call("POST", "/api/providers/nanogpt/test", {})).data;
    expect(test2.providers.nanogpt.health.failures).toBe(2);
    await call("PUT", "/api/providers/nanogpt", { key: "good-key" });
    const profile = (await call("GET", "/api/state")).data.profiles[0];
    const ok = (await call("POST", `/api/profiles/${profile.id}/test`, {})).data;
    expect(ok).toMatchObject({ ok: true });
    expect(ok.providers.nanogpt.health).toMatchObject({ ok: true, failures: 0 });
  });

  test("testing needs a model, and a provider test needs a profile on it", async () => {
    const empty = (await call("POST", "/api/profiles", { name: "Empty" })).data;
    expect((await call("POST", `/api/profiles/${empty.id}/test`, {})).status).toBe(400);
    expect((await call("POST", "/api/providers/nanogpt/test", {})).status).toBe(400);
    expect((await call("POST", "/api/providers/claude/test", {})).status).toBe(404);
  });

  test("Vertex AI is set up from settings: project, region and a checked key file", async () => {
    expect((await call("PUT", "/api/providers/vertex", { project: "Not A Project!" })).status).toBe(400);
    expect((await call("PUT", "/api/providers/vertex", { location: "the-moon" })).status).toBe(400);
    expect((await call("PUT", "/api/providers/vertex", { keyJson: '{"hello": 1}' })).status).toBe(400);
    const key = JSON.stringify({ type: "service_account", client_email: "rp@my-project-123.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n" });
    const v = (await call("PUT", "/api/providers/vertex", { project: "my-project-123", location: "us-central1", keyJson: key, keyName: "rp-key.json" })).data.vertex;
    expect(v).toMatchObject({ set: true, source: "app", project: "my-project-123", location: "us-central1", keyName: "rp-key.json", account: "rp@my-project-123.iam.gserviceaccount.com" });
    expect(JSON.stringify(v)).not.toContain("PRIVATE");
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

test("nudges: adding one makes a block right after your post, as you", async () => {
  const { chat } = await setUp();
  const pace = (await call("POST", `/api/chats/${chat.id}/blocks`, { preset: "pace" })).data;
  expect(pace).toMatchObject({ title: "Match my pace", role: "user", depth: 0, content: "{{paceNote}}" });
  expect((await call("POST", `/api/chats/${chat.id}/blocks`, { preset: "nope" })).status).toBe(400);
  await call("POST", `/api/chats/${chat.id}/send`, { content: "Hi Ada. Long day?" });
  const sent = received.at(-1)!.messages;
  expect(sent.at(-1)!.content).toContain("My post was about 4 words, in one paragraph");
});

test("nudges: the mark stays through a rename, a new role or depth, and a branch", async () => {
  const { chat } = await setUp();
  const pace = (await call("POST", `/api/chats/${chat.id}/blocks`, { preset: "pace" })).data;
  expect(pace.nudge).toBe(true);
  const own = (await call("POST", `/api/chats/${chat.id}/blocks`, { title: "Nudge", content: "(Be brief.)", role: "user", depth: 0, nudge: true })).data;
  const plain = (await call("POST", `/api/chats/${chat.id}/blocks`, { title: "Plain", content: "x" })).data;
  expect(plain.nudge).toBe(false);
  const moved = (await call("PATCH", `/api/blocks/${own.id}`, { title: "Brevity", role: "system", depth: 3 })).data;
  expect(moved).toMatchObject({ title: "Brevity", nudge: true });
  expect((await call("PATCH", `/api/blocks/${plain.id}`, { nudge: true })).data.nudge).toBe(true);
  expect((await call("PATCH", `/api/blocks/${plain.id}`, { nudge: "yes" })).status).toBe(400);
  const history = (await call("GET", `/api/chats/${chat.id}/blocks`)).data.find((b: { kind: string }) => b.kind === "history");
  expect((await call("PATCH", `/api/blocks/${history.id}`, { nudge: true })).status).toBe(400);
  const titles = (await call("GET", `/api/chats/${chat.id}/blocks`)).data.filter((b: { nudge: boolean }) => b.nudge).map((b: { title: string }) => b.title);
  expect(titles.sort()).toEqual(["Brevity", "Match my pace", "Plain"]);
});

describe("streaming a reply", () => {
  /** A stand-in model that streams `chunks` (each a delta, or an error object), waiting `gapMs` between them. */
  function streams(chunks: Record<string, unknown>[], gapMs = 0) {
    fake.reload({
      async fetch(request) {
        const body = (await request.json()) as (typeof received)[number] & { stream?: boolean };
        received.push(body);
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            async start(controller) {
              try {
                for (const c of chunks) {
                  if (gapMs) await Bun.sleep(gapMs);
                  const event = "error" in c ? c : { model: "test/model-v2", choices: [{ delta: c, finish_reason: null }] };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                }
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              } catch {
                // the app hung up (Stop)
              }
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
  }

  /** Read a stream of the app's events to the end. */
  async function events(response: Response) {
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    return text
      .split("\n\n")
      .filter((block) => block.startsWith("data: "))
      .map((block) => JSON.parse(block.slice(6)));
  }

  test("reasoning and text arrive as they're written, and the reply keeps its reasoning", async () => {
    const { chat } = await setUp();
    streams([{ reasoning: "She is tired; " }, { reasoning: "keep it short." }, { content: "Ada " }, { content: "looks up." }]);
    const response = await app.fetch(
      new Request(`http://127.0.0.1/api/chats/${chat.id}/send?stream=1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "Hi." }) }),
    );
    const all = await events(response);
    expect(received.at(-1)).toMatchObject({ stream: true });
    expect(all[0]).toMatchObject({ type: "start", busy: true, live: { reasoning: "", content: "" } });
    expect(all[0].messages.at(-1)).toMatchObject({ role: "user", content: "Hi." });
    const more = all.filter((e) => e.type === "more");
    expect(more.map((e) => e.reasoning).join("")).toBe("She is tired; keep it short.");
    expect(more.map((e) => e.content).join("")).toBe("Ada looks up.");
    const done = all.at(-1);
    expect(done).toMatchObject({ type: "done", busy: false });
    expect(done.error).toBeUndefined();
    expect(done.messages.at(-1)).toMatchObject({ role: "assistant", content: "Ada looks up.", reasoning: "She is tired; keep it short.", model: "test/model-v2" });
    // A new version keeps its own reasoning; the first version keeps the first's.
    streams([{ content: "<think>Try again.</think>Ada nods." }]);
    const regen = await events(await app.fetch(new Request(`http://127.0.0.1/api/chats/${chat.id}/regenerate?stream=1`, { method: "POST" })));
    const last = regen.at(-1).messages.at(-1);
    expect(last).toMatchObject({ content: "Ada nods.", reasoning: "Try again.", swipeIndex: 1 });
    const first = (await call("PATCH", `/api/messages/${last.id}`, { swipeIndex: 0 })).data;
    expect(first).toMatchObject({ content: "Ada looks up.", reasoning: "She is tired; keep it short." });
  });

  test("a reasoning field that only repeats the reply isn't kept as reasoning", async () => {
    const { chat } = await setUp();
    streams([{ reasoning: "Ada looks up.", content: "Ada looks up." }]);
    const done = (await events(await app.fetch(new Request(`http://127.0.0.1/api/chats/${chat.id}/send?stream=1`, { method: "POST", body: "{}" })))).at(-1);
    expect(done.messages.at(-1)).toMatchObject({ content: "Ada looks up.", reasoning: "" });
  });

  test("a model that sends its reply as reasoning first: after the first time, it streams as text", async () => {
    const { chat } = await setUp();
    // Like DeepSeek V3.1 Terminus on nanoGPT: the reply word by word as "reasoning", then all of it as text.
    const echo = [{ reasoning: "Ada " }, { reasoning: "looks up." }, { content: "Ada looks up." }];
    streams(echo);
    const send = async () => events(await app.fetch(new Request(`http://127.0.0.1/api/chats/${chat.id}/send?stream=1`, { method: "POST", body: "{}" })));
    const first = await send();
    expect(first.at(-1).messages.at(-1)).toMatchObject({ content: "Ada looks up.", reasoning: "" });
    const second = await send();
    const more = second.filter((e) => e.type === "more");
    expect(more.map((e) => e.reasoning).join("")).toBe("");
    expect(more.map((e) => e.content).join("")).toBe("Ada looks up.");
    expect(second.at(-1).messages.at(-1)).toMatchObject({ content: "Ada looks up.", reasoning: "" });
    expect(JSON.parse(readFileSync(join(dir, "reasoning-echoes.json"), "utf8"))).toEqual(["nanogpt:test/model"]);
    // It thinks for real after all: off the list, and its reasoning is kept.
    streams([{ reasoning: "Be brief." }, { content: "Ada nods." }]);
    expect((await send()).at(-1).messages.at(-1)).toMatchObject({ content: "Ada nods.", reasoning: "Be brief." });
    expect(JSON.parse(readFileSync(join(dir, "reasoning-echoes.json"), "utf8"))).toEqual([]);
  });

  test("<think> tags split live: reasoning first, then the text", async () => {
    const { chat } = await setUp();
    streams([{ content: "<thi" }, { content: "nk>Plan" }, { content: " it.</th" }, { content: "ink>Hello" }]);
    const all = await events(await app.fetch(new Request(`http://127.0.0.1/api/chats/${chat.id}/send?stream=1`, { method: "POST", body: "{}" })));
    // The text never shows a tag, even half of one.
    for (const e of all.filter((x) => x.type === "more" || x.type === "reply")) expect(e.content ?? "").not.toContain("<");
    expect(all.at(-1).messages.at(-1)).toMatchObject({ content: "Hello", reasoning: "Plan it." });
  });

  test("Stop keeps the words that had arrived", async () => {
    const { chat } = await setUp();
    streams([{ content: "Ada starts " }, { content: "to answer" }, { content: " and goes on" }, { content: " and on." }], 60);
    const response = await app.fetch(new Request(`http://127.0.0.1/api/chats/${chat.id}/send?stream=1`, { method: "POST", body: "{}" }));
    setTimeout(() => void call("POST", `/api/chats/${chat.id}/stop`), 150);
    const all = await events(response);
    const done = all.at(-1);
    // Kept like a reply that ended there: no error to show.
    expect(done.error).toBeUndefined();
    expect(done.messages.at(-1)).toMatchObject({ role: "assistant", content: "Ada starts to answer" });
  });

  test("Stop before any words saves nothing", async () => {
    const { chat } = await setUp();
    streams([{ reasoning: "Hm." }, { content: "Late." }], 200);
    const response = await app.fetch(new Request(`http://127.0.0.1/api/chats/${chat.id}/send?stream=1`, { method: "POST", body: JSON.stringify({ content: "Hi." }) }));
    setTimeout(() => void call("POST", `/api/chats/${chat.id}/stop`), 50);
    const done = (await events(response)).at(-1);
    expect(done.error).toBe("Stopped.");
    expect(done.messages.at(-1)).toMatchObject({ role: "user", content: "Hi." });
  });

  test("an error partway: the reply isn't saved, and the error says what happened", async () => {
    const { chat } = await setUp();
    streams([{ content: "Ada be" }, { error: { message: "overloaded" } }]);
    const done = (await events(await app.fetch(new Request(`http://127.0.0.1/api/chats/${chat.id}/send?stream=1`, { method: "POST", body: JSON.stringify({ content: "Hi." }) })))).at(-1);
    expect(done.error).toContain("overloaded");
    expect(done.messages.at(-1)).toMatchObject({ role: "user" });
    // and a second reply can start
    streams([{ content: "Ada smiles." }]);
    const again = (await events(await app.fetch(new Request(`http://127.0.0.1/api/chats/${chat.id}/send?stream=1`, { method: "POST", body: "{}" })))).at(-1);
    expect(again.messages.at(-1)).toMatchObject({ content: "Ada smiles." });
  });

  test("watching later: the reply so far, then the rest; nothing to watch says done", async () => {
    const { chat } = await setUp();
    const idle = await events(await app.fetch(new Request(`http://127.0.0.1/api/chats/${chat.id}/live`)));
    expect(idle).toEqual([expect.objectContaining({ type: "done", busy: false })]);
    streams([{ content: "One, " }, { content: "two, " }, { content: "three." }], 60);
    const first = await app.fetch(new Request(`http://127.0.0.1/api/chats/${chat.id}/send?stream=1`, { method: "POST", body: "{}" }));
    await Bun.sleep(100);
    const later = await events(await app.fetch(new Request(`http://127.0.0.1/api/chats/${chat.id}/live`)));
    expect(later[0]).toMatchObject({ type: "start", busy: true });
    expect(later[0].live.content).toStartWith("One,");
    expect(later[0].live.content + later.filter((e) => e.type === "more").map((e) => e.content).join("")).toBe("One, two, three.");
    expect(later.at(-1).messages.at(-1)).toMatchObject({ content: "One, two, three." });
    await first.text();
  });

  test("a second reply can't start while one is being written", async () => {
    const { chat } = await setUp();
    streams([{ content: "Slow." }], 150);
    const first = app.fetch(new Request(`http://127.0.0.1/api/chats/${chat.id}/send?stream=1`, { method: "POST", body: "{}" }));
    await Bun.sleep(20);
    expect((await call("POST", `/api/chats/${chat.id}/send?stream=1`, {})).status).toBe(400);
    await (await first).text();
  });
});
