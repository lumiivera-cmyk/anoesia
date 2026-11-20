/**
 * The cards page: the library (personas set apart, kind and size, find a
 * card), the card editor (name, colour, the two switches, fields as blocks),
 * where the card is used, and markdown import.
 *
 * The field order here is the order inside the card's folder in every chat.
 * Everything saves as you go.
 */

import { $, api, approxTokens, attempt, cardById, escapeHtml, fmt, gem, go, isPhone, loadState, macroHtml, state, timeLabel, tokChip } from "./core.js";
import { openTextEditor, unknownNote } from "./editor.js";
import { icon } from "./icons.js";
import { closeOverlay, confirmDialog, openOverlay } from "./overlay.js";
import { openPicker, swatchesHtml, wirePicker } from "./colour.js";
import { renderChat } from "./chat.js";
import { renderSide } from "./side.js";

let selected = null;
let query = "";
/** Open fields, by id. While adding a field the others fold, in their own set. */
const openFields = new Set();
const openWhileAdding = new Set();
let adding = false;
let renaming = null;
let savedAt = null;
const saveTimers = new Map();

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

export function showCards(id) {
  if (id && !cardById(id)) id = null;
  if (id !== selected) {
    adding = false;
    renaming = null;
    savedAt = null;
    if (id) {
      const card = cardById(id);
      openFields.clear();
      const first = card.fields.find((f) => f.content.trim());
      if (first) openFields.add(first.id);
    }
  }
  selected = id ?? (isPhone() ? null : (selected && cardById(selected) ? selected : state.cards[0]?.id ?? null));
  $("view-cards").dataset.mode = id ? "card" : "library";
  // On a phone the library has no sidebar: its back button leads out to the chat.
  const back = $("cards-back");
  back.href = id ? "#/cards" : state.chatId ? `#/chat/${state.chatId}` : "#/";
  back.setAttribute("aria-label", id ? "All cards" : "Back to the chat");
  render();
}

function kindOf(card) {
  return card.isPersona ? "persona" : card.isCharacter ? "character" : "world";
}
const chatsWith = (card) => state.chats.filter((c) => c.cast.includes(card.id));
const cardTokens = (card) => card.fields.reduce((n, f) => n + approxTokens(f.content), 0);
const fieldName = (f) => (f.key === "custom" ? f.title : f.title.toLowerCase());

function render() {
  const n = state.cards.length;
  const card = selected ? cardById(selected) : null;
  $("cards-meta").textContent = isPhone() && card ? `${kindOf(card)} · ${fmt(cardTokens(card))} tokens` : isPhone() ? `${n} card${n === 1 ? "" : "s"}` : `${n} card${n === 1 ? "" : "s"} · characters, personas and worlds you can put in any chat`;
  $("cards-title").textContent = isPhone() && card ? card.name : "Cards";
  renderLibrary();
  renderEditor();
  renderRail();
}

// ----------------------------------------------------------------- library

function renderLibrary() {
  const q = query.trim().toLowerCase();
  const shown = state.cards.filter((c) => !q || c.name.toLowerCase().includes(q));
  const group = (title, list) =>
    list.length
      ? `<h2 class="grp">${title}</h2><ul class="crows">${list
          .map((c) => {
            const used = chatsWith(c).length;
            return `<li><a class="crow press" href="#/cards/${c.id}" ${c.id === selected ? 'aria-current="true"' : ""}>${gem(c, 30)}<span class="crow-text"><span class="n">${escapeHtml(c.name)}</span><span class="k">${kindOf(c)}${c.isCharacter || c.isPersona ? "" : ""} · ${used} chat${used === 1 ? "" : "s"}</span></span>${tokChip(cardTokens(c))}</a></li>`;
          })
          .join("")}</ul>`
      : "";
  const html =
    group("characters", shown.filter((c) => !c.isPersona && c.isCharacter)) +
    group("personas · you play these", shown.filter((c) => c.isPersona)) +
    group("worlds and factions", shown.filter((c) => !c.isPersona && !c.isCharacter));
  $("card-groups").innerHTML =
    html ||
    (state.cards.length
      ? `<p class="meta empty-note">No card matches “${escapeHtml(query)}”.</p>`
      : `<div class="empty raised"><p class="disp">No cards yet</p><p class="meta">Import your cards from markdown, or start a new one.</p></div>`);
}

