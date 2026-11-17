/**
 * Selenite plates in the app: the outlines from the handoff's layout files,
 * fitted to each plate's real size, painted by the worker, and laid over the
 * photo behind the elements that sit on them.
 *
 * A plate is a stack of layers (see "selenite plate machinery" in
 * anoesia.css): the refraction and smoke (.fx), a faint light (.light), the
 * painted crystal (.zone), the specular light (.spec), twinkles, and under
 * it all a shadow and rim glow (.under) that spills 40 px past the outline.
 *
 * Until its images are painted, a plate shows its outline as plain frosted
 * smoke, which is also what Safari and Firefox keep showing for the bend:
 * only Chromium can use an SVG filter as a backdrop filter.
 *
 * Images are painted once per plate size and kept: in memory, and in the
 * browser's Cache Storage where it's allowed, so a reload doesn't repaint.
 */

import { MARGIN } from "./paint.js";

/**
 * Outlines, in the size they were drawn at (plate pixels), copied from the
 * handoff's layout files (sources in the comments). `content` is where the
 * board puts its controls: the crystal calms down behind it. The phone
 * boards' header, composer and agent are `phead`, `pcompose` and `pagent`.
 * Seeds are fixed so a plate paints the same every time.
 */
export const PLATES = {
  // selenite_layout.py: the chat board
  side: {
    w: 256, h: 876, inset: 12, fibre: 88, seed: 311,
    poly: [[0, 40], [18, 0], [186, 0], [186, 8], [224, 8], [256, 84], [256, 188], [242, 188], [242, 556], [252, 596], [252, 764], [226, 876], [46, 870], [46, 860], [8, 860], [8, 612], [0, 604]],
    feathers: [[70, 640, 60], [180, 470, 34]],
    content: [[12, 20, 244, 846]],
    // conform on the board: newchat, row1, tray
  },
  agent: {
    w: 378, h: 876, inset: 12, fibre: 93, seed: 514,
    poly: [[0, 58], [24, 0], [300, 0], [300, 8], [350, 8], [378, 52], [378, 540], [360, 540], [360, 660], [374, 706], [374, 820], [334, 876], [70, 870], [0, 806], [0, 530], [10, 530], [10, 300], [0, 300]],
    feathers: [[150, 700, 70]],
    content: [[12, 20, 366, 862]],
    // conform on the board: a-ask, a-comp
  },
  head: {
    w: 728, h: 72, inset: 10, fibre: 3, seed: 543,
    poly: [[0, 14], [14, 0], [508, 0], [516, 6], [714, 6], [728, 20], [728, 58], [712, 72], [152, 72], [146, 66], [0, 66]],
    feathers: [],
    content: [[20, 16, 704, 60]],
  },
  compose: {
    w: 728, h: 120, inset: 10, fibre: -2, seed: 572,
    poly: [[0, 16], [20, 0], [436, 0], [436, 6], [704, 6], [728, 28], [728, 120], [40, 120], [0, 106]],
    feathers: [[480, 92, 26]],
    content: [[12, 18, 710, 110]],
    // conform on the board: c-nudges
  },
  pop: {
    w: 360, h: 280, inset: 10, fibre: 84, seed: 601,
    poly: [[0, 0], [284, 0], [284, 8], [328, 8], [360, 50], [360, 280], [28, 280], [0, 250]],
    feathers: [],
    content: [[10, 14, 350, 266]],
    // conform on the board: p-row1, p-new
  },
  // cards_selenite_layout.py: the cards page (chead is also the prompts and settings header)
  chead: {
    w: 1132, h: 72, inset: 10, fibre: 3, seed: 340,
    poly: [[0, 14], [14, 0], [640, 0], [646, 6], [1112, 6], [1132, 26], [1132, 58], [1116, 72], [330, 72], [324, 66], [0, 66]],
    feathers: [],
    content: [[22, 14, 1104, 60]],
  },
  lib: {
    w: 294, h: 784, inset: 12, fibre: 89, seed: 630,
    poly: [[0, 28], [24, 0], [232, 0], [232, 6], [268, 6], [294, 40], [294, 380], [286, 380], [286, 590], [294, 612], [294, 760], [270, 784], [36, 784], [0, 752]],
    feathers: [[150, 720, 46]],
    content: [[10, 12, 284, 736]],
    // conform on the board: l-find
  },
  edit: {
    w: 532, h: 784, inset: 12, fibre: 92, seed: 659,
    poly: [[0, 20], [20, 0], [330, 0], [336, 6], [508, 6], [532, 30], [532, 690], [522, 690], [522, 752], [494, 784], [44, 784], [0, 746]],
    feathers: [[300, 744, 40]],
    content: [[16, 22, 506, 740]],
  },
  rail: {
    w: 266, h: 784, inset: 12, fibre: 87, seed: 688,
    poly: [[0, 0], [226, 0], [266, 40], [266, 784], [30, 784], [0, 754], [0, 470], [8, 470], [8, 250], [0, 250]],
    feathers: [[150, 700, 40]],
    content: [[22, 16, 250, 740]],
  },
  dlg: {
    w: 440, h: 250, inset: 12, fibre: 4, seed: 717,
    poly: [[0, 0], [372, 0], [372, 8], [414, 8], [440, 36], [440, 250], [30, 250], [0, 222]],
    feathers: [],
    content: [[26, 24, 418, 226]],
  },
  cpick: {
    w: 352, h: 392, inset: 12, fibre: 86, seed: 746,
    poly: [[0, 0], [290, 0], [296, 6], [324, 6], [352, 34], [352, 392], [28, 392], [0, 364]],
    feathers: [],
    content: [[26, 24, 322, 366]],
  },
  // prompts_selenite_layout.py: the prompts page, and the phone move menu
  pblocks: {
    w: 660, h: 784, inset: 12, fibre: 90, seed: 775,
    poly: [[0, 24], [24, 0], [420, 0], [426, 6], [630, 6], [660, 36], [660, 520], [650, 520], [650, 700], [660, 716], [660, 756], [632, 784], [40, 784], [0, 744]],
    feathers: [[330, 744, 44]],
    content: [[20, 22, 624, 728]],
  },
  pprev: {
    w: 452, h: 784, inset: 12, fibre: 88, seed: 804,
    poly: [[0, 30], [30, 0], [300, 0], [306, 6], [420, 6], [452, 38], [452, 760], [428, 784], [0, 784], [0, 560], [10, 560], [10, 330], [0, 330]],
    feathers: [[220, 740, 40]],
    content: [[24, 20, 438, 742]],
  },
  pmenu: {
    w: 300, h: 336, inset: 10, fibre: 86, seed: 833,
    poly: [[0, 0], [250, 0], [256, 6], [272, 6], [300, 34], [300, 336], [26, 336], [0, 314]],
    feathers: [],
    content: [[10, 16, 290, 312]],
  },
  // settings_selenite_layout.py
  setnav: {
    w: 272, h: 784, inset: 12, fibre: 89, seed: 369,
    poly: [[0, 28], [24, 0], [214, 0], [214, 6], [246, 6], [272, 40], [272, 380], [264, 380], [264, 590], [272, 612], [272, 760], [248, 784], [36, 784], [0, 752]],
    feathers: [[140, 720, 46]],
    content: [[20, 32, 250, 734]],
  },
  setmain: {
    w: 840, h: 784, inset: 12, fibre: 92, seed: 398,
    poly: [[0, 20], [20, 0], [520, 0], [526, 6], [812, 6], [840, 34], [840, 690], [830, 690], [830, 752], [798, 784], [44, 784], [0, 746]],
    feathers: [[420, 744, 40]],
    content: [[26, 24, 812, 730]],
  },
  smodel: {
    w: 808, h: 372, inset: 12, fibre: 86, seed: 427,
    poly: [[0, 0], [732, 0], [738, 6], [788, 6], [808, 26], [808, 372], [28, 372], [0, 344]],
    feathers: [],
    content: [[24, 24, 784, 344]],
  },
  // phone_layout.py: the phone boards
  phead: {
    w: 374, h: 64, inset: 10, fibre: 2, seed: 862,
    poly: [[0, 12], [12, 0], [140, 0], [143, 3], [268, 3], [271, 0], [366, 0], [374, 8], [374, 50], [360, 64], [205, 64], [202, 61], [70, 61], [67, 64], [0, 64]],
    feathers: [],
    content: [[10, 10, 364, 54]],
  },
  pcompose: {
    w: 374, h: 114, inset: 10, fibre: -3, seed: 891,
    poly: [[0, 14], [16, 0], [220, 0], [220, 6], [358, 6], [374, 22], [374, 100], [360, 114], [50, 114], [0, 82]],
    feathers: [],
    content: [[10, 18, 352, 94]],
    // conform on the board: c-nudges
  },
  drawer: {
    w: 306, h: 760, inset: 12, fibre: 87, seed: 920,
    poly: [[0, 30], [20, 0], [262, 0], [306, 92], [306, 196], [292, 196], [292, 470], [302, 500], [302, 676], [280, 760], [14, 760], [0, 740]],
    feathers: [[120, 560, 54]],
    content: [[12, 20, 294, 748]],
    // conform on the board: d-new, d-row1, d-tray
  },
  sheet: {
    w: 414, h: 412, inset: 12, fibre: 4, seed: 485,
    poly: [[0, 40], [40, 18], [150, 18], [160, 6], [250, 6], [256, 0], [330, 0], [370, 22], [414, 22], [414, 412], [0, 412]],
    feathers: [],
    content: [[24, 26, 390, 334]],
  },
  pagent: {
    w: 378, h: 454, inset: 12, fibre: 88, seed: 949,
    poly: [[0, 26], [26, 0], [200, 0], [206, 6], [346, 6], [378, 30], [378, 318], [362, 318], [362, 414], [326, 454], [34, 454], [0, 420]],
    feathers: [],
    content: [[12, 18, 366, 432]],
    // conform on the board: a-ask, a-comp
  },
  agentfull: {
    w: 378, h: 760, inset: 12, fibre: 91, seed: 456,
    poly: [[0, 26], [26, 0], [220, 0], [226, 6], [346, 6], [378, 30], [378, 552], [362, 552], [362, 712], [326, 760], [34, 760], [0, 726]],
    feathers: [[180, 640, 40]],
    content: [[14, 22, 366, 742]],
    // conform on the board: f-ask, f-comp
  },
  menu: {
    w: 228, h: 236, inset: 10, fibre: 86, seed: 978,
    poly: [[0, 0], [190, 0], [228, 30], [228, 236], [36, 236], [0, 200]],
    feathers: [],
    content: [[10, 12, 218, 218]],
    // conform on the board: m-copy, m-del
  },
  lift: {
    w: 370, h: 238, inset: 12, fibre: 3, seed: 1007,
    poly: [[0, 18], [18, 0], [300, 0], [306, 6], [370, 6], [370, 214], [346, 238], [0, 238]],
    feathers: [],
    content: [[16, 20, 352, 214]],
  },

};

