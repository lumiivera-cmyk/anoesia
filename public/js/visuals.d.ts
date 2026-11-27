// Types for visuals.js (plain JS in the browser), for the server and tests.
export interface VisualPart {
  kind: "text" | "visual";
  text: string;
  closed: boolean;
}
export function splitVisuals(text: string): VisualPart[];
export function hasVisual(text: string): boolean;
export function visualWords(html: string): string;
export function shortenVisuals(text: string, options?: { keepLast?: boolean }): string;
export function cleanStyle(style: string): string;
export function sanitizeVisual(html: string): string;
