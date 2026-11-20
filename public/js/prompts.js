/**
 * The prompts page: every block of the open chat's prompt, in send order,
 * and beside it (or behind a tab, on narrower screens) the preview.
 *
 * A card's fields sit in a folder named after the card, and the folder
 * moves as one. Any field can be dragged out; it then says "moved out of
 * its folder". A block with a depth sits inside the chat history, that
 * many messages from the end, with − and + to move it.
 *
 * Every block, folder and the history has a grip strip (the bumps) on its
 * left edge, the only drag handle. Drag it with a mouse or finger; or focus
 * it, press Space to pick up, arrows to move, Space to drop, Esc to cancel;
 * or tap it for the move menu.
 *
 * An open block's text is the editor: type in it and it saves itself a
 * moment after you stop (or as soon as you leave the box). Anything else
 * that changes blocks (role, switch, drag, the agent) saves typed text first.
 */

import { $, api, approxTokens, attempt, cardById, escapeHtml, fmt, gem, isPhone, loadState, macroHtml, personaOf, state, timeLabel, tokChip } from "./core.js";
import { macroBarHtml, unknownNote, wireMacroBar } from "./editor.js";
import { icon } from "./icons.js";
import { closeOverlay, confirmDialog, openOverlay } from "./overlay.js";

let blocks = [];
let preview = null;
/** Open blocks and folders: block ids, and `folder:<cardId>`. */
const open = new Set();
/** Typed text not saved yet, by block id: { timer, dirty, saving }. */
const pending = new Map();
/** The block whose text was last focused: its macro bar shows. */
let active = null;
/** How long typing pauses before it saves. */
const SAVE_AFTER = 800;
let tab = "blocks";
let pvView = "blocks";
let pvAll = false;
/** Known context sizes, by model id. */
const contexts = new Map();

export async function showPrompts(startTab = "blocks") {
  tab = startTab;
  await flushAll();
  active = null;
  const loaded = await attempt(() => api("GET", `/api/chats/${state.chatId}/blocks`));
  if (!loaded) return;
  blocks = loaded;
  render();
  setTab(tab);
  await refreshPreview();
  loadContext();
}

// --------------------------------------------------------------- the layout

/**
 * The page's top-level items in order: folders (a card's longest run of
 * fields), lone blocks (a field out of its folder is one), and the history.
 * Blocks with a depth live inside the history instead.
 */
function units() {
  const flat = blocks.filter((b) => b.depth === null || b.kind === "history");
  const runs = [];
  for (const b of flat) {
    const last = runs.at(-1);
    if (b.kind === "field" && last?.cardId === b.cardId) last.blocks.push(b);
    else runs.push({ cardId: b.kind === "field" ? b.cardId : null, blocks: [b] });
  }
  const home = new Map();
  runs.forEach((r, i) => {
    if (r.cardId && (!home.has(r.cardId) || r.blocks.length > runs[home.get(r.cardId)].blocks.length)) home.set(r.cardId, i);
  });
  return runs.flatMap((r, i) =>
    r.cardId && home.get(r.cardId) === i
      ? [{ type: "folder", key: `folder:${r.cardId}`, cardId: r.cardId, blocks: r.blocks }]
      : r.blocks.map((b) => ({ type: b.kind === "history" ? "history" : "block", key: b.id, cardId: b.cardId, blocks: [b], movedOut: b.kind === "field" })),
  );
}

const inHistory = () => blocks.filter((b) => b.depth !== null && b.kind !== "history");
const isEmpty = (b) => b.kind !== "history" && !b.content.trim();
/** A field of an offstage card, other than its Description: kept here, not sent (src/prompt.ts heldBack). */
const isHeld = (b) => b.kind === "field" && b.offstage && cardById(b.cardId)?.fields.find((f) => f.id === b.fieldId)?.key !== "description";
const tokens = (b) => (b.enabled && !isEmpty(b) && !isHeld(b) ? approxTokens(b.content) : 0);
/** What each chat note is for. */
const NOTE_HINTS = { "Right now": "where the story stands", "Who knows what": "one line per secret" };

function blockName(b) {
  if (b.kind === "field") {
    const card = cardById(b.cardId);
    const t = fieldTitle(b);
    return card ? `${card.name}'s ${t}` : t;
  }
  return b.title;
}

/** Base fields read in lower case, as on the boards; your own fields as you named them. */
function fieldTitle(b) {
  const card = cardById(b.cardId);
  const f = card?.fields.find((x) => x.id === b.fieldId);
  return f && f.key !== "custom" ? b.title.toLowerCase() : b.title;
}

function kindLine(card) {
  return card.isPersona ? "persona" : card.isCharacter ? "character" : "world, not in cast";
}

function sourceLine(b, movedOut) {
  if (b.kind === "main") return "main prompt · shared by every chat";
  if (b.kind === "text") return "this chat's own";
  if (b.kind === "note") return `this chat's note · ${isEmpty(b) ? "empty, not sent" : (NOTE_HINTS[b.title] ?? "this chat only")}`;
  if (b.kind === "field") {
    const card = cardById(b.cardId);
    const state = isHeld(b) ? " · offstage in this chat, not sent" : isEmpty(b) ? " · empty, not sent" : "";
    return `from ${card ? `${card.name}'s` : "a"} card${movedOut ? " · moved out of its folder" : ""}${state}`;
  }
  return "";
}

// ---------------------------------------------------------------- drawing

