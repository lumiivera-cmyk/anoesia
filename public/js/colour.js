/**
 * A card's bead colour: the three presets or any colour from the picker
 * (a saturation and brightness area, a hue slider and a hex field).
 *
 * Changes show live on every bead for the card. Done or a tap outside keeps
 * them; Cancel (or Esc) puts back the colour from when the picker opened.
 * The picker starts from the bead's current colour, and the bead only turns
 * custom once something moves, so opening and closing it changes nothing.
 */

import { $, escapeHtml, gem, state } from "./core.js";
import { closeOverlay, openOverlay } from "./overlay.js";

/** Each preset's base colour, where the picker starts from a preset bead. */
export const PRESET_BASE = { violet: "#B488FF", blue: "#62C3FF", pink: "#FF6FD8" };

const toHex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
export function hsvToHex({ h, s, v }) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return toHex(f(5) * 255, f(3) * 255, f(1) * 255);
}
export function hexToHsv(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b);
  const d = mx - Math.min(r, g, b);
  let h = 0;
  if (d) {
    h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: mx ? d / mx : 0, v: mx };
}
const HUES = [
  [15, "red"],
  [45, "orange"],
  [70, "yellow"],
  [165, "green"],
  [200, "cyan"],
  [255, "blue"],
  [290, "violet"],
  [335, "pink"],
  [361, "red"],
];
const hueName = (h) => HUES.find((x) => h < x[0])[1];
const pct = (x) => Math.round(x * 100);
const clamp = (x) => Math.max(0, Math.min(1, x));

