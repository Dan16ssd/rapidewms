import { t, locale, fDateTime, fDateLong } from "../i18n/index.js";
import { parseTyped, daysLeft, status, SOON_DAYS } from "./expiry.js";

// HTML-escape any value before putting it into markup or an attribute.
export const E = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");

export const $ = (s) => document.querySelector(s);

// Kip has no practical subunit, so whole amounts show no decimals.
export const fmt = (n) =>
  "₭" +
  (+n || 0).toLocaleString(locale(), {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

export const dt = (t) => (t ? fDateTime(t) : "");

export const num = (n) => (+n || 0).toLocaleString(locale());

let toastTimer;
export function toast(msg, bad) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "show" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), bad ? 5000 : 2500);
}

// Promise-based modal form. fields: [{k, label, type, value, ...}]
//   type     text | number | select (with options: [[value, label]]) | expiry
//   expiry   a text box that takes typed shortcuts (1227, 311227, 31/12/27),
//            shows the date it understood, and refuses one it can't read
//   tools    [{ act, label }]: buttons beside the field, run through the
//            page's data-act handlers with data-for naming the field
//   showIf   [otherField, value]: only shown while that field has that value
//   hint     small text under the field
export function form(title, fields, okLabel = t("btn.save"), note = "") {
  const dlg = $("#dlg");
  const input = (f) => {
    if (f.type == "select")
      return `<select name="${E(f.k)}">${f.options
        .map(([v, l]) => `<option value="${E(v)}"${v == f.value ? " selected" : ""}>${E(l)}</option>`)
        .join("")}</select>`;
    const type = f.type == "expiry" ? "text" : f.type || "text";
    return `<input name="${E(f.k)}" type="${type}" value="${E(f.value ?? "")}"${
      f.type == "number" ? ' step="any" min="0"' : ""
    }${f.type == "expiry" ? ` data-expiry autocomplete="off" inputmode="numeric" placeholder="${E(t("f.expiryPh"))}"` : ""}${
      f.required ? " required" : ""
    }>`;
  };
  dlg.innerHTML = `<form method="dialog"><h3>${E(title)}</h3>${note ? `<p class="mut">${note}</p>` : ""}<div class="mt">${fields
    .map(
      (f) =>
        `<label data-field="${E(f.k)}"${f.showIf ? ` data-show-if="${E(f.showIf.join("="))}"` : ""}>${E(f.label)}${
          f.tools
            ? `<span class="tools">${input(f)}${f.tools
                .map((b) => `<button type="button" class="g" data-act="${E(b.act)}" data-for="${E(f.k)}">${E(b.label)}</button>`)
                .join("")}</span>`
            : input(f)
        }${f.type == "expiry" ? `<small class="said"></small>` : ""}${f.hint ? `<small class="mut">${E(f.hint)}</small>` : ""}</label>`,
    )
    .join("")}</div><div class="row"><button class="b" value="ok">${E(okLabel)}</button><button class="g" value="cancel" formnovalidate>${E(t("btn.cancel"))}</button></div></form>`;
  const fm = dlg.querySelector("form");
  // Fields that only apply to some products (an expiry date to consumables).
  const sync = () =>
    fm.querySelectorAll("[data-show-if]").forEach((l) => {
      const [k, v] = l.dataset.showIf.split("=");
      l.hidden = fm.elements[k]?.value != v;
    });
  fm.addEventListener("change", sync);
  sync();
  fm.querySelectorAll("[data-expiry]").forEach((el) => {
    el.addEventListener("input", () => checkExpiry(el));
    checkExpiry(el);
  });
  dlg.showModal();
  dlg.querySelector("input,select")?.focus();
  return new Promise((res) =>
    dlg.addEventListener(
      "close",
      () => {
        if (dlg.returnValue != "ok") return res(null);
        const out = Object.fromEntries(new FormData(fm));
        // Expiry boxes hand back the date they understood, not what was typed.
        fm.querySelectorAll("[data-expiry]").forEach((el) => {
          out[el.name] = el.closest("label").hidden ? "" : parseTyped(el.value) || "";
        });
        res(out);
      },
      { once: true },
    ),
  );
}

// Show the date an expiry box understood, and stop the form saving a typo.
export function checkExpiry(el) {
  const said = el.closest("label")?.querySelector(".said"),
    v = el.value.trim(),
    d = v && parseTyped(v);
  el.setCustomValidity(v && !d ? t("err.badDate") : "");
  if (said) {
    said.textContent = d ? "→ " + dateText(d) + expiryNote(d) : v ? t("err.badDate") : "";
    said.className = "said " + (d ? (status(d) == "ok" ? "in" : "warn") : v ? "err" : "");
  }
}

export const dateText = (iso) =>
  iso ? fDateLong(iso + "T00:00:00") : "";

// "(expired 3 days ago)" / "(in 12 days)" beside a date that needs attention.
export function expiryNote(iso) {
  const d = daysLeft(iso);
  if (d < 0) return " · " + t("exp.agoN", { n: -d });
  if (d <= SOON_DAYS) return " · " + (d == 0 ? t("exp.today") : t("exp.inN", { n: d }));
  return "";
}

// Ask for a photo: the camera app on a phone, a file picker on a computer.
export function pickPhoto() {
  return new Promise((res) => {
    const i = document.createElement("input");
    i.type = "file";
    i.accept = "image/*";
    i.capture = "environment";
    // In the page (inside the open dialog, which makes everything else inert):
    // older iPhone Safari does not open a picker that is not in the document.
    i.hidden = true;
    (document.querySelector("dialog[open]") || document.body).append(i);
    const done = (f) => (i.remove(), res(f));
    i.onchange = () => done(i.files[0] || null);
    i.addEventListener("cancel", () => done(null));
    i.click();
  });
}

export function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
