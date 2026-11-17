/**
 * The material and the photo behind the app.
 *
 * Two materials: lacquer (panes over the photo, plain CSS) and selenite
 * (crystal plates, painted at runtime by js/selenite/). For now selenite
 * covers Settings only: everywhere else stays lacquer until those pages get
 * their selenite pass. The root element carries `.theme-lacquer` or
 * `.theme-selenite`, plus `.sel` while selenite plates are up. This file
 * also sets the variables the background settings decide: the lacquer
 * colour retinted towards the photo (`--lac`), the glass panes' colour and
 * blur, how dark the photo is (`--dim`) and the reading column (`--window`).
 *
 * The photos are your own, uploaded in settings (`state.photos`): each has a
 * dark tint worked out from its colours when it's added.
 */

import { state } from "./core.js";
import { addPlate, baseSmoke } from "./selenite/plates.js";

export const FINISHES = {
  roiro: { label: "roiro", hint: "opaque", opacity: 1, blur: 0 },
  tamenuri: { label: "tamenuri", hint: "light glows through", opacity: 0.72, blur: 22 },
  shunkei: { label: "shunkei", hint: "clear coat, most photo", opacity: 0.5, blur: 14 },
};

/** The pages that have their selenite design so far. */
const SELENITE_PAGES = ["settings"];

const phone = () => matchMedia("(max-width: 899px)").matches;

/** The readable dim: 0.3, or 0.35 for selenite on a wide screen. */
export const readableDim = (material = state.settings?.background?.material) => (material === "selenite" && !phone() ? 0.35 : 0.3);

/** Whether the reading column applies: lacquer always; selenite only on a phone (its desktop story sits on a fixed dark backdrop). */
export const hasWindow = (material = state.settings?.background?.material) => material !== "selenite" || phone();

/** "Back to readable": what dim and window go back to (window null: the device's default). */
export const readable = () => ({ dim: readableDim(), window: null });

/** The readable reading column: 0.72 on a wide screen, 0.7 on a phone. */
export const windowDefault = () => (phone() ? 0.7 : 0.72);

