/**
 * The selenite map painter: a port of the handoff's make_selenite.py.
 *
 * Given a plate's outline (a polygon in plate pixels), its inset, fibre
 * direction and feather fractures, it paints the five images a crystal plate
 * is made of, at the plate's real size:
 *
 *   disp   displacement map for the SVG filter that bends the photo behind
 *   mask   the outline, with a slightly rough, anti-aliased edge
 *   zone   the painted crystal: haze, terraces, silky streaks, feathers,
 *          specks, a faint thin-film rainbow and the frosty rim
 *   spec   light: the rim catching it, glints on the bevel, terrace highlights
 *   under  soft shadow plus white light leaking from the rim (40 px margin)
 *
 * It's pure (no DOM), so it runs in a worker. The numpy original works on a
 * 2x supersampled raster and distance transforms; this one uses the
 * polygon's exact signed distance instead, which is anti-aliased on its own,
 * and paints at `ss` pixels per plate pixel (1 or 2, from the screen).
 */

export const MARGIN = 40;

const hexc = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function rngOf(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const uniform = (lo, hi) => lo + (hi - lo) * next();
  const normal = (mu, sd) => {
    const u = Math.max(1e-9, next());
    return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  return { random: next, uniform, normal, choice: (arr) => arr[Math.floor(next() * arr.length)] };
}

/** Smooth value noise in [-0.5, 0.5], with features about `cell` plate pixels wide. */
function noise(W, H, ss, cell, rng) {
  const out = new Float32Array(W * H);
  const c = cell * ss; // cell in raster pixels
  if (c < 1.6) {
    for (let i = 0; i < out.length; i++) out[i] = rng.random() - 0.5;
    if (c > 0.9) blur(out, W, H, 0.5);
    return out;
  }
  const gw = Math.max(2, Math.floor(W / c)) + 4;
  const gh = Math.max(2, Math.floor(H / c)) + 4;
  const g = new Float32Array(gw * gh);
  for (let i = 0; i < g.length; i++) g[i] = rng.random();
  // Catmull-Rom weights, per column and per row, then a separable pass.
  const sx = (gw - 4) / W;
  const sy = (gh - 4) / H;
  const tmp = new Float32Array(W * gh);
  const wts = (t) => {
    const t2 = t * t;
    const t3 = t2 * t;
    return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
  };
  for (let x = 0; x < W; x++) {
    const gx = 1 + (x + 0.5) * sx;
    const i0 = Math.floor(gx);
    const [a, b, cc, d] = wts(gx - i0);
    for (let r = 0; r < gh; r++) {
      const row = r * gw;
      tmp[r * W + x] = a * g[row + i0 - 1] + b * g[row + i0] + cc * g[row + i0 + 1] + d * g[row + Math.min(gw - 1, i0 + 2)];
    }
  }
  for (let y = 0; y < H; y++) {
    const gy = 1 + (y + 0.5) * sy;
    const j0 = Math.floor(gy);
    const [a, b, cc, d] = wts(gy - j0);
    const r0 = (j0 - 1) * W;
    const r1 = j0 * W;
    const r2 = (j0 + 1) * W;
    const r3 = Math.min(gh - 1, j0 + 2) * W;
    for (let x = 0; x < W; x++) out[y * W + x] = a * tmp[r0 + x] + b * tmp[r1 + x] + cc * tmp[r2 + x] + d * tmp[r3 + x] - 0.5;
  }
  return out;
}

/** One box blur pass of radius r along rows (step 1) or columns (step W), edges clamped. */
function boxPass(a, W, H, r, horizontal) {
  const len = horizontal ? W : H;
  const lines = horizontal ? H : W;
  const line = new Float32Array(len);
  const n = 2 * r + 1;
  for (let l = 0; l < lines; l++) {
    const at = (k) => (horizontal ? l * W + k : k * W + l);
    for (let k = 0; k < len; k++) line[k] = a[at(k)];
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += line[k < 0 ? 0 : k >= len ? len - 1 : k];
    for (let k = 0; k < len; k++) {
      a[at(k)] = acc / n;
      const add = k + r + 1;
      const drop = k - r;
      acc += line[add >= len ? len - 1 : add] - line[drop < 0 ? 0 : drop];
    }
  }
}

/** Gaussian blur in place (sigma in raster pixels), separable, edges clamped. Wide ones are three box blurs. */
function blur(a, W, H, sigma) {
  if (sigma <= 0) return a;
  if (sigma > 3) {
    // three boxes of width ~sqrt(4 sigma^2 + 1) approximate a gaussian
    const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
    for (let p = 0; p < 3; p++) {
      if (W > 1) boxPass(a, W, H, r, true);
      if (H > 1) boxPass(a, W, H, r, false);
    }
    return a;
  }
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) s += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const line = new Float32Array(Math.max(W, H));
  for (let y = 0; y < H; y++) {
    const o = y * W;
    for (let x = 0; x < W; x++) line[x] = a[o + x];
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i < 0 ? 0 : x + i >= W ? W - 1 : x + i;
        v += k[i + r] * line[xx];
      }
      a[o + x] = v;
    }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) line[y] = a[y * W + x];
    for (let y = 0; y < H; y++) {
      let v = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i < 0 ? 0 : y + i >= H ? H - 1 : y + i;
        v += k[i + r] * line[yy];
      }
      a[y * W + x] = v;
    }
  }
  return a;
}

