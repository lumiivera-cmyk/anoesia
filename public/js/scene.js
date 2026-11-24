/**
 * The scene, from the chat screen: who's onstage, the chat's notes, and its
 * nudges.
 *
 * Onstage, a cast member's whole card goes into the prompt; offstage, only
 * its Description, and `{{cast}}` leaves them out. On a wide screen each
 * cast chip in the header is the switch (one tap); the scene menu (the
 * "scene" button by the composer, on every screen size) has the same
 * switches plus the chat's two notes, "Right now" and "Who knows what",
 * and its nudges, all written right there: each text saves itself a moment
 * after you stop typing, when it loses focus, and when the sheet closes.
 *
 * A nudge is a text block marked as one (`nudge`): the ones made here or
 * from the ready-made list (src/nudges.ts), and any block the prompts page
 * puts "in the scene menu". New ones go right after your post, as you; the
 * mark stays whatever the block is renamed to or wherever it moves. The
 * sheet lets you switch each on or off, rename, reword or remove it, and
 * adds your own or a ready-made one. Notes and nudges are blocks on the
 * prompts page too: same text, two ways in.
 *
 * "Story so far" is the note that stands in for older messages
 * (src/summary.ts). Under it: how far it reaches, how many of the latest
 * messages go word for word, whether it folds on its own, fold now, and
 * start over. Folding adds to the end of the note; what you wrote stays.
 */

import { $, api, attempt, cardById, escapeHtml, gem, state } from "./core.js";
import { icon } from "./icons.js";
import { confirmDialog, openOverlay, place } from "./overlay.js";

/** What each note is for, shown in it while it's empty. */
const NOTE_HINTS = {
  "Story so far": "older scenes, as finished beats · stands in for the messages it covers",
  "Right now": "where the story stands",
  "Who knows what": "one line per secret",
};

/** The ready-made nudges (src/nudges.ts), offered while the chat has none by that name or with its words (renamed). */
const PRESETS = [
  { preset: "pace", title: "Match my pace", label: "match my pace", marker: "{{paceNote}}" },
  { preset: "restraint", title: "Scene restraint", label: "scene restraint", marker: "Stop at the first point where" },
];

/** This chat's notes and nudges, as the server last saved them. */
let blocks = [];
/** How the story so far stands (GET /api/chats/:id/summary). */
let summary = null;
let summaryPoll = 0;
const SUMMARY = "Story so far";
/** The button the scene opened from: on a wide screen the menu sits by it, and moves as it grows. */
let anchor = null;

/** How long after the last keystroke a text saves. */
const SAVE_AFTER_MS = 700;
/** Per "block id:field": the pending save timer, and the save in flight (so saves never overlap). */
const timers = new Map();
const inflight = new Map();

const isNudge = (b) => b.kind === "text" && b.nudge;
const notes = () => blocks.filter((b) => b.kind === "note");
const nudges = () => blocks.filter(isNudge);
const menu = () => $("scene-menu");

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
  if (!(await reload())) return;
  anchor = opener;
  menu().replaceChildren(); // fresh from the server, not what an earlier visit left typed
  render();
  openOverlay(menu(), { opener, anchor: opener, focus: "[data-stage], [data-text]", onClose: () => void flushAll() });
  fit();
}

async function reload() {
  const [all, sum] = await Promise.all([attempt(() => api("GET", `/api/chats/${state.chatId}/blocks`)), attempt(() => api("GET", `/api/chats/${state.chatId}/summary`))]);
  if (!all || !sum) return false;
  blocks = all.filter((b) => b.kind === "note" || isNudge(b));
  summary = sum;
  watchFolding();
  return true;
}

/** While a summary is being written on its own, look again now and then, and show it when it's done. */
function watchFolding() {
  clearTimeout(summaryPoll);
  if (!summary?.folding) return;
  const chatId = state.chatId;
  summaryPoll = setTimeout(async () => {
    if (!menu().open || state.chatId !== chatId) return;
    const sum = await api("GET", `/api/chats/${chatId}/summary`).catch(() => null);
    if (!sum || !menu().open || state.chatId !== chatId) return;
    if (!sum.folding) await takeNote(sum);
    else summary = sum;
    watchFolding();
  }, 3000);
}

