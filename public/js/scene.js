/**
 * The scene, from the chat screen: who's onstage, and the chat's notes.
 *
 * Onstage, a cast member's whole card goes into the prompt; offstage, only
 * its Description, and `{{cast}}` leaves them out. On a wide screen each
 * cast chip in the header is the switch (one tap); the scene menu (the
 * "scene" button by the composer, on every screen size) has the same
 * switches plus the chat's two notes, "Right now" and "Who knows what",
 * each one tap from its editor. The notes are blocks on the prompts page
 * too: same text, two ways in.
 */

import { $, api, attempt, cardById, escapeHtml, gem, state } from "./core.js";
import { openTextEditor } from "./editor.js";
import { icon } from "./icons.js";
import { openOverlay } from "./overlay.js";

/** What each note is for, shown under it while it's empty. */
const NOTE_HINTS = {
  "Right now": "where the story stands",
  "Who knows what": "one line per secret",
};

let notes = [];

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
  const blocks = await attempt(() => api("GET", `/api/chats/${state.chatId}/blocks`));
  if (!blocks) return;
  notes = blocks.filter((b) => b.kind === "note");
  render();
  openOverlay($("scene-menu"), { opener, anchor: opener, focus: "[data-stage], [data-note]" });
}

function render() {
  const cast = (state.chat?.cast ?? []).map(cardById).filter(Boolean);
  const castRows = cast
    .map(
      (c) => `<li class="sc-row">${gem(c, 28)}<span class="sc-text"><span class="sc-n">${escapeHtml(c.name)}${c.isPersona ? ' <span class="chip-you">· you</span>' : ""}</span><span class="meta">${stageLine(c.id)}</span></span>
        <button type="button" role="switch" class="switch" aria-checked="${!isOffstage(c.id)}" aria-label="${escapeHtml(c.name)} onstage" data-stage="${c.id}"><span class="knob"></span></button></li>`,
    )
    .join("");
  const noteRows = notes
    .map((n) => {
      const text = n.content.trim();
      const line = text ? escapeHtml(text.split("\n")[0]) : `<span class="faint">empty · ${NOTE_HINTS[n.title] ?? "not sent"}</span>`;
      return `<li><button type="button" class="sc-note press" data-note="${n.id}" aria-label="Edit ${escapeHtml(n.title)}${text ? "" : ", empty"}">
        <span class="sc-text"><span class="sc-n">${escapeHtml(n.title)}${n.enabled ? "" : ' <span class="chip-you">· switched off</span>'}</span><span class="sc-line">${line}</span></span>${icon.edit(18)}</button></li>`;
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
      $("scene-menu").querySelector(`[data-stage="${CSS.escape(id)}"]`)?.focus();
    }
    return;
  }
  const row = e.target.closest("[data-note]");
  if (row) {
    const note = notes.find((n) => n.id === row.dataset.note);
    if (!note) return;
    openTextEditor({
      title: note.title,
      sub: `${state.chat.name}'s note · ${NOTE_HINTS[note.title] ?? "this chat only"}`,
      text: note.content,
      label: `${note.title} text`,
      note: "This chat only. An empty note isn't sent.",
      opener: row,
      onSave: async (text) => {
        const saved = await attempt(() => api("PATCH", `/api/blocks/${note.id}`, { content: text }));
        if (!saved) return false;
        notes = notes.map((n) => (n.id === saved.id ? saved : n));
        if ($("scene-menu").open) render();
        return true;
      },
    });
  }
}

export function wireScene() {
  $("open-scene").insertAdjacentHTML("afterbegin", icon.text(18));
  $("scene-menu").addEventListener("click", onClick);
}