// ------------------------------------------------------------------ editor

function renderEditor() {
  const card = selected ? cardById(selected) : null;
  const box = $("card-editor");
  if (!card) {
    box.innerHTML = isPhone() ? "" : `<div class="empty raised"><p class="disp">Pick a card</p><p class="meta">Or make a new one with new card.</p></div>`;
    return;
  }
  const used = chatsWith(card).length;
  const withText = card.fields.filter((f) => f.content.trim()).length;
  const kindMeta = card.isPersona
    ? `persona · fills <span class="mac">user</span>`
    : card.isCharacter
      ? `character · listed in <span class="mac">cast</span>`
      : `${card.isCharacter ? "character" : "world"} · not in <span class="mac">cast</span>`;
  const set = adding ? openWhileAdding : openFields;
  const baseFirst = (() => {
    const firstCustom = card.fields.findIndex((f) => f.key === "custom");
    return firstCustom < 0 || card.fields.slice(firstCustom).every((f) => f.key === "custom");
  })();
  const fields = card.fields
    .map((f, i) => {
      const divider = baseFirst && f.key === "custom" && card.fields[i - 1]?.key !== "custom" ? `<div class="divider"><span class="eyebrow">advanced · your own fields</span></div>` : "";
      return divider + fieldHtml(card, f, i, set.has(f.id));
    })
    .join("");
  box.innerHTML = `
    <div class="card-head">
      ${gem(card, 64)}
      <div class="ch-text">
        <label class="sr" for="card-name">Card name</label>
        <input id="card-name" class="inp name-inp" value="${escapeHtml(card.name)}" autocomplete="off" maxlength="200" />
        <span class="meta">${kindMeta} · used in ${used} chat${used === 1 ? "" : "s"}</span>
      </div>
      <div class="ch-count"><span class="big">${fmt(cardTokens(card))}</span><span class="meta">tokens · ${withText} field${withText === 1 ? "" : "s"} with text</span></div>
    </div>
    <div class="colour-row"><span class="meta">colour</span>${swatchesHtml(card)}</div>
    <div class="tiles">
      <div class="raised tile"><button type="button" class="switch" role="switch" aria-checked="${card.isPersona}" aria-labelledby="me-t" data-flag="isPersona"><span class="knob"></span></button>
        <span class="tile-text"><span class="tt" id="me-t">This is me</span><span class="td">a persona you play. It fills <span class="mac">user</span> instead of <span class="mac">cast</span>.</span></span></div>
      <div class="raised tile"><button type="button" class="switch" role="switch" aria-checked="${card.isCharacter}" aria-labelledby="ch-t" data-flag="isCharacter"><span class="knob"></span></button>
        <span class="tile-text"><span class="tt" id="ch-t">A character</span><span class="td">listed in <span class="mac">cast</span>. Off for worlds, places and factions.</span></span></div>
    </div>
    <section class="sunk fwell fields" aria-label="${escapeHtml(card.name)}'s fields">
      <div class="fields-head"><span class="eyebrow">fields · sent in this order</span><span class="meta">this is the order inside ${escapeHtml(card.name)}'s folder in every chat</span></div>
      <ol class="field-list" id="field-list">${fields}</ol>
      ${
        adding
          ? `<form class="raised blk newfield" id="new-field" aria-label="New field">
              <span class="bumps" aria-hidden="true"></span>
              <label class="sr" for="nf-name">Field name</label>
              <input id="nf-name" class="sunk inp" placeholder="name it, like relationships or rules" autocomplete="off" required />
              <label class="sr" for="nf-text">What goes in it</label>
              <textarea id="nf-text" class="sunk ftext" placeholder="what goes in it"></textarea>
              <div class="nf-buttons"><span class="meta">sent after ${escapeHtml(card.name)}'s other fields, until you move it</span>
                <button type="button" class="btn ghost press" data-add-cancel>cancel</button><button type="submit" class="btn btn-primary press">add field</button></div>
            </form>`
          : `<button type="button" class="btn ghost press add-field" data-add-field>${icon.plus(16)} add a field</button>`
      }
    </section>
    <div class="card-foot">
      <button type="button" class="btn btn-quiet-danger press" data-delete-card>${icon.trash()} delete ${escapeHtml(card.name)}</button>
      <span class="meta saved" role="status">${savedAt ? `saved · last edit ${timeLabel(savedAt)}` : `last edit ${timeLabel(card.updatedAt)}`}</span>
    </div>`;
}

