// What a sale, a void, a stock change or a write-off does to a shop's data,
// worked out in the browser. Two users:
//   - local.js, the demo backend, which has no server at all;
//   - remote.js, which shows work done offline (still queued) on top of the
//     last copy from the server, until the server has it.
// It mirrors the database functions in supabase/migrations, so the screen
// shows what the server will end up with.
//
// db: { items, lots, movements, sales, sale_lines, orders, settings }, where
// settings maps shop id → { auto_reorder, ... }. Lists are changed in place.
// ctx: { shopId, userId, at (ISO time it happened), short (may go below zero) }
import { err } from "../i18n/index.js";
import { today } from "../lib/expiry.js";

const uid = () => crypto.randomUUID();
const fail = (code, params) => {
  throw err(code, params);
};
const drop = (list, gone) => {
  for (let i = list.length; i--; ) if (gone(list[i])) list.splice(i, 1);
};
const at = (ctx) => ctx.at || new Date().toISOString();

// Same rule as create_sale(): the wholesale price from the wholesale quantity.
export function linePrice(it, qty) {
  const ws = +it.price_wholesale > 0 && +it.wholesale_min_qty > 0 && qty >= +it.wholesale_min_qty;
  return { price: ws ? +it.price_wholesale : +it.price, ws };
}

/** stock_move(): stock leaves from in-date lots soonest first, then undated
 * stock, then expired lots; each part is its own movement. */
export function stockMove(db, ctx, itemId, delta, note, expiry = null, saleId = null) {
  const it = db.items.find((i) => i.id == itemId && i.shop_id == ctx.shopId) || fail("err.itemNotFound");
  if (!delta) fail("err.zeroQty");
  const q = +it.qty + delta;
  if (q < 0 && delta < 0 && !ctx.short) fail("err.stock", { sku: it.sku, qty: +it.qty });
  const log = (type, qty, exp) =>
    db.movements.push({
      id: uid(),
      shop_id: it.shop_id,
      item_id: it.id,
      sku: it.sku,
      type,
      qty,
      note: note || "",
      expiry: exp || null,
      sale_id: saleId,
      created_at: at(ctx),
    });
  if (delta > 0) {
    // Lots never hold more than the stock: units that only fill a hole left
    // by offline sales below zero carry no date.
    const dated = Math.min(delta, Math.max(q, 0));
    if (expiry && dated > 0) {
      const lot = db.lots.find((l) => l.item_id == it.id && l.expiry == expiry);
      if (lot) lot.qty = +lot.qty + dated;
      else db.lots.push({ id: uid(), shop_id: it.shop_id, item_id: it.id, expiry, qty: dated, created_at: at(ctx) });
    }
    log("in", delta, expiry);
  } else {
    let left = -delta;
    const lots = db.lots.filter((l) => l.item_id == it.id).sort((a, b) => (a.expiry < b.expiry ? -1 : 1)),
      free = Math.max(+it.qty - lots.reduce((a, l) => a + +l.qty, 0), 0),
      now = today();
    const take = (lot) => {
      const n = Math.min(+lot.qty, left);
      if (!n) return;
      lot.qty = +lot.qty - n;
      left -= n;
      log("out", n, lot.expiry);
    };
    lots.filter((l) => l.expiry >= now).forEach(take);
    if (left && free) {
      const n = Math.min(free, left);
      left -= n;
      log("out", n, null);
    }
    lots.filter((l) => l.expiry < now).forEach(take);
    if (left) log("out", left, null);
    drop(db.lots, (l) => l.qty <= 0);
  }
  it.qty = q;
  it.updated_at = new Date().toISOString();
  autoReorder(db, it);
  return q;
}

function autoReorder(db, it) {
  if (
    db.settings[it.shop_id]?.auto_reorder &&
    +it.qty < +it.min_qty &&
    !db.orders.some((o) => o.item_id == it.id && o.type == "in" && o.status == "pending")
  )
    db.orders.push({
      id: uid(),
      shop_id: it.shop_id,
      item_id: it.id,
      type: "in",
      qty: it.min_qty * 2 - it.qty,
      party: "Auto-reorder",
      status: "pending",
      auto: true,
      created_at: new Date().toISOString(),
    });
}