/**
 * Fit an outline to a new size. Features near an edge keep their distance
 * from that edge (corner cuts and notches stay the size they were drawn);
 * whatever lies between the edge bands stretches.
 */
function fitAxis(v, from, to) {
  const band = Math.max(0, Math.min(120, from / 2 - 1, to / 2 - 1));
  if (v <= band) return v;
  if (v >= from - band) return to - (from - v);
  return band + ((v - band) * (to - 2 * band)) / Math.max(1, from - 2 * band);
}

export function fitPlate(name, w, h) {
  const p = PLATES[name];
  const fx = (x) => Math.round(fitAxis(x, p.w, w) * 10) / 10;
  const fy = (y) => Math.round(fitAxis(y, p.h, h) * 10) / 10;
  return {
    w, h, inset: p.inset, fibre: p.fibre, seed: p.seed,
    poly: p.poly.map(([x, y]) => [fx(x), fy(y)]),
    feathers: p.feathers.map(([x, y, s]) => [fx(x), fy(y), s]),
    content: p.content.map(([x0, y0, x1, y1]) => [fx(x0), fy(y0), fx(x1), fy(y1)]),
  };
}

// ------------------------------------------------------------------ tuning

/** The crystal's tuning, as shipped (handoff: "ship their defaults; they aren't meant as user settings"). */
export const TUNING = { bend: 1.3, frost: 1, shine: 1, rimGlow: 0.85 };