function fieldHtml(card, f, i, isOpen) {
  const name = fieldName(f);
  const empty = !f.content.trim();
  const src = f.key === "system" && empty ? "optional · empty, so it isn’t sent" : empty ? "empty, so it isn’t sent" : f.key === "custom" ? "your own field" : `sent ${ORDINALS[i] ?? `#${i + 1}`}`;
  const title =
    renaming === f.id
      ? `<span class="rename"><label class="sr" for="rn-${f.id}">Rename ${escapeHtml(name)}</label><input id="rn-${f.id}" class="sunk inp" value="${escapeHtml(f.title)}" data-rename-input="${f.id}" autocomplete="off" /></span>`
      : isPhone()
        ? `<button type="button" class="btitle" data-field-edit="${f.id}"><span class="t">${escapeHtml(name)}</span><span class="src">${escapeHtml(src)} · tap to edit</span></button>`
        : `<button type="button" class="btitle" data-field-toggle="${f.id}" aria-expanded="${isOpen}"><span class="t">${escapeHtml(name)}</span><span class="src">${escapeHtml(src)}</span></button>`;
  const rename = f.key === "custom" && renaming !== f.id ? `<button type="button" class="ibs press hit44" data-rename="${f.id}" aria-label="Rename ${escapeHtml(name)}">${icon.edit()}</button>` : "";
  const how = isPhone() ? "Hold the bumps and drag, or tap them for move options" : "Drag the bumps, or press space and use the arrow keys";
  const note = unknownNote(f.content);
  const body = isOpen
    ? `<div class="fbody">
        <label class="sr" for="ft-${f.id}">${escapeHtml(card.name)}'s ${escapeHtml(name)}</label>
        <textarea id="ft-${f.id}" class="sunk ftext" data-field-text="${f.id}" placeholder="${f.key === "system" ? "Empty. Anything written here is sent with the card’s other fields." : "Empty, so it isn’t sent."}">${escapeHtml(f.content)}</textarea>
        ${note ? `<p class="bnote warn" role="note">${icon.warn()}${escapeHtml(note)}</p>` : ""}
        <div class="fhint"><span class="meta">type <span class="mac">user</span> or <span class="mac">char</span> for whoever is playing · edits ${escapeHtml(card.name)} in every chat</span>
        ${f.key === "custom" ? `<button type="button" class="btn btn-quiet-danger press" data-remove-field="${f.id}">${icon.trash(16)} remove field</button>` : ""}</div>
      </div>`
    : "";
  return `<li data-fid="${f.id}"><div class="raised blk field-blk" data-field="${f.id}">
    <button type="button" class="bumps" data-fgrip="${f.id}" aria-label="Move ${escapeHtml(name)}. ${how}"></button>
    <div class="bhead">${title}${rename}${tokChip(approxTokens(f.content), empty)}
      <button type="button" class="chev" data-field-toggle="${f.id}" aria-expanded="${isOpen}" aria-label="Show ${escapeHtml(card.name)}'s ${escapeHtml(name)}">${icon.down()}</button></div>
    ${body}</div></li>`;
}

// -------------------------------------------------------------------- rail

