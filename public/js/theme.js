/**
 * The material and the photo behind the app.
 *
 * Lacquer is the only material for now (selenite comes once its plate
 * generator is ported). The root element carries `.theme-lacquer`; this
 * file sets the variables the background settings decide: the lacquer
 * colour retinted towards the photo (`--lac`), the glass panes' colour and
 * blur, how dark the photo is (`--dim`) and the reading column (`--window`).
 *
 * The photos are your own, uploaded in settings (`state.photos`): each has a
 * dark tint worked out from its colours when it's added.
 */

import { state } from "./core.js";

export const FINISHES = {
  roiro: { label: "roiro", hint: "opaque", opacity: 1, blur: 0 },
  tamenuri: { label: "tamenuri", hint: "light glows through", opacity: 0.72, blur: 22 },
  shunkei: { label: "shunkei", hint: "clear coat, most photo", opacity: 0.5, blur: 14 },
};

/** "Back to readable": what dim and window go back to (window null: the device's default). */
export const READABLE = { dim: 0.3, window: null };

/** The readable reading column: 0.72 on a wide screen, 0.7 on a phone. */
export const windowDefault = () => (matchMedia("(max-width: 899px)").matches ? 0.7 : 0.72);

/** Whether dim or the reading column is past (below) its readable default. */
export function belowReadable(bg) {
  return bg.dim < READABLE.dim - 1e-9 || (bg.window ?? windowDefault()) < windowDefault() - 1e-9;
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