function render() {
  const chat = state.chat;
  $("prompts-back").setAttribute("aria-label", `Back to ${chat.name}`);
  $("prompts-back").href = `#/chat/${chat.id}`;
  $("prompts-meta").textContent = isPhone() ? chat.name : `${chat.name} · send order for this chat · drag the bumps to reorder`;
  const list = units();
  // Redrawing replaces the text boxes: keep the one being typed in focused, caret and all.
  const was = document.activeElement?.closest?.("#block-list") ? document.activeElement : null;
  const keep = was?.id && /^(text|title)-/.test(was.id) ? { id: was.id, start: was.selectionStart, end: was.selectionEnd, scroll: was.scrollTop } : null;
  $("block-list").innerHTML = list
    .map((u, i) => `<li data-unit="${u.key}" data-index="${i}">${u.type === "folder" ? folderHtml(u) : u.type === "history" ? historyHtml(u.blocks[0]) : blockHtml(u.blocks[0], { movedOut: u.movedOut && u.type === "block" })}</li>`)
    .join("");
  for (const area of $("block-list").querySelectorAll("textarea[data-text-of]")) autosize(area);
  const back = keep && document.getElementById(keep.id);
  if (back) {
    back.focus({ preventScroll: true });
    back.setSelectionRange(keep.start, keep.end);
    back.scrollTop = keep.scroll;
  }
  renderMeter();
}

function roleButton(b) {
  return `<button type="button" class="role press role-${b.role}" data-role="${b.id}" aria-haspopup="menu" aria-label="${escapeHtml(blockName(b))} role: ${b.role}. Change role">${b.role}${icon.caret()}</button>`;
}

function switchButton(id, on, label, attr = "data-switch") {
  return `<button type="button" role="switch" class="switch" aria-checked="${on}" aria-label="${escapeHtml(label)}" ${attr}="${id}"><span class="knob"></span></button>`;
}

function chev(key, isOpen, label) {
  return `<button type="button" class="chev" data-toggle="${key}" aria-expanded="${isOpen}" aria-label="Show ${escapeHtml(label)}">${icon.down()}</button>`;
}

function grip(key, label) {
  const how = isPhone() ? "Hold the bumps and drag, or tap them for move options" : "Drag the bumps, or press space and use the arrow keys";
  return `<button type="button" class="bumps" data-grip="${key}" aria-label="Move ${escapeHtml(label)}. ${how}"></button>`;
}

function blockIcon(b) {
  if (b.kind === "main") return `<span class="bicon" aria-hidden="true">${icon.main()}</span>`;
  if (b.kind === "text" || b.kind === "note") return `<span class="bicon" aria-hidden="true">${icon.text()}</span>`;
  return "";
}

function blockHtml(b, { movedOut = false, inFolder = false } = {}) {
  const card = b.kind === "field" ? cardById(b.cardId) : null;
  const title = b.kind === "field" ? (movedOut && card ? `${card.name} · ${fieldTitle(b)}` : fieldTitle(b)) : b.title;
  const name = blockName(b);
  const isOpen = open.has(b.id);
  const tok = tokChip(tokens(b), isEmpty(b) || isHeld(b));
  const src = sourceLine(b, movedOut);
  const snippet = inFolder && !isOpen && !isEmpty(b) ? `<div class="snippet">${escapeHtml(b.content.trim().split("\n")[0])}</div>` : "";
  const head = isPhone()
    ? `<div class="l1">${blockIcon(b)}<button type="button" class="ptitle" data-toggle="${b.id}" aria-expanded="${isOpen}"><span class="t">${escapeHtml(title)}</span><span class="src">${escapeHtml(src)}</span></button>${switchButton(b.id, b.enabled, name)}</div>
       <div class="l2">${roleButton(b)}${tok}<span class="grow"></span>${chev(b.id, isOpen, name)}</div>`
    : `<div class="bhead">${blockIcon(b)}<button type="button" class="btitle" data-toggle="${b.id}" aria-expanded="${isOpen}"><span class="t">${escapeHtml(title)}</span><span class="src">${escapeHtml(src)}</span></button>
       ${roleButton(b)}${tok}${switchButton(b.id, b.enabled, name)}${chev(b.id, isOpen, name)}</div>`;
  return `<div class="raised blk${isPhone() ? " prow" : ""}${b.enabled && !isHeld(b) ? "" : " is-off"}${isHeld(b) ? " is-held" : ""}" data-block="${b.id}">
    ${grip(b.id, name)}${head}${snippet}${isOpen ? bodyHtml(b) : ""}</div>`;
}

function folderHtml(u) {
  const card = cardById(u.cardId);
  const name = card?.name ?? "Card";
  const key = u.key;
  const isOpen = open.has(key);
  const on = u.blocks.some((b) => b.enabled);
  const sum = u.blocks.reduce((n, b) => n + tokens(b), 0);
  const offstage = u.blocks.some((b) => b.offstage);
  const src = `folder · ${card ? kindLine(card) : "card"} · ${offstage ? "offstage: description only" : `${u.blocks.length} block${u.blocks.length === 1 ? "" : "s"}`}`;
  const inner = isOpen ? `<div class="sunk ${isPhone() ? "pfwell" : "fwell"}" data-well="${u.cardId}"><ol class="well-list">${u.blocks.map((b) => `<li data-in="${b.id}">${blockHtml(b, { inFolder: true })}</li>`).join("")}</ol></div>` : "";
  const fIcon = `<span class="bicon" aria-hidden="true">${icon.folder(20, card)}</span>`;
  const head = isPhone()
    ? `<div class="l1">${fIcon}<button type="button" class="ptitle" data-toggle="${key}" aria-expanded="${isOpen}"><span class="t">${escapeHtml(name)}</span><span class="src">${escapeHtml(src)}</span></button>${switchButton(u.cardId, on, `${name} folder`, "data-folder-switch")}</div>
       <div class="l2">${tokChip(sum)}<span class="grow"></span>${chev(key, isOpen, `what's in ${name}'s folder`)}</div>`
    : `<div class="bhead">${fIcon}<button type="button" class="btitle" data-toggle="${key}" aria-expanded="${isOpen}"><span class="t">${escapeHtml(name)}</span><span class="src">${escapeHtml(src)}</span></button>
       ${tokChip(sum)}${switchButton(u.cardId, on, `${name} folder`, "data-folder-switch")}${chev(key, isOpen, `${name} folder`)}</div>`;
  return `<div class="raised blk folder${isPhone() ? " prow" : ""}${on ? "" : " is-off"}" data-folder="${u.cardId}">${grip(key, `${name} folder`)}${head}${inner}</div>`;
}

