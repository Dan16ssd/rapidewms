import { E } from "../lib/util.js";

const CUR = ["LAK", "THB", "USD", "CNY"];
export const R = { USD: 1, LAK: 21700, THB: 35, CNY: 7.1 };
try {
  Object.assign(R, JSON.parse(localStorage.rates));
} catch {}

const opts = (sel) => CUR.map((c) => `<option ${c == sel ? "selected" : ""}>${c}</option>`).join("");

export function conv() {
  const a = +document.querySelector("#c_a").value || 0,
    f = document.querySelector("#c_f").value,
    t = document.querySelector("#c_t").value;
  document.querySelector("#c_r").textContent =
    `${a.toLocaleString()} ${f} = ${((a / R[f]) * R[t]).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${t}`;
}

export async function refreshRates() {
  const m = (t) => {
    const e = document.querySelector("#c_m");
    if (e) e.textContent = t;
  };
  try {
    const j = await (await fetch("https://open.er-api.com/v6/latest/USD")).json();
    ["LAK", "THB", "CNY"].forEach((c) => (R[c] = j.rates[c]));
    localStorage.rates = JSON.stringify(R);
    m("Live rates updated " + new Date().toLocaleString());
    if (document.querySelector("#c_r")) conv();
  } catch {
    m("Offline – using last saved rates");
  }
}

export default function rep(s) {
  const val = s.items.reduce((a, i) => a + i.qty * i.cost, 0);
  return `<div class="card"><h3>Export your data</h3>${["Inventory", "Orders", "Movements"]
    .map(
      (k) =>
        `<div class="row mt"><b style="flex:1 1 120px">${k}</b>${["pdf", "xlsx", "csv"]
          .map(
            (f) =>
              `<button class="g" data-act="export" data-set="${k}" data-fmt="${f}">${{ pdf: "PDF", xlsx: "Excel", csv: "CSV" }[f]}</button>`,
          )
          .join("")}</div>`,
    )
    .join("")}<p class="mut mt">Movements export covers the last 30 days.</p></div>
<div class="card"><h3>Currency converter</h3><div class="row mt"><input id="c_a" type="number" value="1" data-input="conv"><select id="c_f" data-input="conv">${opts("LAK")}</select><select id="c_t" data-input="conv">${opts("USD")}</select></div><h2 id="c_r" class="mt"></h2><p class="mut mt">Stock value: ${E(
    CUR.map((c) => c + " " + Math.round((val / R.LAK) * R[c]).toLocaleString()).join(" · "),
  )}</p><button class="g mt" data-act="rates">↻ Refresh live rates</button> <span class="mut" id="c_m"></span></div>`;
}