/** Base smoke: 0.28 on a wide screen, 0.3 on a phone. */
export const baseSmoke = () => (matchMedia("(max-width: 899px)").matches ? 0.3 : 0.28);

/** Whether this browser can bend the backdrop through an SVG filter (Chromium only). */
export const canBend = (() => {
  const brands = navigator.userAgentData?.brands ?? [];
  return brands.some((b) => /Chromium/i.test(b.brand));
})();

// ----------------------------------------------------------------- painting

const workers = [];
const queue = [];
let nextId = 1;
const waiting = new Map();
const memo = new Map(); // key -> Promise<painted>

function pool() {
  if (workers.length) return workers;
  const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  for (let i = 0; i < n; i++) {
    const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    w.busy = false;
    w.onmessage = ({ data }) => {
      w.busy = false;
      const done = waiting.get(data.id);
      waiting.delete(data.id);
      if (data.error) done?.reject(new Error(data.error));
      else done?.resolve(data);
      pump();
    };
    w.onerror = (e) => {
      w.busy = false;
      for (const [id, d] of waiting) if (d.worker === w) {
        waiting.delete(id);
        d.reject(new Error(e.message || "The selenite painter failed."));
      }
      pump();
    };
    workers.push(w);
  }
  return workers;
}

function pump() {
  for (const w of pool()) {
    if (w.busy || !queue.length) continue;
    const job = queue.shift();
    w.busy = true;
    waiting.get(job.id).worker = w;
    w.postMessage(job);
  }
}

