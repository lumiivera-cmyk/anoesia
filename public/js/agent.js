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

import { $, api, attempt, escapeHtml, formatText, loadState, sendsOnEnter, state } from "./core.js";
import { openChat, readEvents, renderChat as renderRoleplay } from "./chat.js";
import { icon } from "./icons.js";
import { confirmDialog } from "./overlay.js";
import { reloadPrompts } from "./prompts.js";
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
  /** The reply being written right now ({ reasoning, content }), while a turn runs. */
  live: null,
  /** Stop was pressed and the turn hasn't ended yet. */
  stopping: false,
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

/** Open the panel on one of its tabs (Settings → Agent's "open notes" and "open the log"). */
export async function openAgentTab(tab) {
  agent.tab = tab;
  if (tab === "files") agent.filePath = null;
  await toggleAgent(true);
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
  if (agent.sessionId !== id) return;
  agent.busy = Boolean(agent.view?.busy);
  agent.live = agent.busy ? { reasoning: "", content: "" } : null;
  renderAll();
  // A turn still running (the page was reloaded, the phone slept): watch it.
  if (agent.busy) follow(id, (signal) => fetch(`api/agent/sessions/${id}/live`, { signal }));
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

/** Your messages and the agent's answers, grouped: each of yours, then its answers (the one shown, and earlier versions). */
function exchanges(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "user" || !out.length) out.push({ user: m.role === "user" ? m : null, runs: [] });
    if (m.role === "user") continue;
    const ex = out.at(-1);
    let run = ex.runs.find((r) => r.turnId === m.turnId);
    if (!run) ex.runs.push((run = { turnId: m.turnId, messages: [], hidden: m.hidden }));
    run.messages.push(m);
  }
  return out;
}

function toolHtml(call, result, live) {
  const args = parseArgs(call.function.arguments);
  if (call.function.name === "ask_user") {
    return `<div class="agent-ask"><p>${escapeHtml(args.question ?? "")}</p><div class="agent-options">${(args.options ?? [])
      .map(
        (o) =>
          `<button type="button" class="button agent-option" data-answer="${escapeHtml(o.label ?? "")}" ${live ? "" : "disabled"}>${escapeHtml(o.label ?? "")}${
            o.description ? `<span class="muted small">${escapeHtml(o.description)}</span>` : ""
          }</button>`,
      )
      .join("")}</div></div>`;
  }
  const failed = result?.content.startsWith("Error:");
  return `<details class="agent-tool${failed ? " failed" : ""}"><summary>${escapeHtml(callSummary(call.function.name, args))}${failed ? " (failed)" : ""}</summary><pre>${escapeHtml(
    result?.content ?? "(no result)",
  )}</pre></details>`;
}

const ACT_ICONS = { copy: () => icon.copy(), edit: () => icon.edit(), branch: () => icon.branch(), rewind: () => icon.rewind(), reroll: () => icon.regen() };

function actButton(act, id, label, svg = ACT_ICONS[act]()) {
  return `<button type="button" class="ghost press ib agent-act" data-agent-act="${act}" data-id="${id}" aria-label="${label}" title="${label}">${svg}</button>`;
}

/** A message's actions. The last answer's stay shown, with its versions and reroll; the rest show on hover, or on a tap on a phone. */
function actsHtml(acts, last, id, runs = null) {
  const versions =
    runs && runs.length > 1
      ? (() => {
          const at = runs.findIndex((r) => !r.hidden);
          return `<span class="sunk versions"><button type="button" class="ghost press ib" data-agent-version="${at - 1}" aria-label="Previous version" ${at === 0 ? 'aria-disabled="true"' : ""}>${icon.left()}</button><span class="vcount">${at + 1} / ${runs.length}</span><button type="button" class="ghost press ib" data-agent-version="${at + 1}" aria-label="Next version" ${at === runs.length - 1 ? 'aria-disabled="true"' : ""}>${icon.right()}</button></span>`;
        })()
      : "";
  const reroll = runs ? actButton("reroll", id, "Reroll: undo what it did and answer again") : "";
  return `<div class="agent-acts${last ? " shown" : ""}">${acts.map(([act, mid, label]) => actButton(act, mid, label)).join("")}<span class="spacer"></span>${versions}${reroll}</div>`;
}

