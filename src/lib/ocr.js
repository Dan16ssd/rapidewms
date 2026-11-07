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
//
// `turn` is any angle: people photograph a box whichever way it sits, and
// rarely quite straight. `join` blurs the picture by that many pixels and
// then makes it pure black and white, which fuses the separate dots of an
// inkjet (dot-matrix) date into solid strokes; Tesseract reads dots as noise.
// How far apart the dots are depends on how close the photo was taken, so
// several strengths are tried, and a small date in a whole-package photo is
// also read at a higher resolution (`max`), where its dots are still apart.
async function prepare(img, { turn = 0, join = 0, max = 1600 } = {}) {
  const k = Math.min(1, max / Math.max(img.width, img.height)),
    w = Math.round(img.width * k),
    h = Math.round(img.height * k),
    r = (turn * Math.PI) / 180,
    cos = Math.abs(Math.cos(r)),
    sin = Math.abs(Math.sin(r)),
    side = [Math.round(w * cos + h * sin), Math.round(w * sin + h * cos)],
    c = new OffscreenCanvas(...side),
    g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#fff";
  g.fillRect(0, 0, ...side);
  g.translate(side[0] / 2, side[1] / 2);
  g.rotate(r);
  if (join) g.filter = `blur(${join}px)`;
  g.drawImage(img, -w / 2, -h / 2, w, h);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.filter = "none";
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
  for (let i = 0; i < d.length; i += 4) {
    let v = ((d[i] - lo) * 255) / span;
    if (join) v = v < 150 ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  g.putImageData(px, 0, 0);
  return c.convertToBlob({ type: "image/png" });
}

// What to try, in order, until a date turns up: the photo as taken, then with
// inkjet dots joined, then a little tilted either way, then turned on its side
// or upside down. Most photos are read on the first or second try.
const TRIES = [
  {},
  { join: 2 },
  { join: 2, max: 3000 },
  { join: 4, max: 3000 },
  { join: 5 },
  { join: 9 },
  { turn: -10 },
  { turn: 10 },
  { turn: -10, join: 3 },
  { turn: 10, join: 3 },
  { turn: 90 },
  { turn: 270 },
  { turn: 90, join: 3 },
  { turn: 270, join: 3 },
  { turn: 180 },
];

/** { expiry: "YYYY-MM-DD" | null, text } for a photo. */
export async function readExpiry(file, onStage = () => {}) {
  onStage("load");
  const w = await worker(),
    img = await createImageBitmap(file);
  let text = "";
  for (const t of TRIES) {
    onStage("read");
    const { data } = await w.recognize(await prepare(img, t));
    text = data.text;
    const expiry = parseExpiry(text);
    if (expiry) return { expiry, text };
  }
  return { expiry: null, text };
}