/** A new summary state, with the note's text as the server has it now (folding wrote to it). */
async function takeNote(sum) {
  summary = sum;
  const note = sum.note ?? (await attempt(() => api("GET", `/api/chats/${state.chatId}/blocks`)))?.find((b) => b.kind === "note" && b.title === SUMMARY);
  if (note) {
    blocks = blocks.map((b) => (b.id === note.id ? { ...b, content: note.content } : b));
    const area = menu().querySelector(`[data-text="${CSS.escape(note.id)}:content"]`);
    if (area) area.value = note.content;
  }
  document.dispatchEvent(new CustomEvent("anoesia:summary-changed", { detail: sum }));
  redraw();
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Under the Story so far note: its reach, what's waiting, and its controls. */
function summaryHtml(n) {
  if (!summary) return "";
  const s = summary;
  let line;
  if (s.folding) line = "Writing the next part…";
  else if (s.covered) line = `Covers the first ${plural(s.covered, "message")}${s.sent ? ", which aren't sent word for word" : `, but it's ${n.enabled ? "empty" : "switched off"}, so they're sent word for word`}.`;
  else line = "Nothing folded in yet: every message is sent word for word.";
  if (!s.folding && s.waiting) line += ` ${plural(s.waiting, "older message")} could be folded in${s.auto ? `; it folds on its own at ${s.batch}` : ""}.`;
  const stale = s.stale && !s.folding ? `<p class="sc-sum-warn" role="status">A folded message was edited, deleted or swapped for another version since. Check the summary still fits. <button type="button" class="btn ghost press sc-inline" data-sum="checked">it fits</button></p>` : "";
  const error = s.error && !s.folding ? `<p class="sc-sum-warn" role="alert">Couldn't fold: ${escapeHtml(s.error)}</p>` : "";
  return `<div class="sc-sum" aria-live="polite">
      <p class="meta sc-sum-line">${escapeHtml(line)}</p>${stale}${error}
      <div class="sc-sum-row">
        <span class="depth" role="group" aria-label="Messages kept word for word"><span class="meta">latest kept word for word</span>
          <button type="button" class="step press" data-keep="-10" aria-label="Keep 10 fewer word for word" aria-disabled="${s.keep <= 10}">−</button>
          <span class="dn">${s.keep}</span>
          <button type="button" class="step press" data-keep="10" aria-label="Keep 10 more word for word" aria-disabled="${s.keep >= 990}">+</button></span>
        <span class="sc-sum-auto"><span class="meta">on its own</span><button type="button" role="switch" class="switch" aria-checked="${s.auto}" aria-label="Fold on its own" data-sum-auto><span class="knob"></span></button></span>
      </div>
      <div class="sc-add sc-sum-acts">
        <button type="button" class="raised press btn" data-sum="fold" ${s.folding || !s.waiting ? 'aria-disabled="true"' : ""}>${icon.text(16)}fold now</button>
        ${s.covered || n.content.trim() ? `<button type="button" class="ghost press btn" data-sum="reset" ${s.folding ? 'aria-disabled="true"' : ""}>start over</button>` : ""}
      </div>
    </div>`;
}

async function onSummary(e) {
  const keep = e.target.closest("[data-keep]");
  if (keep) {
    if (keep.getAttribute("aria-disabled") === "true") return;
    const next = Math.min(990, Math.max(10, Math.round((summary.keep + Number(keep.dataset.keep)) / 10) * 10));
    const done = await attempt(() => api("PATCH", `/api/chats/${state.chatId}`, { summaryKeep: next }));
    if (done) await refreshSummary(`[data-keep="${keep.dataset.keep}"]`);
    return true;
  }
  if (e.target.closest("[data-sum-auto]")) {
    const done = await attempt(() => api("PATCH", `/api/chats/${state.chatId}`, { summaryAuto: !summary.auto }));
    if (done) await refreshSummary("[data-sum-auto]");
    return true;
  }
  const act = e.target.closest("[data-sum]");
  if (!act) return false;
  if (act.getAttribute("aria-disabled") === "true") return true;
  const what = act.dataset.sum;
  if (what === "reset" && !(await confirmDialog({ title: "Start the story so far over?", body: ["The note is emptied, and every message is sent word for word again until it's folded anew."], confirm: "start over", opener: act }))) return true;
  await flushAll();
  if (what === "fold") {
    summary = { ...summary, folding: true, error: "" };
    redraw();
  }
  const done = await attempt(() => api("POST", `/api/chats/${state.chatId}/summary/${what}`));
  if (done) await takeNote(done);
  else await refreshSummary();
  menu().querySelector(what === "reset" ? "[data-sum=fold]" : `[data-sum="${what}"]`)?.focus();
  return true;
}

async function refreshSummary(focus) {
  const sum = await attempt(() => api("GET", `/api/chats/${state.chatId}/summary`));
  if (sum) summary = sum;
  document.dispatchEvent(new CustomEvent("anoesia:summary-changed", { detail: summary }));
  watchFolding();
  redraw(focus);
}

/** Size every text to what's in it, then put the menu back by its button (its height changed). */
function fit() {
  for (const area of menu().querySelectorAll("textarea")) autosize(area);
  if (anchor?.isConnected && menu().open) place(menu(), anchor);
}

const saved = (id) => `<span class="sc-saved" data-saved="${id}" aria-live="polite"></span>`;

function render() {
  // A redraw keeps whatever is typed, saved or not.
  const typed = new Map([...menu().querySelectorAll("[data-text]")].map((a) => [a.dataset.text, a.value]));
  const value = (b, field) => typed.get(`${b.id}:${field}`) ?? b[field];
  const cast = (state.chat?.cast ?? []).map(cardById).filter(Boolean);
  const castRows = cast
    .map(
      (c) => `<li class="sc-row">${gem(c, 28)}<span class="sc-text"><span class="sc-n">${escapeHtml(c.name)}${c.isPersona ? ' <span class="chip-you">· you</span>' : ""}</span><span class="meta">${stageLine(c.id)}</span></span>
        <button type="button" role="switch" class="switch" aria-checked="${!isOffstage(c.id)}" aria-label="${escapeHtml(c.name)} onstage" data-stage="${c.id}"><span class="knob"></span></button></li>`,
    )
    .join("");
  const noteRows = notes()
    .map((n) => {
      const hint = NOTE_HINTS[n.title] ?? "this chat only";
      return `<li class="sc-note"><span class="sc-note-head"><label class="sc-n" for="sc-${n.id}">${escapeHtml(n.title)}${n.enabled ? "" : ' <span class="chip-you">· switched off</span>'}</label>${saved(n.id)}</span>
        <textarea class="sunk" id="sc-${n.id}" data-text="${n.id}:content" rows="2" placeholder="${escapeHtml(hint)} · empty isn't sent">${escapeHtml(value(n, "content"))}</textarea>${n.title === SUMMARY ? summaryHtml(n) : ""}</li>`;
    })
    .join("");
  const nudgeRows = nudges()
    .map((n) => {
      const title = value(n, "title");
      return `<li class="sc-note sc-nudge${n.enabled ? "" : " is-off"}"><span class="sc-note-head">
          <input class="sc-title" id="sc-t-${n.id}" data-text="${n.id}:title" value="${escapeHtml(title)}" aria-label="Nudge name" maxlength="200" />${saved(n.id)}
          <button type="button" class="ghost press ib sc-del" data-remove="${n.id}" aria-label="Remove ${escapeHtml(title)}" title="Remove">${icon.trash(18)}</button>
          <button type="button" role="switch" class="switch" aria-checked="${n.enabled}" aria-label="${escapeHtml(title)} on" data-enable="${n.id}"><span class="knob"></span></button></span>
        <textarea class="sunk" id="sc-${n.id}" data-text="${n.id}:content" rows="2" aria-label="${escapeHtml(title)} text" placeholder="what the narrator should keep in mind next · empty isn't sent">${escapeHtml(value(n, "content"))}</textarea>${whereLine(n)}</li>`;
    })
    .join("");
  const presetButtons = PRESETS.filter((p) => !nudges().some((n) => n.title === p.title || n.content.includes(p.marker)))
    .map((p) => `<button type="button" class="raised press btn" data-preset="${p.preset}">${icon.plus(16)}${p.label}</button>`)
    .join("");
  // Only the body is redrawn: in selenite the sheet's plate lives in the dialog beside it.
  let body = menu().querySelector(":scope > .sc-body");
  if (!body) menu().append((body = Object.assign(document.createElement("div"), { className: "sc-body" })));
  body.innerHTML = `
    <div class="menu-head"><span class="mh-t" id="scene-title">This scene</span><span class="meta">${escapeHtml(state.chat.name)}</span></div>
    <h3 class="eyebrow sc-h" id="sc-cast-h">On stage</h3>
    <ul class="sc-list" aria-labelledby="sc-cast-h">${castRows || `<li class="meta sc-empty">No cast yet. Add cards in chat settings.</li>`}</ul>
    <h3 class="eyebrow sc-h" id="sc-notes-h">Notes <span class="meta">sent when they have text</span></h3>
    <ul class="sc-list" aria-labelledby="sc-notes-h">${noteRows}</ul>
    <h3 class="eyebrow sc-h" id="sc-nudges-h">Nudges <span class="meta">sent right after your post, as you</span></h3>
    <ul class="sc-list" aria-labelledby="sc-nudges-h">${nudgeRows || `<li class="meta sc-empty">None in this chat.</li>`}</ul>
    <div class="sc-add"><button type="button" class="raised press btn" data-new-nudge>${icon.plus(16)}your own</button>${presetButtons}</div>`;
}

/** Where a nudge goes, when it isn't the usual right after your post, as you (moved on the prompts page). */
function whereLine(n) {
  if (n.role === "user" && n.depth === 0) return "";
  const who = n.role === "user" ? "as you" : n.role === "assistant" ? "as the narrator" : "as instructions";
  const where = n.depth === null ? "in its place in the prompt" : n.depth === 0 ? "after the last message" : `${n.depth} message${n.depth === 1 ? "" : "s"} from the end`;
  return `<span class="meta sc-where">sent ${who}, ${where} · change it on the prompts page</span>`;
}

/** Redraw, size the texts, and put focus on `selector` (the control that was used, or what replaced it). */
function redraw(selector) {
  render();
  fit();
  if (selector) menu().querySelector(selector)?.focus();
}

async function onClick(e) {
  if (await onSummary(e)) return;
  const sw = e.target.closest("[data-stage]");
  if (sw) {
    const id = sw.dataset.stage;
    if (await toggleStage(id)) redraw(`[data-stage="${CSS.escape(id)}"]`);
    return;
  }
  const on = e.target.closest("[data-enable]");
  if (on) {
    const id = on.dataset.enable;
    const block = blocks.find((b) => b.id === id);
    const done = block && (await attempt(() => api("PATCH", `/api/blocks/${id}`, { enabled: !block.enabled })));
    if (!done) return;
    blocks = blocks.map((b) => (b.id === id ? { ...b, enabled: done.enabled } : b));
    redraw(`[data-enable="${CSS.escape(id)}"]`);
    return;
  }
  const rm = e.target.closest("[data-remove]");
  if (rm) {
    const id = rm.dataset.remove;
    const area = menu().querySelector(`[data-text="${CSS.escape(id)}:content"]`);
    const title = menu().querySelector(`[data-text="${CSS.escape(id)}:title"]`)?.value || "this nudge";
    // An empty nudge goes at once; one with words in it asks first.
    if (area?.value.trim() && !(await confirmDialog({ title: `Remove ${title}?`, body: "It goes from this chat's prompt, here and on the prompts page.", confirm: "remove", opener: rm }))) return;
    for (const key of [`${id}:title`, `${id}:content`]) clearTimeout(timers.get(key)), timers.delete(key);
    await Promise.all([inflight.get(`${id}:title`), inflight.get(`${id}:content`)]);
    if (!(await attempt(() => api("DELETE", `/api/blocks/${id}`)))) return;
    blocks = blocks.filter((b) => b.id !== id);
    redraw("[data-new-nudge]");
    return;
  }
  const add = e.target.closest("[data-new-nudge], [data-preset]");
  if (add) {
    const body = add.dataset.preset ? { preset: add.dataset.preset } : { title: "Nudge", content: "", role: "user", depth: 0, nudge: true };
    const made = await attempt(() => api("POST", `/api/chats/${state.chatId}/blocks`, body));
    if (!made) return;
    blocks = [...blocks, made];
    redraw(add.dataset.preset ? "[data-new-nudge]" : `[data-text="${CSS.escape(made.id)}:content"]`);
    menu().querySelector(`[data-text="${CSS.escape(made.id)}:content"]`)?.scrollIntoView({ block: "nearest" });
  }
}

// ---------------------------------------------------------------- texts written in place

function autosize(area) {
  area.style.height = "auto";
  area.style.height = `${area.scrollHeight + 2}px`;
}

/** "saving…", "saved" and so on, by the block's name. */
function showSaved(key, text) {
  const el = menu().querySelector(`[data-saved="${CSS.escape(key.split(":")[0])}"]`);
  if (el) el.textContent = text;
}

function onInput(e) {
  const box = e.target.closest("[data-text]");
  if (!box) return;
  if (box.tagName === "TEXTAREA") {
    const before = box.offsetHeight;
    autosize(box);
    if (box.offsetHeight !== before && anchor?.isConnected) place(menu(), anchor);
  }
  const key = box.dataset.text;
  showSaved(key, "");
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => void save(key, box.value), SAVE_AFTER_MS));
}

