/**
 * The scene, from the chat screen: who's onstage, and the chat's notes.
 *
 * Onstage, a cast member's whole card goes into the prompt; offstage, only
 * its Description, and `{{cast}}` leaves them out. On a wide screen each
 * cast chip in the header is the switch (one tap); the scene menu (the
 * "scene" button by the composer, on every screen size) has the same
 * switches plus the chat's two notes, "Right now" and "Who knows what",
 * written right there: each note saves itself a moment after you stop
 * typing, and again when the sheet closes. The notes are blocks on the
 * prompts page too: same text, two ways in.
 */

import { $, api, attempt, cardById, escapeHtml, gem, state } from "./core.js";
import { icon } from "./icons.js";
import { openOverlay, place } from "./overlay.js";

/** What each note is for, shown under it while it's empty. */
const NOTE_HINTS = {
  "Right now": "where the story stands",
  "Who knows what": "one line per secret",
};

let notes = [];
/** The button the scene opened from: on a wide screen the menu sits by it, and moves as notes grow. */
let anchor = null;

/** How long after the last keystroke a note saves. */
const SAVE_AFTER_MS = 700;
/** Per note id: the pending save timer, and the save in flight (so saves never overlap). */
const timers = new Map();
const inflight = new Map();

export const isOffstage = (cardId) => Boolean(state.chat?.offstage?.includes(cardId));

/** Flip one cast member on or off stage, then redraw whatever shows it. */
export async function toggleStage(cardId) {
  const chat = state.chat;
  if (!chat) return null;
  const offstage = isOffstage(cardId) ? chat.offstage.filter((id) => id !== cardId) : [...chat.offstage, cardId];
  const saved = await attempt(() => api("PATCH", `/api/chats/${chat.id}`, { offstage }));
  if (!saved) return null;
  state.chat = saved;
  const i = state.chats.findIndex((c) => c.id === saved.id);
  if (i >= 0) state.chats[i] = saved;
  document.dispatchEvent(new CustomEvent("anoesia:stage-changed"));
  return saved;
}

/** "onstage · whole card" or "offstage · description only". */
export function stageLine(cardId) {
  return isOffstage(cardId) ? "offstage · description only" : "onstage · whole card";
}

// ---------------------------------------------------------------- the menu

export async function openScene(opener) {
  if (!state.chat) return;
  await flushAll();
  const blocks = await attempt(() => api("GET", `/api/chats/${state.chatId}/blocks`));
  if (!blocks) return;
  notes = blocks.filter((b) => b.kind === "note");
  anchor = opener;
  $("scene-menu").replaceChildren(); // fresh from the server, not what an earlier visit left typed
  render();
  openOverlay($("scene-menu"), { opener, anchor: opener, focus: "[data-stage], [data-note]", onClose: () => void flushAll() });
  fitNotes();
}

/** Size every note to its text, then put the menu back by its button (its height changed). */
function fitNotes() {
  for (const area of $("scene-menu").querySelectorAll("[data-note]")) autosize(area);
  if (anchor?.isConnected) place($("scene-menu"), anchor);
}

