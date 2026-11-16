/**
 * The agent panel: talk to the agent, see what it did (each change as a
 * diff, with revert), and read or edit its files.
 *
 * Two agents: the main one, and the open chat's own (its own personality
 * and notebook, in agent/chats/<chat>/). "Main" / "This chat" switches.
 *
 *   Chat     the session: your messages, its replies, each tool it used,
 *            and the changes each turn made, with "Revert" and "Revert all"
 *   Changes  every change the agent has made, newest first
 *   Files    agent/index.md, personality.md, notes/, chats/<chat>/
 */

import { $, api, attempt, escapeHtml, formatText, loadState, state } from "./core.js";
import { openChat, renderChat as renderRoleplay } from "./chat.js";
import { renderSide } from "./side.js";

const agent = {
  open: false,
  /** "main" or "chat": whose sessions the panel shows. */
  mode: "main",
  tab: "chat",
  sessions: [],
  sessionId: null,
  view: null,
  busy: false,
  files: [],
  filePath: null,
  edits: [],
};

/** The last session used, per agent ("main", or a chat's id). */
let lastSessions = {};
try {
  lastSessions = JSON.parse(localStorage.getItem("anoesia.agentSessions") ?? "{}") ?? {};
  agent.mode = localStorage.getItem("anoesia.agentMode") === "chat" ? "chat" : "main";
} catch {
  // private mode
}

/** Which agent the panel is on: "main", or the open chat's id. */
function owner() {
  return agent.mode === "chat" ? state.chatId : "main";
}

function visibleSessions() {
  return agent.sessions.filter((s) => (agent.mode === "chat" ? s.scope === "chat" && s.chatId === state.chatId : s.scope !== "chat"));
}

function remember(key, value) {
  try {
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    // fine
  }
}

/** Show the session last used with this agent, or none yet. */
async function pickSession() {
  if (agent.mode === "chat" && !state.chatId) agent.mode = "main";
  const list = visibleSessions();
  const pick = list.find((s) => s.id === lastSessions[owner()]) ?? list[0];
  await openSession(pick?.id ?? null);
}

// ----------------------------------------------------------------- open

export async function toggleAgent(force) {
  agent.open = force ?? !agent.open;
  $("agent-panel").hidden = !agent.open;
  document.body.classList.toggle("agent-open", agent.open);
  if (!agent.open) return;
  await refreshList();
  if (!agent.sessionId) await pickSession();
  else renderAll();
  $("agent-input").focus();
}

async function refreshList() {
  const data = await attempt(() => api("GET", "/api/agent"));
  if (!data) return;
  agent.sessions = data.sessions;
  agent.files = data.files;
}

async function openSession(id) {
  agent.sessionId = id;
  if (id) {
    lastSessions[owner()] = id;
    remember("anoesia.agentSessions", lastSessions);
  }
  agent.view = id ? await attempt(() => api("GET", `/api/agent/sessions/${id}`)) : null;
  renderAll();
}

async function newSession() {
  const s = await attempt(() => api("POST", "/api/agent/sessions", { chatId: state.chatId, scope: agent.mode }));
  if (!s) return;
  await refreshList();
  await openSession(s.id);
  $("agent-input").focus();
}

// --------------------------------------------------------------- render

function renderAll() {
  const chatName = state.chat?.name ?? "";
  for (const b of document.querySelectorAll("[data-agent-mode]")) {
    b.classList.toggle("active", b.dataset.agentMode === agent.mode);
    b.setAttribute("aria-selected", String(b.dataset.agentMode === agent.mode));
    if (b.dataset.agentMode === "chat") {
      b.disabled = !state.chatId;
      b.textContent = state.chatId ? `${chatName}'s agent` : "A chat's agent";
      b.title = state.chatId ? `This chat's own agent: its own personality and notebook` : "Open a chat first";
    }
  }
  $("agent-session").innerHTML =
    visibleSessions().map((s) => `<option value="${s.id}" ${s.id === agent.sessionId ? "selected" : ""}>${escapeHtml(s.title)}</option>`).join("") ||
    `<option value="">No sessions yet</option>`;
  for (const t of document.querySelectorAll("[data-agent-tab]")) {
    t.classList.toggle("active", t.dataset.agentTab === agent.tab);
    t.setAttribute("aria-selected", String(t.dataset.agentTab === agent.tab));
  }
  $("agent-chat").hidden = agent.tab !== "chat";
  $("agent-changes").hidden = agent.tab !== "changes";
  $("agent-files").hidden = agent.tab !== "files";
  if (agent.tab === "chat") renderChat();
  if (agent.tab === "changes") renderChanges();
  if (agent.tab === "files") renderFiles();
}

