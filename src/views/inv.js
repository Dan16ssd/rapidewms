import { E, fmt, num } from "../lib/util.js";
import { isOwner } from "../data/store.js";

export const ui = { q: "" };

export function rows(s) {
  const q = ui.q.toLowerCase(),
    L = s.items.filter((i) =>
      [i.sku, i.name, i.category, i.barcode].join(" ").toLowerCase().includes(q),
    );
  if (!L.length)
    return `<tr><td colspan="8" class="mut">${
      s.items.length ? "No products match your search." : "No products yet. Tap “Add product” to add your first one."
    }</td></tr>`;
  return L.map((i) => {
    const low = +i.qty < +i.min_qty,
      id = E(i.id);
    return `<tr><td><b>${E(i.sku)}</b></td><td>${E(i.name)}</td><td>${E(i.category)}</td><td class="${low ? "warn" : ""}">${num(i.qty)}${low ? " ⚠" : ""}</td><td>${num(i.min_qty)}</td><td>${fmt(i.cost)}</td><td>${fmt(i.qty * i.cost)}</td><td><button class="g" data-act="adj" data-id="${id}" data-dir="1" title="Add stock">＋</button> <button class="g" data-act="adj" data-id="${id}" data-dir="-1" title="Remove stock">－</button> <button class="g" data-act="editItem" data-id="${id}" title="Edit">✎</button>${
      isOwner() ? ` <button class="g" data-act="delItem" data-id="${id}" title="Delete">🗑</button>` : ""
    }</td></tr>`;
  }).join("");
}

export default function inv(s) {
  return `<div class="card"><input id="q" placeholder="Search SKU, name, category, barcode…" value="${E(ui.q)}" data-input="search"></div><div class="card ts"><table class="rt"><thead><tr><th>SKU</th><th>NAME</th><th>CATEGORY</th><th>QTY</th><th>MIN</th><th>UNIT COST</th><th>VALUE</th><th></th></tr></thead><tbody id="tb">${rows(s)}</tbody></table></div>`;
}