function renderRail() {
  const card = selected ? cardById(selected) : null;
  const rail = $("card-rail");
  if (!card) {
    rail.innerHTML = "";
    rail.hidden = true;
    return;
  }
  rail.hidden = false;
  const chats = chatsWith(card);
  const how = card.isPersona ? "you play this card" : card.isCharacter ? "in the cast" : "world, sent as a folder";
  rail.innerHTML = `
    <h2>used in</h2>
    ${chats.length ? `<ul class="urows">${chats.map((c) => `<li><a class="urow press" href="#/chat/${c.id}"><span class="un">${escapeHtml(c.name)}</span><span class="meta">${how}</span></a></li>`).join("")}</ul>` : `<p class="meta">Not in any chat yet. Add it from a chat's settings.</p>`}
    <h2 class="gap">in the prompt</h2>
    <p class="meta">Sent as the folder “${escapeHtml(card.name)}”, fields in this order. A chat can move a field out of the folder without changing the card.</p>
    <ol class="prows2">${card.fields
      .map((f, i) => `<li class="prow2"><span class="pn">${i + 1}</span><span class="pt">${escapeHtml(fieldName(f))}</span><span class="meta">${f.content.trim() ? fmt(approxTokens(f.content)) : "empty, skipped"}</span></li>`)
      .join("")}</ol>
    ${state.chat?.cast.includes(card.id) ? `<a class="btn ghost press rail-link" href="#/prompts">open the prompts page</a>` : ""}`;
}

// ------------------------------------------------------------------- saving

async function saveCard(change, { rerender = true } = {}) {
  const card = cardById(selected);
  const saved = await attempt(() => api("PATCH", `/api/cards/${card.id}`, change));
  if (!saved) return null;
  const i = state.cards.findIndex((c) => c.id === saved.id);
  state.cards[i] = saved;
  savedAt = saved.updatedAt;
  if (rerender) render();
  else {
    const s = $("card-editor").querySelector(".saved");
    if (s) s.textContent = `saved · last edit ${timeLabel(savedAt)}`;
  }
  renderChat();
  return saved;
}

function fieldsPayload(card, edit = {}) {
  return card.fields.map((f) => ({ key: f.key, id: f.id, title: f.title, content: f.content, ...(edit[f.id] ?? {}) }));
}

/** Field text saves a moment after you stop typing. */
function onFieldInput(area) {
  const card = cardById(selected);
  const id = area.dataset.fieldText;
  const f = card.fields.find((x) => x.id === id);
  f.content = area.value;
  const blk = area.closest(".field-blk");
  blk.querySelector(".tok").outerHTML = tokChip(approxTokens(f.content), !f.content.trim());
  clearTimeout(saveTimers.get(id));
  saveTimers.set(
    id,
    setTimeout(() => saveCard({ fields: fieldsPayload(card) }, { rerender: false }).then(() => renderLibrary()), 600),
  );
}

async function reorderFields(ids, focusId) {
  const card = cardById(selected);
  const byId = new Map(card.fields.map((f) => [f.id, f]));
  card.fields = ids.map((id) => byId.get(id));
  render();
  await saveCard({ fields: fieldsPayload(card) });
  if (focusId) $("card-editor").querySelector(`[data-fgrip="${focusId}"]`)?.focus();
}

function movedFields(id, step) {
  const ids = cardById(selected).fields.map((f) => f.id);
  const i = ids.indexOf(id);
  const j = step === "top" ? 0 : step === "bottom" ? ids.length - 1 : i + step;
  if (j < 0 || j >= ids.length || j === i) return null;
  ids.splice(i, 1);
  ids.splice(j, 0, id);
  return ids;
}

// ---------------------------------------------------------- drag and keys

let drag = null;
let picked = null;
let suppressClick = false;

function wireFieldMoves(box) {
  box.addEventListener("pointerdown", (e) => {
    const grip = e.target.closest("[data-fgrip]");
    if (!grip || e.button !== 0) return;
    drag = { grip, id: grip.dataset.fgrip, y: e.clientY, pid: e.pointerId, live: false };
    grip.setPointerCapture(e.pointerId);
  });
  box.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    if (!drag.live) {
      if (Math.abs(e.clientY - drag.y) < 6) return;
      drag.live = true;
      drag.el = drag.grip.closest(".blk");
      drag.el.classList.add("is-dragging");
      drag.line = Object.assign(document.createElement("li"), { className: "drop-li", innerHTML: '<div class="dropline"></div>' });
      drag.line.setAttribute("aria-hidden", "true");
    }
    drag.el.style.translate = `0 ${e.clientY - drag.y}px`;
    const list = $("field-list");
    const items = [...list.children].filter((li) => li.dataset.fid && li.dataset.fid !== drag.id);
    const before = items.find((li) => {
      const r = li.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    drag.before = before?.dataset.fid ?? null;
    if (before) list.insertBefore(drag.line, before);
    else list.appendChild(drag.line);
  });
  const end = (commit) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.live) return;
    suppressClick = true;
    d.line.remove();
    d.el.classList.remove("is-dragging");
    d.el.style.translate = "";
    if (!commit) return render();
    const ids = cardById(selected).fields.map((f) => f.id).filter((x) => x !== d.id);
    const at = d.before ? ids.indexOf(d.before) : ids.length;
    ids.splice(at, 0, d.id);
    reorderFields(ids, d.id);
  };
  box.addEventListener("pointerup", () => end(true));
  box.addEventListener("pointercancel", () => end(false));
  box.addEventListener("keydown", (e) => {
    const grip = e.target.closest("[data-fgrip]");
    if (!grip) return;
    const id = grip.dataset.fgrip;
    if (e.key === " ") {
      e.preventDefault();
      if (!picked) {
        picked = { id, before: cardById(selected).fields.map((f) => f.id) };
        grip.closest(".blk").classList.add("is-dragging");
        $("drag-status").textContent = "Picked up. Use the up and down arrows to move it, space to drop it, escape to cancel.";
      } else {
        picked = null;
        $("drag-status").textContent = "Dropped.";
        reorderFields(cardById(selected).fields.map((f) => f.id), id);
      }
    } else if (picked && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const ids = movedFields(id, e.key === "ArrowUp" ? -1 : 1);
      if (!ids) return;
      const card = cardById(selected);
      const byId = new Map(card.fields.map((f) => [f.id, f]));
      card.fields = ids.map((x) => byId.get(x));
      render();
      const g = $("card-editor").querySelector(`[data-fgrip="${id}"]`);
      g.closest(".blk").classList.add("is-dragging");
      g.focus();
      $("drag-status").textContent = `Position ${ids.indexOf(id) + 1} of ${ids.length}.`;
    } else if (picked && e.key === "Escape") {
      e.preventDefault();
      const card = cardById(selected);
      const byId = new Map(card.fields.map((f) => [f.id, f]));
      card.fields = picked.before.map((x) => byId.get(x));
      picked = null;
      render();
      $("card-editor").querySelector(`[data-fgrip="${id}"]`)?.focus();
      $("drag-status").textContent = "Cancelled. It's back where it was.";
    }
  });
  box.addEventListener("keyup", (e) => {
    if (e.key === " " && e.target.closest("[data-fgrip]")) e.preventDefault();
  });
}

function openFieldMoveMenu(grip) {
  const id = grip.dataset.fgrip;
  const card = cardById(selected);
  const i = card.fields.findIndex((f) => f.id === id);
  const n = card.fields.length;
  $("move-head").innerHTML = `<span class="mh-t">${escapeHtml(fieldName(card.fields[i]))}</span><span class="meta">in ${escapeHtml(card.name)}'s card · field ${i + 1} of ${n}</span>`;
  $("move-menu-items").innerHTML = [
    ["-1", "↑", "Move up", i === 0],
    ["1", "↓", "Move down", i === n - 1],
    ["top", "⤒", "Move to the top", i === 0],
    ["bottom", "⤓", "Move to the bottom", i === n - 1],
  ]
    .map(([k, g, label, off]) => `<button type="button" role="menuitem" class="press" data-move="${k}" ${off ? 'aria-disabled="true"' : ""}><span class="mi glyph" aria-hidden="true">${g}</span>${label}</button>`)
    .join("");
  const dialog = $("move-menu");
  dialog.onclick = (e) => {
    const item = e.target.closest("[data-move]");
    if (!item || item.getAttribute("aria-disabled") === "true") return;
    const k = item.dataset.move;
    closeOverlay(dialog, "replace");
    const ids = movedFields(id, k === "top" || k === "bottom" ? k : Number(k));
    if (ids) reorderFields(ids, id);
    else $("card-editor").querySelector(`[data-fgrip="${id}"]`)?.focus();
  };
  openOverlay(dialog, { opener: grip, anchor: grip, focus: "[role=menuitem]:not([aria-disabled=true])" });
}