function paintInWorker(cfg, ss) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    queue.push({ id, cfg, ss });
    pump();
  });
}

const CACHE = "selenite-v2";
const KINDS = ["zone", "mask", "clear", "edge", "spec", "disp", "under"];
const cacheUrl = (key, kind) => new URL(`selenite-cache/${key}/${kind}`, location.href).href;

let oldCachesGone = false;
async function fromCache(key) {
  try {
    if (!("caches" in self)) return null;
    if (!oldCachesGone) {
      oldCachesGone = true;
      caches.delete("selenite-v1"); // painted before plates had a clear zone
    }
    const c = await caches.open(CACHE);
    const meta = await c.match(cacheUrl(key, "meta"));
    if (!meta) return null;
    const out = { ...(await meta.json()), png: {} };
    for (const k of KINDS) {
      const r = await c.match(cacheUrl(key, k));
      if (!r) return null;
      out.png[k] = await r.blob();
    }
    return out;
  } catch {
    return null;
  }
}

async function toCache(key, painted) {
  try {
    if (!("caches" in self)) return;
    const c = await caches.open(CACHE);
    await c.put(cacheUrl(key, "meta"), new Response(JSON.stringify({ maxd: painted.maxd, twinkles: painted.twinkles }), { headers: { "Content-Type": "application/json" } }));
    for (const k of KINDS) await c.put(cacheUrl(key, k), new Response(painted.png[k], { headers: { "Content-Type": "image/png" } }));
  } catch {
    // no room, or not allowed here: it just paints again next time
  }
}

const dataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/** Painted images for a plate at a size: object URLs, the displacement map as a data URL (for feImage). */
function painted(name, w, h) {
  // 1 or 2 pixels per plate pixel, from the screen, kept under ~1.3 megapixels a plate
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const ss = Math.round(Math.min(dpr, Math.sqrt(1.3e6 / (w * h))) * 4) / 4 || 1;
  const key = `${name}-${w}x${h}@${ss}`;
  if (!memo.has(key)) {
    memo.set(
      key,
      (async () => {
        let p = await fromCache(key);
        if (!p) {
          p = await paintInWorker(fitPlate(name, w, h), ss);
          toCache(key, p);
        }
        const urls = {};
        for (const k of KINDS) urls[k] = URL.createObjectURL(p.png[k]);
        urls.dispData = await dataUrl(p.png.disp);
        return { urls, maxd: p.maxd, twinkles: p.twinkles };
      })().catch((error) => {
        memo.delete(key);
        throw error;
      }),
    );
  }
  return memo.get(key);
}

// ------------------------------------------------------------------- plates

/** Signed distance from a point to a polygon, positive inside. */
export function signedDistance(poly, px, py) {
  let best = Infinity;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j];
    const [cx, cy] = poly[i];
    if (ay > py !== cy > py && px < ((cx - ax) * (py - ay)) / (cy - ay) + ax) inside = !inside;
    const dx = cx - ax;
    const dy = cy - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1e-9)));
    best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
  }
  return (inside ? 1 : -1) * best;
}

/**
 * Whether a box (plate pixels, [x0, y0, x1, y1]) lies wholly in a fitted
 * plate's clear zone: every point of its edge at least `inset` inside the
 * outline. Checked every 4 px along the edge, with half a pixel of slack.
 */
