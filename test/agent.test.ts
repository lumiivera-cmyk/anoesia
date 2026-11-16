/**
 * The agent: its paths, the edit log and revert, the tools, and a whole
 * turn through the server against a stand-in model that calls tools.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool } from "../src/agenttools.ts";
import { AgentStore } from "../src/agentstore.ts";
import { parseCards } from "../src/cards.ts";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db.ts";
import { compactDiff, diff } from "../src/diff.ts";
import { createApp, type App } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { Workspace } from "../src/workspace.ts";

const fixture = readFileSync(join(import.meta.dir, "fixtures", "sample-cards.md"), "utf8");

function world() {
  const db = openDatabase(":memory:");
  const store = new Store(db);
  const agent = new AgentStore(db);
  const ws = new Workspace(store, agent);
  const cards = store.importCards(parseCards(fixture));
  const ada = cards.find((c) => c.name === "Ada Vale")!;
  const chat = store.createChat({ name: "Night Market", cast: [ada.id] });
  store.addMessage({ chatId: chat.id, role: "user", author: "user", content: "Hi Ada." });
  store.addMessage({ chatId: chat.id, role: "assistant", author: "narrator", content: "Ada smirks. She checks the setlist twice." });
  store.addMessage({ chatId: chat.id, role: "user", author: "user", content: "Again?" });
  store.addMessage({ chatId: chat.id, role: "assistant", author: "narrator", content: "Ada smirks again and shrugs." });
  const session = agent.createSession({ chatId: chat.id });
  const ctx = { sessionId: session.id, turnId: "turn-1" };
  const tool = (name: string, args: Record<string, unknown>, turnId = "turn-1") => runTool(name, JSON.stringify(args), { ws, ctx: { ...ctx, turnId }, chatId: chat.id });
  return { db, store, agent, ws, ada, chat, ctx, tool };
}

describe("diff", () => {
  test("marks one changed word in a long text", () => {
    const parts = diff("She smirks and walks off.", "She smiles and walks off.");
    expect(parts).toEqual([
      { op: "same", text: "She " },
      { op: "del", text: "smirks" },
      { op: "add", text: "smiles" },
      { op: "same", text: " and walks off." },
    ]);
  });

  test("handles creation and deletion", () => {
    expect(diff("", "new")).toEqual([{ op: "add", text: "new" }]);
    expect(diff("old", "")).toEqual([{ op: "del", text: "old" }]);
  });

  test("compactDiff cuts long unchanged runs", () => {
    const long = "word ".repeat(100);
    const parts = compactDiff(diff(long + "a" + long, long + "b" + long), 20);
    expect(parts[0]!.text.startsWith("…")).toBe(true);
    expect(parts.at(-1)!.text.endsWith("…")).toBe(true);
  });
});

describe("workspace paths", () => {
  test("lists the top, cards, a chat's messages and the agent's folder", () => {
    const { ws } = world();
    expect(ws.list("").map((e) => e.path)).toEqual(["cards/", "prompt/", "chats/", "agent/"]);
    expect(ws.list("cards/ada vale").map((e) => e.path)).toContain("cards/Ada Vale/Advanced description");
    const messages = ws.list("chats/Night Market/messages");
    expect(messages).toHaveLength(4);
    expect(messages[1]!.note).toContain("narrator: Ada smirks.");
    expect(ws.list("agent").map((e) => e.path)).toEqual(["agent/chats/", "agent/index.md", "agent/notes/", "agent/personality.md"]);
    expect(ws.list("agent/chats").map((e) => e.path)).toEqual(["agent/chats/Night Market/"]);
  });

  test("reads by name, any case, and blocks by their card and field", () => {
    const { ws } = world();
    expect(ws.read("cards/ada vale/description").text).toContain("Lead singer");
    expect(ws.read("chats/night market/messages/2").text).toBe("Ada smirks. She checks the setlist twice.");
    expect(ws.read("chats/Night Market/blocks/Ada Vale: Description").text).toContain("Lead singer");
    expect(ws.read("prompt/main").text).toContain("roleplay");
    expect(() => ws.read("chats/Night Market/messages/9")).toThrow("4 messages");
    expect(() => ws.read("cards/Nobody/Description")).toThrow("no card named");
  });

  test("a chat's agent folder is stored under its id and shown by name", () => {
    const { ws, agent, chat, ctx } = world();
    ws.write("agent/chats/Night Market/notebook.md", "# Notebook", ctx);
    expect(agent.file(`chats/${chat.id}/notebook.md`)!.content).toBe("# Notebook");
    expect(ws.list("agent/chats/Night Market").map((e) => e.path)).toEqual(["agent/chats/Night Market/notebook.md"]);
  });
});

describe("edit log and revert", () => {
  test("an edit is logged and reverts", () => {
    const { ws, ctx, ada } = world();
    const edit = ws.write("cards/Ada Vale/Description", "Ada Vale, 28.", ctx);
    expect(edit.before).toContain("27");
    expect(edit.target).toBe(`field:${ada.fields[0]!.id}`);
    ws.revert(edit.id);
    expect(ws.read("cards/Ada Vale/Description").text).toContain("27");
    expect(() => ws.revert(edit.id)).toThrow("already reverted");
  });

  test("revert refuses to undo newer changes unless forced", () => {
    const { ws, ctx, store, chat } = world();
    const edit = ws.write("chats/Night Market/messages/2", "Ada smiles.", ctx);
    const message = store.messages(chat.id)[1]!;
    store.editMessage(message.id, "Ada smiles, then laughs.");
    expect(() => ws.revert(edit.id)).toThrow("changed since");
    ws.revert(edit.id, true);
    expect(store.messages(chat.id)[1]!.content).toBe("Ada smirks. She checks the setlist twice.");
  });

  test("a message edit stays with its version when another is shown", () => {
    const { ws, ctx, store, chat } = world();
    const edit = ws.write("chats/Night Market/messages/2", "Ada smiles.", ctx);
    const message = store.messages(chat.id)[1]!;
    store.addSwipe(message.id, "A new version.", "", "");
    ws.revert(edit.id);
    const after = store.message(message.id);
    expect(after.swipes[0]).toBe("Ada smirks. She checks the setlist twice.");
    expect(after.content).toBe("A new version.");
  });

  test("created and deleted things come and go with revert", () => {
    const { ws, ctx, store, chat, agent } = world();
    const field = ws.write("cards/Ada Vale/Voice bank", '"Again."', ctx);
    expect(store.cards().find((c) => c.name === "Ada Vale")!.fields.at(-1)!.title).toBe("Voice bank");
    const block = ws.write("chats/Night Market/blocks/Scene restraint", "Stop early.", ctx);
    const blocksBefore = store.blocks(chat.id).map((b) => b.id);
    const deleted = ws.remove("chats/Night Market/blocks/Scene restraint", ctx);
    ws.revert(deleted.id);
    expect(store.blocks(chat.id).map((b) => b.id)).toEqual(blocksBefore);
    ws.revert(block.id);
    expect(store.blocks(chat.id).some((b) => b.title === "Scene restraint")).toBe(false);
    ws.revert(field.id);
    expect(store.cards().find((c) => c.name === "Ada Vale")!.fields.some((f) => f.title === "Voice bank")).toBe(false);
    const file = ws.write("agent/notes/draft.md", "draft", ctx);
    ws.revert(file.id);
    expect(agent.file("notes/draft.md")).toBeNull();
  });

  test("a card's default fields and messages can't be deleted", () => {
    const { ws, ctx } = world();
    expect(() => ws.remove("cards/Ada Vale/Description", ctx)).toThrow("always exist");
    expect(() => ws.remove("chats/Night Market/messages/1", ctx)).toThrow();
    expect(() => ws.write("chats/Night Market/messages/1", "  ", ctx)).toThrow("empty");
  });

  test("a whole turn reverts together, and not at all on a conflict", () => {
    const { ws, ctx, store, chat } = world();
    ws.write("chats/Night Market/messages/2", "Ada grins. She checks the setlist twice.", ctx);
    ws.write("chats/Night Market/messages/4", "Ada grins again and shrugs.", ctx);
    ws.write("chats/Night Market/messages/2", "Ada grins. She checks the setlist.", ctx);
    const m4 = store.messages(chat.id)[3]!;
    store.editMessage(m4.id, "Changed by hand.");
    expect(() => ws.revertTurn("turn-1")).toThrow("changed since");
    expect(store.messages(chat.id)[1]!.content).toBe("Ada grins. She checks the setlist.");
    store.editMessage(m4.id, "Ada grins again and shrugs.");
    ws.revertTurn("turn-1");
    expect(store.messages(chat.id).map((m) => m.content)).toEqual(["Hi Ada.", "Ada smirks. She checks the setlist twice.", "Again?", "Ada smirks again and shrugs."]);
  });
});

describe("tools", () => {
  test("grep finds a habit across a chat, and edit combs it out", () => {
    const { tool, store, chat } = world();
    const found = tool("grep", { pattern: "smirk", path: "chats/Night Market/messages" }).text;
    expect(found).toContain("2 matches in 2 texts");
    expect(found).toContain("chats/Night Market/messages/2:");
    expect(found).toContain("chats/Night Market/messages/4:");
    expect(tool("edit", { path: "chats/Night Market/messages/2", find: "smirks", replace: "smiles" }).edits).toHaveLength(1);
    expect(tool("edit", { path: "chats/Night Market/messages/4", find: "nope", replace: "x" }).text).toStartWith("Error:");
    expect(store.messages(chat.id)[1]!.content).toBe("Ada smiles. She checks the setlist twice.");
  });

  test("edit refuses an ambiguous find unless replace_all", () => {
    const { tool, ws } = world();
    ws.write("agent/notes/a.md", "x and x", { sessionId: "s", turnId: "t" });
    expect(tool("edit", { path: "agent/notes/a.md", find: "x", replace: "y" }).text).toContain("2 times");
    tool("edit", { path: "agent/notes/a.md", find: "x", replace: "y", replace_all: true });
    expect(ws.read("agent/notes/a.md").text).toBe("y and y");
  });

  test("remember adds under a heading, in the index or a chat's notebook", () => {
    const { tool, ws } = world();
    tool("remember", { note: "Keep replies short.", heading: "Preferences" });
    tool("remember", { note: "No em dashes.", heading: "Preferences" });
    const index = ws.read("agent/index.md").text;
    expect(index).toContain("## Preferences\n\n- Keep replies short.\n- No em dashes.");
    tool("remember", { note: "Ada's wrist is sprained.", chat: "Night Market" });
    expect(ws.read("agent/chats/Night Market/notebook.md").text).toContain("- Ada's wrist is sprained.");
  });

  test("preview_prompt and resolve_macros use the open chat", () => {
    const { tool } = world();
    const preview = tool("preview_prompt", {}).text;
    expect(preview).toContain("Main prompt (system)");
    expect(preview).toContain("Ada Vale: Description");
    expect(tool("resolve_macros", { text: "Hello {{char}}, {{messageCount}} messages." }).text).toBe("Hello Ada Vale, 4 messages.");
  });

  test("broken arguments and unknown tools come back as errors", () => {
    const { ws, ctx, chat } = world();
    expect(runTool("read", "{not json", { ws, ctx, chatId: chat.id }).text).toStartWith("Error:");
    expect(runTool("fly", "{}", { ws, ctx, chatId: chat.id }).text).toStartWith("Error:");
  });
});

// ------------------------------------------------------------------ server

let dir: string;
let app: App;
let fake: ReturnType<typeof Bun.serve>;
let script: Record<string, unknown>[];
let received: { messages: Record<string, unknown>[]; tools?: unknown[] }[];

async function call(method: string, path: string, body?: unknown) {
  const response = await app.fetch(new Request(`http://127.0.0.1${path}`, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }));
  return { status: response.status, data: (await response.json()) as any };
}

const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

describe("agent turns through the server", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "anoesia-agent-"));
    script = [];
    received = [];
    fake = Bun.serve({
      port: 0,
      async fetch(request) {
        received.push((await request.json()) as (typeof received)[number]);
        const message = script.shift() ?? { content: "(out of script)" };
        return Response.json({ model: "agent/model", choices: [{ message, finish_reason: "stop" }] });
      },
    });
    app = createApp(loadConfig({ DATA_DIR: dir, NANOGPT_API_KEY: "k", NANOGPT_BASE_URL: `http://127.0.0.1:${fake.port}/v1` }));
  });

  afterEach(() => {
    app.close();
    fake.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  async function setUp() {
    const profile = (await call("POST", "/api/profiles", { name: "Agent", model: "agent/model" })).data;
    await call("POST", "/api/cards/import", { text: fixture });
    const chat = (await call("POST", "/api/chats", { name: "Night Market" })).data;
    const session = (await call("POST", "/api/agent/sessions", { chatId: chat.id })).data;
    return { profile, chat, session };
  }

  test("needs an agent profile", async () => {
    const { session } = await setUp();
    const r = await call("POST", `/api/agent/sessions/${session.id}/send`, { content: "hi" });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain("Settings → Connections");
  });

  test("runs tools, logs the edit with a diff, and reverts it", async () => {
    const { profile, chat, session } = await setUp();
    await call("PATCH", "/api/settings", { agentProfileId: profile.id });
    script.push(
      { content: null, tool_calls: [toolCall("c1", "read", { path: "cards/Ada Vale/Description" })] },
      { content: "", tool_calls: [toolCall("c2", "edit", { path: "cards/Ada Vale/Description", find: "27", replace: "28" })] },
      { content: "Done: Ada is 28 now." },
    );
    const r = await call("POST", `/api/agent/sessions/${session.id}/send`, { content: "Make Ada 28.", chatId: chat.id });
    expect(r.status).toBe(200);
    expect(r.data.error).toBeUndefined();
    expect(r.data.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant"]);
    expect(r.data.messages[2].content).toContain("Lead singer");
    expect(r.data.session.title).toBe("Make Ada 28.");
    expect(r.data.edits).toHaveLength(1);
    expect(r.data.edits[0].diff).toContainEqual({ op: "add", text: "28" });

    // What the model saw: the system prompt with its notes and the open chat, the tools, and the tool results.
    const first = received[0]!;
    expect(first.messages[0]!.role).toBe("system");
    expect(String(first.messages[0]!.content)).toContain("Open chat: Night Market");
    expect(String(first.messages[0]!.content)).toContain("## Your notes (agent/index.md)");
    expect(first.tools!.length).toBeGreaterThan(10);
    const third = received[2]!;
    expect(third.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c2" });

    const state = await call("GET", "/api/state");
    expect(state.data.cards.find((c: any) => c.name === "Ada Vale").fields[0].content).toContain("28");
    const reverted = await call("POST", `/api/agent/edits/${r.data.edits[0].id}/revert`, {});
    expect(reverted.data.revertedAt).toBeTruthy();
    const after = await call("GET", "/api/state");
    expect(after.data.cards.find((c: any) => c.name === "Ada Vale").fields[0].content).toContain("27");
  });

  test("ask_user ends the turn, and a revert conflict is a 409", async () => {
    const { profile, session } = await setUp();
    await call("PATCH", "/api/settings", { agentProfileId: profile.id });
    script.push({ content: "", tool_calls: [toolCall("q", "ask_user", { question: "Which?", options: [{ label: "A" }, { label: "B" }] }), toolCall("r", "list", {})] });
    const r = await call("POST", `/api/agent/sessions/${session.id}/send`, { content: "Fix it." });
    expect(received).toHaveLength(1);
    expect(r.data.messages.at(-1).content).toContain("Not run");

    script.push({ content: "", tool_calls: [toolCall("w", "write", { path: "prompt/main", content: "New main." })] }, { content: "Changed." });
    const w = await call("POST", `/api/agent/sessions/${session.id}/send`, { content: "B" });
    await call("PATCH", "/api/settings", { mainPrompt: "Hand edited." });
    const conflict = await call("POST", `/api/agent/edits/${w.data.edits[0].id}/revert`, {});
    expect(conflict.status).toBe(409);
    const forced = await call("POST", `/api/agent/turns/${w.data.edits[0].turnId}/revert`, { force: true });
    expect(forced.status).toBe(200);
    expect((await call("GET", "/api/state")).data.settings.mainPrompt).toContain("roleplay");
  });

  test("files can be read and written from the panel", async () => {
    await setUp();
    const listed = await call("GET", "/api/agent/files");
    expect(listed.data.map((f: any) => f.display)).toEqual(["agent/index.md", "agent/personality.md"]);
    await call("PUT", "/api/agent/files", { path: "notes/a.md", content: "hello" });
    expect((await call("GET", "/api/agent/files?path=notes/a.md")).data.content).toBe("hello");
    expect((await call("PUT", "/api/agent/files", { path: "../x", content: "" })).status).toBe(400);
  });
});
