import { E, fmt, num } from "../lib/util.js";
import { t } from "../i18n/index.js";
import { isOwner } from "../data/store.js";

export const ui = { q: "" };

// Column order, shared by the header and the per-cell mobile labels
// (styles.css shows `data-l` instead of the hidden header on narrow screens).
const COLS = ["th.sku", "th.name", "th.category", "th.qty", "th.min", "th.cost", "th.price", "th.value"];

export function rows(s) {
  const q = ui.q.toLowerCase(),
    L = s.items.filter((i) =>
      [i.sku, i.name, i.category, i.barcode].join(" ").toLowerCase().includes(q),
    );
  if (!L.length)
    return `<tr><td colspan="9" class="mut">${t(s.items.length ? "inv.noMatch" : "inv.none")}</td></tr>`;
  const l = COLS.map((k) => E(t(k)));
  return L.map((i) => {
    const low = +i.qty < +i.min_qty,
      id = E(i.id),
      td = (j, v, cls) => `<td data-l="${l[j]}"${cls ? ` class="${cls}"` : ""}>${v}</td>`;
    return `<tr>${td(0, `<b>${E(i.sku)}</b>`)}${td(1, E(i.name))}${td(2, E(i.category))}${td(
      3,
      num(i.qty) + (low ? " ⚠" : ""),
      low ? "warn" : "",
    )}${td(4, num(i.min_qty))}${td(5, fmt(i.cost))}${td(6, fmt(i.price))}${td(
      7,
      fmt(i.qty * i.cost),
    )}<td class="act"><button class="g" data-act="adj" data-id="${id}" data-dir="1" title="${E(
      t("tip.addStock"),
    )}">＋</button> <button class="g" data-act="adj" data-id="${id}" data-dir="-1" title="${E(
      t("tip.removeStock"),
    )}">－</button> <button class="g" data-act="editItem" data-id="${id}" title="${E(t("tip.edit"))}">✎</button>${
      isOwner()
        ? ` <button class="g" data-act="delItem" data-id="${id}" title="${E(t("tip.delete"))}">🗑</button>`
        : ""
    }</td></tr>`;
  }).join("");
}

export default function inv(s) {
  return `<div class="card"><input id="q" placeholder="${E(t("inv.search"))}" value="${E(
    ui.q,
  )}" data-input="search"></div><div class="card ts"><table class="rt"><thead><tr>${COLS.map(
    (k) => `<th>${t(k)}</th>`,
  ).join("")}<th></th></tr></thead><tbody id="tb">${rows(s)}</tbody></table></div>`;
}
