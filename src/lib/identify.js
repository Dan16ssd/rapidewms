// Name a product from a photo with a small vision-language model that runs
// on the device: no server, no per-photo cost, and the photo never leaves it.
//
// SmolVLM-256M is the smallest model that can look at a package and answer in
// words. It downloads once (the size is shown before it starts) and the
// browser keeps it. On a phone with WebGPU it answers in a few seconds; on
// plain CPU it is slower. It reads Latin print well, Thai and Lao poorly, and
// can be wrong, so what it says fills the form for a person to check.

export const MODEL = "HuggingFaceTB/SmolVLM-256M-Instruct";
// Must match node_modules/onnxruntime-web (the version transformers.js bundles).
const ORT = "1.31.0-dev.20260914-8d85527a0";
// The 8-bit word table: half the size and memory of the 16-bit one, same
// answers (measured: page peak 947 → 792 MB in Chrome).
const DTYPE = { embed_tokens: "int8", vision_encoder: "q4", decoder_model_merged: "q4" };
// Measured download: 179 MB of model files plus the 5.5 MB runtime.
const BYTES = 179e6;
export const MODEL_MB = 185;

// iPhone Safari closes a page that uses too much memory ("A problem repeatedly
// occurred"). WebGPU is fastest and lightest for the page itself, but if the
// page died while using it, the next try runs on the CPU instead: slower
// (about 17 s here), with no graphics memory. localStorage
// "rapidewms.ai.device" = "webgpu" / "wasm" forces one.
async function pickDevice() {
  const forced = ls()?.getItem("rapidewms.ai.device");
  if (forced) return forced;
  if (ls()?.getItem(NO_GPU)) return "wasm";
  return (await navigator.gpu?.requestAdapter?.().catch(() => null)) ? "webgpu" : "wasm";
}

// The model sees the photo at 512 px, but a phone photo is 12–48 megapixels:
// 50–200 MB once decoded. Shrink it once, before anything looks at it.
export async function shrink(file, max = 1024) {
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return file;
  }
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  if (k == 1) return bmp.close?.(), file;
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const out = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
  c.width = c.height = 0; // let Safari free the canvas memory now
  return out || file;
}

// If the page dies while the model loads or looks (the phone ran out of
// memory), the mark below survives; the next start sees it and the app asks
// before trying again, instead of crashing the same way.
const TRYING = "rapidewms.ai.trying",
  CRASHED = "rapidewms.ai.crashed",
  NO_GPU = "rapidewms.ai.noGpu"; // stays: this device crashes with WebGPU
const ls = () => globalThis.localStorage;
export function crashedBefore() {
  try {
    const was = ls()?.getItem(TRYING);
    if (was) {
      ls().setItem(CRASHED, was);
      if (was == "webgpu") ls().setItem(NO_GPU, "1");
      ls().removeItem(TRYING);
    }
    return !!ls()?.getItem(CRASHED);
  } catch {
    return false;
  }
}
// The mark holds the device in use, so a crash on WebGPU moves to the CPU.
const mark = (device) => {
  try {
    device ? ls()?.setItem(TRYING, device) : ls()?.removeItem(TRYING);
  } catch {}
};
const workedHere = () => {
  try {
    ls()?.removeItem(CRASHED);
  } catch {}
};

// Types a product can be, and whether each is used up (consumable, tracked for
// expiry) or lasts (durable).
export const TYPES = {
  food: "consumable",
  drink: "consumable",
  medicine: "consumable",
  cosmetic: "consumable",
  household: "consumable",
  clothing: "durable",
  electronics: "durable",
  tool: "durable",
  other: "durable",
};