/** An open block: its text, editable right here, and its actions. */
function bodyHtml(b) {
  const id = `text-${b.id}`;
  const note = unknownNote(b.content);
  const placeLabel = b.depth === null ? "put it inside the chat history" : "take it out of the chat history";
  const empty = b.kind === "field" ? "Empty. An empty field isn't sent." : "Empty. Nothing is sent until it has text.";
  const where = b.kind === "field" ? `edits the card in every chat${isHeld(b) ? " · sent again when the card is onstage" : ""}` : b.kind === "main" ? "edits the main prompt in every chat" : b.kind === "note" ? "this chat only · also one tap from the chat's scene menu" : "this chat only";
  return `<div class="bbody${active === b.id ? " is-active" : ""}" data-body="${b.id}">
    ${b.kind === "text" ? `<label class="sr" for="title-${b.id}">Block title</label><div class="sunk well"><input id="title-${b.id}" class="inp" data-title-of="${b.id}" value="${escapeHtml(b.title)}" autocomplete="off" /></div>` : ""}
    <label class="sr" for="${id}">${escapeHtml(blockName(b))} text</label>
    <textarea id="${id}" class="sunk btext btext-edit" data-text-of="${b.id}" placeholder="${escapeHtml(empty)}">${escapeHtml(b.content)}</textarea>
    <p class="bnote warn" role="note" data-note-of="${b.id}"${note ? "" : " hidden"}>${icon.warn()}<span>${escapeHtml(note)}</span></p>
    <div class="macbar sunk" role="group" aria-label="Insert a macro">${macroBarHtml(id)}</div>
    <div class="bactions">
      <button type="button" class="btn ghost press" data-place="${b.id}">${placeLabel}</button>
      ${b.kind === "text" ? `<button type="button" class="btn btn-quiet-danger press" data-delete="${b.id}">${icon.trash(16)} delete block</button>` : ""}
      <span class="meta src-note">${where}</span><span class="grow"></span><span class="meta save-state" role="status" data-status-of="${b.id}"></span>
    </div>
  </div>`;
}

function historyHtml(h) {
  const msgs = state.messages;
  const n = msgs.length;
  const total = msgs.reduce((s, m) => s + approxTokens(m.content), 0);
  const slots = inHistory();
  const gapOf = (b) => Math.max(0, n - b.depth);
  const firstGap = slots.length ? Math.min(...slots.map(gapOf)) : n;
  const start = Math.max(0, Math.min(n - 3, firstGap));
  const persona = personaOf(state.chat);
  let lanes = start > 0 ? `<div class="lane-msg earlier"><span aria-hidden="true" class="lane-dot">⋮</span>${start} earlier message${start === 1 ? "" : "s"}</div>` : "";
  for (let g = start; g <= n; g++) {
    lanes += slots
      .filter((b) => gapOf(b) === g)
      .map((b) => slotHtml(b, n))
      .join("");
    if (g < n) {
      const m = msgs[g];
      const you = m.role === "user";
      lanes += `<div class="lane-msg">${you && persona ? gem(persona, 16, { label: false }) : `<span aria-hidden="true" class="lane-dot">◇</span>`}<span class="who">${escapeHtml(you ? (persona?.name ?? "you") : "narrator")}</span><span class="when">#${g + 1} · ${escapeHtml(timeLabel(m.createdAt))}</span><span class="x">${escapeHtml(m.content.split("\n")[0])}</span></div>`;
    }
  }
  if (!n && !slots.length) lanes = `<div class="lane-msg earlier">No messages yet.</div>`;
  return `<div class="sunk blk history${isPhone() ? " phist" : ""}" data-block="${h.id}">
    ${grip(h.id, "chat history")}
    <div class="bhead"><span class="bicon" aria-hidden="true">${icon.history()}</span>
      <span class="btitle static"><span class="t">Chat history</span><span class="src">${n} message${n === 1 ? "" : "s"}, oldest first · blocks with a depth sit inside it</span></span>${tokChip(total)}</div>
    <div class="lanes">${lanes}</div>
  </div>`;
}

function slotHtml(b, n) {
  const name = blockName(b);
  const where = b.depth === 0 ? "after the last message" : b.depth >= n ? "before the first message" : `lands before #${n - b.depth + 1}`;
  const atMin = b.depth <= 0;
  const atMax = b.depth >= n;
  const isOpen = open.has(b.id);
  return `<div class="slot-wrap" data-block="${b.id}"><div class="raised slot${b.enabled && !isHeld(b) ? "" : " is-off"}">
    <span class="bicon" aria-hidden="true">${b.kind === "field" ? icon.folder(16, cardById(b.cardId)) : icon.text(16)}</span>
    <button type="button" class="slot-title" data-toggle="${b.id}" aria-expanded="${isOpen}"><span class="t">${escapeHtml(b.kind === "field" ? name : b.title)}</span><span class="src">${escapeHtml(where)}</span></button>
    <span class="depth" role="group" aria-label="Depth for ${escapeHtml(name)}"><span class="meta">depth</span>
      <button type="button" class="step press" data-depth="-1" data-id="${b.id}" aria-label="Move ${escapeHtml(name)} one message later" aria-disabled="${atMin}">−</button>
      <span class="dn">${b.depth}</span>
      <button type="button" class="step press" data-depth="1" data-id="${b.id}" aria-label="Move ${escapeHtml(name)} one message earlier" aria-disabled="${atMax}">+</button></span>
    ${tokChip(tokens(b), isEmpty(b) || isHeld(b))}${switchButton(b.id, b.enabled, name)}
  </div>${isOpen ? bodyHtml(b) : ""}</div>`;
}