// ------------------------------------------------------------------ clicks

async function onEditorClick(e) {
  const t = e.target;
  const card = cardById(selected);
  if (!card) return;
  if (suppressClick) {
    suppressClick = false;
    if (t.closest("[data-fgrip]")) return;
  }
  const grip = t.closest("[data-fgrip]");
  if (grip) return picked ? undefined : openFieldMoveMenu(grip);
  const toggle = t.closest("[data-field-toggle]");
  if (toggle) {
    const id = toggle.dataset.fieldToggle;
    const set = adding ? openWhileAdding : openFields;
    if (set.has(id)) set.delete(id);
    else set.add(id);
    renderEditor();
    $("card-editor").querySelector(`[data-field-toggle="${id}"].${toggle.classList[0]}`)?.focus();
    return;
  }
  const fedit = t.closest("[data-field-edit]");
  if (fedit) {
    const f = card.fields.find((x) => x.id === fedit.dataset.fieldEdit);
    openTextEditor({
      title: fieldName(f),
      sub: `${card.name}'s card · in every chat`,
      text: f.content,
      label: `${card.name}'s ${fieldName(f)}`,
      note: "type {{user}} or {{char}} for whoever is playing",
      opener: fedit,
      onSave: async (text) => Boolean(await saveCard({ fields: fieldsPayload(card, { [f.id]: { content: text } }) })),
    });
    return;
  }
  const flag = t.closest("[data-flag]");
  if (flag) {
    const key = flag.dataset.flag;
    await saveCard({ [key]: !card[key] });
    await loadState();
    render();
    renderSide();
    $("card-editor").querySelector(`[data-flag="${key}"]`)?.focus();
    return;
  }
  const sw = t.closest("[data-colour]");
  if (sw) {
    const c = sw.dataset.colour;
    if (c !== "custom") {
      if (c !== card.colour) await saveCard({ colour: c });
      $("card-editor").querySelector(`[data-colour="${c}"]`)?.focus();
      return;
    }
    const from = card.colour;
    const show = (colour) => {
      card.colour = colour;
      renderLibrary();
      renderEditorBeads(card);
    };
    openPicker(card, sw, {
      live: show,
      commit: async (hex) => {
        await saveCard({ colour: hex });
        $("card-editor").querySelector('[data-colour="custom"]')?.focus();
      },
      revert: () => {
        show(from);
        render();
        $("card-editor").querySelector('[data-colour="custom"]')?.focus();
      },
    });
    return;
  }
  const rn = t.closest("[data-rename]");
  if (rn) {
    renaming = rn.dataset.rename;
    renderEditor();
    const input = $(`rn-${renaming}`);
    input.focus();
    input.select();
    return;
  }
  const rm = t.closest("[data-remove-field]");
  if (rm) {
    const f = card.fields.find((x) => x.id === rm.dataset.removeField);
    const ok = await confirmDialog({ title: `Remove ${f.title}?`, body: `Its text goes from ${card.name}'s card, and from the card's folder in every chat.`, confirm: "remove field", keep: "keep it", opener: rm });
    if (!ok) return;
    card.fields = card.fields.filter((x) => x.id !== f.id);
    await saveCard({ fields: fieldsPayload(card) });
    return;
  }
  if (t.closest("[data-add-field]")) {
    adding = true;
    openWhileAdding.clear();
    renderEditor();
    $("nf-name").focus();
    $("new-field").scrollIntoView({ block: "nearest" });
    return;
  }
  if (t.closest("[data-add-cancel]")) {
    adding = false;
    renderEditor();
    $("card-editor").querySelector("[data-add-field]")?.focus();
    return;
  }
  const del = t.closest("[data-delete-card]");
  if (del) return deleteCard(card, del);
}

