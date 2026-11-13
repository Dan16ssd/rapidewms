// Expiry dates: reading them from what is typed at the counter, printed on a
// package (via the camera) or encoded in a GS1 barcode, and judging how close
// they are. Pure functions, no DOM, so scripts/test-units.mjs can test them.
//
// Dates are ISO strings, YYYY-MM-DD, in the shop's local calendar.

// How many days ahead a date counts as "soon": the shop's setting (settings.expiry_days).
export let SOON_DAYS = 30;
export const setSoonDays = (n) => (SOON_DAYS = +n > 0 ? +n : 30);

const pad = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => isoOf(new Date());

// Whole days from `from` to `expiry`: 0 = expires today, negative = expired.
export const daysLeft = (expiry, from = today()) =>
  Math.round((Date.parse(expiry + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 864e5);

export function status(expiry, from) {
  const d = daysLeft(expiry, from);
  return d < 0 ? "expired" : d <= SOON_DAYS ? "soon" : "ok";
}

// A real calendar date, or null. With no day, the date is the month's last day:
// "EXP 05/2027" means good until the end of May.
function mk(y, m, d) {
  y = +y;
  m = +m;
  if (y < 100) y += y >= 60 ? 2500 : 2000; // 2-digit: 60–99 can only be a Thai year (25xx)
  if (y > 2400) y -= 543; // Thai Buddhist era, common on Thai imports: 2570 = 2027
  if (!(m >= 1 && m <= 12) || y < 2000 || y > 2100) return null;
  const last = new Date(y, m, 0).getDate();
  d = d == null ? last : +d;
  if (!(d >= 1 && d <= last)) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

// Day and month in either order. Laos, Thailand and Vietnam write day first;
// a first number above 12 can't be a month either, but a second one above 12
// means the package was printed month-first.
const dm = (a, b, y) => (+b > 12 && +a <= 12 ? mk(y, a, b) : mk(y, b, a));

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const mon = (s) => MONTHS.indexOf(s.slice(0, 3)) + 1;

/**
 * What a person types into the expiry box. Digits alone are shortcuts:
 *   1227      → end of Dec 2027     (MMYY)
 *   311227    → 31 Dec 2027         (DDMMYY)
 *   122027    → end of Dec 2027     (MMYYYY, when DDMMYY isn't a date)
 *   31122027  → 31 Dec 2027         (DDMMYYYY)
 *   20271231  → 31 Dec 2027         (YYYYMMDD)
 * Anything else goes through the same reader as printed text.
 */
/**
 * Slashes put in while a date is typed as digits: "311227" shows as
 * "31/12/27". The iPhone number pad has no "/" key, so without this the
 * familiar form cannot be typed there. "1227" becomes "12/27" (month/year);
 * 8 digits starting 20xx are left as a year-first date. Anything with other
 * characters in it is left alone.
 */
export function slashDigits(v) {
  if (!/^[\d/]*$/.test(v)) return v;
  const d = v.replace(/\//g, "").slice(0, 8);
  if (d.length == 8 && /^2[01]/.test(d) && mk(d.slice(0, 4), d.slice(4, 6), d.slice(6))) return d;
  // 6 digits that are no day/month/year are month and 4-digit year: 06/2026.
  if (d.length == 6 && !mk(d.slice(4), d.slice(2, 4), d.slice(0, 2)) && mk(d.slice(2), d.slice(0, 2)))
    return d.slice(0, 2) + "/" + d.slice(2);
  return [d.slice(0, 2), d.slice(2, 4), d.slice(4)].filter(Boolean).join("/");
}

export function parseTyped(s) {
  let t = String(s || "").trim();
  // Slashes the box put in itself mean nothing more than the digits did.
  if (t.includes("/") && /^[\d/]+$/.test(t) && slashDigits(t.replace(/\//g, "")) == t) t = t.replace(/\//g, "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return mk(t.slice(0, 4), t.slice(5, 7), t.slice(8));
  const d = t.replace(/\s+/g, "");
  if (/^\d+$/.test(d)) {
    if (d.length == 4) return mk(d.slice(2), d.slice(0, 2));
    // Typed digits are always day first: no month-first guessing as with print.
    if (d.length == 6) return mk(d.slice(4), d.slice(2, 4), d.slice(0, 2)) || mk(d.slice(2), d.slice(0, 2));
    if (d.length == 8)
      return (/^2[01]/.test(d) && mk(d.slice(0, 4), d.slice(4, 6), d.slice(6))) || mk(d.slice(4), d.slice(2, 4), d.slice(0, 2));
    return null;
  }
  return parseExpiry(t);
}

// Words that sit in front of an expiry date on a package. Not "MFG"/"MFD":
// those mark the production date, which is the one to ignore.
const MARK =
  /\b(EXP\w*|E\s*X\s*P|BB\w*|BBE|BEST\s*BEFORE|BEST\s*BY|USE\s*BY|SELL\s*BY|EXPIRY|HSD|HAN\s*SU\s*DUNG)\b|หมดอายุ|ควรบริโภคก่อน|ໝົດອາຍຸ|ຫມົດອາຍຸ|有效期|到期/i;
const PROD = /\b(MFG|MFD|MFT|PROD\w*|NSX|PKD|PACKED)\b|ผลิต|ຜະລິດ|生产/i;

/**
 * The expiry date in a block of text, such as the camera's reading of a
 * package, or null. With several dates, the one after an EXP-like word wins;
 * failing that, the latest (a package's other date is when it was made).
 */
export function parseExpiry(text) {
  let s = String(text || "")
    .toUpperCase()
    // the camera's usual misreads inside numbers: O→0, I/l→1, S→5
    .replace(/(?<=\d)[OQ]|[OQ](?=\d)/g, "0")
    .replace(/(?<=\d)[IL|](?=\d)/g, "1")
    .replace(/(?<=\d)S(?=\d)/g, "5");
  const found = [],
    taken = [];
  const free = (a, b) => !taken.some(([x, y]) => a < y && b > x);
  const scan = (re, fn) => {
    for (const m of s.matchAll(re)) {
      const a = m.index,
        b = a + m[0].length;
      if (!free(a, b)) continue;
      const date = fn(m);
      if (date) {
        found.push({ date, at: a });
        taken.push([a, b]);
      }
    }
  };
  const SEP = "[\\/\\-. ]";
  scan(new RegExp(`\\b(20\\d\\d|25\\d\\d)${SEP}(\\d{1,2})${SEP}(\\d{1,2})\\b`, "g"), (m) => mk(m[1], m[2], m[3]));
  scan(new RegExp(`\\b(\\d{1,2})${SEP}(\\d{1,2})${SEP}(\\d{4}|\\d{2})\\b`, "g"), (m) => dm(m[1], m[2], m[3]));
  scan(/\b(\d{1,2})[\s\-./]*([A-Z]{3})[A-Z]*[\s\-./,]*(\d{4}|\d{2})\b/g, (m) => mon(m[2]) && mk(m[3], mon(m[2]), m[1]));
  scan(/\b([A-Z]{3})[A-Z]*[\s\-./,]*(\d{4}|\d{2})\b/g, (m) => mon(m[1]) && mk(m[2], mon(m[1])));
  scan(/\b(\d{1,2})[\/\-.](\d{4})\b/g, (m) => mk(m[2], m[1]));
  scan(/\b(\d{1,2})\/(\d{2})\b/g, (m) => mk(m[2], m[1])); // "EXP 12/27": slash only, so prices like 12.50 stay out
  // Compact digits right after a marker: "EXP 311227", "BB20271231".
  for (const m of s.matchAll(new RegExp(`(?:${MARK.source})[\\s:.]*(\\d{4,8})\\b`, "gi"))) {
    const at = m.index + m[0].length - m.at(-1).length;
    if (free(at, at + m.at(-1).length)) {
      const date = parseTyped(m.at(-1));
      if (date) found.push({ date, at });
    }
  }
  if (!found.length) return null;

  // Nearest date after an expiry word (within a short distance) wins.
  let best = null;
  for (const w of s.matchAll(new RegExp(MARK.source, "gi"))) {
    const end = w.index + w[0].length,
      next = found.filter((f) => f.at >= end && f.at - end <= 24).sort((a, b) => a.at - b.at)[0];
    if (next && (!best || next.at < best.at)) best = next;
  }
  if (best) return best.date;
  // Otherwise drop dates that follow a production word, and take the latest.
  const prodEnds = [...s.matchAll(new RegExp(PROD.source, "gi"))].map((m) => m.index + m[0].length);
  const rest = found.filter((f) => !prodEnds.some((e) => f.at >= e && f.at - e <= 24));
  return (rest.length ? rest : found).map((f) => f.date).sort().at(-1);
}

/**
 * GS1 barcodes (GS1-128, GS1 DataMatrix, GS1 QR) carry more than a product
 * number: (01) the GTIN, (17) the expiry date, (15) best-before, (10) the batch.
 * Accepts the bracketed human form and the raw form with FNC1 (ASCII 29)
 * separators and an optional ]C1 / ]d2 / ]Q3 prefix. Returns null for a plain
 * product barcode.
 */
export function parseGS1(raw) {
  let s = String(raw || "").trim();
  const out = {};
  const ymd = (v) => (/^\d{6}$/.test(v) ? mk(v.slice(0, 2), v.slice(2, 4), v.slice(4) == "00" ? null : v.slice(4)) : null);
  const put = (ai, v) => {
    if (ai == "01" || ai == "02") out.gtin = v;
    else if (ai == "17") out.expiry = ymd(v);
    else if (ai == "15" && !out.expiry) out.expiry = ymd(v);
    else if (ai == "10") out.batch = v;
  };
  if (s.includes("(")) {
    for (const m of s.matchAll(/\((\d{2,4})\)([^(]*)/g)) put(m[1], m[2].trim());
  } else {
    s = s.replace(/^\][A-Za-z]\d/, "");
    if (!/^0[12]\d{14}./.test(s)) return null;
    const FIXED = { "00": 18, "01": 14, "02": 14, 11: 6, 12: 6, 13: 6, 15: 6, 16: 6, 17: 6 };
    let i = 0;
    while (i < s.length) {
      if (s[i] == "\x1d") {
        i++;
        continue;
      }
      const ai = s.slice(i, i + 2);
      if (FIXED[ai]) {
        put(ai, s.slice(i + 2, i + 2 + FIXED[ai]));
        i += 2 + FIXED[ai];
      } else if (ai == "10" || ai == "21") {
        const end = s.indexOf("\x1d", i);
        put(ai, s.slice(i + 2, end < 0 ? undefined : end));
        i = end < 0 ? s.length : end + 1;
      } else break; // an AI we don't read: stop rather than misread the rest
    }
  }
  return out.gtin ? out : null;
}

// The forms one product number takes on different barcodes: a GTIN-14 in a
// GS1 code is the EAN-13 on the shelf with a leading 0, or a UPC-A with two.
export function codeVariants(code) {
  const c = String(code || "").trim(),
    v = new Set([c]);
  if (/^\d{14}$/.test(c)) {
    if (c[0] == "0") v.add(c.slice(1));
    if (c.startsWith("00")) v.add(c.slice(2));
  }
  if (/^\d{13}$/.test(c)) v.add("0" + c);
  if (/^\d{12}$/.test(c)) v.add("00" + c);
  return [...v];
}

// Find the product a scanned code belongs to, and any expiry it carries.
// packs: a product's bigger units ("Carton" = 24); a carton's own barcode
// finds the product with `pack` set.
export function lookupCode(items, raw, packs = []) {
  const code = String(raw || "").trim(),
    gs1 = parseGS1(code),
    keys = codeVariants(gs1 ? gs1.gtin : code),
    lc = code.toLowerCase();
  let pack = null;
  let item =
    items.find((i) => i.barcode && keys.includes(String(i.barcode).trim())) ||
    items.find((i) => i.sku.toLowerCase() == lc);
  if (!item) {
    pack = packs.find((p) => p.barcode && keys.includes(String(p.barcode).trim())) || null;
    item = pack ? items.find((i) => i.id == pack.item_id) : undefined;
    if (!item) pack = null;
  }
  return { item, pack, code: gs1 ? gs1.gtin : code, expiry: gs1?.expiry || null, batch: gs1?.batch || null };
}
