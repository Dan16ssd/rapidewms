import { E, fmt, num, dateText, expiryNote } from "../lib/util.js";
import { t } from "../i18n/index.js";
import { isOwner } from "../data/store.js";
import { status } from "../lib/expiry.js";
import { SIGN } from "../lib/rates.js";

// q: search text. f: all | consumable | durable | soon | expired. s: sort order (SORTS)
export const ui = { q: "", f: "all", s: "name" };

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
  sortBy(L, next);
  if (!L.length)
    return `<tr><td colspan="9" class="mut">${t(s.items.length ? "inv.noMatch" : "inv.none")}</td></tr>`;
  const l = COLS.map((k) => E(t(k)));
  return L.map((i) => {
    const low = +i.qty < +i.min_qty,
      id = E(i.id),
      e = next.get(i.id),
      td = (j, v, cls) => `<td data-l="${l[j]}"${cls ? ` class="${cls}"` : ""}>${v}</td>`,
      kind = i.kind == "consumable" ? "consumable" : "durable";
    // Its packs ("Carton × 24 · ₭210,000"); the owner taps one to change it.
    const packs = s.packs
      .filter((p) => p.item_id == i.id)
      .map(
        (p) =>
          `<${isOwner() ? `button class="tag pk" data-act="editPack" data-item="${id}" data-id="${E(p.id)}"` : 'span class="tag"'}>${E(
            p.name,
          )} × ${num(p.size)} · ${fmt(p.price)}</${isOwner() ? "button" : "span"}>`,
      )
      .join(" ");
    const name = `${E(i.name)} <span class="tag ${kind}">${t("kind." + kind)}</span>${packs ? "<br>" + packs : ""}${
      e
        ? `<br><small class="${status(e) == "ok" ? "mut" : "warn"}">${t("exp.short")} ${dateText(e)}${expiryNote(e)}</small>`
        : ""
    }`;
    const cost =
      fmt(i.cost) +
      (i.cost_currency && i.cost_currency != "LAK" ? `<br><small class="mut">${SIGN[i.cost_currency]}${num(i.cost_orig)}</small>` : "");
    return `<tr>${td(0, `<b>${E(i.sku)}</b>`)}${td(1, name, "nm")}${td(2, E(i.category))}${td(
      3,
      num(i.qty) + (i.unit ? " " + E(i.unit) : "") + (low ? " ⚠" : ""),
      low ? "warn" : "",
    )}${td(4, num(i.min_qty))}${td(5, cost)}${td(6, fmt(i.price))}${td(
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
    }${
      isOwner() ? ` <button class="g" data-act="addPack" data-id="${id}" title="${E(t("tip.addPack"))}">📦</button>` : ""
    }</td></tr>`;
  }).join("");
}

const FILTERS = ["all", "consumable", "durable", "soon", "expired"];
const SORTS = ["name", "sku", "expiry", "recent", "qty", "low"];

// Products with no date go last when sorting by expiry; ties keep name order.
function sortBy(L, next) {
  const byName = (a, b) => a.name.localeCompare(b.name),
    far = "9999-12-31",
    by = {
      name: byName,
      sku: (a, b) => a.sku.localeCompare(b.sku, undefined, { numeric: true }),
      expiry: (a, b) => (next.get(a.id) || far).localeCompare(next.get(b.id) || far) || byName(a, b),
      recent: (a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")) || byName(a, b),
      qty: (a, b) => a.qty - b.qty || byName(a, b),
      low: (a, b) => a.qty - a.min_qty - (b.qty - b.min_qty) || byName(a, b),
    }[ui.s];
  if (by) L.sort(by);
}

export default function inv(s) {
  return `<div class="card"><div class="row"><input id="q" placeholder="${E(t("inv.search"))}" value="${E(
    ui.q,
  )}" data-input="search"><select data-input="invFilter">${FILTERS.map(
    (f) => `<option value="${f}"${f == ui.f ? " selected" : ""}>${t("inv.f." + f)}</option>`,
  ).join("")}</select><select data-input="invSort" aria-label="${E(t("inv.sortBy"))}">${SORTS.map(
    (k) => `<option value="${k}"${k == ui.s ? " selected" : ""}>${t("inv.s." + k)}</option>`,
  ).join("")}</select></div></div><div class="card ts"><table class="rt"><thead><tr>${COLS.map(
    (k) => `<th>${t(k)}</th>`,
  ).join("")}<th></th></tr></thead><tbody id="tb">${rows(s)}</tbody></table></div>`;
}
