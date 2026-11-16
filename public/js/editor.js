/**
 * Editing text: the macro bar (tap a chip to insert a macro), and the
 * full-screen editor with Save and Cancel that phones use for prompt
 * blocks and card fields.
 */

import { $, approxTokens, escapeHtml, fmt, macroHtml } from "./core.js";
import { closeOverlay, openOverlay } from "./overlay.js";

/** The macros on the bar, in the order people reach for them. */
const BAR = [
  ["user", "{{user}}"],
  ["char", "{{char}}"],
  ["cast", "{{cast}}"],
  ["date", "{{date}}"],
  ["time", "{{time}}"],
  ["random", "{{random::a::b}}"],
  ["getvar", "{{getvar::name}}"],
  ["//", "{{// a note to yourself}}"],
];

export function macroBarHtml(target) {
  return BAR.map(([name, text]) => `<button type="button" class="mac press" data-insert="${escapeHtml(text)}" data-target="${target}" aria-label="Insert ${escapeHtml(text)}"><span class="hit"></span>${escapeHtml(name)}</button>`).join("");
}

/** Wire a container's macro chips to insert into their textarea. */
export function wireMacroBar(root) {
  root.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-insert]");
    if (!chip) return;
    const area = document.getElementById(chip.dataset.target);
    if (!area) return;
    const text = chip.dataset.insert;
    const start = area.selectionStart ?? area.value.length;
    const end = area.selectionEnd ?? start;
    area.setRangeText(text, start, end, "end");
    area.dispatchEvent(new Event("input", { bubbles: true }));
    area.focus();
  });
}

/** "scene_mood isn't a macro I know, so it's sent as typed". */
export function unknownNote(text) {
  const { unknown } = macroHtml(text);
  if (!unknown.length) return "";
  const names = unknown.map((u) => u.split(/::|:/)[0]);
  return `${names.join(", ")} ${names.length === 1 ? "isn't a macro I know, so it's" : "aren't macros I know, so they're"} sent as typed`;
}

let current = null;

/**
 * The full-screen editor. `name` (optional) adds a title field.
 * `onSave(text, name)` may return false to keep it open.
 */
export function openTextEditor({ title, sub = "", text, name = null, note = "", label = "Text", opener, onSave }) {
  const dialog = $("text-editor");
  $("te-title").textContent = title;
  $("te-sub").textContent = sub;
  $("te-text").value = text;
  $("te-text-label").textContent = label;
  $("te-name-row").hidden = name === null;
  $("te-name").value = name ?? "";
  $("te-note").textContent = note;
  const count = () => ($("te-tok").textContent = text.trim() || $("te-text").value.trim() ? `${fmt(approxTokens($("te-text").value))} t` : "—");
  count();
  current = { onSave, count };
  openOverlay(dialog, { opener, focus: name === null ? "#te-text" : "#te-name", onClose: () => (current = null) });
}

export function wireTextEditor() {
  $("te-macbar").innerHTML = macroBarHtml("te-text");
  wireMacroBar($("te-macbar"));
  $("te-text").addEventListener("input", () => current?.count());
  $("text-editor").querySelector("[data-te-cancel]").addEventListener("click", () => closeOverlay($("text-editor"), "cancel"));
  $("te-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!current) return;
    const keep = await current.onSave($("te-text").value, $("te-name-row").hidden ? null : $("te-name").value);
    if (keep !== false) closeOverlay($("text-editor"));
  });
}