export function clearOf(cfg, [x0, y0, x1, y1]) {
  const steps = (a, b) => {
    const n = Math.max(2, Math.ceil((b - a) / 4) + 1);
    return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
  };
  const xs = steps(x0, x1);
  const ys = steps(y0, y1);
  const pts = [...xs.flatMap((x) => [[x, y0], [x, y1]]), ...ys.flatMap((y) => [[x0, y], [x1, y]])];
  return pts.every(([x, y]) => signedDistance(cfg.poly, x, y) >= cfg.inset - 0.5);
}

let filterSvg = null;
function filterFor(id, w, h, href, scale) {
  if (!filterSvg) {
    filterSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    filterSvg.setAttribute("width", "0");
    filterSvg.setAttribute("height", "0");
    filterSvg.setAttribute("aria-hidden", "true");
    filterSvg.style.position = "absolute";
    document.body.append(filterSvg);
  }
  let f = filterSvg.querySelector(`#${id}`);
  if (!f) {
    f = document.createElementNS("http://www.w3.org/2000/svg", "filter");
    f.id = id;
    for (const [k, v] of Object.entries({ x: "0%", y: "0%", width: "100%", height: "100%", "color-interpolation-filters": "sRGB" })) f.setAttribute(k, v);
    f.innerHTML = `<feImage x="0" y="0" preserveAspectRatio="none" result="map"></feImage><feDisplacementMap in="SourceGraphic" in2="map" xChannelSelector="R" yChannelSelector="G"></feDisplacementMap>`;
    filterSvg.append(f);
  }
  const img = f.querySelector("feImage");
  img.setAttribute("width", String(w));
  img.setAttribute("height", String(h));
  img.setAttribute("href", href);
  f.querySelector("feDisplacementMap").setAttribute("scale", String(scale));
}

const layer = () => {
  let el = document.getElementById("plates");
  if (!el) {
    el = document.createElement("div");
    el.id = "plates";
    el.setAttribute("aria-hidden", "true");
    document.querySelector(".app")?.before(el);
  }
  return el;
};

let plateCount = 0;

/** What a plate's backdrop is without the bend: the same smoke over a plain blur. */
const FALLBACK = "blur(12px) saturate(1.1) brightness(1.05)";

/**
 * Put a plate behind `host`.
 *   name    an outline from PLATES
 *   smoke   the smoke's opacity (base smoke plus the plate's extra)
 *   grow    how far the plate reaches past the host's box, {l, t, r, b} in px
 *   inside  put the plate inside the host (for dialogs, which sit in the top
 *           layer) instead of in the page's plate layer under everything
 *   blur    the backdrop blur under the bend (0.3 px; the model list uses 9)
 *   cut     a selector for the controls on this plate that the crystal may cut
 *           (the boards' "conform" elements): any of them that crosses the
 *           plate's clear zone is masked to it, with a faint ring along the cut
 * Returns { update(), remove() }.
 */