// ----------------------------------------------------------------- meter

function renderMeter() {
  const total = preview?.approxTokens ?? blocks.reduce((n, b) => n + tokens(b), 0) + state.messages.reduce((n, m) => n + approxTokens(m.content), 0);
  const profile = state.profiles.find((p) => p.id === state.settings.rpProfileId);
  const ctx = profile ? contexts.get(`${profile.provider}:${profile.model}`) : undefined;
  $("meter-n").innerHTML = `${fmt(total)} <span class="meta">tokens</span>`;
  $("meter-of").textContent = [ctx ? `of ${Math.round(ctx / 1024)}k` : "", profile?.model ? profile.model.split("/").at(-1) : "no profile yet"].filter(Boolean).join(" · ");
  const meter = $("prompt-meter");
  meter.setAttribute("aria-valuenow", String(total));
  meter.setAttribute("aria-valuemax", String(ctx ?? Math.max(total, 1)));
  meter.setAttribute("aria-valuetext", `${fmt(total)} tokens${ctx ? ` of ${fmt(ctx)}` : ""}`);
  $("meter-fill").style.width = `${ctx ? Math.min(100, (total / ctx) * 100).toFixed(1) : 0}%`;
  $("prompt-meter").classList.toggle("no-ctx", !ctx);
}

async function loadContext() {
  const profile = state.profiles.find((p) => p.id === state.settings.rpProfileId);
  if (!profile?.model || contexts.has(`${profile.provider}:${profile.model}`)) return;
  try {
    const models = await api("GET", `/api/models?provider=${profile.provider}`);
    for (const m of models) if (m.contextLength) contexts.set(`${profile.provider}:${m.id}`, m.contextLength);
    renderMeter();
  } catch {
    // No list (no key, offline): the meter shows the total alone.
  }
}

// --------------------------------------------------------------- preview

let previewTimer = 0;
function refreshPreviewSoon() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 150);
}

async function refreshPreview() {
  try {
    preview = await api("GET", `/api/chats/${state.chatId}/preview`);
  } catch (error) {
    $("preview-body").innerHTML = `<p class="meta pv-empty">${escapeHtml(error.message)}</p>`;
    return;
  }
  renderPreview();
  renderMeter();
}

function pvEntry(role, label, content, tokensText, sunk = false) {
  const { html } = macroHtml(content);
  return `<div class="pv-entry"><div class="pv-head"><span class="role role-${role}">${role}</span><span class="pv-label">${escapeHtml(label)}</span>${tokensText ? `<span class="meta">${tokensText}</span>` : ""}</div>
    <div class="pv-text${sunk ? " sunk" : ""}">${html}</div></div>`;
}

function renderPreview() {
  for (const [id, v] of [
    ["pv-blocks", "blocks"],
    ["pv-sent", "sent"],
  ])
    $(id).setAttribute("aria-selected", String(pvView === v));
  if (!preview) return;
  const KEEP = 4;
  let out = "";
  if (pvView === "blocks") {
    const items = preview.blocks;
    const msgIdx = items.map((b, i) => (b.source.startsWith("message:") ? i : -1)).filter((i) => i >= 0);
    const fold = pvAll ? [] : msgIdx.slice(0, Math.max(0, msgIdx.length - KEEP));
    const folded = new Set(fold);
    items.forEach((b, i) => {
      if (folded.has(i)) {
        if (i === fold[0]) {
          const t = fold.reduce((n, k) => n + approxTokens(items[k].content), 0);
          out += `<div class="pv-entry"><div class="pv-head"><span class="role role-history">history</span><span class="pv-label">Chat history · ${fold.length} earlier message${fold.length === 1 ? "" : "s"}</span><span class="meta">${fmt(t)} t</span></div>
            <div class="pv-text"><span class="meta">Folded. The last ${Math.min(KEEP, msgIdx.length)} are below, with blocks placed by depth.</span> <button type="button" class="btn ghost press pv-all" data-pv-all>show all</button></div></div>`;
        }
        return;
      }
      const label = b.label.replace(/: /, " · ") + (b.depth !== undefined ? ` · depth ${b.depth}` : "");
      out += pvEntry(b.role, label, b.content, `${fmt(approxTokens(b.content))} t`);
    });
  } else {
    const msgs = preview.messages;
    const firstChat = msgs.findIndex((m) => m.role !== "system");
    const cut = pvAll || msgs.length <= 10 ? -1 : Math.max(firstChat, msgs.length - 6);
    msgs.forEach((m, i) => {
      if (cut > 0 && i >= Math.max(firstChat, 0) && i < cut) {
        if (i === Math.max(firstChat, 0)) out += `<div class="pv-entry"><p class="meta">${cut - i} earlier messages folded. <button type="button" class="btn ghost press pv-all" data-pv-all>show all</button></p></div>`;
        return;
      }
      const label = m.role === "system" ? (i === 0 ? "system prompt, merged blocks" : "system") : `message ${i + 1}`;
      out += pvEntry(m.role, label, m.content, `${fmt(approxTokens(m.content))} t`, true);
    });
  }
  $("preview-body").innerHTML = out || `<p class="meta pv-empty">Nothing is sent yet.</p>`;
}

// --------------------------------------------------------------- changes

