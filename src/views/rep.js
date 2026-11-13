import { E } from "../lib/util.js";
import { t, locale, fDateTime } from "../i18n/index.js";
import { SETS } from "../lib/export.js";

import { CUR, kipPer, fetchRates } from "../lib/rates.js";

const opts = (sel) => CUR.map((c) => `<option ${c == sel ? "selected" : ""}>${c}</option>`).join("");

export function conv() {
  const a = +document.querySelector("#c_a").value || 0,
    f = document.querySelector("#c_f").value,
    tc = document.querySelector("#c_t").value,
    v = (a * kipPer(f)) / kipPer(tc);
  // One kip is a few hundred-thousandths of a dollar, so two decimal places
  // would print the default view of this converter as "1 LAK = 0 USD" and look
  // broken. Below one unit, show significant digits instead.
  const digits = v && Math.abs(v) < 1 ? { maximumSignificantDigits: 4 } : { maximumFractionDigits: 2 };
  document.querySelector("#c_r").textContent =
    `${a.toLocaleString(locale())} ${f} = ${v.toLocaleString(locale(), digits)} ${tc}`;
}

export async function refreshRates() {
  const m = (s) => {
    const e = document.querySelector("#c_m");
    if (e) e.textContent = s;
  };
  if (await fetchRates()) {
    m(t("rep.updated", { t: fDateTime(new Date()) }));
    if (document.querySelector("#c_r")) conv();
  } else m(t("rep.offlineRates"));
}

export default function rep(s) {
  // The set keys stay English: they index sets() in lib/export.js.
  const val = s.items.reduce((a, i) => a + i.qty * i.cost, 0);
  return `<div class="card"><h3>${t("rep.export")}</h3>${SETS
    .map(
      (k) =>
        `<div class="row mt"><b style="flex:1 1 120px">${t("rep.set." + k)}</b>${["pdf", "print", "xlsx", "csv"]
          .map(
            (f) =>
              `<button class="g" data-act="export" data-set="${k}" data-fmt="${f}">${{ pdf: "PDF", print: t("rep.print"), xlsx: "Excel", csv: "CSV" }[f]}</button>`,
          )
          .join("")}</div>`,
    )
    .join("")}<p class="mut mt">${t("rep.note")}</p></div>
<div class="card"><h3>${t(
    "rep.conv",
  )}</h3><div class="row mt"><input id="c_a" type="number" value="1" data-input="conv"><select id="c_f" data-input="conv">${opts(
    "LAK",
  )}</select><select id="c_t" data-input="conv">${opts(
    "USD",
  )}</select></div><h2 id="c_r" class="mt"></h2><p class="mut mt">${t("rep.stockValue", {
    v: E(CUR.map((c) => c + " " + Math.round(val / kipPer(c)).toLocaleString(locale())).join(" · ")),
  })}</p><button class="g mt" data-act="rates">${t(
    "rep.refresh",
  )}</button> <span class="mut" id="c_m"></span></div>`;
}
