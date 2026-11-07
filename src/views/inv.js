import { E, fmt, num, dateText, expiryNote } from "../lib/util.js";
import { t } from "../i18n/index.js";
import { isOwner } from "../data/store.js";
import { status } from "../lib/expiry.js";

// q: search text. f: all | consumable | durable | soon | expired
export const ui = { q: "", f: "all" };

// Column order, shared by the header and the per-cell mobile labels
// (styles.css shows `data-l` instead of the hidden header on narrow screens).
const COLS = ["th.sku", "th.name", "th.category", "th.qty", "th.min", "th.cost", "th.price", "th.value"];

// The soonest expiry per product (lots arrive sorted by date).
const firstExpiry = (s) => {
  const m = new Map();
  for (const l of s.lots) if (!m.has(l.item_id)) m.set(l.item_id, l.expiry);
  return m;
};

export function rows(s) {
  const q = ui.q.toLowerCase(),
    next = firstExpiry(s),
    pass = (i) => {
      const e = next.get(i.id);
      switch (ui.f) {
        case "consumable":
        case "durable":
          return (i.kind || "durable") == ui.f;
        case "soon":
          return e && status(e) == "soon";
        case "expired":
          return e && status(e) == "expired";
      }
      return true;
    },
    L = s.items.filter(
      (i) => pass(i) && [i.sku, i.name, i.category, i.barcode].join(" ").toLowerCase().includes(q),
    );
  if (!L.length)
    return `<tr><td colspan="9" class="mut">${t(s.items.length ? "inv.noMatch" : "inv.none")}</td></tr>`;
  const l = COLS.map((k) => E(t(k)));
  return L.map((i) => {
    const low = +i.qty < +i.min_qty,
      id = E(i.id),
      e = next.get(i.id),
      td = (j, v, cls) => `<td data-l="${l[j]}"${cls ? ` class="${cls}"` : ""}>${v}</td>`,
      kind = i.kind == "consumable" ? "consumable" : "durable";
    const name = `${E(i.name)} <span class="tag ${kind}">${t("kind." + kind)}</span>${
      e
        ? `<br><small class="${status(e) == "ok" ? "mut" : "warn"}">${t("exp.short")} ${dateText(e)}${expiryNote(e)}</small>`
        : ""
    }`;
    return `<tr>${td(0, `<b>${E(i.sku)}</b>`)}${td(1, name, "nm")}${td(2, E(i.category))}${td(
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

const FILTERS = ["all", "consumable", "durable", "soon", "expired"];

export default function inv(s) {
  return `<div class="card"><div class="row"><input id="q" placeholder="${E(t("inv.search"))}" value="${E(
    ui.q,
  )}" data-input="search"><select data-input="invFilter">${FILTERS.map(
    (f) => `<option value="${f}"${f == ui.f ? " selected" : ""}>${t("inv.f." + f)}</option>`,
  ).join("")}</select></div></div><div class="card ts"><table class="rt"><thead><tr>${COLS.map(
    (k) => `<th>${t(k)}</th>`,
  ).join("")}<th></th></tr></thead><tbody id="tb">${rows(s)}</tbody></table></div>`;
}
