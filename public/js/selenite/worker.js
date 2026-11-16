/**
 * Paints selenite plates off the main thread. One message in ({ id, cfg, ss }),
 * one out: { id, maxd, twinkles, png: { zone, mask, spec, disp, under } } as
 * PNG blobs, or { id, error }.
 */

import { paintPlate } from "./paint.js";

async function png(W, H, data) {
  const canvas = new OffscreenCanvas(W, H);
  canvas.getContext("2d").putImageData(new ImageData(data, W, H), 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

self.onmessage = async ({ data }) => {
  const { id, cfg, ss } = data;
  try {
    const r = paintPlate(cfg, ss);
    const [zone, mask, spec, disp, under] = await Promise.all([
      png(r.W, r.H, r.zone),
      png(r.W, r.H, r.mask),
      png(r.W, r.H, r.spec),
      png(r.W, r.H, r.disp),
      png(r.under.W, r.under.H, r.under.data),
    ]);
    self.postMessage({ id, maxd: r.maxd, twinkles: r.twinkles, png: { zone, mask, spec, disp, under } });
  } catch (error) {
    self.postMessage({ id, error: String(error?.message ?? error) });
  }
};