function render() {
  // A redraw (a switch flipped) keeps what's typed in the notes, saved or not.
  const typed = new Map([...$("scene-menu").querySelectorAll("[data-note]")].map((a) => [a.dataset.note, a.value]));
  const cast = (state.chat?.cast ?? []).map(cardById).filter(Boolean);
  const castRows = cast
    .map(
      (c) => `<li class="sc-row">${gem(c, 28)}<span class="sc-text"><span class="sc-n">${escapeHtml(c.name)}${c.isPersona ? ' <span class="chip-you">· you</span>' : ""}</span><span class="meta">${stageLine(c.id)}</span></span>
        <button type="button" role="switch" class="switch" aria-checked="${!isOffstage(c.id)}" aria-label="${escapeHtml(c.name)} onstage" data-stage="${c.id}"><span class="knob"></span></button></li>`,
    )
    .join("");
  const noteRows = notes
    .map((n) => {
      const hint = NOTE_HINTS[n.title] ?? "this chat only";
      return `<li class="sc-note"><span class="sc-note-head"><label class="sc-n" for="sc-note-${n.id}">${escapeHtml(n.title)}${n.enabled ? "" : ' <span class="chip-you">· switched off</span>'}</label><span class="sc-saved" data-saved="${n.id}" aria-live="polite"></span></span>
        <textarea class="sunk" id="sc-note-${n.id}" data-note="${n.id}" rows="2" placeholder="${escapeHtml(hint)} · empty isn't sent">${escapeHtml(typed.get(n.id) ?? n.content)}</textarea></li>`;
    })
    .join("");
  $("scene-menu").innerHTML = `
    <div class="menu-head"><span class="mh-t" id="scene-title">This scene</span><span class="meta">${escapeHtml(state.chat.name)}</span></div>
    <h3 class="eyebrow sc-h" id="sc-cast-h">On stage</h3>
    <ul class="sc-list" aria-labelledby="sc-cast-h">${castRows || `<li class="meta sc-empty">No cast yet. Add cards in chat settings.</li>`}</ul>
    <h3 class="eyebrow sc-h" id="sc-notes-h">Notes <span class="meta">sent when they have text</span></h3>
    <ul class="sc-list" aria-labelledby="sc-notes-h">${noteRows}</ul>`;
}

async function onClick(e) {
  const sw = e.target.closest("[data-stage]");
  if (sw) {
    const id = sw.dataset.stage;
    if (await toggleStage(id)) {
      render();
      fitNotes();
      $("scene-menu").querySelector(`[data-stage="${CSS.escape(id)}"]`)?.focus();
    }
    return;
  }
}

// ---------------------------------------------------------------- the notes, written in place

function autosize(area) {
  area.style.height = "auto";
  area.style.height = `${area.scrollHeight + 2}px`;
}

function showSaved(id, text) {
  const el = $("scene-menu").querySelector(`[data-saved="${CSS.escape(id)}"]`);
  if (el) el.textContent = text;
}

function onInput(e) {
  const area = e.target.closest("[data-note]");
  if (!area) return;
  const before = area.offsetHeight;
  autosize(area);
  if (area.offsetHeight !== before && anchor?.isConnected) place($("scene-menu"), anchor);
  const id = area.dataset.note;
  showSaved(id, "");
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => void save(id, area.value), SAVE_AFTER_MS));
}

/** Save one note's text, if it changed. Waits for an earlier save of the same note first. */
async function save(id, text) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const before = inflight.get(id);
  const run = (async () => {
    await before;
    const note = notes.find((n) => n.id === id);
    if (!note || note.content === text) return;
    showSaved(id, "saving…");
    const saved = await attempt(() => api("PATCH", `/api/blocks/${id}`, { content: text }));
    if (!saved) {
      showSaved(id, "not saved");
      return;
    }
    notes = notes.map((n) => (n.id === saved.id ? saved : n));
    showSaved(id, "saved");
  })();
  inflight.set(id, run);
  await run;
  if (inflight.get(id) === run) inflight.delete(id);
}

/** Save whatever is still waiting: when a note loses focus, and when the sheet closes. */
function flushAll() {
  const pending = [];
  for (const area of $("scene-menu").querySelectorAll("[data-note]")) {
    if (timers.has(area.dataset.note)) pending.push(save(area.dataset.note, area.value));
  }
  return Promise.all(pending);
}

export function wireScene() {
  $("open-scene").insertAdjacentHTML("afterbegin", icon.text(18));
  $("scene-menu").addEventListener("click", onClick);
  $("scene-menu").addEventListener("input", onInput);
  $("scene-menu").addEventListener("focusout", (e) => {
    const area = e.target.closest?.("[data-note]");
    if (area && timers.has(area.dataset.note)) void save(area.dataset.note, area.value);
  });
  // Leaving the page with a note still waiting: send it anyway.
  addEventListener("pagehide", () => void flushAll());
}
