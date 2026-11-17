// Types for paint.js (plain JS in the browser), for the tests.
export const MARGIN: number;
export interface PlateConfig {
  w: number;
  h: number;
  poly: [number, number][];
  inset: number;
  fibre: number;
  feathers: [number, number, number][];
  content?: [number, number, number, number][];
  seed?: number;
}
export interface Painted {
  W: number;
  H: number;
  zone: Uint8ClampedArray;
  mask: Uint8ClampedArray;
  spec: Uint8ClampedArray;
  disp: Uint8ClampedArray;
  under: { W: number; H: number; data: Uint8ClampedArray };
  maxd: number;
  twinkles: [number, number][];
}
export function paintPlate(cfg: PlateConfig, ss?: number): Painted;
