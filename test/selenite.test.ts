import { describe, expect, test } from "bun:test";
import { MARGIN, paintPlate } from "../public/js/selenite/paint.js";
import { fitPlate, PLATES } from "../public/js/selenite/plates.js";

describe("selenite plates", () => {
  test("an outline fitted to a new size keeps its corner cuts and notches", () => {
    const fit = fitPlate("setmain", 700, 600);
    expect(fit.w).toBe(700);
    // the top-left cut (0,20)-(20,0) and the bottom-right notch keep their size
    expect(fit.poly[0]).toEqual([0, 20]);
    expect(fit.poly[1]).toEqual([20, 0]);
    expect(fit.poly[6]).toEqual([700, 600 - (784 - 690)]);
    expect(fit.poly[7]).toEqual([690, 600 - (784 - 690)]);
    // nothing leaves the box, and x never runs backwards along the top edge
    for (const [x, y] of fit.poly) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(700);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(600);
    }
    const top = fit.poly.slice(1, 5).map(([x]) => x);
    expect([...top].sort((a, b) => a - b)).toEqual(top);
  });

  test("every outline still fits at a small size", () => {
    for (const name of Object.keys(PLATES)) {
      const fit = fitPlate(name, 160, 120);
      for (const [x, y] of fit.poly) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(160);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(120);
      }
    }
  });

  test("the painter makes five images at the plate's size", () => {
    const cfg = fitPlate("smodel", 240, 160);
    const r = paintPlate(cfg, 1);
    expect([r.W, r.H]).toEqual([240, 160]);
    for (const k of ["zone", "mask", "spec", "disp"] as const) expect(r[k].length).toBe(240 * 160 * 4);
    expect([r.under.W, r.under.H]).toEqual([240 + 2 * MARGIN, 160 + 2 * MARGIN]);
    const alpha = (img: Uint8ClampedArray, x: number, y: number) => img[(y * 240 + x) * 4 + 3];
    // inside the outline the mask is solid, outside (the cut bottom-left corner) it's clear
    expect(alpha(r.mask, 120, 80)).toBe(255);
    expect(alpha(r.mask, 2, 157)).toBe(0);
    // the displacement map is centred on 128 away from the rim, and bends near it
    const disp = (x: number, y: number) => [r.disp[(y * 240 + x) * 4], r.disp[(y * 240 + x) * 4 + 1]];
    expect(disp(120, 80)).toEqual([128, 128]);
    expect(r.maxd).toBeGreaterThan(1);
    expect(r.twinkles.length).toBe(1);
  });

  test("the same plate paints the same way every time", () => {
    const cfg = fitPlate("chead", 300, 72);
    const a = paintPlate(cfg, 1);
    const b = paintPlate(cfg, 1);
    expect(Buffer.from(a.zone).equals(Buffer.from(b.zone))).toBe(true);
  });
});