/** erf, Abramowitz-Stegun 7.1.26. */
function erf(x) {
  const s = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

/** Signed distance to a polygon (positive inside) and the nearest boundary point, per raster pixel. */
function polygonField(poly, W, H, ss) {
  const n = poly.length;
  const sd = new Float32Array(W * H);
  const ex = new Float32Array(W * H);
  const ey = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const py = (y + 0.5) / ss;
    for (let x = 0; x < W; x++) {
      const px = (x + 0.5) / ss;
      let best = Infinity;
      let bx = 0;
      let by = 0;
      let inside = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const [ax, ay] = poly[j];
        const [cx, cy] = poly[i];
        if (ay > py !== cy > py && px < ((cx - ax) * (py - ay)) / (cy - ay) + ax) inside = !inside;
        const dx = cx - ax;
        const dy = cy - ay;
        const l2 = dx * dx + dy * dy || 1e-9;
        let t = ((px - ax) * dx + (py - ay) * dy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + t * dx;
        const qy = ay + t * dy;
        const d2 = (px - qx) ** 2 + (py - qy) ** 2;
        if (d2 < best) {
          best = d2;
          bx = qx;
          by = qy;
        }
      }
      const i = y * W + x;
      sd[i] = (inside ? 1 : -1) * Math.sqrt(best);
      ex[i] = bx;
      ey[i] = by;
    }
  }
  return { sd, ex, ey };
}

/** A stroke from (x0, y0) along `ang`, length L, gaussian width w, over a window; returns [field, t]. */
function segField(px, py, x0, y0, ang, L, w) {
  const sx = px - x0;
  const sy = py - y0;
  const u = sx * Math.cos(ang) + sy * Math.sin(ang);
  const v = -sx * Math.sin(ang) + sy * Math.cos(ang);
  if (u <= 0 || u >= L) return [0, clamp01(u / L)];
  const end = clamp01(Math.min(u, L - u) / 3);
  return [Math.exp(-((v / w) ** 2)) * end, clamp01(u / L)];
}

/** Signed distance to a rotated rectangle (positive inside). */
function rectSd(px, py, cx, cy, ang, hl, hd) {
  const sx = px - cx;
  const sy = py - cy;
  const u = Math.abs(sx * Math.cos(ang) + sy * Math.sin(ang)) - hl;
  const v = Math.abs(-sx * Math.sin(ang) + sy * Math.cos(ang)) - hd;
  const out = Math.hypot(Math.max(u, 0), Math.max(v, 0));
  return -(out + Math.min(Math.max(u, v), 0));
}

