// Read an expiry date off a photo of a package.
//
// Tesseract (an open-source text reader) runs in the browser. It downloads
// about 6 MB the first time it is used and the service worker keeps it, so
// later reads work offline. Printed dates on curved bottles and in dot-matrix
// ink are hard to read, so the result is always a suggestion for a person to
// check, never saved on its own.
import { parseExpiry } from "./expiry.js";

let workerPromise = null;
const worker = () =>
  (workerPromise ||= import("tesseract.js").then(({ createWorker }) => createWorker("eng")).catch((e) => {
    workerPromise = null; // let the next try download again
    throw e;
  }));

// A phone photo is 12 megapixels; text the size of a date reads fine at 1600 px
// and many times faster. Greyscale and stretched contrast help faded ink.
async function prepare(file, turn) {
  const img = await createImageBitmap(file),
    k = Math.min(1, 1600 / Math.max(img.width, img.height)),
    w = Math.round(img.width * k),
    h = Math.round(img.height * k),
    side = turn % 180 ? [h, w] : [w, h],
    c = new OffscreenCanvas(...side),
    g = c.getContext("2d");
  g.translate(side[0] / 2, side[1] / 2);
  g.rotate((turn * Math.PI) / 180);
  g.drawImage(img, -w / 2, -h / 2, w, h);
  const px = g.getImageData(0, 0, ...side),
    d = px.data;
  let lo = 255,
    hi = 0;
  for (let i = 0; i < d.length; i += 4) {
    const y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    d[i] = y;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = ((d[i] - lo) * 255) / span;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.putImageData(px, 0, 0);
  return c.convertToBlob({ type: "image/png" });
}

/**
 * { expiry: "YYYY-MM-DD" | null, text } for a photo. Tries the photo upright,
 * then turned, since people photograph a label whichever way the box sits.
 */
export async function readExpiry(file, onStage = () => {}) {
  onStage("load");
  const w = await worker();
  let text = "";
  for (const turn of [0, 90, 270, 180]) {
    onStage("read");
    const { data } = await w.recognize(await prepare(file, turn));
    text = data.text;
    const expiry = parseExpiry(text);
    if (expiry) return { expiry, text };
  }
  return { expiry: null, text };
}