async function patch(id, change) {
  await flushAll();
  const saved = await attempt(() => api("PATCH", `/api/blocks/${id}`, change));
  if (!saved) return null;
  const i = blocks.findIndex((b) => b.id === id);
  if (i >= 0) blocks[i] = saved;
  return saved;
}

async function saveOrder(ids, focusKey = null) {
  await flushAll();
  const saved = await attempt(() => api("PUT", `/api/chats/${state.chatId}/blocks`, { ids }));
  if (saved) blocks = saved;
  render();
  if (focusKey) focusGrip(focusKey);
  refreshPreviewSoon();
}

function focusGrip(key) {
  $("block-list").querySelector(`[data-grip="${CSS.escape(key)}"]`)?.focus();
}

/** Flatten units back to ids: depth blocks keep their place at the end (their depth decides where they go). */
function idsOf(list) {
  return [...list.flatMap((u) => u.blocks.map((b) => b.id)), ...inHistory().map((b) => b.id)];
}

/** Where a grip's thing sits: its unit, and for a field in its folder, the folder. */
function locate(key) {
  const list = units();
  const ui = list.findIndex((u) => u.key === key);
  if (ui >= 0) return { list, ui, fi: -1 };
  for (let i = 0; i < list.length; i++) {
    const fi = list[i].type === "folder" ? list[i].blocks.findIndex((b) => b.id === key) : -1;
    if (fi >= 0) return { list, ui: i, fi };
  }
  return null;
}

/** Move a grip's thing by `step` (−1 up, +1 down) or to an end ("top" / "bottom"). Returns the new order or null. */
function moved(key, step) {
  const at = locate(key);
  if (!at) return null;
  const { list, ui, fi } = at;
  if (fi >= 0) {
    const f = list[ui].blocks;
    const j = step === "top" ? 0 : step === "bottom" ? f.length - 1 : fi + step;
    if (j < 0 || j >= f.length || j === fi) return null;
    const [b] = f.splice(fi, 1);
    f.splice(j, 0, b);
    return idsOf(list);
  }
  const j = step === "top" ? 0 : step === "bottom" ? list.length - 1 : ui + step;
  if (j < 0 || j >= list.length || j === ui) return null;
  const [u] = list.splice(ui, 1);
  list.splice(j, 0, u);
  return idsOf(list);
}

/** Take a field out of its folder (it lands just after it), or put a moved-out field back at the folder's end. */
function inOut(key) {
  const at = locate(key);
  if (!at) return null;
  const { list, ui, fi } = at;
  if (fi >= 0) {
    const [b] = list[ui].blocks.splice(fi, 1);
    list.splice(ui + 1, 0, { type: "block", key: b.id, blocks: [b] });
    return idsOf(list);
  }
  const u = list[ui];
  const home = list.findIndex((x) => x.type === "folder" && x.cardId === u.cardId);
  if (home < 0) return null;
  list[home].blocks.push(u.blocks[0]);
  list.splice(ui, 1);
  return idsOf(list);
}

// ------------------------------------------------------------- move menu

function openMoveMenu(grip) {
  const key = grip.dataset.grip;
  const at = locate(key);
  if (!at) return;
  const { list, ui, fi } = at;
  const u = list[ui];
  const b = fi >= 0 ? u.blocks[fi] : u.blocks[0];
  const card = b.kind === "field" ? cardById(b.cardId) : null;
  const name = u.type === "folder" && fi < 0 ? `${card?.name ?? "Card"} folder` : u.type === "history" ? "Chat history" : b.kind === "field" ? fieldTitle(b) : b.title;
  const place =
    fi >= 0 ? `in ${card?.name}'s folder · block ${fi + 1} of ${u.blocks.length}` : `${ui + 1} of ${list.length} in send order${u.movedOut && u.type === "block" ? ` · out of ${card?.name}'s folder` : ""}`;
  const count = fi >= 0 ? u.blocks.length : list.length;
  const pos = fi >= 0 ? fi : ui;
  const items = [
    ["-1", "↑", "Move up", pos === 0],
    ["1", "↓", "Move down", pos === count - 1],
    ["top", "⤒", "Move to the top", pos === 0],
    ["bottom", "⤓", "Move to the bottom", pos === count - 1],
  ];
  if (fi >= 0 && card) items.push(["out", "⇱", `Take it out of ${card.name}'s folder`, false]);
  if (fi < 0 && u.type === "block" && u.movedOut && list.some((x) => x.type === "folder" && x.cardId === u.cardId)) items.push(["in", "▭", `Put it back in ${card?.name}'s folder`, false]);
  $("move-head").innerHTML = `<span class="mh-t">${escapeHtml(name)}</span><span class="meta">${escapeHtml(place)}</span>`;
  $("move-menu-items").innerHTML = items
    .map(([k, glyph, label, off]) => `<button type="button" role="menuitem" class="press" data-move="${k}" ${off ? 'aria-disabled="true"' : ""}><span class="mi glyph" aria-hidden="true">${glyph}</span>${escapeHtml(label)}</button>`)
    .join("");
  const dialog = $("move-menu");
  dialog.onclick = (e) => {
    const item = e.target.closest("[data-move]");
    if (!item || item.getAttribute("aria-disabled") === "true") return;
    const k = item.dataset.move;
    const ids = k === "out" || k === "in" ? inOut(key) : moved(key, k === "top" || k === "bottom" ? k : Number(k));
    closeOverlay(dialog, "replace");
    if (ids) saveOrder(ids, key);
    else focusGrip(key);
  };
  openOverlay(dialog, { opener: grip, anchor: grip, focus: "[role=menuitem]:not([aria-disabled=true])" });
}

// ------------------------------------------------------------- role menu

