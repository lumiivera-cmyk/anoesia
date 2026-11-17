// Types for plates.js (plain JS in the browser), for the tests.
import type { PlateConfig } from "./paint.js";
export const PLATES: Record<string, Required<Omit<PlateConfig, "content">> & { content: [number, number, number, number][] }>;
export function fitPlate(name: string, w: number, h: number): Required<PlateConfig>;