// The model names a product well but sorts it badly (tested: asked "can people
// eat this?" it said yes to a hammer, a shirt and a charger). So it is asked
// only for the name, and the type comes from the words in that name. First
// match wins: appliances and tools are checked before food, so "rice cooker"
// is not food. English, Lao and Thai,
// because staff may correct the name in any of them.
const WORDS = [
  // Food whose name holds another type's word ("cream" is also a cosmetic).
  ["food", "ice cream|ice-cream|cream cracker|cream biscuit|ไอศกรีม|ກະແລ້ມ"],
  ["medicine", "paracetamol|tablet|capsule|medicine|pharma|vitamin|syrup|ointment|aspirin|ibuprofen|antibiotic|amoxicillin|bandage|plaster|drops|ຢາ|ยา"],
  ["cosmetic", "shampoo|conditioner|lotion|cream|soap|toothpaste|tooth paste|deodorant|perfume|lipstick|makeup|make-up|sunscreen|face wash|cleanser|talc|ແຊມພູ|ສະບູ|ຢາສີຟັນ|ແຊມພູ|แชมพู|สบู่|ยาสีฟัน|โลชั่น"],
  ["household", "detergent|bleach|cleaner|dishwash|dish soap|tissue|toilet paper|napkin|insecticide|mosquito|air freshener|garbage bag|trash bag|washing powder|softener|battery|batteries|candle|ຜົງຊັກຟອກ|ເຈ້ຍທິດຊູ|ผงซักฟอก|ทิชชู่"],
  ["electronics", "charger|cable|phone|usb|headphone|earphone|speaker|adapter|power bank|powerbank|bulb|lamp|fan|radio|remote|electric|ສາຍສາກ|โทรศัพท์|สายชาร์จ|cooker|kettle|blender|microwave|heater|iron|torch|flashlight|ໝໍ້ຫຸງເຂົ້າ|หม้อหุงข้าว"],
  ["tool", "hammer|screwdriver|wrench|spanner|pliers|saw|drill|knife|scissors|tape measure|shovel|hoe|axe|ຄ້ອນ|ມີດ|ค้อน|มีด|ไขควง"],
  ["clothing", "shirt|t-shirt|tshirt|pants|trousers|jeans|dress|sock|shoe|sandal|slipper|hat|cap|jacket|skirt|underwear|ເສື້ອ|ໂສ້ງ|ເກີບ|เสื้อ|กางเกง|รองเท้า"],
  ["drink", "water|drink|juice|milk|soda|cola|coffee|tea|beer|wine|whisky|liquor|beverage|energy|yogurt|yoghurt|ນ້ຳ|ນົມ|ເບຍ|ກາເຟ|ນ້ຳດື່ມ|น้ำ|นม|เบียร์|กาแฟ"],
  ["food", "chip|crisp|snack|noodle|rice|bread|biscuit|cookie|cake|candy|sweet|chocolate|sauce|oil|sugar|salt|egg|meat|fish|sardine|tuna|fruit|vegetable|cereal|canned|seasoning|ketchup|mayonnaise|cracker|wafer|jam|butter|cheese|flour|instant|ເຂົ້າ|ໝີ່|ເສັ້ນ|ຂະໜົມ|ນ້ຳປາ|ข้าว|บะหมี่|ขนม|น้ำปลา"],
];
// A plain substring test, because Lao and Thai have no spaces between words.
// "tea" inside "steak" would be a false hit in English, so Latin words must
// start at a word boundary.
const RX = WORDS.map(([type, w]) => [
  type,
  new RegExp(
    w
      .split("|")
      .map((x) => (/^[a-z]/.test(x) ? "\\b" + x : x))
      .join("|"),
    "i",
  ),
]);

/** The type a product name points to, or "" when nothing in it is known. */
export function typeOf(name) {
  return RX.find(([, rx]) => rx.test(name || ""))?.[0] || "";
}

// "This product is a hammer." → "Hammer"
export function cleanName(text) {
  let s = String(text || "").split("\n")[0].trim();
  s = s.replace(/^(this|the)\s+(product|image|object|item)\s+(is|shows)\s+(an?\s+|the\s+)?/i, "");
  s = s.replace(/^(an?|the)\s+/i, "").replace(/[.。!]+$/, "").trim();
  return (s.charAt(0).toUpperCase() + s.slice(1)).slice(0, 80);
}

