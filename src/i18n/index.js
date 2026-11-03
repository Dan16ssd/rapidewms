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

document.documentElement.lang = cur;
