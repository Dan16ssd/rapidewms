import { E, dt, num } from "../lib/util.js";
import { isOwner } from "../data/store.js";

export default function ord(s) {
  const sku = (id) => s.items.find((i) => i.id == id)?.sku ?? "(deleted)";
  const list = s.orders.length
    ? s.orders
        .map(
          (o) =>
            `<tr><td>${dt(o.created_at)}</td><td><span class="tag ${o.type == "in" ? "in" : "out"}">${o.type == "in" ? "Inbound" : "Outbound"}</span></td><td>${E(sku(o.item_id))}</td><td>${num(o.qty)}</td><td>${E(o.party)}</td><td>${o.status == "done" ? "Done" : "Pending"}</td><td>${
              o.status == "pending"
                ? `<button class="g" data-act="doneOrder" data-id="${E(o.id)}">✔ Complete</button> `
                : ""
            }${isOwner() ? `<button class="g" data-act="delOrder" data-id="${E(o.id)}" title="Delete">🗑</button>` : ""}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="7" class="mut">No orders yet.</td></tr>`;
  return `<div class="card"><div class="row"><select id="o_t"><option value="in">Inbound (receive shipment)</option><option value="out">Outbound (ship order)</option></select><select id="o_s">${
    s.items.length
      ? s.items.map((i) => `<option value="${E(i.id)}">${E(i.sku)} – ${E(i.name)}</option>`).join("")
      : `<option value="">Add a product first</option>`
  }</select><input id="o_q" type="number" min="1" placeholder="Quantity"><input id="o_p" placeholder="Supplier / Customer"><button class="b" data-act="addOrder">Create order</button></div></div><div class="card ts"><table class="rt"><thead><tr><th>DATE</th><th>TYPE</th><th>SKU</th><th>QTY</th><th>PARTY</th><th>STATUS</th><th></th></tr></thead><tbody>${list}</tbody></table></div>`;
}