// The model arrives as several files, each reporting its own 0–100%. This adds
// them into one figure that only goes up: until every file has started, the
// measured size stands in for the total so the bar does not run ahead.
export function downloadMeter(onProgress, expected = BYTES) {
  const files = new Map();
  let best = 0;
  return (p) => {
    if (p.status != "progress" || !p.total) return;
    files.set(p.file, [p.loaded, p.total]);
    let loaded = 0,
      total = 0;
    for (const [l, t] of files.values()) (loaded += l), (total += t);
    total = Math.max(total, expected);
    best = Math.max(best, Math.min(100, Math.floor((loaded / total) * 100)));
    onProgress?.({ pct: best, loaded, total });
  };
}

let loading = null,
  used = null; // the device the loaded model runs on

// The files this device would load, e.g. "onnx/embed_tokens_int8.onnx".
const files = () => Object.entries(DTYPE).map(([f, d]) => `onnx/${f}_${d}.onnx`);

export const isCached = async () => {
  try {
    const c = await caches.open("transformers-cache");
    const urls = (await c.keys()).map((r) => r.url).filter((u) => u.includes(MODEL));
    return files().every((f) => urls.some((u) => u.endsWith(f)));
  } catch {
    return false;
  }
};

// Files of an earlier set (the 16-bit word table) only take up space.
async function dropOthers() {
  try {
    const c = await caches.open("transformers-cache"),
      keep = files();
    for (const r of await c.keys())
      if (r.url.includes(MODEL) && r.url.endsWith(".onnx") && !keep.some((f) => r.url.endsWith(f))) await c.delete(r);
  } catch {}
}

function load(onProgress) {
  return (loading ||= (async () => {
    const T = await import("@huggingface/transformers");
    // The 27 MB engine comes from the CDN, at exactly the version bundled
    // (the build drops its own copy); the service worker keeps it after.
    T.env.backends.onnx.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT}/dist/`;
    const device = await pickDevice();
    mark((used = device));
    const progress = downloadMeter(onProgress);
    const processor = await T.AutoProcessor.from_pretrained(MODEL, { progress_callback: progress });
    const model = await T.AutoModelForVision2Seq.from_pretrained(MODEL, {
      dtype: DTYPE,
      device,
      progress_callback: progress,
    });
    dropOthers();
    return { T, processor, model, device };
  })().catch((e) => {
    loading = null;
    throw e;
  }));
}

const PROMPT = "What is this product? Answer with its name only, including brand and size if printed.";

/**
 * { name, type, kind, raw, ms, device } for a photo of a product. type and kind
 * are "" when the name gives no clue, so the person picks them. onLook runs
 * once the model is ready, as it starts looking at the photo.
 */
export async function identify(file, onProgress, onLook) {
  mark(used || "loading");
  try {
    const r = await look(file, onProgress, onLook);
    workedHere();
    return r;
  } finally {
    mark(false);
  }
}

async function look(file, onProgress, onLook) {
  const { T, processor, model, device } = await load(onProgress);
  onLook?.();
  const t0 = performance.now();
  const image = await T.RawImage.fromBlob(file);
  const messages = [{ role: "user", content: [{ type: "image" }, { type: "text", text: PROMPT }] }];
  const prompt = processor.apply_chat_template(messages, { add_generation_prompt: true });
  const inputs = await processor(prompt, [image], { do_image_splitting: false });
  const out = await model.generate({ ...inputs, max_new_tokens: 24, do_sample: false });
  const [raw] = processor.batch_decode(out.slice(null, [inputs.input_ids.dims.at(-1), null]), {
    skip_special_tokens: true,
  });
  const name = cleanName(raw),
    type = typeOf(name);
  return { name, type, kind: type ? TYPES[type] : "", raw, ms: Math.round(performance.now() - t0), device };
}