export function addPlate(host, name, { smoke = baseSmoke(), grow = {}, inside = false, blur = 0.3, cut = "" } = {}) {
  const g = { l: 0, t: 0, r: 0, b: 0, ...grow };
  const id = `f-sel-${++plateCount}`;
  const el = document.createElement("div");
  el.className = "plate pending";
  el.dataset.plate = name;
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = `<img class="under" alt="" /><div class="gl"><span class="fx"></span><span class="light"></span><span class="zone"></span><span class="spec"></span></div>`;
  const gl = el.querySelector(".gl");
  const fx = el.querySelector(".fx");
  const under = el.querySelector(".under");
  fx.style.background = `rgba(10,8,18,${Math.min(0.92, smoke)})`;
  if (inside) host.prepend(el);
  else layer().append(el);

  let size = "";
  let removed = false;
  let timer = 0;

  function place() {
    if (removed) return;
    const r = host.getBoundingClientRect();
    const w = Math.round(r.width + g.l + g.r);
    const h = Math.round(r.height + g.t + g.b);
    if (!r.width || !r.height || !host.isConnected || host.closest("[hidden]")) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    if (inside) Object.assign(el.style, { left: `${-g.l}px`, top: `${-g.t}px`, width: `${w}px`, height: `${h}px` });
    else Object.assign(el.style, { left: `${Math.round(r.left - g.l)}px`, top: `${Math.round(r.top - g.t)}px`, width: `${w}px`, height: `${h}px` });
    const s = `${w}x${h}`;
    if (s === size) return;
    const first = !size;
    size = s;
    // the outline at once, as plain frost; the crystal once it's painted
    const cfg = fitPlate(name, w, h);
    gl.style.clipPath = `polygon(${cfg.poly.map(([x, y]) => `${x}px ${y}px`).join(",")})`;
    clearTimeout(timer);
    timer = setTimeout(() => paint(w, h, s), first ? 0 : 250);
  }

  async function paint(w, h, s) {
    let p;
    try {
      p = await painted(name, w, h);
    } catch {
      return; // stays as plain frost
    }
    if (removed || s !== size) return;
    const mask = `url("${p.urls.mask}") 0 0/100% 100% no-repeat`;
    for (const layerEl of [fx, el.querySelector(".light")]) {
      layerEl.style.webkitMask = mask;
      layerEl.style.mask = mask;
    }
    gl.style.clipPath = "";
    el.querySelector(".zone").style.backgroundImage = `url("${p.urls.zone}")`;
    el.querySelector(".zone").style.opacity = String(TUNING.frost);
    el.querySelector(".spec").style.backgroundImage = `url("${p.urls.spec}")`;
    el.querySelector(".spec").style.opacity = String(TUNING.shine);
    under.src = p.urls.under;
    Object.assign(under.style, { left: `${-MARGIN}px`, top: `${-MARGIN}px`, width: `${w + 2 * MARGIN}px`, height: `${h + 2 * MARGIN}px`, opacity: String(TUNING.rimGlow) });
    const tail = `blur(${blur}px) saturate(1.1) brightness(1.05)`;
    if (canBend) {
      filterFor(id, w, h, p.urls.dispData, Math.round(p.maxd * TUNING.bend * 10) / 10);
      fx.style.backdropFilter = `url(#${id}) ${tail}`;
    }
    else fx.style.backdropFilter = FALLBACK; // Safari and Firefox: frosted smoke, no bend
    fx.style.webkitBackdropFilter = FALLBACK;
    for (const t of el.querySelectorAll(".tw")) t.remove();
    p.twinkles.forEach(([x, y], i) => {
      const t = document.createElement("span");
      t.className = "tw";
      Object.assign(t.style, { left: `${x}px`, top: `${y}px`, animationDelay: `${-(1.3 + i * 1.1).toFixed(2)}s` });
      gl.append(t);
    });
    el.classList.remove("pending");
    current = { w, h, urls: p.urls };
    cutControls();
  }

  // ---- controls the crystal cuts
  let current = null; // the painted size and images
  let cutFrame = 0;
  function cutControls() {
    cutFrame = 0;
    if (!cut || removed) return;
    const r = host.getBoundingClientRect();
    const ox = r.left - g.l;
    const oy = r.top - g.t;
    const cfg = current && fitPlate(name, current.w, current.h);
    for (const c of host.querySelectorAll(cut)) {
      const b = c.getBoundingClientRect();
      const rect = [b.left - ox, b.top - oy, b.right - ox, b.bottom - oy];
      if (!cfg || !b.width || clearOf(cfg, rect)) {
        if (c.classList.contains("cut")) {
          c.classList.remove("cut");
          for (const v of ["--cut-clear", "--cut-edge", "--cut-pos", "--cut-size"]) c.style.removeProperty(v);
        }
        continue;
      }
      c.classList.add("cut");
      c.style.setProperty("--cut-clear", `url("${current.urls.clear}")`);
      c.style.setProperty("--cut-edge", `url("${current.urls.edge}")`);
      c.style.setProperty("--cut-pos", `${-rect[0]}px ${-rect[1]}px`);
      c.style.setProperty("--cut-size", `${current.w}px ${current.h}px`);
    }
  }
  const recut = () => {
    if (cut && !cutFrame) cutFrame = requestAnimationFrame(cutControls);
  };
  const mo = cut ? new MutationObserver(recut) : null;
  mo?.observe(host, { childList: true, subtree: true });
  if (cut) host.addEventListener("scroll", recut, { capture: true, passive: true });

  const ro = new ResizeObserver(() => {
    place();
    recut();
  });
  ro.observe(host);
  addEventListener("resize", place);
  place();

  return {
    el,
    update: place,
    remove() {
      removed = true;
      clearTimeout(timer);
      ro.disconnect();
      mo?.disconnect();
      cancelAnimationFrame(cutFrame);
      host.removeEventListener("scroll", recut, { capture: true });
      for (const c of host.querySelectorAll(".cut")) c.classList.remove("cut");
      removeEventListener("resize", place);
      el.remove();
      filterSvg?.querySelector(`#${id}`)?.remove();
    },
  };
}
