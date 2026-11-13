// What a sale, a void, a stock change or a write-off does to a shop's data,
// worked out in the browser. Two users:
//   - local.js, the demo backend, which has no server at all;
//   - remote.js, which shows work done offline (still queued) on top of the
//     last copy from the server, until the server has it.
// It mirrors the database functions in supabase/migrations, so the screen
// shows what the server will end up with.
//
// db: { items, packs, customers, lots, movements, sales, sale_lines, orders, settings }, where
// settings maps shop id → { auto_reorder, vat_rate, ... }. Lists are changed in place.
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

/** What one till line costs, the same way create_sale() prices it:
 * a pack at the pack's price (qty counts packs), a batch with an expiring
 * price at that price, otherwise the normal or wholesale price.
 * Returns { price (per unit sold), ws, pack, base (units leaving stock) }. */
export function priceOf(db, it, { qty, pack_id = null, expiry = null }) {
  if (pack_id) {
    const pack = (db.packs || []).find((p) => p.id == pack_id && p.item_id == it.id) || fail("err.packNotFound");
    return { price: +pack.price, ws: false, pack, base: qty * +pack.size };
  }
  const lot = expiry && db.lots.find((l) => l.item_id == it.id && l.expiry == expiry);
  if (lot && lot.price != null) return { price: +lot.price, ws: false, pack: null, base: qty };
  return { ...linePrice(it, qty), pack: null, base: qty };
}

/** The VAT inside a total, as create_sale() works it out (rate in %). */
export const vatOf = (total, rate) => (rate > 0 ? Math.round((total * rate * 100) / (100 + rate)) / 100 : 0);

/** stock_move(): stock leaves from in-date lots soonest first, then undated
 * stock, then expired lots; each part is its own movement. `first`: an
 * expiry date whose batch goes before all of that (an expiring-price sale). */
export function stockMove(db, ctx, itemId, delta, note, expiry = null, saleId = null, first = null) {
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
    if (first) lots.filter((l) => l.expiry == first).forEach(take);
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

/** create_sale(). lines: [{ item_id, qty, price?, pack_id?, expiry? }]; a line's
 * price is used only when ctx.short is set (an offline sale keeps the price it
 * was sold at). With pack_id, qty counts packs.
 * Returns the new sale, or the existing one with the same client_id. */
export function sale(
  db,
  ctx,
  {
    id = uid(),
    client_id,
    lines,
    discount = 0,
    method = "cash",
    paid = 0,
    receipt_no = null,
    till = null,
    till_no = null,
    customer_id = null,
  },
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
    // A customer that is gone (deleted while the sale waited) is dropped, as create_sale() does.
    customer_id:
      customer_id && (db.customers || []).some((c) => c.id == customer_id && c.shop_id == ctx.shopId) ? customer_id : null,
    created_at: at(ctx),
  };
  // One line per product, pack and batch (a batch only counts without a pack).
  const merged = new Map();
  for (const l of lines) {
    if (!(+l.qty > 0)) fail("err.qtyPositive");
    const pack_id = l.pack_id || null,
      expiry = pack_id ? null : l.expiry || null,
      k = [l.item_id, pack_id || "", expiry || ""].join("|");
    const m = merged.get(k) || { item_id: l.item_id, pack_id, expiry, qty: 0, price: null };
    m.qty += +l.qty;
    if (l.price != null) m.price = +l.price;
    merged.set(k, m);
  }
  let sub = 0;
  for (const [, { item_id, pack_id, expiry, qty, price: sold }] of [...merged].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const it = db.items.find((i) => i.id == item_id && i.shop_id == ctx.shopId) || fail("err.itemNotFound");
    let { price, ws, pack, base } = priceOf(db, it, { qty, pack_id, expiry });
    if (ctx.short && sold != null) price = sold;
    else if (!(price > 0)) fail("err.noPrice", { sku: it.sku });
    stockMove(db, ctx, item_id, -base, "sale", null, s.id, expiry);
    db.sale_lines.push({
      id: uid(),
      shop_id: ctx.shopId,
      sale_id: s.id,
      item_id,
      sku: it.sku,
      name: it.name,
      qty: base,
      unit_price: (qty * price) / base,
      wholesale: ws,
      line_total: qty * price,
      pack_id: pack?.id ?? null,
      pack_name: pack?.name ?? null,
      pack_size: pack ? +pack.size : null,
      pack_qty: pack ? qty : null,
      expiry,
      created_at: s.created_at,
    });
    sub += qty * price;
  }
  discount = +discount || 0;
  if (discount < 0 || discount > sub) fail("err.discount");
  const total = sub - discount;
  paid = method == "cash" ? +paid || 0 : total;
  if (paid < total) fail("err.cashShort");
  const rate = +(db.settings[ctx.shopId]?.vat_rate ?? 0) || 0;
  Object.assign(s, { subtotal: sub, discount, total, paid, change_due: paid - total, vat_rate: rate, vat: vatOf(total, rate) });
  db.sales.push(s);
  return s;
}