/** While picking, only the beads change, so the picker and focus stay where they are. */
function renderEditorBeads(card) {
  const box = $("card-editor");
  const big = box.querySelector(".card-head .gem");
  if (big) big.outerHTML = gem(card, 64);
  for (const chip of document.querySelectorAll("#cast-chips .gem")) void chip;
  renderChat();
}

async function deleteCard(card, opener) {
  const chats = chatsWith(card).map((c) => c.name);
  const where = chats.length ? `${card.name} is in ${chats.length === 1 ? chats[0] : `${chats.slice(0, -1).join(", ")} and ${chats.at(-1)}`}.` : `${card.name} isn't in any chat.`;
  const ok = await confirmDialog({
    title: `Delete ${card.name}?`,
    body: [where, "Deleting takes the card’s folder out of those prompts. Messages already written stay as they are."],
    confirm: `delete ${card.name}`,
    keep: `keep ${card.name}`,
    opener,
  });
  if (!ok) return;
  if (!(await attempt(() => api("DELETE", `/api/cards/${card.id}`)))) return;
  await loadState();
  if (state.chat) state.chat = state.chats.find((c) => c.id === state.chat.id) ?? state.chat;
  selected = null;
  renderChat();
  go(isPhone() ? "#/cards" : state.cards[0] ? `#/cards/${state.cards[0].id}` : "#/cards");
}