/** create_sale(). lines: [{ item_id, qty, price? }]; a line's price is used
 * only when ctx.short is set (an offline sale keeps the price it was sold at).
 * Returns the new sale, or the existing one with the same client_id. */
export function sale(
  db,
  ctx,
  { id = uid(), client_id, lines, discount = 0, method = "cash", paid = 0, receipt_no = null, till = null, till_no = null },
) {
  const dup = db.sales.find((x) => x.shop_id == ctx.shopId && x.client_id == client_id);
  if (dup) return dup;
  if (!["cash", "transfer"].includes(method)) fail("err.payMethod");
  if (!lines?.length) fail("err.emptySale");
  const s = {
    id,
    shop_id: ctx.shopId,
    client_id,
    receipt_no,
    till,
    till_no,
    method,
    status: "paid",
    flags: [],
    cashier: ctx.userId ?? null,
    created_at: at(ctx),
  };
  const merged = new Map();
  for (const l of lines) {
    if (!(+l.qty > 0)) fail("err.qtyPositive");
    const m = merged.get(l.item_id) || { qty: 0, price: null };
    m.qty += +l.qty;
    if (l.price != null) m.price = +l.price;
    merged.set(l.item_id, m);
  }
  let sub = 0;
  for (const [item_id, { qty, price: sold }] of [...merged].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const it = db.items.find((i) => i.id == item_id && i.shop_id == ctx.shopId) || fail("err.itemNotFound");
    let { price, ws } = linePrice(it, qty);
    if (ctx.short && sold != null) price = sold;
    else if (!(price > 0)) fail("err.noPrice", { sku: it.sku });
    stockMove(db, ctx, item_id, -qty, "sale", null, s.id);
    db.sale_lines.push({
      id: uid(),
      shop_id: ctx.shopId,
      sale_id: s.id,
      item_id,
      sku: it.sku,
      name: it.name,
      qty,
      unit_price: price,
      wholesale: ws,
      line_total: qty * price,
      created_at: s.created_at,
    });
    sub += qty * price;
  }
  discount = +discount || 0;
  if (discount < 0 || discount > sub) fail("err.discount");
  const total = sub - discount;
  paid = method == "cash" ? +paid || 0 : total;
  if (paid < total) fail("err.cashShort");
  Object.assign(s, { subtotal: sub, discount, total, paid, change_due: paid - total });
  db.sales.push(s);
  return s;
}

/** void_sale(): every unit goes back into the lot it left. Voiding a void sale
 * does nothing (a resent void must not fail). */
export function voidSale(db, ctx, s) {
  if (s.status == "void") return;
  const back = new Map();
  for (const m of db.movements)
    if (m.sale_id == s.id && m.type == "out" && m.item_id) {
      const k = m.item_id + "|" + (m.expiry || "");
      back.set(k, (back.get(k) || 0) + +m.qty);
    }
  for (const [k, qty] of back) {
    const [item, exp] = k.split("|");
    stockMove(db, { ...ctx, short: true }, item, qty, "void", exp || null, s.id);
  }
  s.status = "void";
  s.voided_at = at(ctx);
}

/** write_off_expiry(): what is left of one expiry date, up to qty. */
export function writeOff(db, ctx, itemId, expiry, qty, note = "expired") {
  const it = db.items.find((i) => i.id == itemId && i.shop_id == ctx.shopId) || fail("err.itemNotFound"),
    lot = db.lots.find((l) => l.item_id == itemId && l.expiry == expiry);
  if (!lot) return +it.qty;
  const n = Math.min(+lot.qty, qty ?? +lot.qty);
  if (!(n > 0)) return +it.qty;
  lot.qty = +lot.qty - n;
  drop(db.lots, (l) => l.qty <= 0);
  it.qty = +it.qty - n;
  it.updated_at = new Date().toISOString();
  db.movements.push({
    id: uid(),
    shop_id: it.shop_id,
    item_id: it.id,
    sku: it.sku,
    type: "out",
    qty: n,
    note,
    expiry,
    sale_id: null,
    created_at: at(ctx),
  });
  autoReorder(db, it);
  return it.qty;
}

/** The number printed on a receipt: the till's own (A-0042) when it has one. */
export const saleNo = (s) =>
  s.till ? `${s.till}-${String(s.till_no).padStart(4, "0")}` : s.receipt_no != null ? String(s.receipt_no) : "…";
