import { E, dt, num } from "../lib/util.js";
import { t } from "../i18n/index.js";
import { isOwner } from "../data/store.js";

const COLS = ["th.date", "th.type", "th.sku", "th.qty", "th.party", "th.status"];

export default function ord(s) {
  const sku = (id) => s.items.find((i) => i.id == id)?.sku ?? t("ord.deletedItem"),
    l = COLS.map((k) => E(t(k))),
    td = (j, v) => `<td data-l="${l[j]}">${v}</td>`;
  const list = s.orders.length
    ? s.orders
        .map(
          (o) =>
            `<tr>${td(0, dt(o.created_at))}${td(
              1,
              `<span class="tag ${o.type == "in" ? "in" : "out"}">${t(
                o.type == "in" ? "ord.inbound" : "ord.outbound",
              )}</span>`,
            )}${td(2, E(sku(o.item_id)))}${td(3, num(o.qty))}${td(4, E(o.party))}${td(
              5,
              t(o.status == "done" ? "ord.done" : "ord.pending"),
            )}<td class="act">${
              o.status == "pending"
                ? `<button class="g" data-act="doneOrder" data-id="${E(o.id)}">${t("ord.complete")}</button> `
                : ""
            }${
              isOwner()
                ? `<button class="g" data-act="delOrder" data-id="${E(o.id)}" title="${E(t("tip.delete"))}">🗑</button>`
                : ""
            }</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="7" class="mut">${t("ord.none")}</td></tr>`;
  return `<div class="card"><div class="row"><select id="o_t"><option value="in">${t(
    "ord.optIn",
  )}</option><option value="out">${t("ord.optOut")}</option></select><select id="o_s">${
    s.items.length
      ? s.items.map((i) => `<option value="${E(i.id)}">${E(i.sku)} – ${E(i.name)}</option>`).join("")
      : `<option value="">${t("ord.addFirst")}</option>`
  }</select><input id="o_q" type="number" min="1" placeholder="${E(t("ord.qty"))}"><input id="o_p" placeholder="${E(
    t("ord.party"),
  )}"><button class="b" data-act="addOrder">${t("ord.create")}</button></div></div><div class="card ts"><table class="rt"><thead><tr>${COLS.map(
    (k) => `<th>${t(k)}</th>`,
  ).join("")}<th></th></tr></thead><tbody>${list}</tbody></table></div>`;
}