function openRoleMenu(button) {
  const b = blocks.find((x) => x.id === button.dataset.role);
  $("role-menu-items").innerHTML = ["system", "user", "assistant"]
    .map((r) => `<button type="button" role="menuitemradio" class="press" aria-checked="${b.role === r}" data-set-role="${r}"><span class="role role-${r}">${r}</span><span class="meta">${r === "system" ? "instructions" : r === "user" ? "as if you wrote it" : "as if the narrator wrote it"}</span></button>`)
    .join("");
  const dialog = $("role-menu");
  dialog.onclick = async (e) => {
    const item = e.target.closest("[data-set-role]");
    if (!item) return;
    closeOverlay(dialog);
    if (item.dataset.setRole !== b.role && (await patch(b.id, { role: item.dataset.setRole }))) {
      render();
      $("block-list").querySelector(`[data-role="${b.id}"]`)?.focus();
      refreshPreviewSoon();
    }
  };
  openOverlay(dialog, { opener: button, anchor: button, focus: "[aria-checked=true]" });
}

// ------------------------------------------------------------------- drag

let drag = null;

function onPointerDown(e) {
  const grip = e.target.closest(".bumps");
  if (!grip || e.button !== 0 || drag) return;
  drag = { grip, key: grip.dataset.grip, x: e.clientX, y: e.clientY, id: e.pointerId, live: false };
  grip.setPointerCapture(e.pointerId);
}

function startDrag() {
  const at = locate(drag.key);
  if (!at) return (drag = null);
  drag.live = true;
  drag.at = at;
  drag.el = drag.grip.closest(".blk");
  drag.el.classList.add("is-dragging");
  drag.line = document.createElement("li");
  drag.line.className = "drop-li";
  drag.line.setAttribute("aria-hidden", "true");
  drag.line.innerHTML = `<div class="dropline"></div>`;
  document.documentElement.classList.add("dragging-block");
  $("drag-status").textContent = "";
}

function onPointerMove(e) {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.live) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
    startDrag();
    if (!drag) return;
  }
  e.preventDefault();
  drag.el.style.translate = `0 ${e.clientY - drag.y}px`;
  // Auto-scroll near the pane's edges.
  const pane = $("blocks-pane");
  const r = pane.getBoundingClientRect();
  if (e.clientY < r.top + 40) pane.scrollTop -= 12;
  else if (e.clientY > r.bottom - 40) pane.scrollTop += 12;
  placeLine(e.clientX, e.clientY);
}

/** Where the dragged thing would land: inside its card's folder well, or between top-level items. */
function placeLine(x, y) {
  const { list, ui, fi } = drag.at;
  const b = fi >= 0 ? list[ui].blocks[fi] : list[ui].blocks[0];
  const isField = list[ui].type !== "folder" && b.kind === "field";
  const well = isField ? $("block-list").querySelector(`[data-well="${CSS.escape(b.cardId)}"]`) : null;
  const wr = well?.getBoundingClientRect();
  let container;
  let items;
  if (well && y >= wr.top && y <= wr.bottom && x >= wr.left && x <= wr.right) {
    container = well.querySelector(".well-list");
    items = [...container.children].filter((li) => li.dataset.in && li.dataset.in !== b.id);
    drag.target = { scope: "folder", cardId: b.cardId };
  } else {
    container = $("block-list");
    items = [...container.children].filter((li) => li.dataset.unit && li.dataset.unit !== (fi >= 0 ? "" : list[ui].key));
    drag.target = { scope: "top" };
  }
  let before = null;
  for (const li of items) {
    const r = li.getBoundingClientRect();
    if (y < r.top + r.height / 2) {
      before = li;
      break;
    }
  }
  drag.target.before = before ? before.dataset.in ?? before.dataset.unit : null;
  if (before) container.insertBefore(drag.line, before);
  else container.appendChild(drag.line);
}

function dropOrder(d) {
  const { list, ui, fi } = d.at;
  const t = d.target;
  if (!t) return null;
  let unit;
  // Take the dragged thing out of where it is.
  if (fi >= 0) {
    const [b] = list[ui].blocks.splice(fi, 1);
    unit = { type: "block", key: b.id, blocks: [b] };
  } else {
    [unit] = list.splice(ui, 1);
  }
  if (t.scope === "folder") {
    const home = list.find((x) => x.type === "folder" && x.cardId === t.cardId);
    if (!home) return null;
    const at = t.before ? home.blocks.findIndex((b) => b.id === t.before) : home.blocks.length;
    home.blocks.splice(at < 0 ? home.blocks.length : at, 0, ...unit.blocks);
  } else {
    const at = t.before ? list.findIndex((u) => u.key === t.before) : list.length;
    list.splice(at < 0 ? list.length : at, 0, unit);
  }
  return idsOf(list);
}

function endDrag(commit) {
  if (!drag) return;
  const d = drag;
  drag = null;
  document.documentElement.classList.remove("dragging-block");
  if (!d.live) return;
  suppressNextClick = true;
  const ids = commit ? dropOrder(d) : null;
  d.line?.remove();
  d.el.classList.remove("is-dragging");
  d.el.style.translate = "";
  if (ids) saveOrder(ids, d.key);
  else render();
}

let suppressNextClick = false;

// --------------------------------------------------------------- keyboard

let picked = null;