/** One line for a tool call: what it did, to what. */
function callSummary(name, args) {
  const path = args.path ?? "";
  switch (name) {
    case "list":
      return `Looked in ${path || "/"}`;
    case "read":
      return `Read ${path}`;
    case "grep":
      return `Searched ${args.path || "everything"} for “${args.pattern}”`;
    case "edit":
      return `Edited ${path}`;
    case "write":
      return `Wrote ${path}`;
    case "delete":
      return `Deleted ${path}`;
    case "preview_prompt":
      return `Previewed the prompt${args.chat ? ` of ${args.chat}` : ""}`;
    case "resolve_macros":
      return "Filled macros";
    case "count_tokens":
      return `Counted tokens${path ? ` in ${path}` : ""}`;
    case "remember":
      return `Noted: ${args.note ?? ""}`;
    case "list_edits":
      return "Listed its changes";
    case "revert_edit":
      return "Reverted a change";
    case "ask_user":
      return "Asked you";
    default:
      return name;
  }
}

function parseArgs(text) {
  try {
    return JSON.parse(text || "{}") ?? {};
  } catch {
    return {};
  }
}

function diffHtml(parts) {
  return parts
    .map((p) => (p.op === "same" ? escapeHtml(p.text) : `<${p.op === "add" ? "ins" : "del"}>${escapeHtml(p.text)}</${p.op === "add" ? "ins" : "del"}>`))
    .join("");
}

function editHtml(e) {
  const what = e.before === null ? "Created" : e.after === null ? "Deleted" : "Edited";
  return `<div class="agent-edit${e.revertedAt ? " reverted" : ""}" data-edit="${e.id}">
    <div class="agent-edit-head"><span class="small"><strong>${what}</strong> ${escapeHtml(e.path)}</span><span class="spacer"></span>${
      e.revertedAt ? `<span class="muted small">Reverted</span>` : `<button type="button" class="button small-button" data-revert="${e.id}">Revert</button>`
    }</div>
    <pre class="agent-diff">${diffHtml(e.diff)}</pre>
  </div>`;
}

function renderChat() {
  const log = $("agent-log");
  const view = agent.view;
  $("agent-stop").hidden = !agent.busy;
  $("agent-send").disabled = agent.busy;
  if (!view && agent.mode === "chat") {
    const name = escapeHtml(state.chat?.name ?? "this chat");
    log.innerHTML = `<div class="agent-empty muted small">
      <p>${name}'s own agent. It keeps a notebook for this story and has its own personality, both in <code>agent/chats/${name}/</code> (see Files).</p>
      <p>Ask it to comb old messages, retcon something, or note what to keep consistent. The notebook is never sent to the roleplay model.</p>
      <p>Like the main agent, it changes things only when you ask, and every change can be reverted.</p>
      ${state.settings?.agentProfileId ? "" : "<p><strong>First pick a profile for it in Settings → Agent.</strong></p>"}
    </div>`;
    return;
  }
  if (!view) {
    log.innerHTML = `<div class="agent-empty muted small">
      <p>Ask the agent to read, search or revise your cards, prompts and chats, or to draft something into its notes.</p>
      <p>It changes things only when you ask. Every change shows here as a diff you can revert.</p>
      ${state.settings?.agentProfileId ? "" : "<p><strong>First pick a profile for it in Settings → Agent.</strong></p>"}
    </div>`;
    return;
  }
  const results = new Map(view.messages.filter((m) => m.role === "tool").map((m) => [m.toolCallId, m]));
  const editsByTurn = new Map();
  for (const e of [...view.edits].reverse()) {
    if (!editsByTurn.has(e.turnId)) editsByTurn.set(e.turnId, []);
    editsByTurn.get(e.turnId).push(e);
  }
  const html = [];
  const turns = [];
  for (const m of view.messages) {
    if (turns.at(-1)?.id !== m.turnId) turns.push({ id: m.turnId, messages: [] });
    turns.at(-1).messages.push(m);
  }
  const lastTurn = turns.at(-1)?.id;
  for (const turn of turns) {
    for (const m of turn.messages) {
      if (m.role === "user") html.push(`<div class="agent-msg user">${formatText(m.content)}</div>`);
      if (m.role === "assistant") {
        if (m.content.trim()) html.push(`<div class="agent-msg assistant">${formatText(m.content)}</div>`);
        for (const call of m.toolCalls ?? []) {
          const args = parseArgs(call.function.arguments);
          const result = results.get(call.id);
          if (call.function.name === "ask_user") {
            const live = turn.id === lastTurn && !agent.busy;
            html.push(`<div class="agent-ask"><p>${escapeHtml(args.question ?? "")}</p><div class="agent-options">${(args.options ?? [])
              .map(
                (o) =>
                  `<button type="button" class="button agent-option" data-answer="${escapeHtml(o.label ?? "")}" ${live ? "" : "disabled"}>${escapeHtml(o.label ?? "")}${
                    o.description ? `<span class="muted small">${escapeHtml(o.description)}</span>` : ""
                  }</button>`,
              )
              .join("")}</div></div>`);
            continue;
          }
          const failed = result?.content.startsWith("Error:");
          html.push(`<details class="agent-tool${failed ? " failed" : ""}"><summary>${escapeHtml(callSummary(call.function.name, args))}${failed ? " (failed)" : ""}</summary><pre>${escapeHtml(
            result?.content ?? "(no result)",
          )}</pre></details>`);
        }
      }
    }
    const edits = editsByTurn.get(turn.id);
    if (edits?.length) {
      const open = edits.filter((e) => !e.revertedAt).length;
      html.push(`<div class="agent-turn-edits"><div class="agent-edit-head"><strong class="small">${edits.length} change${edits.length === 1 ? "" : "s"} this turn</strong><span class="spacer"></span>${
        open > 1 ? `<button type="button" class="button small-button" data-revert-turn="${turn.id}">Revert all ${open}</button>` : ""
      }</div>${edits.map(editHtml).join("")}</div>`);
    }
  }
  if (agent.busy) html.push(`<div class="agent-msg assistant muted">Working…</div>`);
  log.innerHTML = html.join("");
  log.scrollTop = log.scrollHeight;
}