function renderChat() {
  const log = $("agent-log");
  const view = agent.view;
  $("agent-stop").hidden = !agent.busy;
  $("agent-stop").disabled = agent.stopping;
  $("agent-stop").textContent = agent.stopping ? "Stopping…" : "Stop";
  $("agent-send").hidden = agent.busy;
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
      ${state.settings?.agentProfileId ? "" : "<p><strong>First pick a profile for it in Settings → Connections.</strong></p>"}
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
  const all = exchanges(view.messages);
  all.forEach((ex, i) => {
    const isLast = i === all.length - 1;
    const shown = ex.runs.find((r) => !r.hidden);
    const answering = isLast && agent.busy;
    if (ex.user) {
      html.push(`<div class="agent-ex-user" data-msg="${ex.user.id}"><div class="agent-msg user" data-text-of="${ex.user.id}">${formatText(ex.user.content)}</div>${
        ex.user.id === "pending" || answering ? "" : actsHtml([["copy", ex.user.id, "Copy"], ["edit", ex.user.id, "Edit and send again"]], isLast && !shown, ex.user.id)
      }</div>`);
    }
    if (!shown) {
      // Stopped before it wrote anything: it can still be answered again.
      if (isLast && ex.user && !agent.busy && ex.runs.length === 0) html.push(`<div class="agent-acts shown">${actButton("reroll", ex.user.id, "Answer again", icon.regen())}</div>`);
      return;
    }
    html.push(`<div class="agent-run${isLast ? " last" : ""}" data-run="${shown.turnId}">`);
    for (const m of shown.messages) {
      if (m.role !== "assistant") continue;
      if (m.content.trim()) html.push(`<div class="agent-msg assistant" data-text-of="${m.id}">${formatText(m.content)}</div>`);
      for (const call of m.toolCalls ?? []) html.push(toolHtml(call, results.get(call.id), isLast && !agent.busy));
    }
    const edits = editsByTurn.get(shown.turnId);
    if (edits?.length) {
      const open = edits.filter((e) => !e.revertedAt).length;
      html.push(`<div class="agent-turn-edits"><div class="agent-edit-head"><strong class="small">${edits.length} change${edits.length === 1 ? "" : "s"} this turn</strong><span class="spacer"></span>${
        open > 1 ? `<button type="button" class="button small-button" data-revert-turn="${shown.turnId}">Revert all ${open}</button>` : ""
      }</div>${edits.map(editHtml).join("")}</div>`);
    }
    if (!answering) {
      const words = [...shown.messages].reverse().find((m) => m.role === "assistant" && !m.toolCalls?.length && m.content.trim());
      const end = shown.messages.at(-1);
      const acts = [
        ...(words ? [["copy", words.id, "Copy"], ["edit", words.id, "Edit"]] : []),
        ["branch", end.id, "Branch from here"],
        ...(isLast ? [] : [["rewind", end.id, "Rewind to here"]]),
      ];
      html.push(actsHtml(acts, isLast, end.id, isLast ? ex.runs : null));
    }
    html.push(`</div>`);
  });
  if (agent.busy) html.push(liveHtml());
  const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.innerHTML = html.join("");
  if (agent.busy) drawLive();
  if (atEnd || !agent.busy) log.scrollTop = log.scrollHeight;
}

// ------------------------------------------------------------ the live reply

/** The agent's reply as it's written: its thinking in a fold, then the text with a caret. */
function liveHtml() {
  return `<div class="agent-live" aria-busy="true">
    <div class="agent-live-status muted small" role="status" data-live-status></div>
    <details class="thinking" data-live-thinking hidden${foldOpen ? " open" : ""}><summary>${icon.right(14)}<span data-live-thinking-label>thinking</span></summary><div class="thinking-body" data-live-reasoning></div></details>
    <div class="agent-msg assistant" data-live-text hidden></div>
  </div>`;
}

/** Whether you've opened or closed the live fold yourself, and whether it's open. */
let foldTouched = false;
let foldOpen = true;
let drawQueued = false;