/** Save one text ("block id:content" or "block id:title"), if it changed. Waits for an earlier save of the same text first. */
async function save(key, text) {
  clearTimeout(timers.get(key));
  timers.delete(key);
  const [id, field] = key.split(":");
  const before = inflight.get(key);
  const run = (async () => {
    await before;
    const block = blocks.find((b) => b.id === id);
    if (!block) return;
    const value = field === "title" ? text.trim() : text;
    if (field === "title" && !value) return showSaved(key, "needs a name");
    if (block[field] === value) return showSaved(key, "");
    showSaved(key, "saving…");
    const done = await attempt(() => api("PATCH", `/api/blocks/${id}`, { [field]: value }));
    if (!done) return showSaved(key, "not saved");
    blocks = blocks.map((b) => (b.id === id ? { ...b, [field]: done[field] } : b));
    showSaved(key, "saved");
  })();
  inflight.set(key, run);
  await run;
  if (inflight.get(key) === run) inflight.delete(key);
}

/** Save whatever is still waiting: when a text loses focus, and when the sheet closes. */
function flushAll() {
  const pending = [];
  for (const box of menu().querySelectorAll("[data-text]")) {
    if (timers.has(box.dataset.text)) pending.push(save(box.dataset.text, box.value));
  }
  return Promise.all([...pending, ...inflight.values()]);
}

export function wireScene() {
  $("open-scene").insertAdjacentHTML("afterbegin", icon.text(18));
  menu().addEventListener("click", onClick);
  menu().addEventListener("input", onInput);
  menu().addEventListener("focusout", (e) => {
    const box = e.target.closest?.("[data-text]");
    if (box && timers.has(box.dataset.text)) void save(box.dataset.text, box.value);
  });
  // Leaving the page with a text still waiting: send it anyway.
  addEventListener("pagehide", () => void flushAll());
}