async function renderChanges() {
  const list = $("agent-changes");
  list.innerHTML = `<p class="muted small">Loading…</p>`;
  const edits = await attempt(() => api("GET", "/api/agent/edits"));
  if (!edits) return;
  agent.edits = edits;
  list.innerHTML = edits.length ? edits.map((e) => `<div class="muted small agent-when">${new Date(e.createdAt).toLocaleString()}</div>${editHtml(e)}`).join("") : `<p class="muted small">No changes yet.</p>`;
}

function renderFiles() {
  const box = $("agent-files");
  if (agent.filePath !== null) {
    const known = agent.files.find((f) => f.path === agent.filePath);
    box.innerHTML = `<div class="row"><button type="button" class="button small-button" data-files-back>← Files</button><span class="small agent-file-name">${escapeHtml(
      known ? known.display : "New file",
    )}</span></div>
      ${known ? "" : `<label class="field small">Path (under agent/) <input id="agent-file-path" placeholder="notes/draft.md" /></label>`}
      <textarea id="agent-file-text" rows="18"></textarea>
      <div class="row end">${known ? `<button type="button" class="button danger" data-file-delete>Delete</button>` : ""}<span class="spacer"></span><span class="muted small" id="agent-file-status"></span><button type="button" class="button primary" data-file-save>Save</button></div>`;
    if (known) attempt(() => api("GET", `/api/agent/files?path=${encodeURIComponent(known.path)}`)).then((f) => f && ($("agent-file-text").value = f.content));
    return;
  }
  box.innerHTML = `<p class="muted small">The agent's own files. It reads <code>index.md</code> and <code>personality.md</code> at the start of every session, and a chat's <code>notebook.md</code> when that chat is open.</p>
    <ul class="agent-file-list">${agent.files
      .map((f) => `<li><button type="button" class="link-button" data-file="${escapeHtml(f.path)}">${escapeHtml(f.display.replace(/^agent\//, ""))}</button> <span class="muted small">${f.size} chars</span></li>`)
      .join("")}</ul>
    <button type="button" class="button" data-file-new>New file</button>`;
}

// ---------------------------------------------------------------- act

async function send(text) {
  text = text.trim();
  if (!text || agent.busy) return;
  if (!agent.sessionId) {
    const s = await attempt(() => api("POST", "/api/agent/sessions", { chatId: state.chatId, scope: agent.mode }));
    if (!s) return;
    agent.sessionId = s.id;
    lastSessions[owner()] = s.id;
    remember("anoesia.agentSessions", lastSessions);
    agent.view = { session: s, messages: [], edits: [] };
  }
  const id = agent.sessionId;
  agent.busy = true;
  // Show your message right away.
  agent.view.messages.push({ id: "pending", turnId: "pending", role: "user", content: text });
  $("agent-input").value = "";
  renderChat();
  let view;
  try {
    view = await api("POST", `/api/agent/sessions/${id}/send`, { content: text, chatId: state.chatId });
  } catch (error) {
    view = await api("GET", `/api/agent/sessions/${id}`).catch(() => agent.view);
    view.error = error.message;
    if (!view.messages.some((m) => m.role === "user" && m.content === text)) $("agent-input").value = text;
  }
  agent.busy = false;
  if (agent.sessionId === id) agent.view = view;
  await refreshList();
  renderAll();
  $("agent-error").textContent = view.error ?? "";
  $("agent-error").hidden = !view.error;
  if (view.edits?.length) await refreshApp();
}

/** The agent may have changed cards, prompts or messages: show them as they are now. */
async function refreshApp() {
  await loadState();
  renderSide();
  if (state.chatId) {
    await openChat(state.chatId);
    // openChat only loads; draw the messages so the agent's edits show at once.
    renderRoleplay();
  }
}

async function revert(path, label) {
  let result;
  try {
    result = await api("POST", path, {});
  } catch (error) {
    if (!/changed since/.test(error.message)) {
      $("agent-error").textContent = error.message;
      $("agent-error").hidden = false;
      return;
    }
    if (!confirm(`${error.message}\n\n${label}`)) return;
    result = await attempt(() => api("POST", path, { force: true }));
    if (!result) return;
  }
  if (agent.sessionId) agent.view = await attempt(() => api("GET", `/api/agent/sessions/${agent.sessionId}`));
  renderAll();
  await refreshApp();
}

export function wireAgent() {
  $("open-agent").addEventListener("click", () => toggleAgent());
  $("open-agent-phone").addEventListener("click", () => toggleAgent());
  $("agent-close").addEventListener("click", () => toggleAgent(false));
  $("agent-new").addEventListener("click", newSession);
  $("agent-session").addEventListener("change", (e) => openSession(e.target.value || null));
  for (const b of document.querySelectorAll("[data-agent-mode]"))
    b.addEventListener("click", async () => {
      if (agent.busy || agent.mode === b.dataset.agentMode) return;
      agent.mode = b.dataset.agentMode;
      remember("anoesia.agentMode", agent.mode);
      await refreshList();
      await pickSession();
    });
  // Another chat opened: a chat's agent belongs to its chat, so follow it.
  document.addEventListener("anoesia:chat-opened", async () => {
    if (!agent.open || agent.busy) return;
    if (agent.mode === "chat") {
      await refreshList();
      await pickSession();
    } else renderAll();
  });
  for (const t of document.querySelectorAll("[data-agent-tab]"))
    t.addEventListener("click", async () => {
      agent.tab = t.dataset.agentTab;
      if (agent.tab === "files") {
        agent.filePath = null;
        await refreshList();
      }
      renderAll();
    });
  $("agent-form").addEventListener("submit", (e) => {
    e.preventDefault();
    send($("agent-input").value);
  });
  $("agent-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer: fine)").matches) {
      e.preventDefault();
      send($("agent-input").value);
    }
  });
  $("agent-stop").addEventListener("click", () => agent.sessionId && api("POST", `/api/agent/sessions/${agent.sessionId}/stop`).catch(() => {}));

  $("agent-panel").addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.answer !== undefined) return send(t.dataset.answer);
    if (t.dataset.revert) return revert(`/api/agent/edits/${t.dataset.revert}/revert`, "Revert anyway?");
    if (t.dataset.revertTurn) return revert(`/api/agent/turns/${t.dataset.revertTurn}/revert`, "Revert the whole turn anyway?");
    if (t.dataset.file !== undefined) {
      agent.filePath = t.dataset.file;
      return renderFiles();
    }
    if (t.dataset.fileNew !== undefined) {
      agent.filePath = "";
      return renderFiles();
    }
    if (t.dataset.filesBack !== undefined) {
      agent.filePath = null;
      await refreshList();
      return renderFiles();
    }
    if (t.dataset.fileSave !== undefined) {
      const path = agent.filePath || $("agent-file-path")?.value.trim().replace(/^agent\//, "");
      const saved = await attempt(() => api("PUT", "/api/agent/files", { path, content: $("agent-file-text").value }));
      if (!saved) return;
      await refreshList();
      agent.filePath = saved.path;
      renderFiles();
      $("agent-file-status").textContent = "Saved";
      return;
    }
    if (t.dataset.fileDelete !== undefined) {
      if (!confirm("Delete this file?")) return;
      await attempt(() => api("DELETE", `/api/agent/files?path=${encodeURIComponent(agent.filePath)}`));
      agent.filePath = null;
      await refreshList();
      return renderFiles();
    }
  });
}