function queueLive() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    const log = $("agent-log");
    const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    drawLive();
    if (atEnd) log.scrollTop = log.scrollHeight;
  });
}

function drawLive() {
  const box = $("agent-log");
  const fold = box.querySelector("[data-live-thinking]");
  if (!fold) return;
  const live = agent.live ?? { reasoning: "", content: "" };
  const caret = `<span class="caret" aria-hidden="true">▍</span>`;
  const status = agent.stopping ? "stopping" : live.content ? "writing" : live.reasoning ? "thinking" : "working";
  box.querySelector("[data-live-status]").innerHTML = `${status}${live.content ? "" : caret}`;
  fold.hidden = !live.reasoning;
  if (live.reasoning) {
    box.querySelector("[data-live-thinking-label]").textContent = live.content ? "reasoning" : "thinking";
    const body = box.querySelector("[data-live-reasoning]");
    const following = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    body.innerHTML = formatText(live.reasoning);
    if (following) body.scrollTop = body.scrollHeight;
    if (live.content && fold.open && !foldTouched) fold.open = false;
  }
  const text = box.querySelector("[data-live-text]");
  text.hidden = !live.content;
  if (live.content) {
    const html = formatText(live.content);
    const end = html.endsWith("</p></div>") ? html.lastIndexOf("</p>") : -1;
    text.innerHTML = end >= 0 ? `${html.slice(0, end)}${caret}${html.slice(end)}` : html + caret;
  }
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
  // Show your message right away.
  agent.view.messages.push({ id: "pending", turnId: "pending", role: "user", content: text, hidden: false });
  $("agent-input").value = "";
  const sent = await startRun(id, `api/agent/sessions/${id}/send`, { content: text, chatId: state.chatId });
  // Refused before it started (no profile yet, say): your words go back in the box.
  if (sent === "refused" && !$("agent-input").value) $("agent-input").value = text;
}

/**
 * Run a turn (a message, a reroll, an edited message sent again) and show it
 * as it's written. A conflict (something the old answer changed was changed
 * again since) asks first, then goes ahead with force.
 */