/** Whether dim or the reading column is past (below) its readable default. */
export function belowReadable(bg) {
  if (bg.dim < readableDim(bg.material) - 1e-9) return true;
  return hasWindow(bg.material) && (bg.window ?? windowDefault()) < windowDefault() - 1e-9;
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgba = (c, a) => `rgba(${c.join(",")},${a})`;

let photoFailed = "";

/** Apply background settings to the page. */
export function applyBackground(bg) {
  const root = document.documentElement;
  const photo = bg.photo !== "none" && bg.photo !== photoFailed ? ((state.photos ?? []).find((p) => p.id === bg.photo) ?? null) : null;
  const base = hex("#15131C");
  const lac = mix(base, photo ? hex(photo.tint) : base, photo ? bg.tint : 0);
  const pane = mix([5, 5, 8], lac, 0.55);
  const finish = FINISHES[bg.finish] ?? FINISHES.tamenuri;
  root.style.setProperty("--lac", rgba(lac, 1));
  root.style.setProperty("--pane", rgba(pane, finish.opacity));
  // The pane colour alone, for the finish swatches in Settings → Look.
  root.style.setProperty("--pane-rgb", pane.join(" "));
  root.style.setProperty("--pane-filter", finish.blur ? `blur(${finish.blur}px) saturate(1.3)` : "none");
  root.style.setProperty("--dim", String(bg.dim));
  if (bg.window === null) root.style.removeProperty("--window-set");
  else root.style.setProperty("--window-set", String(bg.window));
  root.classList.toggle("has-photo", Boolean(photo));
  root.style.setProperty("--dim-floor", String(readableDim(bg.material)));
  applyMaterial();
  const img = document.getElementById("bg-img");
  if (!photo) {
    img.removeAttribute("src");
    return;
  }
  root.style.setProperty("--photo-pos", photo.position);
  if (img.getAttribute("src") !== photo.url) {
    // A photo whose file can't be loaded: fall back to the plain ground.
    img.onerror = () => {
      photoFailed = bg.photo;
      applyBackground(bg);
    };
    img.src = photo.url;
  }
}

// ---------------------------------------------------------------- selenite

let plates = [];
let plateKey = "";

/** The plates each selenite page stands on: [host selector, outline, options]. */
function platesFor(view) {
  if (view !== "settings") return [];
  const smoke = baseSmoke();
  if (phone()) return [["#view-settings", "agentfull", { smoke: smoke + 0.2 }]];
  return [
    ["#side", "side", { smoke }],
    ["#view-settings .page-head", "chead", { smoke }],
    ["#settings-nav", "setnav", { smoke: smoke + 0.16, grow: { l: 20, t: 32, r: 22, b: 50 } }],
    ["#settings-main", "setmain", { smoke: smoke + 0.16, grow: { l: 26, t: 24, r: 28, b: 54 } }],
  ];
}

/** The neon tubes: selenite's scene when there's no photo (from the selenite boards). */
const TUBES = [
  ["M-20 548 L 30 596 L 80 548 L 130 596 L 180 548 L 230 596 L 280 548", "#A86CFF", "#EEE2FF"],
  ["M138 788 a94 94 0 1 0 188 0 a94 94 0 1 0 -188 0", "#A86CFF", "#EEE2FF"],
  ["M262 96 C 420 86, 520 -4, 760 4 C 930 10, 990 70, 1070 52", "#4DB8FF", "#E0F4FF"],
  ["M240 892 C 460 818, 700 912, 1080 846", "#4DB8FF", "#E0F4FF"],
  ["M1030 150 C 1120 96, 1230 260, 1470 176", "#FF4FD8", "#FFE2F7"],
  ["M1036 470 L 1086 520", "#FF4FD8", "#FFE2F7"],
  ["M1332 838 a72 72 0 1 0 144 0 a72 72 0 1 0 -144 0", "#FF4FD8", "#FFE2F7"],
];

/** The tubes as an SVG: `id` names its bloom filter (unique per copy); thumbnails pass a smaller blur. */
export function tubesSvg(id, { cls = "tubes", bloom = 1 } = {}) {
  const paths = TUBES.map(([d, c, core]) => `<path d="${d}" stroke="${c}" stroke-width="5"/><path d="${d}" stroke="${core}" stroke-width="1.5"/>`).join("");
  return `<svg class="${cls}" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false"><defs><filter id="${id}" x="-20%" y="-20%" width="140%" height="140%">
    <feGaussianBlur in="SourceGraphic" stdDeviation="${22 * bloom}" result="haze"/><feGaussianBlur in="SourceGraphic" stdDeviation="${9 * bloom}" result="wide"/><feGaussianBlur in="SourceGraphic" stdDeviation="${2.6 * bloom}" result="near"/>
    <feMerge><feMergeNode in="haze"/><feMergeNode in="wide"/><feMergeNode in="wide"/><feMergeNode in="near"/><feMergeNode in="near"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    <g filter="url(#${id})" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity=".85">${paths}</g></svg>`;
}

/** Whether selenite is showing now (your material, on a page that has its selenite design). */
export const seleniteOn = () => state.settings?.background?.material === "selenite" && SELENITE_PAGES.includes(document.documentElement.dataset.view);

/** Switch the root between lacquer and selenite for the page that's showing, and put up its plates. */
export function applyMaterial() {
  const root = document.documentElement;
  const on = seleniteOn();
  root.classList.toggle("theme-selenite", on);
  root.classList.toggle("theme-lacquer", !on);
  root.classList.toggle("sel", on);
  const bgEl = document.querySelector(".bg");
  if (on && bgEl && !bgEl.querySelector(".tubes")) bgEl.insertAdjacentHTML("beforeend", tubesSvg("bloom-bg"));
  const key = on ? `${root.dataset.view}:${phone() ? "phone" : "wide"}` : "";
  if (key === plateKey) {
    for (const p of plates) p.update();
    return;
  }
  plateKey = key;
  for (const p of plates) p.remove();
  plates = [];
  if (!on) return;
  for (const [sel, name, opts] of platesFor(root.dataset.view)) {
    const host = document.querySelector(sel);
    if (host) plates.push(addPlate(host, name, opts));
  }
}

matchMedia("(max-width: 899px)").addEventListener("change", () => {
  if (!state.settings) return;
  document.documentElement.style.setProperty("--dim-floor", String(readableDim()));
  applyMaterial();
});

/** A dialog's own plate while it's open in selenite (the model list): removed when it closes. */
export function dialogPlate(dialog, wide, narrow) {
  if (!seleniteOn()) return;
  const [name, { extra = 0, ...opts }] = phone() ? narrow : wide;
  const p = addPlate(dialog, name, { ...opts, smoke: baseSmoke() + extra, inside: true });
  dialog.addEventListener("close", () => p.remove(), { once: true });
}

/** The longest side an uploaded photo keeps: sharp on a big screen, small enough to load fast. */
const MAX_SIDE = 2560;

/**
 * Get a picked image file ready to upload: scaled down to MAX_SIDE as a
 * JPEG, with the dark tint the lacquer leans towards (the photo's average
 * hue at the darkness of the board's tints, like #111A26).
 */
export async function preparePhoto(file) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error("That file isn't an image this browser can open.");
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const small = document.createElement("canvas");
  small.width = small.height = 24;
  const sc = small.getContext("2d", { willReadFrequently: true });
  sc.drawImage(bitmap, 0, 0, 24, 24);
  const px = sc.getImageData(0, 0, 24, 24).data;
  const avg = [0, 0, 0];
  for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) avg[c] += px[i + c];
  const [r, g, b] = avg.map((v) => v / (px.length / 4) / 255);
  const mx = Math.max(r, g, b);
  const d = mx - Math.min(r, g, b);
  let h = 0;
  if (d) h = (mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
  if (h < 0) h += 360;
  const s = Math.min(0.6, Math.max(0.3, mx ? (d / mx) * 1.3 : 0));
  const v = 0.15;
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  const tint = `#${[f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
  bitmap.close?.();
  if (!blob) throw new Error("Couldn't read that image.");
  const name = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim().slice(0, 40) || "my photo";
  return { blob, tint, name };
}
