/**
 * The material and the photo behind the app.
 *
 * Lacquer is the only material for now (selenite comes once its plate
 * generator is ported). The root element carries `.theme-lacquer`; this
 * file sets the variables the background settings decide: the lacquer
 * colour retinted towards the photo (`--lac`), the glass panes' colour and
 * blur, how dark the photo is (`--dim`) and the reading column (`--window`).
 */

/** The six photos: file, how it's framed, and the hue lacquer leans towards. */
export const PHOTOS = {
  crossing: { file: "photos/crossing.jpg", position: "50% 38%", tint: "#111A26" },
  "purple alley": { file: "photos/purple-alley.jpg", position: "50% 50%", tint: "#261126" },
  "kimbap corner": { file: "photos/kimbap-corner.jpg", position: "50% 45%", tint: "#261216" },
  "pink street": { file: "photos/pink-street.jpg", position: "40% 50%", tint: "#111626" },
  downpour: { file: "photos/downpour.jpg", position: "50% 50%", tint: "#121E26" },
  lanterns: { file: "photos/lanterns.jpg", position: "50% 50%", tint: "#111B26" },
};

export const FINISHES = {
  roiro: { label: "roiro", hint: "opaque", opacity: 1, blur: 0 },
  tamenuri: { label: "tamenuri", hint: "light glows through", opacity: 0.72, blur: 22 },
  shunkei: { label: "shunkei", hint: "clear coat, most photo", opacity: 0.5, blur: 14 },
};

/** "Back to readable": what dim and window go back to. */
export const READABLE = { dim: 0.3, window: null };

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgba = (c, a) => `rgba(${c.join(",")},${a})`;

let photoFailed = "";

/** Apply background settings to the page. */
export function applyBackground(bg) {
  const root = document.documentElement;
  const photo = bg.photo !== "none" && bg.photo !== photoFailed ? PHOTOS[bg.photo] : null;
  const base = hex("#15131C");
  const lac = mix(base, photo ? hex(photo.tint) : base, photo ? bg.tint : 0);
  const pane = mix([5, 5, 8], lac, 0.55);
  const finish = FINISHES[bg.finish] ?? FINISHES.tamenuri;
  root.style.setProperty("--lac", rgba(lac, 1));
  root.style.setProperty("--pane", rgba(pane, finish.opacity));
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
  if (img.getAttribute("src") !== photo.file) {
    // A photo that isn't on the server yet (they're copied by hand): fall back to the plain ground.
    img.onerror = () => {
      photoFailed = bg.photo;
      applyBackground(bg);
    };
    img.src = photo.file;
  }
}