async function newCard() {
  const card = await attempt(() => api("POST", "/api/cards", { name: "New card" }));
  if (!card) return;
  await loadState();
  go(`#/cards/${card.id}`);
  setTimeout(() => {
    const input = $("card-name");
    input?.focus();
    input?.select();
  });
}

// ------------------------------------------------------------------ import

function openImport(opener) {
  const d = $("import-dialog");
  d.innerHTML = `
    <header class="dlg-head"><h2 class="disp" id="import-title">Import cards</h2><button type="button" class="ghost press ib" data-close aria-label="Close">${icon.close()}</button></header>
    <div class="dlg-body scroll">
      <p class="meta">Paste one or more cards. Each starts with <code># Name</code>, and each <code>## Heading</code> under it is a field. Description, Advanced Description and System Prompt fill the usual fields; any other heading becomes a field of your own.</p>
      <label class="sr" for="import-text">Cards as markdown</label>
      <textarea id="import-text" class="sunk ftext import-text" placeholder="# Rumi&#10;## Description&#10;…"></textarea>
      <label class="btn raised press file-pick">${icon.import()} pick a .md file<input type="file" id="import-file" class="sr" accept=".md,.markdown,.txt,text/markdown,text/plain" /></label>
      <div id="import-preview" aria-live="polite"></div>
    </div>
    <footer class="dlg-foot"><button type="button" class="btn ghost press" data-close>cancel</button><button type="button" class="btn btn-primary press" id="import-go" disabled>import</button></footer>`;
  openOverlay(d, { opener, focus: "#import-text" });
}

let importTimer = 0;
async function previewImport() {
  const text = $("import-text").value;
  const box = $("import-preview");
  if (!text.trim()) {
    box.innerHTML = "";
    $("import-go").disabled = true;
    return;
  }
  const result = await attempt(() => api("POST", "/api/cards/import", { text, dryRun: true }));
  const cards = result?.cards ?? [];
  $("import-go").disabled = cards.length === 0;
  box.innerHTML = cards.length
    ? `<h3 class="eyebrow">${cards.length} card${cards.length === 1 ? "" : "s"} found</h3><ul class="import-list">${cards
        .map((c) => {
          const taken = state.cards.some((x) => x.name.toLowerCase() === c.name.toLowerCase()) ? ` <span class="tag">name already used</span>` : "";
          return `<li class="raised"><span class="n">${escapeHtml(c.name)}${taken}</span><span class="meta">${c.fields.map((f) => `${escapeHtml(f.title.toLowerCase())} (${fmt(approxTokens(f.content))})`).join(" · ") || "no fields"}</span></li>`;
        })
        .join("")}</ul>`
    : `<p class="meta">No cards found yet. Each card starts with a line like <code># Name</code>.</p>`;
}