async function startRun(id, path, body) {
  agent.busy = true;
  agent.live = { reasoning: "", content: "" };
  foldTouched = false;
  foldOpen = true;
  showError(null);
  renderChat();
  const open = (b) => (signal) => fetch(`${path}?stream=1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal });
  let result = await follow(id, open(body));
  if (result === "conflict") {
    const ok = await confirmDialog({ title: "Undo it anyway?", body: [lastConflict], confirm: "undo anyway", keep: "leave it", icon: icon.regen(16) });
    if (!ok) return result;
    agent.busy = true;
    agent.live = { reasoning: "", content: "" };
    renderChat();
    result = await follow(id, open({ ...body, force: true }));
  }
  return result;
}

function showError(message) {
  $("agent-error").textContent = message ?? "";
  $("agent-error").hidden = !message;
}

/** Why the last turn was refused as a conflict (see `follow`). */
let lastConflict = "";

/** Which turn this panel is watching (one at a time), so a stream from a session you've left is let go. */
let watching = null;

/**
 * Follow a turn's events (see the server's `watch`) until it's done. If the
 * connection drops first (the phone slept, the network blinked) and the turn
 * is still running, watch it again from where it is. Returns "done",
 * "refused" (it never started: the reason is shown) or "lost".
 */
async function follow(id, open) {
  watching?.abort();
  const me = new AbortController();
  watching = me;
  const mine = () => watching === me && agent.sessionId === id;
  const editsAtStart = agent.view?.edits?.length ?? 0;
  let editsSeen = editsAtStart;
  let result = "lost";
  for (let tries = 0; result === "lost" && tries < 6 && mine(); tries++) {
    if (tries) await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** tries, 8000)));
    if (!mine()) break;
    let response;
    try {
      response = await (tries === 0 ? open(me.signal) : fetch(`api/agent/sessions/${id}/live`, { signal: me.signal }));
    } catch {
      continue;
    }
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const data = await response.json().catch(() => null);
      if (response.status === 401 && data?.login) location.href = "login";
      // Something it changed was changed again since: the caller asks before going ahead.
      if (response.status === 409) {
        lastConflict = data?.error ?? "";
        result = "conflict";
        break;
      }
      if (mine()) showError(data?.error ?? `The server answered ${response.status}.`);
      result = "refused";
      break;
    }
    try {
      const done = await readEvents(response, (event) => {
        if (!mine()) return;
        if (event.type === "start" || event.type === "saved") {
          const { type, live, ...view } = event;
          agent.view = view;
          agent.live = live ?? { reasoning: "", content: "" };
          renderChat();
          // The agent changed something: show it in the app as it happens.
          if ((view.edits?.length ?? 0) !== editsSeen) {
            editsSeen = view.edits?.length ?? 0;
            refreshApp();
          }
        } else if (event.type === "more") {
          agent.live ??= { reasoning: "", content: "" };
          agent.live.reasoning += event.reasoning ?? "";
          agent.live.content += event.content ?? "";
          queueLive();
        } else if (event.type === "reply") {
          agent.live = { reasoning: event.reasoning ?? "", content: event.content ?? "" };
          queueLive();
        } else if (event.type === "done") {
          const { type, error, ...view } = event;
          agent.view = view;
          if (error && !/stopped/i.test(error)) showError(error);
          if ((view.edits?.length ?? 0) !== editsSeen) refreshApp();
        }
      });
      if (done) result = "done";
    } catch {
      // dropped: try again
    }
  }
  if (watching === me) watching = null;
  if (agent.sessionId === id) {
    agent.busy = false;
    agent.stopping = false;
    agent.live = null;
    if (result !== "done") agent.view = (await api("GET", `/api/agent/sessions/${id}`).catch(() => null)) ?? agent.view;
    await refreshList();
    renderAll();
  }
  return result;
}

async function stop() {
  if (!agent.sessionId || !agent.busy || agent.stopping) return;
  agent.stopping = true;
  renderChat();
  await api("POST", `/api/agent/sessions/${agent.sessionId}/stop`).catch(() => {});
}

/** The agent may have changed cards, prompts or messages: show them as they are now. */
async function refreshApp() {
  await loadState();
  renderSide();
  if (state.chatId) {
    await openChat(state.chatId);
    // openChat only loads; draw the messages so the agent's edits show at once.
    renderRoleplay();
    // An open prompts page shows the agent's block edits too.
    await reloadPrompts();
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

/** Do something that may undo the agent's changes; when one was changed again since, ask, then do it anyway. Shows the session after. */
async function withForce(call, question) {
  let view;
  try {
    view = await call(false);
  } catch (error) {
    if (!/changed since/.test(error.message)) return showError(error.message);
    const ok = await confirmDialog({ title: question, body: [error.message], confirm: "go ahead", keep: "leave it", icon: icon.regen(16) });
    if (!ok) return;
    view = await attempt(() => call(true));
  }
  if (!view) return;
  showError(null);
  if (view.session?.id === agent.sessionId) agent.view = view;
  renderAll();
  await refreshApp();
}

const messageById = (id) => agent.view?.messages.find((m) => m.id === id);

async function act(what, id, button) {
  const m = messageById(id);
  if (!m || agent.busy) return;
  if (what === "copy") {
    const ok = await navigator.clipboard?.writeText(m.content).then(() => true, () => false);
    if (!ok) return showError("Couldn't copy. Your browser blocked the clipboard.");
    button.innerHTML = icon.check();
    setTimeout(() => (button.innerHTML = icon.copy()), 1400);
    return;
  }
  if (what === "edit") return startEdit(m);
  if (what === "reroll") return startRun(agent.sessionId, `api/agent/sessions/${agent.sessionId}/reroll`, { chatId: state.chatId });
  if (what === "branch") return branchFrom(m);
  if (what === "rewind") {
    const count = (await attempt(() => api("GET", `/api/agent/messages/${m.id}/rewind`)))?.changes ?? 0;
    const ok = await confirmDialog({
      title: "Rewind to here?",
      body: [
        "Everything after this goes for good.",
        count ? `The ${count === 1 ? "change" : `${count} changes`} the agent made after it ${count === 1 ? "is" : "are"} undone.` : "The agent made no changes after it, so nothing else is undone.",
      ],
      confirm: "rewind",
      keep: "keep them",
      alt: "branch instead",
      icon: icon.rewind(16),
      opener: button,
    });
    if (ok === "alt") return branchFrom(m);
    if (!ok) return;
    return withForce((force) => api("POST", `/api/agent/messages/${m.id}/rewind`, { force }), "Rewind anyway?");
  }
}

async function branchFrom(m) {
  const view = await attempt(() => api("POST", `/api/agent/messages/${m.id}/branch`, {}));
  if (!view) return;
  await refreshList();
  await openSession(view.session.id);
}

/** Edit a message in place: yours is sent again (what came after it is rewound), the agent's words are just changed. */
function startEdit(m) {
  const box = $("agent-log").querySelector(`[data-text-of="${m.id}"]`);
  if (!box) return;
  const yours = m.role === "user";
  box.classList.add("editing");
  box.innerHTML = `<form class="agent-edit-form"><label class="sr" for="agent-edit-${m.id}">${yours ? "Edit your message" : "Edit the agent's reply"}</label>
    <textarea id="agent-edit-${m.id}">${escapeHtml(m.content)}</textarea>
    <div class="row end"><button type="button" class="btn ghost press" data-edit-cancel>cancel</button><button type="submit" class="btn btn-primary press">${yours ? "send again" : "save"}</button></div></form>`;
  const form = box.querySelector("form");
  const area = form.querySelector("textarea");
  const fit = () => {
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight + 4}px`;
  };
  area.addEventListener("input", fit);
  fit();
  area.focus();
  form.querySelector("[data-edit-cancel]").addEventListener("click", () => renderChat());
  area.addEventListener("keydown", (e) => {
    if (e.key === "Escape") renderChat();
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const content = area.value.trim();
    if (!content) return;
    if (!yours) return withForce(() => api("PATCH", `/api/agent/messages/${m.id}`, { content }), "Save anyway?");
    const later = exchanges(agent.view.messages).findIndex((ex) => ex.user?.id === m.id) < exchanges(agent.view.messages).length - 1;
    const count = (await attempt(() => api("GET", `/api/agent/messages/${m.id}/rewind`)))?.changes ?? 0;
    if (later || count) {
      const ok = await confirmDialog({
        title: "Send it again from here?",
        body: [
          later ? "Everything after this message goes for good, and it's answered again." : "It's answered again, in place of the answer it has.",
          count ? `The ${count === 1 ? "change" : `${count} changes`} the agent made in reply ${count === 1 ? "is" : "are"} undone.` : "",
        ].filter(Boolean),
        confirm: "send again",
        keep: "cancel",
        icon: icon.regen(16),
      });
      if (!ok) return;
    }
    startRun(agent.sessionId, `api/agent/messages/${m.id}/resend`, { content, chatId: state.chatId });
  });
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
    if (sendsOnEnter(e)) {
      e.preventDefault();
      send($("agent-input").value);
    }
  });
  $("agent-stop").addEventListener("click", stop);
  // Opening or closing the live thinking yourself keeps it as you left it.
  $("agent-log").addEventListener("click", (e) => {
    // On a touch screen, a tap on a message shows its actions.
    if (!e.target.closest("button, a, details, form, textarea")) {
      const holder = e.target.closest(".agent-run, .agent-ex-user");
      if (holder) {
        const was = holder.classList.contains("show-acts");
        for (const el of $("agent-log").querySelectorAll(".show-acts")) el.classList.remove("show-acts");
        holder.classList.toggle("show-acts", !was);
      }
    }
    if (e.target.closest("[data-live-thinking] summary")) {
      foldTouched = true;
      foldOpen = !e.target.closest("details").open;
    }
  });

  $("agent-panel").addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.answer !== undefined) return send(t.dataset.answer);
    if (t.dataset.agentAct) return act(t.dataset.agentAct, t.dataset.id, t);
    if (t.dataset.agentVersion !== undefined) {
      if (t.getAttribute("aria-disabled") === "true") return;
      return withForce((force) => api("POST", `/api/agent/sessions/${agent.sessionId}/version`, { index: Number(t.dataset.agentVersion), force }), "Switch anyway?");
    }
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
