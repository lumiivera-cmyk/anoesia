/**
 * The prompts page: every block of the open chat's prompt, in send order.
 *
 * A run of one card's blocks folds into a card group. Blocks and groups
 * move by dragging or with the arrows (for phones). Editing a block's text
 * saves as you type; linked blocks save to their source (the card, or the
 * shared main prompt), so the card editor and this page show the same text.
 */

import { $, api, approxTokens, attempt, cardById, escapeHtml, loadState, openDialog, state } from "./core.js";
import { renderChat } from "./chat.js";
import { openPreview } from "./settings.js";

let blocks = [];
/** Card groups that are open, by card id. */
const openGroups = new Set();
/** Blocks whose text editor is open, by id. */
const openBlocks = new Set();
const saveTimers = new Map();

export async function openPrompts() {
  if (!state.chatId) return;
  const loaded = await attempt(() => api("GET", `/api/chats/${state.chatId}/blocks`));
  if (!loaded) return;
  blocks = loaded;
  render();
  openDialog("prompts-dialog");
}

/** The list as units: a card group (a run of one card's blocks) or a single block. */
function units() {
  const out = [];
  for (const b of blocks) {
    const last = out.at(-1);
    if (b.kind === "field" && last?.cardId === b.cardId) last.blocks.push(b);
    else out.push({ cardId: b.kind === "field" ? b.cardId : null, blocks: [b] });
  }
  return out;
}

function sourceLabel(b) {
  if (b.kind === "main") return "shared main prompt";
  if (b.kind === "field") {
    const card = cardById(b.cardId);
    return card ? `from ${card.name}'s card` : "from a card";
  }
  if (b.kind === "history") return `${state.messages.length} message${state.messages.length === 1 ? "" : "s"}`;
  return "this chat's own";
}

function tokens(b) {
  return b.enabled ? approxTokens(b.content) : 0;
}

function render() {
  const total = blocks.reduce((n, b) => n + tokens(b), 0);
  const history = state.messages.reduce((n, m) => n + approxTokens(m.content), 0);
  $("prompts-total").textContent = `~${total} tokens of blocks + ~${history} of chat`;
  $("block-list").innerHTML = units()
    .map((u, i, all) => (u.cardId && u.blocks.length > 0 ? groupHtml(u, i, all.length) : blockHtml(u.blocks[0], i, all.length, false)))
    .join("");
}

function moveButtons(kind, id, index, count) {
  return `<span class="moves"><button type="button" class="icon-button" data-move="-1" data-${kind}="${id}" title="Move up" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" class="icon-button" data-move="1" data-${kind}="${id}" title="Move down" ${index === count - 1 ? "disabled" : ""}>↓</button></span>`;
}

function groupHtml(unit, index, count) {
  const card = cardById(unit.cardId);
  const name = card ? card.name : "Card";
  const open = openGroups.has(unit.cardId);
  const sum = unit.blocks.reduce((n, b) => n + tokens(b), 0);
  const first = unit.blocks[0].id;
  const tag = card?.isPersona ? `<span class="tag">you</span>` : card && !card.isCharacter ? `<span class="tag">world</span>` : "";
  const inner = open ? `<div class="group-body">${unit.blocks.map((b, i) => blockHtml(b, i, unit.blocks.length, true)).join("")}</div>` : "";
  return `<div class="card-group${open ? " open" : ""}" draggable="true" data-unit="${first}">
    <div class="group-head">
      <span class="handle" title="Drag to move">⠿</span>
      <button type="button" class="group-toggle" data-toggle-group="${unit.cardId}">${open ? "▾" : "▸"} <strong>${escapeHtml(name)}</strong></button>${tag}
      <span class="muted small">${unit.blocks.length} field${unit.blocks.length === 1 ? "" : "s"} · ~${sum}</span>
      <span class="spacer"></span>
      ${moveButtons("unit", first, index, count)}
    </div>${inner}
  </div>`;
}