/** A point along the outline at arc length s, with the edge's direction. */
function alongOutline(poly, s) {
  const n = poly.length;
  let total = 0;
  const lens = [];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % n];
    lens.push(Math.hypot(bx - ax, by - ay));
    total += lens[i];
  }
  s = ((s % total) + total) % total;
  for (let i = 0; i < n; i++) {
    if (s <= lens[i] || i === n - 1) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % n];
      const t = lens[i] ? s / lens[i] : 0;
      return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, ang: Math.atan2(by - ay, bx - ax) };
    }
    s -= lens[i];
  }
  return { x: poly[0][0], y: poly[0][1], ang: 0 };
}

function perimeter(poly) {
  let p = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    p += Math.hypot(bx - ax, by - ay);
  }
  return p;
}

/**
 * Paint one plate.
 * cfg: { w, h, poly, inset, fibre, feathers, content?: [[x0,y0,x1,y1]], seed }
 * Returns RGBA arrays: { W, H, zone, mask, spec, disp, under: {W, H, data}, maxd, twinkles }.
 */
export function paintPlate(cfg, ss = 1) {
  const { w, h, poly } = cfg;
  const rng = rngOf(cfg.seed ?? 311);
  const W = Math.max(1, Math.round(w * ss));
  const H = Math.max(1, Math.round(h * ss));
  const N = W * H;
  const PX = new Float32Array(N);
  const PY = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    PX[y * W + x] = (x + 0.5) / ss;
    PY[y * W + x] = (y + 0.5) / ss;
  }
  const near = (x, y) => {
    const xi = Math.min(W - 1, Math.max(0, Math.floor(x * ss)));
    const yi = Math.min(H - 1, Math.max(0, Math.floor(y * ss)));
    return yi * W + xi;
  };

  // ---------- outline: signed distance + slight rough, fibrous rim ----------
  const { sd, ex, ey } = polygonField(poly, W, H, ss);
  const hf = noise(W, H, ss, 1.3, rng);
  const lf = noise(W, H, ss, 26, rng);
  const rough5 = noise(W, H, ss, 5, rng);
  const hfE = new Float32Array(N);
  const lfE = new Float32Array(N);
  const sdr = new Float32Array(N);
  const mask = new Float32Array(N);
  const mbin = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const k = near(ex[i], ey[i]);
    hfE[i] = hf[k];
    lfE[i] = lf[k];
    sdr[i] = sd[i] - 0.5 - (rough5[i] * 0.9 + hf[i] * 0.7);
    mask[i] = clamp01(sdr[i] * ss + 0.5);
    mbin[i] = sdr[i] > 0 ? 1 : 0;
  }

  // content damping: features calm down behind the UI
  const content = cfg.content ?? [[cfg.inset + 10, cfg.inset + 10, w - cfg.inset - 10, h - cfg.inset - 10]];
  const damp = new Float32Array(N).fill(1);
  {
    // a gaussian-blurred box is separable: erf across x times erf across y
    const s = 6 * Math.SQRT2;
    const cm = new Float32Array(N);
    const gxs = new Float32Array(W);
    const gys = new Float32Array(H);
    for (const [x0, y0, x1, y1] of content) {
      for (let x = 0; x < W; x++) gxs[x] = 0.5 * (erf(((x + 0.5) / ss - x0) / s) - erf(((x + 0.5) / ss - x1) / s));
      for (let y = 0; y < H; y++) gys[y] = 0.5 * (erf(((y + 0.5) / ss - y0) / s) - erf(((y + 0.5) / ss - y1) / s));
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const v = gxs[x] * gys[y];
        if (v > cm[i]) cm[i] = v;
      }
    }
    for (let i = 0; i < N; i++) damp[i] = 1 - 0.55 * cm[i];
  }

  const cr = new Float32Array(N);
  const cg = new Float32Array(N);
  const cb = new Float32Array(N);
  const alp = new Float32Array(N);
  {
    const [r, g, b] = hexc("#eef1fa");
    const n140 = noise(W, H, ss, 140, rng);
    for (let i = 0; i < N; i++) {
      cr[i] = r;
      cg[i] = g;
      cb[i] = b;
      alp[i] = 0.035 + 0.02 * (n140[i] + 0.5);
    }
  }
  const over = (i, c, a) => {
    if (!(a > 0)) return;
    a = a > 1 ? 1 : a;
    cr[i] = cr[i] * (1 - a) + c[0] * a;
    cg[i] = cg[i] * (1 - a) + c[1] * a;
    cb[i] = cb[i] * (1 - a) + c[2] * a;
    alp[i] = a + alp[i] * (1 - a);
  };

  // ---------- terraces: thinner layers whose edges echo the outline, with stepped jogs ----------
  const fib = (cfg.fibre * Math.PI) / 180;
  const big = Math.min(w, h) > 100;
  const thStep = new Float32Array(N);
  const terr = new Float32Array(N);
  const layers = [];
  const base = big ? 7 : 5;
  const per = perimeter(poly);
  for (let k = 0; k < (big ? 3 : 2); k++) {
    const t = base + k * (big ? 9 : 6) + rng.uniform(-1.5, 2);
    const jogs = [];
    for (let j = 0; j < Math.floor(Math.max(0, per - 8 * t) / 160) + 1; j++) {
      const p = alongOutline(poly, rng.uniform(0, per));
      // step the point inward to the layer's edge
      const nx = Math.sin(p.ang);
      const ny = -Math.cos(p.ang);
      const inward = sd[near(p.x - nx * t, p.y - ny * t)] > sd[near(p.x + nx * t, p.y + ny * t)] ? -1 : 1;
      const hl = rng.uniform(60, 200) / 2;
      const hd = rng.uniform(2.5, 6);
      jogs.push({ x: p.x + inward * nx * t, y: p.y + inward * ny * t, ang: p.ang, hl, hd, reach: hl + hd + 8 });
    }
    const dl = new Float32Array(N);
    const lm = new Uint8Array(N);
    const vn = noise(W, H, ss, 70, rng);
    const vis = new Float32Array(N);
    let any = false;
    for (let i = 0; i < N; i++) {
      let d = sd[i] - t;
      // a jog only matters near its own rectangle (and the line only near an edge)
      if (d > -12) for (const jg of jogs) {
        if (Math.abs(PX[i] - jg.x) > jg.reach || Math.abs(PY[i] - jg.y) > jg.reach) continue;
        const r = rectSd(PX[i], PY[i], jg.x, jg.y, jg.ang, jg.hl, jg.hd);
        if (-r < d) d = -r;
      }
      lm[i] = d > 0 ? 1 : 0;
      if (lm[i]) any = true;
      dl[i] = Math.abs(d);
      vis[i] = clamp01((vn[i] + 0.5) * 2.4 - 0.7);
      const line = Math.exp(-((dl[i] / 0.6) ** 2)) * vis[i] * (0.34 - 0.08 * k);
      if (line > terr[i]) terr[i] = line;
      thStep[i] += lm[i] * 0.9;
    }
    if (!any) break;
    layers.push({ lm, dl, vis });
  }
  {
    const c1 = hexc("#f6f8ff");
    const c2 = hexc("#f2f4fb");
    for (let i = 0; i < N; i++) {
      over(i, c1, terr[i] * damp[i]);
      if (layers.length && !layers[0].lm[i] && mbin[i]) over(i, c2, 0.035);
    }
  }

  // ---------- silky streaks along the fibre ----------
  const cf = Math.cos(fib);
  const sf = Math.sin(fib);
  const U = new Float32Array(N);
  const V = new Float32Array(N);
  let umin = Infinity;
  let umax = -Infinity;
  let vmin = Infinity;
  let vmax = -Infinity;
  for (let i = 0; i < N; i++) {
    U[i] = PX[i] * cf + PY[i] * sf;
    V[i] = -PX[i] * sf + PY[i] * cf;
    if (U[i] < umin) umin = U[i];
    if (U[i] > umax) umax = U[i];
    if (V[i] < vmin) vmin = V[i];
    if (V[i] > vmax) vmax = V[i];
  }
  {
    const n = Math.floor((vmax - vmin) / 6.5) + 6;
    const vi = Array.from({ length: n }, () => rng.uniform(vmin, vmax)).sort((a, b) => a - b);
    const wi = vi.map(() => rng.uniform(0.35, 0.85));
    const ai = vi.map(() => 0.03 + 0.15 * rng.random() ** 2.2);
    const Li = vi.map(() => rng.uniform(0.25, 1) * (umax - umin));
    const u0 = Li.map((L) => umin + rng.random() * (umax - umin - L * 0.5) - L * 0.25);
    const ph = vi.map(() => rng.uniform(0, 6.3));
    const fr = vi.map(() => rng.uniform(1 / 90, 1 / 30));
    const gN = Math.floor((vmax - vmin) / 0.6) + 4;
    const grid = new Float32Array(gN);
    for (let i = 0; i < gN; i++) grid[i] = rng.random() ** 3;
    blur(grid, gN, 1, 0.6);
    const n120 = noise(W, H, ss, 120, rng);
    const col = hexc("#fbfcff");
    for (let i = 0; i < N; i++) {
      if (!mbin[i]) continue;
      const v = V[i];
      const u = U[i];
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (vi[m] < v) lo = m + 1;
        else hi = m;
      }
      const j = Math.min(n - 1, Math.max(1, lo));
      let st = 0;
      for (let jj = j - 1; jj <= j; jj++) {
        const dv = v - vi[jj];
        const uu = (u - u0[jj]) / Li[jj];
        const win = clamp01((Math.min(uu, 1 - uu) * Li[jj]) / 14);
        const val = ai[jj] * Math.exp(-((dv / wi[jj]) ** 2)) * win * (0.65 + 0.35 * Math.sin(u * fr[jj] * 6.283 + ph[jj]));
        if (val > st) st = val;
      }
      const gp = (v - vmin) / 0.6;
      const g0 = Math.min(gN - 1, Math.floor(gp));
      const g1 = Math.min(gN - 1, g0 + 1);
      const sat = (grid[g0] + (grid[g1] - grid[g0]) * (gp - g0)) * clamp01(n120[i] * 2.2 + 0.4) * 0.1;
      over(i, col, Math.max(st, sat) * damp[i]);
    }
  }

  // short streaks at ~66 deg to the fibre
  const stroke = (field, x0, y0, ang, L, wd, amp, mul = null) => {
    const xa = Math.min(x0, x0 + L * Math.cos(ang)) - 3;
    const xb = Math.max(x0, x0 + L * Math.cos(ang)) + 3;
    const ya = Math.min(y0, y0 + L * Math.sin(ang)) - 3;
    const yb = Math.max(y0, y0 + L * Math.sin(ang)) + 3;
    const bx0 = Math.max(0, Math.floor(xa * ss));
    const bx1 = Math.min(W, Math.ceil(xb * ss));
    const by0 = Math.max(0, Math.floor(ya * ss));
    const by1 = Math.min(H, Math.ceil(yb * ss));
    for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) {
      const i = y * W + x;
      const [f, t] = segField(PX[i], PY[i], x0, y0, ang, L, wd);
      const val = f * amp * (mul ? mul(t) : 1);
      if (val > field[i]) field[i] = val;
    }
  };
  {
    const sec = new Float32Array(N);
    for (let k = 0; k < Math.floor((w * h) / 7000) + 2; k++) {
      const x0 = rng.uniform(0, w);
      const y0 = rng.uniform(0, h);
      const a = fib + ((66 * rng.choice([-1, 1]) + rng.normal(0, 3)) * Math.PI) / 180;
      const L = rng.uniform(14, 60);
      stroke(sec, x0, y0, a, L, rng.uniform(0.35, 0.6), rng.uniform(0.06, 0.15));
    }
    const col = hexc("#f4f6ff");
    for (let i = 0; i < N; i++) if (mbin[i] && sec[i]) over(i, col, sec[i] * damp[i]);
  }

  // ---------- feather fractures ----------
  {
    const fea = new Float32Array(N);
    for (const [fx, fy, sz] of cfg.feathers ?? []) {
      const sp = fib + ((rng.choice([-66, 66]) + rng.normal(0, 6)) * Math.PI) / 180;
      const acc = new Float32Array(N);
      const sx0 = fx - (sz / 2) * Math.cos(sp);
      const sy0 = fy - (sz / 2) * Math.sin(sp);
      stroke(acc, sx0, sy0, sp, sz, 0.45, 0.5);
      for (let s = 2; s < sz - 2; s += 1.7) {
        const t = s / sz;
        const bxp = sx0 + s * Math.cos(sp);
        const byp = sy0 + s * Math.sin(sp);
        for (const side of [-1, 1]) {
          const ba = sp + side * ((38 + rng.normal(0, 5)) * Math.PI) / 180;
          const bl = sz * 0.36 * Math.sin(Math.PI * t) ** 0.8 * rng.uniform(0.45, 1);
          if (bl < 1.5) continue;
          stroke(acc, bxp, byp, ba, bl, 0.38, rng.uniform(0.35, 0.8), (tt) => 1 - 0.6 * tt);
        }
      }
      for (let i = 0; i < N; i++) if (acc[i] * 0.32 > fea[i]) fea[i] = acc[i] * 0.32;
    }
    const col = hexc("#f8f9ff");
    for (let i = 0; i < N; i++) if (mbin[i] && fea[i]) over(i, col, fea[i] * damp[i]);
  }

  // ---------- specks ----------
  for (let k = 0; k < Math.floor((w * h) / 5000) + 2; k++) {
    const x0 = rng.uniform(4, w - 4);
    const y0 = rng.uniform(4, h - 4);
    const r = rng.uniform(0.45, 1);
    const dark = rng.random() < 0.55;
    const c = hexc(dark ? "#4a4650" : "#ffffff");
    for (let y = Math.max(0, Math.floor((y0 - 3) * ss)); y < Math.min(H, Math.ceil((y0 + 3) * ss)); y++) {
      for (let x = Math.max(0, Math.floor((x0 - 3) * ss)); x < Math.min(W, Math.ceil((x0 + 3) * ss)); x++) {
        const i = y * W + x;
        over(i, c, Math.exp(-((PX[i] - x0) ** 2 + (PY[i] - y0) ** 2) / (r * r)) * (dark ? 0.35 : 0.45) * damp[i]);
      }
    }
  }

  // ---------- one faint thin-film rainbow along the first terrace ----------
  if (layers.length) {
    const { dl } = layers[0];
    const cx = rng.uniform(0.25, 0.75) * w;
    const cy = rng.uniform(0.15, 0.85) * h;
    const rx = w * 0.35 + 30;
    const ry = h * 0.25 + 20;
    const film = [0, 0, 0];
    for (let i = 0; i < N; i++) {
      if (!mbin[i] || dl[i] > 5) continue;
      const nr = Math.exp(-(((PX[i] - cx) / rx) ** 2 + ((PY[i] - cy) / ry) ** 2));
      const a = Math.exp(-((dl[i] / 1.6) ** 2)) * nr * 0.3 * damp[i];
      const ph = (2 * Math.PI * U[i]) / 26;
      film[0] = 0.55 + 0.45 * Math.cos(ph);
      film[1] = 0.55 + 0.45 * Math.cos(ph + 2.1);
      film[2] = 0.55 + 0.45 * Math.cos(ph + 4.2);
      over(i, film, a);
    }
  }

  // ---------- frosty granular rim with short fibres pointing inward ----------
  const fa = new Float32Array(N);
  {
    const grain = noise(W, H, ss, 0.9, rng);
    const col = hexc("#fbf9f4");
    for (let i = 0; i < N; i++) {
      const wr = 2.5 + 4 * (lfE[i] + 0.5);
      const Lf = wr * (1 + 1.8 * clamp01(hfE[i] * 2.4));
      const frost = clamp01(1 - sdr[i] / Lf) ** 1.3;
      const gr = clamp01(grain[i] * 2.6 + 0.55);
      fa[i] = frost * (0.22 + 0.5 * gr) + Math.exp(-Math.max(sdr[i], 0) / 0.8) * 0.25;
      if (mbin[i]) over(i, col, Math.min(0.85, Math.max(0, fa[i])));
    }
  }

  const zone = new Uint8ClampedArray(N * 4);
  const maskImg = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    zone[o] = cr[i] * 255;
    zone[o + 1] = cg[i] * 255;
    zone[o + 2] = cb[i] * 255;
    zone[o + 3] = alp[i] * mask[i] * 255;
    maskImg[o] = maskImg[o + 1] = maskImg[o + 2] = 255;
    maskImg[o + 3] = mask[i] * 255;
  }

  // ---------- refraction: edge bevel + tiny walls at each terrace ----------
  const B = 5;
  const T = 9;
  const N2 = 1.52;
  const hh = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const tt = clamp01(sdr[i] / B);
    hh[i] = (mbin[i] ? T * Math.sqrt(1 - (1 - tt) ** 2) : 0) + thStep[i];
  }
  blur(hh, W, H, 0.6 * ss);
  const nX = new Float32Array(N);
  const nY = new Float32Array(N);
  const nZ = new Float32Array(N);
  const dX = new Float32Array(N);
  const dY = new Float32Array(N);
  const F = 1.8;
  let md = 0;
  const eta = 1 / N2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const gx = ((x < W - 1 ? hh[i + 1] : hh[i]) - (x > 0 ? hh[i - 1] : hh[i])) / ((x > 0 && x < W - 1 ? 2 : 1) / ss);
    const gy = ((y < H - 1 ? hh[i + W] : hh[i]) - (y > 0 ? hh[i - W] : hh[i])) / ((y > 0 && y < H - 1 ? 2 : 1) / ss);
    const ln = Math.sqrt(gx * gx + gy * gy + 1);
    const nx = -gx / ln;
    const ny = -gy / ln;
    const nz = 1 / ln;
    nX[i] = nx;
    nY[i] = ny;
    nZ[i] = nz;
    if (!mbin[i]) continue;
    const kk = Math.max(0, 1 - eta * eta * (1 - nz * nz));
    const cc = eta * nz - Math.sqrt(kk);
    const tz = -eta + eta * nz * nz - Math.sqrt(kk) * nz;
    let dx = (hh[i] * cc * nx) / -tz;
    let dy = (hh[i] * cc * ny) / -tz;
    dx = (Math.min(w - 1, Math.max(1, PX[i] + F * dx)) - PX[i]) / F;
    dy = (Math.min(h - 1, Math.max(1, PY[i] + F * dy)) - PY[i]) / F;
    dX[i] = dx;
    dY[i] = dy;
    const m = Math.hypot(dx, dy);
    if (m > md) md = m;
  }
  md = md || 1;
  const disp = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    disp[o] = Math.round(128 + (127 * dX[i]) / md);
    disp[o + 1] = Math.round(128 + (127 * dY[i]) / md);
    disp[o + 2] = 128;
    disp[o + 3] = 255;
  }

  // ---------- light: rim catching the light, glare runs, bevel glints, terrace highlights ----------
  const L2 = (() => {
    const l = Math.hypot(-0.56, -0.83);
    return [-0.56 / l, -0.83 / l];
  })();
  const L3 = (() => {
    const v = [-0.45, -0.65, 0.61];
    const l = Math.hypot(...v);
    return v.map((c) => c / l);
  })();
  const H3 = (() => {
    const v = [L3[0], L3[1], L3[2] + 1];
    const l = Math.hypot(...v);
    return v.map((c) => c / l);
  })();
  const sdb = Float32Array.from(sd);
  blur(sdb, W, H, 1.2 * ss);
  const segN = noise(W, H, ss, 34, rng);
  const spec = new Uint8ClampedArray(N * 4);
  const h3z = H3[2] ** 160;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const o = i * 4;
    spec[o] = spec[o + 1] = spec[o + 2] = 255;
    if (!mbin[i]) continue;
    const gsx = (x < W - 1 ? sdb[i + 1] : sdb[i]) - (x > 0 ? sdb[i - 1] : sdb[i]);
    const gsy = (y < H - 1 ? sdb[i + W] : sdb[i]) - (y > 0 ? sdb[i - W] : sdb[i]);
    const on = -(gsx * L2[0] + gsy * L2[1]) / Math.max(Math.hypot(gsx, gsy), 1e-6);
    const facing = clamp01(on);
    const seg = clamp01((segN[near(ex[i], ey[i])] + 0.5) * 2.2 - 0.8);
    const s0 = Math.max(sdr[i], 0);
    const rim = Math.exp(-s0 / 0.7) * (0.18 + 0.55 * facing * facing) + Math.exp(-s0 / 1.6) * seg * facing * 0.5;
    const ndh = clamp01(nX[i] * H3[0] + nY[i] * H3[1] + nZ[i] * H3[2]);
    const glint = sdr[i] < B + 1 ? Math.max(0, ndh ** 160 - h3z) : 0;
    let tl = 0;
    if (layers.length) tl = layers[0].vis[i] * Math.exp(-((layers[0].dl[i] / 0.45) ** 2)) * facing * 0.35;
    spec[o + 3] = clamp01(rim + glint * 1.1 + tl) * mask[i] * 255;
  }

  // twinkles at convex outline corners that face the light
  const cands = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[(i - 1 + poly.length) % poly.length];
    const b = poly[i];
    const c = poly[(i + 1) % poly.length];
    const e1 = [b[0] - a[0], b[1] - a[1]];
    const e2 = [c[0] - b[0], c[1] - b[1]];
    if (e1[0] * e2[1] - e1[1] * e2[0] <= 0) continue;
    const l1 = Math.hypot(...e1) || 1;
    const l2 = Math.hypot(...e2) || 1;
    const nrm = [-(e1[0] / l1 - e2[0] / l2), -(e1[1] / l1 - e2[1] / l2)];
    const score = -(nrm[0] * L2[0] + nrm[1] * L2[1]) / (Math.hypot(...nrm) + 1e-9) + rng.uniform(0, 0.3);
    const tc = [w / 2 - b[0], h / 2 - b[1]];
    const tl = Math.hypot(...tc) || 1;
    cands.push([score, [Math.round((b[0] + (tc[0] / tl) * 2.5) * 10) / 10, Math.round((b[1] + (tc[1] / tl) * 2.5) * 10) / 10]]);
  }
  cands.sort((p, q) => q[0] - p[0]);
  const twinkles = cands.slice(0, h > 200 ? 2 : 1).map((c) => c[1]);

  // ---------- under: soft shadow plus white light leaking from the frosted rim ----------
  const M = MARGIN;
  const UW = w + 2 * M;
  const UH = h + 2 * M;
  const sh = new Float32Array(UW * UH);
  const gl = new Float32Array(UW * UH);
  // the mask and frost at one pixel per plate pixel
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    let f = 0;
    let c = 0;
    for (let yy = Math.floor(y * ss); yy < Math.min(H, Math.floor((y + 1) * ss)); yy++) {
      for (let xx = Math.floor(x * ss); xx < Math.min(W, Math.floor((x + 1) * ss)); xx++) {
        const i = yy * W + xx;
        m += mask[i];
        f += clamp01(fa[i]) * mask[i];
        c++;
      }
    }
    if (!c) continue;
    const sy = y + M + 12;
    const sx = x + M + 6;
    if (sy < UH && sx < UW) sh[sy * UW + sx] = m / c;
    gl[(y + M) * UW + x + M] = f / c;
  }
  blur(sh, UW, UH, 10);
  const g2 = Float32Array.from(gl);
  blur(gl, UW, UH, 3.5);
  blur(g2, UW, UH, 12);
  const [ur, ug, ub] = hexc("#f2f4ff");
  const under = new Uint8ClampedArray(UW * UH * 4);
  for (let i = 0; i < UW * UH; i++) {
    const g = gl[i] * 0.55 + g2[i] * 0.35;
    const s = sh[i] * 0.4;
    const a = g + s * (1 - g);
    const o = i * 4;
    const k = a > 1e-4 ? g / a : 0;
    under[o] = k * ur * 255;
    under[o + 1] = k * ug * 255;
    under[o + 2] = k * ub * 255;
    under[o + 3] = a * 255;
  }

  return { W, H, zone, mask: maskImg, spec, disp, under: { W: UW, H: UH, data: under }, maxd: Math.round(md * 100) / 100, twinkles };
}