function onGripKey(e) {
  const grip = e.target.closest(".bumps");
  if (!grip) return;
  const key = grip.dataset.grip;
  const say = (t) => ($("drag-status").textContent = t);
  if (e.key === " ") {
    e.preventDefault();
    if (!picked) {
      picked = { key, before: blocks.map((b) => b.id) };
      grip.closest(".blk").classList.add("is-dragging");
      say(`Picked up. Use the up and down arrows to move it, space to drop it, escape to cancel.`);
    } else {
      const ids = blocks.map((b) => b.id);
      picked = null;
      say("Dropped.");
      saveOrder(ids, key);
    }
    return;
  }
  if (!picked) return;
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault();
    const ids = moved(key, e.key === "ArrowUp" ? -1 : 1);
    if (!ids) return say(e.key === "ArrowUp" ? "Already at the top." : "Already at the bottom.");
    blocks = ids.map((id) => blocks.find((b) => b.id === id));
    render();
    const g = $("block-list").querySelector(`[data-grip="${CSS.escape(key)}"]`);
    g?.closest(".blk").classList.add("is-dragging");
    g?.focus();
    const at = locate(key);
    say(at ? `Position ${(at.fi >= 0 ? at.fi : at.ui) + 1} of ${at.fi >= 0 ? at.list[at.ui].blocks.length : at.list.length}.` : "");
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    blocks = picked.before.map((id) => blocks.find((b) => b.id === id));
    picked = null;
    render();
    focusGrip(key);
    say("Cancelled. It's back where it was.");
  }
}

// ------------------------------------------------------------------ clicks

async function onClick(e) {
  if (suppressNextClick) {
    suppressNextClick = false;
    if (e.target.closest(".bumps")) return;
  }
  const t = e.target;
  const grip = t.closest(".bumps");
  if (grip) {
    if (picked) return;
    return openMoveMenu(grip);
  }
  const toggle = t.closest("[data-toggle]");
  if (toggle) {
    const k = toggle.dataset.toggle;
    if (open.has(k)) open.delete(k);
    else open.add(k);
    render();
    $("block-list").querySelector(`[data-toggle="${CSS.escape(k)}"].${toggle.classList[0]}`)?.focus();
    return;
  }
  const role = t.closest("[data-role]");
  if (role) return openRoleMenu(role);
  const sw = t.closest("[data-switch]");
  if (sw) {
    const id = sw.dataset.switch;
    const b = blocks.find((x) => x.id === id);
    if (await patch(id, { enabled: !b.enabled })) afterChange(`[data-switch="${id}"]`);
    return;
  }
  const fsw = t.closest("[data-folder-switch]");
  if (fsw) {
    const cardId = fsw.dataset.folderSwitch;
    const run = units().find((u) => u.type === "folder" && u.cardId === cardId).blocks;
    const to = !run.some((b) => b.enabled);
    for (const b of run) await patch(b.id, { enabled: to });
    afterChange(`[data-folder-switch="${cardId}"]`);
    return;
  }
  const step = t.closest("[data-depth]");
  if (step) {
    if (step.getAttribute("aria-disabled") === "true") return;
    const b = blocks.find((x) => x.id === step.dataset.id);
    if (await patch(b.id, { depth: b.depth + Number(step.dataset.depth) })) afterChange(`[data-id="${b.id}"][data-depth="${step.dataset.depth}"]`);
    return;
  }
  const place = t.closest("[data-place]");
  if (place) {
    const b = blocks.find((x) => x.id === place.dataset.place);
    if (await patch(b.id, { depth: b.depth === null ? 1 : null })) {
      open.add(b.id);
      afterChange(`[data-place="${b.id}"]`);
    }
    return;
  }
  const del = t.closest("[data-delete]");
  if (del) {
    const b = blocks.find((x) => x.id === del.dataset.delete);
    const ok = await confirmDialog({ title: `Delete ${b.title}?`, body: "It's this chat's own block, so it goes for good.", confirm: "delete block", keep: "keep it", opener: del });
    if (!ok) return;
    clearTimeout(pending.get(b.id)?.timer);
    pending.delete(b.id);
    if (await attempt(() => api("DELETE", `/api/blocks/${b.id}`))) {
      blocks = blocks.filter((x) => x.id !== b.id);
      render();
      refreshPreviewSoon();
    }
  }
}

function afterChange(focusSelector) {
  render();
  if (focusSelector) $("block-list").querySelector(focusSelector)?.focus();
  refreshPreviewSoon();
}

// ----------------------------------------------------------- typing, saving

/** Grow a text box with its text, where the browser can't (field-sizing). */
function autosize(area) {
  if (CSS.supports?.("field-sizing", "content")) return;
  area.style.height = "auto";
  area.style.height = `${area.scrollHeight + 2}px`;
}

function onInput(e) {
  const area = e.target.closest("[data-text-of]");
  const title = e.target.closest("[data-title-of]");
  if (!area && !title) return;
  const id = area ? area.dataset.textOf : title.dataset.titleOf;
  const b = blocks.find((x) => x.id === id);
  if (!b) return;
  if (area) {
    b.content = area.value;
    autosize(area);
    const note = $("block-list").querySelector(`[data-note-of="${id}"]`);
    const text = unknownNote(b.content);
    if (note) {
      note.hidden = !text;
      note.querySelector("span").textContent = text;
    }
  } else {
    b.title = title.value;
  }
  refreshChrome(b);
  setStatus(id, "");
  const p = pending.get(id) ?? { timer: 0, dirty: false, saving: null };
  clearTimeout(p.timer);
  p.dirty = true;
  p.timer = setTimeout(() => saveText(id), SAVE_AFTER);
  pending.set(id, p);
}

/** After typing: the block's token chip, source line and title, its folder's total, the meter. */
function refreshChrome(b) {
  const list = $("block-list");
  const el = list.querySelector(`[data-block="${CSS.escape(b.id)}"]`);
  if (!el) return;
  const chip = el.querySelector(":scope > .bhead > .tok, :scope > .l2 > .tok, :scope > .slot > .tok");
  if (chip) chip.outerHTML = tokChip(tokens(b), isEmpty(b) || isHeld(b));
  const src = el.querySelector(":scope > .bhead .src, :scope > .l1 .src");
  if (src) src.textContent = sourceLine(b, b.kind === "field" && !el.closest("[data-in]"));
  if (b.kind === "text" && b.title.trim()) {
    const t = el.querySelector(":scope > .bhead .t, :scope > .l1 .t, :scope > .slot .t");
    if (t) t.textContent = b.title;
  }
  const folder = el.closest(".folder");
  const run = folder && units().find((u) => u.type === "folder" && u.cardId === folder.dataset.folder);
  const sum = folder?.querySelector(":scope > .bhead > .tok, :scope > .l2 > .tok");
  if (run && sum) sum.outerHTML = tokChip(run.blocks.reduce((n, x) => n + tokens(x), 0));
  renderMeter();
}

