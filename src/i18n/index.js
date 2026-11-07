// Tiny translation layer. Lao first for Lao browsers, English otherwise.
import en from "./en.js";
import lo from "./lo.js";

const DICT = { en, lo };
export const LANGS = [
  ["lo", "ລາວ"],
  ["en", "English"],
];

function pick() {
  try {
    if (DICT[localStorage.lang]) return localStorage.lang;
  } catch {}
  return String(navigator.language || "").toLowerCase().startsWith("lo") ? "lo" : "en";
}

let cur = pick();

export const lang = () => cur;

// Western digits in both languages: Lao shops write prices with 0-9.
export const locale = () => (cur == "lo" ? "lo-LA-u-nu-latn" : "en");

// Dates and times. Chrome and Edge ship no Lao date data ("lo" silently falls
// back to US English: "Nov 7, 2026, 3:30 PM"), so Lao is formatted here, from
// the CLDR month abbreviations, day first and on a 24-hour clock.
const LO_MONTHS = ["ມ.ກ.", "ກ.ພ.", "ມ.ນ.", "ມ.ສ.", "ພ.ພ.", "ມິ.ຖ.", "ກ.ລ.", "ສ.ຫ.", "ກ.ຍ.", "ຕ.ລ.", "ພ.ຈ.", "ທ.ວ."];
const p2 = (n) => String(n).padStart(2, "0");
const D = (x) => (x instanceof Date ? x : new Date(x));
/** 7/11/2026 */
export const fDate = (x) => {
  const d = D(x);
  return cur == "lo" ? `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}` : d.toLocaleDateString("en");
};
/** 7 ພ.ຈ. 2026 / Nov 7, 2026 */
export const fDateLong = (x) => {
  const d = D(x);
  return cur == "lo"
    ? `${d.getDate()} ${LO_MONTHS[d.getMonth()]} ${d.getFullYear()}`
    : d.toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" });
};
/** 15:30:47 / 3:30:47 PM */
export const fTime = (x, seconds = true) => {
  const d = D(x);
  return cur == "lo"
    ? `${p2(d.getHours())}:${p2(d.getMinutes())}${seconds ? ":" + p2(d.getSeconds()) : ""}`
    : d.toLocaleTimeString("en", seconds ? {} : { hour: "numeric", minute: "2-digit" });
};
export const fDateTime = (x) => `${fDate(x)} ${fTime(x)}`;

export function setLang(l) {
  if (!DICT[l]) return;
  cur = l;
  try {
    localStorage.lang = l;
  } catch {}
  document.documentElement.lang = l;
}

export const other = () => (cur == "lo" ? "en" : "lo");

/** Look up a key and fill {placeholders}. Falls back to English, then the key. */
export function t(key, vars) {
  let s = DICT[cur][key] ?? en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : vars[k]));
  return s;
}

/** Singular/plural: uses `key + "1"` when n is 1. Lao has one form, so both match. */
export const tn = (key, n, vars) => t(n == 1 ? key + "1" : key, { ...vars, n });

/** An error carrying a translation key, so it can be shown in the current language. */
export function err(code, params) {
  const e = new Error(t(code, params));
  e.code = code;
  e.params = params;
  return e;
}

/** Message for any thrown value, translated when it carries a code. */
export const errText = (e) => (e && e.code ? t(e.code, e.params) : (e && e.message) || String(e));

/** Translate static markup: data-i18n (text), -ph (placeholder), -title. */
export function applyStatic(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  root.querySelectorAll("[data-i18n-ph]").forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
  root.querySelectorAll("[data-i18n-title]").forEach((el) => (el.title = t(el.dataset.i18nTitle)));
}

// (No document when the unit tests import this in Node.)
if (typeof document != "undefined") document.documentElement.lang = cur;