/** The swatch row: three presets and the rainbow ring (a radio that opens the picker). */
export function swatchesHtml(card) {
  const custom = card.colour.startsWith("#");
  const remembered = custom ? card.colour : card.customColour;
  const label = remembered ? `Custom colour ${remembered}. Opens the colour picker` : "Custom colour. Opens the colour picker to choose any colour";
  return `<div role="radiogroup" aria-label="Colour for ${escapeHtml(card.name)}" class="swatches">${["violet", "blue", "pink"]
    .map(
      (c) =>
        `<button type="button" class="swatch press" role="radio" aria-checked="${card.colour === c}" aria-label="${c}" data-colour="${c}"><span class="gem gem-${c}" aria-hidden="true" style="width:30px;height:30px"></span></button>`,
    )
    .join("")}<button type="button" class="swatch press" role="radio" aria-checked="${custom}" aria-label="${escapeHtml(label)}" data-colour="custom" aria-haspopup="dialog"><span class="huewheel">${
    remembered
      ? `<span class="gem gem-custom" aria-hidden="true" style="--gem:${remembered};width:22px;height:22px"></span>`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="stroke: var(--ink-1)" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`
  }</span></button></div>`;
}

let pick = null;

/**
 * Open the picker for a card. `live(colour)` shows a colour on every bead
 * without saving; `commit(colour)` saves; `revert()` puts the opening colour back.
 */
export function openPicker(card, opener, { live, commit, revert }) {
  const start = card.colour.startsWith("#") ? card.colour : card.customColour || PRESET_BASE[card.colour] || PRESET_BASE.violet;
  // A remembered custom colour is selected at once; a preset stays a preset until something moves.
  const startsCustom = !card.colour.startsWith("#") && Boolean(card.customColour);
  pick = { card, hsv: hexToHsv(start), moved: startsCustom, draft: null, live, commit, revert, from: card.colour };
  if (startsCustom) live(card.customColour);
  renderPicker();
  openOverlay($("colour-picker"), {
    opener,
    anchor: opener,
    focus: ".thumb",
    onClose: (reason) => {
      const p = pick;
      pick = null;
      if (!p) return;
      if (reason === "cancel") p.revert();
      else if (p.moved) p.commit(hsvToHex(p.hsv));
      else p.revert();
    },
  });
}

function renderPicker() {
  const { card, hsv } = pick;
  const hex = hsvToHex(hsv);
  const shown = { ...card, colour: pick.moved ? hex : card.colour };
  const others = state.cards.filter((c) => c.id !== card.id);
  const d = $("colour-picker");
  d.innerHTML = `
    <div class="cp-head"><span class="cp-title" id="cp-title">${escapeHtml(card.name)}’s colour</span><span class="meta">changes as you pick</span></div>
    <div class="svpick" role="group" aria-label="Saturation and brightness" style="--hue:${Math.round(hsv.h)};--gem:${hex}">
      <button type="button" class="thumb" role="slider" aria-label="Saturation and brightness" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct(hsv.s)}"
        aria-valuetext="saturation ${pct(hsv.s)}%, brightness ${pct(hsv.v)}%" style="left:${hsv.s * 100}%;top:${(1 - hsv.v) * 100}%"></button>
    </div>
    <input class="hue" type="range" min="0" max="359" step="1" value="${Math.round(hsv.h)}" aria-label="Hue" aria-valuetext="${Math.round(hsv.h)} degrees, ${hueName(hsv.h)}" style="--thumb:hsl(${Math.round(hsv.h)} 100% 50%)" />
    <div class="cp-row">
      <label class="sr" for="hex-in">Hex colour for ${escapeHtml(card.name)}</label>
      <input id="hex-in" class="sunk inp hexin" value="${escapeHtml(pick.draft ?? hex)}" spellcheck="false" autocomplete="off" maxlength="7" />
      <div class="beside" aria-hidden="true"><span class="meta">beside your other cards</span>
        <span class="beads">${gem(shown, 30, { extraClass: "ringed" })}${others.length ? '<span class="bead-rule"></span>' : ""}${others
          .slice(0, 4)
          .map((c) => gem(c, 22))
          .join("")}</span></div>
    </div>
    <div class="cp-buttons"><button type="button" class="btn ghost press" data-cp-cancel>Cancel</button><button type="button" class="btn btn-primary press" data-cp-done>Done</button></div>`;
}

/** Re-draw only what changes while dragging, so focus and the pointer stay put. */
function update() {
  const hex = hsvToHex(pick.hsv);
  const d = $("colour-picker");
  const area = d.querySelector(".svpick");
  area.style.setProperty("--hue", String(Math.round(pick.hsv.h)));
  area.style.setProperty("--gem", hex);
  const thumb = area.querySelector(".thumb");
  thumb.style.left = `${pick.hsv.s * 100}%`;
  thumb.style.top = `${(1 - pick.hsv.v) * 100}%`;
  thumb.setAttribute("aria-valuenow", String(pct(pick.hsv.s)));
  thumb.setAttribute("aria-valuetext", `saturation ${pct(pick.hsv.s)}%, brightness ${pct(pick.hsv.v)}%`);
  const hue = d.querySelector(".hue");
  hue.value = String(Math.round(pick.hsv.h));
  hue.setAttribute("aria-valuetext", `${Math.round(pick.hsv.h)} degrees, ${hueName(pick.hsv.h)}`);
  hue.style.setProperty("--thumb", `hsl(${Math.round(pick.hsv.h)} 100% 50%)`);
  const hexIn = d.querySelector("#hex-in");
  if (document.activeElement !== hexIn) hexIn.value = hex;
  const ringed = d.querySelector(".ringed");
  ringed.className = "gem gem-custom ringed";
  ringed.style.setProperty("--gem", hex);
  if (!ringed.querySelector(".gem-i")) ringed.innerHTML = `<span class="gem-i">${escapeHtml(pick.card.name.trim()[0]?.toUpperCase() ?? "?")}</span>`;
}

function setHsv(next) {
  pick.hsv = next;
  pick.moved = true;
  pick.draft = null;
  update();
  pick.live(hsvToHex(next));
}

export function wirePicker() {
  const d = $("colour-picker");
  let dragging = false;
  const fromPoint = (e) => {
    const r = d.querySelector(".svpick").getBoundingClientRect();
    setHsv({ h: pick.hsv.h, s: clamp((e.clientX - r.left) / r.width), v: clamp(1 - (e.clientY - r.top) / r.height) });
  };
  d.addEventListener("pointerdown", (e) => {
    const area = e.target.closest(".svpick");
    if (!area || !pick) return;
    e.preventDefault();
    area.setPointerCapture(e.pointerId);
    dragging = true;
    fromPoint(e);
    area.querySelector(".thumb").focus();
  });
  d.addEventListener("pointermove", (e) => {
    if (dragging && pick) fromPoint(e);
  });
  d.addEventListener("pointerup", () => (dragging = false));
  d.addEventListener("keydown", (e) => {
    if (!pick || !e.target.closest(".thumb")) return;
    const st = e.shiftKey ? 0.1 : 0.02;
    const delta = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, st], ArrowDown: [0, -st] }[e.key];
    if (!delta) return;
    e.preventDefault();
    setHsv({ h: pick.hsv.h, s: clamp(pick.hsv.s + delta[0]), v: clamp(pick.hsv.v + delta[1]) });
  });
  d.addEventListener("input", (e) => {
    if (!pick) return;
    if (e.target.classList.contains("hue")) setHsv({ ...pick.hsv, h: Number(e.target.value) });
    if (e.target.id === "hex-in") {
      // Six digits with or without #; a half-typed value waits without changing the bead.
      const m = /^#?([0-9a-fA-F]{6})$/.exec(e.target.value.trim());
      if (m) setHsv(hexToHsv(`#${m[1].toUpperCase()}`));
      else pick.draft = e.target.value;
    }
  });
  d.addEventListener("click", (e) => {
    if (e.target.closest("[data-cp-cancel]")) closeOverlay(d, "cancel");
    else if (e.target.closest("[data-cp-done]")) closeOverlay(d, "done");
  });
}