/** import_sales(), one sale: { ref, at, method?, discount?, customer?: { name, phone? },
 * lines: [{ sku?, name?, qty, price }] }. History only: no stock moves.
 * Returns false when this receipt was imported before. */
export function importSale(db, ctx, r, receipt_no) {
  const ref = String(r.ref ?? "").trim().slice(0, 100),
    bad = (why) => fail("err.importSales", { why: `${ref || "?"}: ${why}` });
  if (!ref) fail("err.importSales", { why: "a sale has no receipt number" });
  const client_id = "import:" + ref;
  if (db.sales.some((x) => x.shop_id == ctx.shopId && x.client_id == client_id)) return false;
  const when = new Date(r.at);
  if (isNaN(when) || when > Date.now() + 864e5) bad("no date, or a date in the future");
  if (!r.lines?.length) bad("no products");
  const mine = (x) => x.shop_id == ctx.shopId,
    lower = (v) => String(v ?? "").trim().toLowerCase();
  // The customer: found by phone, else by name, else added.
  let customer_id = null;
  const cname = String(r.customer?.name ?? "").trim().slice(0, 80),
    phone = String(r.customer?.phone ?? "").trim().slice(0, 30) || null;
  if (cname || phone) {
    const c =
      (phone && db.customers.find((c) => mine(c) && c.phone == phone)) ||
      (cname && db.customers.find((c) => mine(c) && lower(c.name) == lower(cname)));
    if (c) customer_id = c.id;
    else {
      customer_id = uid();
      db.customers.push({ id: customer_id, shop_id: ctx.shopId, name: cname || phone, phone, note: "", created_at: at(ctx) });
    }
  }
  const s = {
    id: uid(),
    shop_id: ctx.shopId,
    client_id,
    receipt_no,
    till: "IMP",
    till_no: null,
    method: lower(r.method) == "transfer" ? "transfer" : "cash",
    status: "paid",
    flags: ["imported"],
    cashier: ctx.userId ?? null,
    customer_id,
    created_at: when.toISOString(),
  };
  let sub = 0;
  const lines = r.lines.map((l) => {
    const qty = +l.qty,
      price = +(l.price ?? 0);
    if (!(qty > 0) || !(price >= 0)) bad("a line with a bad quantity or price");
    const sku = String(l.sku ?? "").trim().slice(0, 100),
      name = String(l.name ?? "").trim().slice(0, 200),
      it =
        (sku && db.items.find((i) => mine(i) && lower(i.sku) == lower(sku))) ||
        (name && db.items.find((i) => mine(i) && lower(i.name) == lower(name)));
    sub += qty * price;
    return {
      id: uid(),
      shop_id: ctx.shopId,
      sale_id: s.id,
      item_id: it?.id ?? null,
      sku: it?.sku ?? (sku || "-"),
      name: it?.name ?? (name || sku || "-"),
      qty,
      unit_price: price,
      wholesale: false,
      line_total: qty * price,
      created_at: s.created_at,
    };
  });
  const discount = +(r.discount ?? 0) || 0;
  if (discount < 0 || discount > sub) bad("a discount bigger than its total");
  const total = sub - discount,
    rate = +(db.settings[ctx.shopId]?.vat_rate ?? 0) || 0;
  Object.assign(s, { subtotal: sub, discount, total, paid: total, change_due: 0, vat_rate: rate, vat: vatOf(total, rate) });
  db.sales.push(s);
  db.sale_lines.push(...lines);
  return true;
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