function blockHtml(b, index, count, inGroup) {
  const history = b.kind === "history";
  const open = openBlocks.has(b.id);
  const empty = !history && !b.content.trim();
  const role = history
    ? `<span class="role user">chat</span>`
    : `<select class="role-select role ${b.role}" data-field="role" aria-label="Role">${["system", "user", "assistant"].map((r) => `<option value="${r}" ${r === b.role ? "selected" : ""}>${r}</option>`).join("")}</select>`;
  const depth = history
    ? ""
    : `<label class="depth" title="Inside the chat: how many messages from the end">
        <select data-field="placement"><option value="order" ${b.depth === null ? "selected" : ""}>in order</option><option value="chat" ${b.depth !== null ? "selected" : ""}>inside chat</option></select>
        <input type="number" min="0" max="999" data-field="depth" value="${b.depth ?? 0}" ${b.depth === null ? "hidden" : ""} aria-label="Messages from the end" />
      </label>`;
  const toggle = history ? "" : `<label class="switch" title="On or off"><input type="checkbox" data-field="enabled" ${b.enabled ? "checked" : ""} /><span>on</span></label>`;
  const editor = open && !history
    ? `<div class="block-editor">
        ${b.kind === "text" ? `<input class="block-title-input" data-field="title" value="${escapeHtml(b.title)}" aria-label="Title" />` : ""}
        <textarea data-field="content" rows="${Math.min(18, Math.max(4, b.content.split("\n").length + 1))}">${escapeHtml(b.content)}</textarea>
        <div class="row"><span class="muted small" data-saved></span><span class="spacer"></span>${b.kind === "text" ? `<button type="button" class="button danger" data-delete-block="${b.id}">Delete block</button>` : ""}</div>
      </div>`
    : "";
  const attrs = inGroup ? `data-block="${b.id}"` : `data-unit="${b.id}" data-block="${b.id}"`;
  return `<div class="pblock kind-${b.kind}${b.enabled ? "" : " off"}${empty ? " is-empty" : ""}" draggable="true" ${attrs}>
    <div class="pblock-head">
      <span class="handle" title="Drag to move">⠿</span>
      <button type="button" class="pblock-title" ${history ? "disabled" : `data-toggle-block="${b.id}"`}>${history ? "" : open ? "▾ " : "▸ "}${escapeHtml(b.title)}${empty ? ` <span class="muted small">(empty)</span>` : ""}</button>
      <span class="source">${escapeHtml(sourceLabel(b))}</span>
      <span class="spacer"></span>
      <span class="controls">${role}${depth}${toggle}<span class="muted small tokens">${history ? "" : `~${tokens(b)}`}</span>${moveButtons(inGroup ? "block" : "unit", b.id, index, count)}</span>
    </div>${editor}
  </div>`;
}

// ----------------------------------------------------------------- moves

async function saveOrder(ids) {
  const saved = await attempt(() => api("PUT", `/api/chats/${state.chatId}/blocks`, { ids }));
  if (saved) blocks = saved;
  render();
}

/** Move a unit (group or lone block) up or down past its neighbour unit. */
function moveUnit(firstId, step) {
  const list = units();
  const i = list.findIndex((u) => u.blocks[0].id === firstId);
  const j = i + step;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  saveOrder(list.flatMap((u) => u.blocks.map((b) => b.id)));
}

/** Move one block inside its group up or down (it can leave the group at either end). */
function moveBlock(id, step) {
  const ids = blocks.map((b) => b.id);
  const i = ids.indexOf(id);
  const j = i + step;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  saveOrder(ids);
}

// ------------------------------------------------------------------ drag

let dragging = null;

function idsOf(element) {
  if (element.classList.contains("card-group")) {
    const first = element.dataset.unit;
    return units().find((u) => u.blocks[0].id === first).blocks.map((b) => b.id);
  }
  return [element.dataset.block];
}

function onDragStart(e) {
  const el = e.target.closest(".card-group, .pblock");
  if (!el || e.target.closest("textarea, input, select")) return;
  e.stopPropagation();
  dragging = idsOf(el);
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", dragging.join(","));
  el.classList.add("dragging");
}

function onDragOver(e) {
  if (!dragging) return;
  const target = e.target.closest(".pblock, .card-group");
  if (!target) return;
  e.preventDefault();
  for (const t of document.querySelectorAll(".drop-before, .drop-after")) t.classList.remove("drop-before", "drop-after");
  const rect = target.getBoundingClientRect();
  target.classList.add(e.clientY < rect.top + rect.height / 2 ? "drop-before" : "drop-after");
}

function onDrop(e) {
  if (!dragging) return;
  const target = e.target.closest(".pblock, .card-group");
  if (!target) return;
  e.preventDefault();
  const before = e.clientY < target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2;
  const targetIds = idsOf(target);
  const moving = dragging;
  dragging = null;
  if (targetIds.some((id) => moving.includes(id))) return render();
  const rest = blocks.map((b) => b.id).filter((id) => !moving.includes(id));
  const at = before ? rest.indexOf(targetIds[0]) : rest.indexOf(targetIds.at(-1)) + 1;
  rest.splice(at, 0, ...moving);
  saveOrder(rest);
}