function setStatus(id, text) {
  const s = $("block-list").querySelector(`[data-status-of="${CSS.escape(id)}"]`);
  if (s) s.textContent = text;
}

/** Save a block's typed text (and a text block's title) now, if anything is unsaved. */
async function saveText(id) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  while (p.saving) await p.saving;
  if (!p.dirty) return;
  p.dirty = false;
  const b = blocks.find((x) => x.id === id);
  if (!b) return pending.delete(id);
  const change = { content: b.content };
  if (b.kind === "text" && b.title.trim()) change.title = b.title.trim();
  setStatus(id, "saving…");
  p.saving = (async () => {
    try {
      const saved = await api("PATCH", `/api/blocks/${id}`, change);
      // Keep anything typed while it saved; it saves next.
      Object.assign(b, saved, { content: b.content, title: b.kind === "text" && !b.title.trim() ? saved.title : b.title });
      setStatus(id, p.dirty ? "" : "saved");
      if (saved.kind !== "text" && saved.kind !== "note") await loadState();
      refreshPreviewSoon();
    } catch (error) {
      p.dirty = true;
      setStatus(id, `not saved: ${error.message}`);
    }
  })();
  await p.saving;
  p.saving = null;
  if (!p.dirty) pending.delete(id);
}

/** Save every block with typed text, before anything else changes blocks. */
async function flushAll() {
  await Promise.all([...pending.keys()].map(saveText));
}

/** Blocks may have changed elsewhere (the agent): save what's typed, then show them as they are now. */
export async function reloadPrompts() {
  if ($("view-prompts").hidden || !state.chatId) return;
  await flushAll();
  const loaded = await attempt(() => api("GET", `/api/chats/${state.chatId}/blocks`));
  if (!loaded) return;
  blocks = loaded;
  render();
  refreshPreviewSoon();
}

function onFocusIn(e) {
  const box = e.target.closest("[data-text-of], [data-title-of]");
  if (!box) return;
  active = box.dataset.textOf ?? box.dataset.titleOf;
  for (const body of $("block-list").querySelectorAll("[data-body]")) body.classList.toggle("is-active", body.dataset.body === active);
}

function onFocusOut(e) {
  const box = e.target.closest("[data-text-of], [data-title-of]");
  if (box) saveText(box.dataset.textOf ?? box.dataset.titleOf);
}

/** A ready-made nudge (src/nudges.ts): a block right after your post, as you. */
async function addNudge(preset, opener) {
  const block = await attempt(() => api("POST", `/api/chats/${state.chatId}/blocks`, { preset }));
  if (!block) return;
  blocks = await api("GET", `/api/chats/${state.chatId}/blocks`);
  open.add(block.id);
  render();
  opener.focus();
}

async function addBlock() {
  const block = await attempt(() => api("POST", `/api/chats/${state.chatId}/blocks`, { title: "New block", content: "" }));
  if (!block) return;
  blocks = await api("GET", `/api/chats/${state.chatId}/blocks`);
  open.add(block.id);
  render();
  const title = $(`title-${block.id}`);
  title?.focus();
  title?.select();
}

// -------------------------------------------------------------------- tabs

function setTab(which) {
  tab = which;
  $("view-prompts").dataset.tab = which;
  $("tab-blocks").setAttribute("aria-selected", String(which === "blocks"));
  $("tab-preview").setAttribute("aria-selected", String(which === "preview"));
}

export function wirePrompts() {
  $("prompts-back").innerHTML = icon.left(20);
  $("add-block").innerHTML = `${icon.plus(16)}text block`;
  $("add-block").addEventListener("click", addBlock);
  for (const b of document.querySelectorAll("[data-nudge]")) b.addEventListener("click", () => addNudge(b.dataset.nudge, b));
  const list = $("block-list");
  list.addEventListener("click", onClick);
  list.addEventListener("input", onInput);
  list.addEventListener("focusin", onFocusIn);
  list.addEventListener("focusout", onFocusOut);
  list.addEventListener("pointerdown", onPointerDown);
  list.addEventListener("pointermove", onPointerMove);
  list.addEventListener("pointerup", (e) => drag && e.pointerId === drag.id && endDrag(true));
  list.addEventListener("pointercancel", () => endDrag(false));
  list.addEventListener("keydown", onGripKey);
  list.addEventListener("keyup", (e) => {
    if (e.key === " " && e.target.closest(".bumps")) e.preventDefault();
  });
  window.addEventListener("beforeunload", (e) => {
    if ([...pending.values()].some((p) => p.dirty || p.saving)) {
      flushAll();
      e.preventDefault();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drag?.live) endDrag(false);
  });
  wireMacroBar(list);
  $("tab-blocks").addEventListener("click", () => setTab("blocks"));
  $("tab-preview").addEventListener("click", () => {
    setTab("preview");
    refreshPreviewSoon();
  });
  for (const [id, v] of [
    ["pv-blocks", "blocks"],
    ["pv-sent", "sent"],
  ])
    $(id).addEventListener("click", () => {
      pvView = v;
      pvAll = false;
      renderPreview();
    });
  $("preview-body").addEventListener("click", (e) => {
    if (e.target.closest("[data-pv-all]")) {
      pvAll = true;
      renderPreview();
    }
  });
}
