// Customers: who buys here, how often and how much (over all time, from
// customer_totals in 007). Added here or at the till; imported in Shop & backup.
import { E, fmt, num, dt } from "../lib/util.js";
import { t } from "../i18n/index.js";
import { isOwner } from "../data/store.js";

export const ui = { q: "" };

const COLS = ["cust.name", "cust.phone", "cust.visits", "cust.spent", "cust.last", "cust.note"];

export function rows(s) {
  const q = ui.q.trim().toLowerCase(),
    l = COLS.map((k) => E(t(k))),
    td = (j, v) => `<td data-l="${l[j]}">${v}</td>`,
    list = s.customers.filter(
      (c) => !q || c.name.toLowerCase().includes(q) || (c.phone || "").replace(/\s/g, "").includes(q.replace(/\s/g, "")),
    );
  if (!list.length) return `<tr><td colspan="7" class="mut">${t(s.customers.length ? "cust.noMatch" : "cust.none")}</td></tr>`;
  return list
    .map((c) => {
      const tot = s.custTotals[c.id];
      return `<tr>${td(0, `<b>${E(c.name)}</b>`)}${td(1, E(c.phone || ""))}${td(2, num(tot?.visits || 0))}${td(
        3,
        fmt(+tot?.total || 0),
      )}${td(4, tot?.last_at ? dt(tot.last_at) : "")}${td(5, `<small class="mut">${E(c.note || "")}</small>`)}<td class="act"><button class="g" data-act="editCust" data-id="${E(
        c.id,
      )}" title="${E(t("tip.edit"))}">✎</button>${
        isOwner() ? ` <button class="g" data-act="delCust" data-id="${E(c.id)}" title="${E(t("tip.delete"))}">🗑</button>` : ""
      }</td></tr>`;
    })
    .join("");
}

export default function cust(s) {
  return `<div class="card"><div class="row"><input id="cq" data-input="custQ" autocomplete="off" placeholder="${E(
    t("cust.search"),
  )}" value="${E(ui.q)}" style="flex:1 1 220px"><button class="b" data-act="addCust">${t("cust.add")}</button></div><p class="mut mt">${t(
    "cust.count",
    { n: num(s.customers.length) },
  )}</p></div><div class="card ts"><table class="rt"><thead><tr>${COLS.map((k) => `<th>${t(k)}</th>`).join(
    "",
  )}<th></th></tr></thead><tbody id="ctb">${rows(s)}</tbody></table></div>`;
}