function wireImport() {
  const d = $("import-dialog");
  d.addEventListener("click", async (e) => {
    if (e.target.closest("[data-close]")) return closeOverlay(d);
    if (e.target.closest("#import-go")) {
      const result = await attempt(() => api("POST", "/api/cards/import", { text: $("import-text").value }));
      if (!result) return;
      await loadState();
      closeOverlay(d, "replace");
      go(`#/cards/${result.cards[0].id}`);
    }
  });
  d.addEventListener("input", (e) => {
    if (e.target.id !== "import-text") return;
    clearTimeout(importTimer);
    importTimer = setTimeout(previewImport, 300);
  });
  d.addEventListener("change", async (e) => {
    if (e.target.id !== "import-file") return;
    const file = e.target.files?.[0];
    if (!file) return;
    $("import-text").value = await file.text();
    e.target.value = "";
    previewImport();
  });
}

// -------------------------------------------------------------------- wire

export function wireCards() {
  $("cards-back").innerHTML = icon.left(20);
  $("open-import").innerHTML = `${icon.import()}<span class="wide-only">import</span>`;
  $("open-import").setAttribute("aria-label", "Import cards");
  $("new-card").innerHTML = `${icon.plus(16)}<span class="wide-only">new card</span>`;
  $("new-card").setAttribute("aria-label", "New card");
  $("find-icon").innerHTML = icon.search();
  $("find").addEventListener("input", (e) => {
    query = e.target.value;
    renderLibrary();
  });
  $("new-card").addEventListener("click", newCard);
  $("open-import").addEventListener("click", (e) => openImport(e.currentTarget));
  const box = $("card-editor");
  box.addEventListener("click", onEditorClick);
  box.addEventListener("input", (e) => {
    if (e.target.dataset.fieldText) onFieldInput(e.target);
  });
  box.addEventListener("change", async (e) => {
    if (e.target.id === "card-name") {
      if (!e.target.value.trim()) return render();
      await saveCard({ name: e.target.value });
      await loadState();
      render();
      renderSide();
    }
  });
  box.addEventListener("keydown", (e) => {
    const rn = e.target.closest("[data-rename-input]");
    if (rn && (e.key === "Enter" || e.key === "Escape")) {
      e.preventDefault();
      if (e.key === "Escape") rn.value = cardById(selected).fields.find((f) => f.id === rn.dataset.renameInput).title;
      rn.blur();
    }
  });
  box.addEventListener(
    "blur",
    async (e) => {
      const rn = e.target.closest?.("[data-rename-input]");
      if (!rn) return;
      const id = rn.dataset.renameInput;
      const card = cardById(selected);
      renaming = null;
      const title = rn.value.trim();
      if (title && title !== card.fields.find((f) => f.id === id).title) await saveCard({ fields: fieldsPayload(card, { [id]: { title } }) });
      else renderEditor();
      $("card-editor").querySelector(`[data-rename="${id}"]`)?.focus();
    },
    true,
  );
  box.addEventListener("submit", async (e) => {
    if (e.target.id !== "new-field") return;
    e.preventDefault();
    const card = cardById(selected);
    const title = $("nf-name").value.trim();
    if (!title) return $("nf-name").focus();
    const saved = await saveCard({ fields: [...fieldsPayload(card), { key: "custom", title, content: $("nf-text").value }] }, { rerender: false });
    if (!saved) return;
    adding = false;
    const added = saved.fields.at(-1);
    openFields.add(added.id);
    render();
    $("card-editor").querySelector(`[data-field-toggle="${added.id}"]`)?.focus();
  });
  wireFieldMoves(box);
  wirePicker();
  wireImport();
  void macroHtml;
}
