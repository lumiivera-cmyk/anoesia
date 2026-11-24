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

  test("the agent reads and flips who's onstage, logged and revertable", () => {
    const { ws, ctx, store, chat, ada } = world();
    const bo = store.cards().find((c) => c.name === "Bo")!;
    store.updateChat(chat.id, { cast: [ada.id, bo.id] });
    expect(ws.read("chats/Night Market/cast").text).toBe("Ada Vale: onstage\nBo: onstage");
    expect(ws.list("chats/Night Market").find((e) => e.path.endsWith("/cast"))!.note).toBe("onstage: Ada Vale, Bo; offstage: nobody");
    const edit = ws.write("chats/Night Market/cast", "Ada Vale: onstage\nBo: offstage", ctx);
    expect(store.chat(chat.id).offstage).toEqual([bo.id]);
    expect(edit).toMatchObject({ path: "chats/Night Market/cast", before: "Ada Vale: onstage\nBo: onstage", after: "Ada Vale: onstage\nBo: offstage" });
    expect(ws.list("chats/Night Market/blocks").find((e) => e.path.endsWith("Bo: Voice bank"))!.note).toContain("its card is offstage");
    ws.revert(edit.id);
    expect(store.chat(chat.id).offstage).toEqual([]);
    expect(() => ws.write("chats/Night Market/cast", "Cy: offstage", ctx)).toThrow("isn't in Night Market's cast");
    expect(() => ws.write("chats/Night Market/cast", "Bo: backstage", ctx)).toThrow("Name: onstage");
    expect(() => ws.remove("chats/Night Market/cast", ctx)).toThrow();
  });

  test("the agent edits a chat's notes, logged and revertable; they can't be deleted", () => {
    const { ws, ctx, store, chat } = world();
    expect(ws.read("chats/Night Market/blocks/Right now").text).toBe("");
    const edit = ws.write("chats/Night Market/blocks/Who knows what", "Bo knows about the wrist.", ctx);
    expect(store.blocks(chat.id).find((b) => b.title === "Who knows what")!.content).toBe("Bo knows about the wrist.");
    ws.revert(edit.id);
    expect(store.blocks(chat.id).find((b) => b.title === "Who knows what")!.content).toBe("");
    expect(() => ws.remove("chats/Night Market/blocks/Right now", ctx)).toThrow("keeps its notes");
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

  test("a chat's own agent: its personality, its notebook, and it stays with its chat", async () => {
    const { profile, chat } = await setUp();
    await call("PATCH", "/api/settings", { agentProfileId: profile.id });
    expect((await call("POST", "/api/agent/sessions", { scope: "chat" })).status).toBe(400);
    const session = (await call("POST", "/api/agent/sessions", { scope: "chat", chatId: chat.id })).data;
    expect(session.scope).toBe("chat");
    const files = (await call("GET", "/api/agent/files")).data.map((f: any) => f.display);
    expect(files).toContain("agent/chats/Night Market/personality.md");
    await call("PUT", "/api/agent/files", { path: `chats/${chat.id}/personality.md`, content: "You are Moth, this chat's keeper." });

    const other = (await call("POST", "/api/chats", { name: "Elsewhere" })).data;
    script.push({ content: "", tool_calls: [toolCall("n", "remember", { note: "Ada's wrist is sprained.", heading: "Facts" })] }, { content: "Noted." });
    const r = await call("POST", `/api/agent/sessions/${session.id}/send`, { content: "Remember the wrist.", chatId: other.id });
    expect(r.data.error).toBeUndefined();
    expect(r.data.session.chatId).toBe(chat.id);
    const system = String(received[0]!.messages[0]!.content);
    expect(system).toContain('the agent for one chat in Anoesia, a roleplay app: "Night Market"');
    expect(system).toContain("You are Moth");
    expect(system).not.toContain("You help write and tune roleplay in Anoesia");
    expect(system).toContain("Open chat: Night Market");
    expect(r.data.edits[0].path).toBe("agent/chats/Night Market/notebook.md");

    // The next turn sees the notebook; the roleplay model never does.
    script.push({ content: "Hi." });
    await call("POST", `/api/agent/sessions/${session.id}/send`, { content: "Hello?" });
    expect(String(received[2]!.messages[0]!.content)).toContain("Ada's wrist is sprained.");
    const preview = (await call("GET", `/api/chats/${chat.id}/preview`)).data;
    expect(JSON.stringify(preview)).not.toContain("wrist is sprained");

    // A deleted chat leaves its sessions unable to run, with a clear reason.
    await call("DELETE", `/api/chats/${chat.id}`);
    const gone = await call("POST", `/api/agent/sessions/${session.id}/send`, { content: "Still there?" });
    expect(gone.data.error ?? "").toContain("chat was deleted");
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

// ----------------------------------------------------------- streamed turns

describe("agent turns, streamed", () => {
  /** Each request answers with the next script entry: SSE chunks (deltas), sent with a small gap, or held open with `hang`. */
  let streams: { deltas: Record<string, unknown>[]; hang?: boolean }[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "anoesia-agent-"));
    streams = [];
    received = [];
    fake = Bun.serve({
      port: 0,
      async fetch(request) {
        received.push((await request.json()) as (typeof received)[number]);
        const next = streams.shift() ?? { deltas: [{ content: "(out of script)" }] };
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const delta of next.deltas) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ model: "agent/model", choices: [{ delta }] })}\n\n`));
              await Bun.sleep(5);
            }
            if (next.hang) {
              request.signal.addEventListener("abort", () => controller.close());
              return;
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    app = createApp(loadConfig({ DATA_DIR: dir, NANOGPT_API_KEY: "k", NANOGPT_BASE_URL: `http://127.0.0.1:${fake.port}/v1` }));
  });

  afterEach(() => {
    app.close();
    fake.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  async function ready() {
    const profile = (await call("POST", "/api/profiles", { name: "Agent", model: "agent/model" })).data;
    await call("PATCH", "/api/settings", { agentProfileId: profile.id });
    await call("POST", "/api/cards/import", { text: fixture });
    return (await call("POST", "/api/agent/sessions", {})).data;
  }

  async function events(response: Response): Promise<any[]> {
    const text = await response.text();
    return text
      .split("\n\n")
      .filter((b) => b.startsWith("data: "))
      .map((b) => JSON.parse(b.slice(6)));
  }

  test("tool calls arrive in pieces and still run; the reply streams; each saved message is told", async () => {
    const session = await ready();
    streams.push(
      {
        deltas: [
          { content: "Looking." },
          { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read", arguments: "" } }] },
          { tool_calls: [{ index: 0, function: { arguments: '{"path":"cards/Ada' } }] },
          { tool_calls: [{ index: 0, function: { arguments: ' Vale/Description"}' } }] },
        ],
      },
      { deltas: [{ reasoning: "She is 27." }, { content: "Ada is " }, { content: "27." }] },
    );
    const response = await app.fetch(new Request(`http://127.0.0.1/api/agent/sessions/${session.id}/send?stream=1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "How old is Ada?" }) }));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const all = await events(response);
    expect(all[0].type).toBe("start");
    expect(all[0].busy).toBe(true);
    const words = all.filter((e) => e.type === "more").map((e) => e.content).join("");
    expect(words).toContain("Ada is 27.");
    expect(all.filter((e) => e.type === "more").map((e) => e.reasoning).join("")).toContain("She is 27.");
    expect(all.filter((e) => e.type === "saved").length).toBe(3);
    const done = all.at(-1);
    expect(done.type).toBe("done");
    expect(done.busy).toBe(false);
    expect(done.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(done.messages[1].toolCalls[0].function).toEqual({ name: "read", arguments: '{"path":"cards/Ada Vale/Description"}' });
    expect(done.messages[2].content).toContain("Lead singer");
    expect(done.messages[3].content).toBe("Ada is 27.");
  });

  test("Stop ends a turn partway and keeps the words written so far", async () => {
    const session = await ready();
    streams.push({ deltas: [{ content: "Half a " }, { content: "thought" }], hang: true });
    const response = await app.fetch(new Request(`http://127.0.0.1/api/agent/sessions/${session.id}/send?stream=1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "Go." }) }));
    const reading = events(response);
    // Busy, and a second message is refused while it runs.
    await Bun.sleep(60);
    expect((await call("GET", `/api/agent/sessions/${session.id}`)).data.busy).toBe(true);
    expect((await call("POST", `/api/agent/sessions/${session.id}/send`, { content: "Again" })).status).toBe(400);
    // Someone watching from another page sees it too.
    const watcher = app.fetch(new Request(`http://127.0.0.1/api/agent/sessions/${session.id}/live`)).then(events);
    await call("POST", `/api/agent/sessions/${session.id}/stop`, {});
    const all = await reading;
    const done = all.at(-1);
    expect(done.type).toBe("done");
    expect(done.error).toBeUndefined();
    expect(done.messages.map((m: any) => [m.role, m.content])).toEqual([
      ["user", "Go."],
      ["assistant", "Half a thought"],
    ]);
    expect((await watcher).at(-1).type).toBe("done");
    expect((await call("GET", `/api/agent/sessions/${session.id}`)).data.busy).toBe(false);
  });
});

// ------------------------------------------------- rerolls, edits, rewind, branch

describe("agent chat: rerolls, edits, rewind and branch", () => {
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

  async function ready() {
    const profile = (await call("POST", "/api/profiles", { name: "Agent", model: "agent/model" })).data;
    await call("PATCH", "/api/settings", { agentProfileId: profile.id, mainPrompt: "Main v1." });
    return (await call("POST", "/api/agent/sessions", {})).data;
  }
  const main = async () => (await call("GET", "/api/state")).data.settings.mainPrompt;
  const shown = (view: any) => view.messages.filter((m: any) => !m.hidden).map((m: any) => m.content);

  test("a reroll undoes what the answer did, and switching versions puts each one's changes back", async () => {
    const session = await ready();
    script.push({ content: "", tool_calls: [toolCall("a", "write", { path: "prompt/main", content: "Main A." })] }, { content: "Wrote A." });
    await call("POST", `/api/agent/sessions/${session.id}/send`, { content: "Rewrite the main prompt." });
    expect(await main()).toBe("Main A.");

    script.push({ content: "", tool_calls: [toolCall("b", "write", { path: "prompt/main", content: "Main B." })] }, { content: "Wrote B." });
    const rerolled = (await call("POST", `/api/agent/sessions/${session.id}/reroll`, {})).data;
    expect(rerolled.error).toBeUndefined();
    expect(await main()).toBe("Main B.");
    expect(shown(rerolled)).toEqual(["Rewrite the main prompt.", "", expect.any(String), "Wrote B."]);
    // The model saw your message and not the first answer.
    expect(JSON.stringify(received.at(-2)!.messages)).not.toContain("Wrote A.");
    expect(received.at(-2)!.messages.filter((m) => m.role === "user")).toHaveLength(1);

    // Back to the first version: B's change is set aside, A's put back.
    const first = (await call("POST", `/api/agent/sessions/${session.id}/version`, { index: 0 })).data;
    expect(await main()).toBe("Main A.");
    expect(shown(first).at(-1)).toBe("Wrote A.");
    await call("POST", `/api/agent/sessions/${session.id}/version`, { index: 1 });
    expect(await main()).toBe("Main B.");

    // Changed by hand since: switching is refused (409) and changes nothing, unless forced.
    await call("PATCH", "/api/settings", { mainPrompt: "Mine." });
    expect((await call("POST", `/api/agent/sessions/${session.id}/version`, { index: 0 })).status).toBe(409);
    expect(await main()).toBe("Mine.");
    expect((await call("POST", `/api/agent/sessions/${session.id}/reroll`, {})).status).toBe(409);
    expect(await main()).toBe("Mine.");
    script.push({ content: "Left it." });
    const forced = (await call("POST", `/api/agent/sessions/${session.id}/reroll`, { force: true })).data;
    expect(await main()).toBe("Main v1.");
    expect(shown(forced).at(-1)).toBe("Left it.");
  });

  test("a block the agent made goes on reroll and comes back, in place, with its version", async () => {
    const session = await ready();
    const chat = (await call("POST", "/api/chats", { name: "Night Market" })).data;
    script.push({ content: "", tool_calls: [toolCall("a", "write", { path: "chats/Night Market/blocks/Tone", content: "Keep it dry." })] }, { content: "Added." });
    await call("POST", `/api/agent/sessions/${session.id}/send`, { content: "Add a tone block.", chatId: chat.id });
    const blocks = async () => (await call("GET", `/api/chats/${chat.id}/blocks`)).data.map((b: any) => b.title);
    const before = await blocks();
    expect(before).toContain("Tone");
    script.push({ content: "Not adding it." });
    await call("POST", `/api/agent/sessions/${session.id}/reroll`, {});
    expect(await blocks()).not.toContain("Tone");
    await call("POST", `/api/agent/sessions/${session.id}/version`, { index: 0 });
    expect(await blocks()).toEqual(before);
  });

  test("rewind takes back what came after; editing your message answers it again; branch copies up to a message", async () => {
    const session = await ready();
    script.push({ content: "Hi." });
    await call("POST", `/api/agent/sessions/${session.id}/send`, { content: "Hello." });
    script.push({ content: "", tool_calls: [toolCall("a", "write", { path: "prompt/main", content: "Main A." })] }, { content: "Wrote A." });
    const view = (await call("POST", `/api/agent/sessions/${session.id}/send`, { content: "Rewrite it." })).data;
    const hi = view.messages.find((m: any) => m.content === "Hi.");
    const ask = view.messages.find((m: any) => m.content === "Rewrite it.");

    // A branch from the first reply: the conversation to there, in a new session; nothing undone here.
    const branched = (await call("POST", `/api/agent/messages/${hi.id}/branch`, {})).data;
    expect(branched.session.id).not.toBe(session.id);
    expect(shown(branched)).toEqual(["Hello.", "Hi."]);
    expect(await main()).toBe("Main A.");

    // Editing your message: it's answered again, and the old answer's change is undone.
    script.push({ content: "Left it alone." });
    const resent = (await call("POST", `/api/agent/messages/${ask.id}/resend`, { content: "Leave it." })).data;
    expect(shown(resent)).toEqual(["Hello.", "Hi.", "Leave it.", "Left it alone."]);
    expect(await main()).toBe("Main v1.");

    // The agent's words can be edited in place.
    const reply = resent.messages.at(-1);
    const edited = (await call("PATCH", `/api/agent/messages/${reply.id}`, { content: "Left it." })).data;
    expect(shown(edited).at(-1)).toBe("Left it.");

    // Rewind to the first reply: the rest goes.
    script.push({ content: "", tool_calls: [toolCall("b", "write", { path: "prompt/main", content: "Main B." })] }, { content: "Wrote B." });
    await call("POST", `/api/agent/sessions/${session.id}/send`, { content: "Now do it." });
    expect(await main()).toBe("Main B.");
    expect((await call("GET", `/api/agent/messages/${hi.id}/rewind`)).data.changes).toBe(1);
    const rewound = (await call("POST", `/api/agent/messages/${hi.id}/rewind`, {})).data;
    expect(shown(rewound)).toEqual(["Hello.", "Hi."]);
    expect(await main()).toBe("Main v1.");
  });
});