function onDragEnd() {
  dragging = null;
  for (const t of document.querySelectorAll(".dragging, .drop-before, .drop-after")) t.classList.remove("dragging", "drop-before", "drop-after");
}

// --------------------------------------------------------------- editing

async function patch(id, change) {
  const saved = await attempt(() => api("PATCH", `/api/blocks/${id}`, change));
  if (!saved) return null;
  const i = blocks.findIndex((b) => b.id === id);
  if (i >= 0) blocks[i] = saved;
  return saved;
}

function onChange(e) {
  const row = e.target.closest("[data-block]");
  const field = e.target.dataset.field;
  if (!row || !field || field === "content" || field === "title") return;
  const id = row.dataset.block;
  if (field === "role") return patch(id, { role: e.target.value }).then(render);
  if (field === "enabled") return patch(id, { enabled: e.target.checked }).then(render);
  if (field === "placement") return patch(id, { depth: e.target.value === "chat" ? 0 : null }).then(render);
  if (field === "depth") return patch(id, { depth: e.target.value === "" ? 0 : Number(e.target.value) }).then(render);
}

/** Text saves a moment after you stop typing. */
function onInput(e) {
  const field = e.target.dataset.field;
  if (field !== "content" && field !== "title") return;
  const row = e.target.closest("[data-block]");
  const id = row.dataset.block;
  const value = e.target.value;
  const status = row.querySelector("[data-saved]");
  if (status) status.textContent = "…";
  clearTimeout(saveTimers.get(`${id}:${field}`));
  saveTimers.set(
    `${id}:${field}`,
    setTimeout(async () => {
      const saved = await patch(id, { [field]: value });
      if (!saved) return;
      if (status) status.textContent = saved.kind === "field" ? "Saved to the card" : saved.kind === "main" ? "Saved (shared by every chat)" : "Saved";
      row.querySelector(".tokens").textContent = `~${tokens(saved)}`;
      // Linked text changed elsewhere too: refresh what the rest of the app shows.
      if (saved.kind !== "text") await loadState();
    }, 600),
  );
}

async function onClick(e) {
  const toggleGroup = e.target.closest("[data-toggle-group]");
  if (toggleGroup) {
    const id = toggleGroup.dataset.toggleGroup;
    openGroups.has(id) ? openGroups.delete(id) : openGroups.add(id);
    return render();
  }
  const toggleBlock = e.target.closest("[data-toggle-block]");
  if (toggleBlock) {
    const id = toggleBlock.dataset.toggleBlock;
    openBlocks.has(id) ? openBlocks.delete(id) : openBlocks.add(id);
    return render();
  }
  const move = e.target.closest("[data-move]");
  if (move) {
    const step = Number(move.dataset.move);
    if (move.dataset.unit) return moveUnit(move.dataset.unit, step);
    if (move.dataset.block) return moveBlock(move.dataset.block, step);
  }
  const del = e.target.closest("[data-delete-block]");
  if (del) {
    if (!confirm("Delete this block?")) return;
    if (await attempt(() => api("DELETE", `/api/blocks/${del.dataset.deleteBlock}`))) {
      blocks = blocks.filter((b) => b.id !== del.dataset.deleteBlock);
      render();
    }
  }
}

async function addBlock() {
  const block = await attempt(() => api("POST", `/api/chats/${state.chatId}/blocks`, { title: "New block", content: "" }));
  if (!block) return;
  blocks = await api("GET", `/api/chats/${state.chatId}/blocks`);
  openBlocks.add(block.id);
  render();
  $("block-list").querySelector(`[data-block="${block.id}"] textarea`)?.focus();
}

export function wirePrompts() {
  $("open-prompts").addEventListener("click", openPrompts);
  $("add-block").addEventListener("click", addBlock);
  $("prompts-preview").addEventListener("click", openPreview);
  $("prompts-dialog").addEventListener("close", () => renderChat());
  const list = $("block-list");
  list.addEventListener("click", onClick);
  list.addEventListener("change", onChange);
  list.addEventListener("input", onInput);
  list.addEventListener("dragstart", onDragStart);
  list.addEventListener("dragover", onDragOver);
  list.addEventListener("drop", onDrop);
  list.addEventListener("dragend", onDragEnd);
}
