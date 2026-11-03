// Guards the Lao version against drift. Three checks:
//   1. every t()/tn() key used in the code exists in en.js
//   2. every en.js key is translated in lo.js, and none is unused
//   3. no visible text is hardcoded in template-literal markup
// Check 3 is a heuristic: it only looks at text between > and < after stripping
// ${...} expressions, which is where user-visible strings actually live.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import en from "../src/i18n/en.js";
import lo from "../src/i18n/lo.js";

const SRC = new URL("../src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SKIP = /[\\/]i18n[\\/]/;
// Format names, brand words and symbols that stay the same in every language.
const OK_TEXT = /^(PDF|Excel|CSV|LAK|THB|USD|CNY|SKU|QR|RAPIDÉ|WMS|ZIP|Supabase)$/i;

const files = [];
(function walk(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".js") && !SKIP.test(p)) files.push(p);
  }
})(SRC);

const problems = [];
const calls = new Set(); // keys passed to t/tn/err/fail — must exist in en.js
const seen = new Set(); // every key-shaped literal — proves a key is still referenced
const parts = []; // "prefix." or ".suffix" used in concatenated keys

const KEY = /^\w+(?:\.\w+)+$/;

for (const f of files) {
  const src = readFileSync(f, "utf8"),
    rel = f.slice(SRC.length - 4).replace(/\\/g, "/");

  // 1. keys in a call position
  // (a trailing "." means it is a concatenated prefix, handled below)
  for (const m of src.matchAll(/\b(t|err|fail)\(\s*["'`]([\w.]+)["'`]/g))
    if (!m[2].endsWith(".")) calls.add(m[2]);
  for (const m of src.matchAll(/\btn\(\s*["'`]([\w.]+)["'`]/g)) {
    calls.add(m[1]);
    calls.add(m[1] + "1"); // tn() picks key or key+"1"
  }
  // 2. any key-shaped literal counts as a reference (arrays, ternaries, variables)
  for (const m of src.matchAll(/["']([\w.]+)["']/g)) if (KEY.test(m[1])) seen.add(m[1]);
  // Keys built by concatenation: "nav." + k, or k + ".sub"
  for (const m of src.matchAll(/["'`](\w[\w.]*\.)["'`]\s*\+/g)) parts.push((k) => k.startsWith(m[1]));
  for (const m of src.matchAll(/\+\s*["'`](\.[\w.]+)["'`]/g)) parts.push((k) => k.endsWith(m[1]));

  // 3. hardcoded text inside template literals
  const line = (i) => src.slice(0, i).split("\n").length;
  for (const lit of src.matchAll(/`(?:[^`\\]|\\.)*`/gs)) {
    const body = lit[0].replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, "\u0000");
    for (const seg of body.matchAll(/>([^<>]+)</g)) {
      const txt = seg[1].replace(/\u0000/g, " ").replace(/&[a-z]+;/g, " ").trim();
      if (!/[A-Za-z]{3,}[^<]*\s+[A-Za-z]{3,}/.test(txt)) continue;
      if (txt.split(/\s+/).every((w) => OK_TEXT.test(w) || !/[A-Za-z]{3}/.test(w))) continue;
      problems.push(`${rel}:${line(lit.index)} hardcoded text: ${JSON.stringify(txt.slice(0, 60))}`);
    }
  }
}

// Static markup is translated through data-i18n attributes in the shell.
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
for (const m of html.matchAll(/data-i18n(?:-ph|-title)?="([\w.]+)"/g)) calls.add(m[1]);

const covered = (k) => calls.has(k) || seen.has(k) || parts.some((fn) => fn(k));

for (const k of calls) if (!(k in en)) problems.push(`missing in en.js: ${k}`);
for (const k of Object.keys(en)) {
  if (!(k in lo)) problems.push(`not translated in lo.js: ${k}`);
  if (!covered(k)) problems.push(`unused key: ${k}`);
}
for (const k of Object.keys(lo)) if (!(k in en)) problems.push(`in lo.js but not en.js: ${k}`);

if (problems.length) {
  console.error(problems.map((p) => "  " + p).join("\n"));
  console.error(`\n${problems.length} i18n problem(s)`);
  process.exit(1);
}
console.log(`i18n OK — ${Object.keys(en).length} keys, ${files.length} files checked`);
