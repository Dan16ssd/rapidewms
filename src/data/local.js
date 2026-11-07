// Local demo backend: no server, data lives in this browser's localStorage.
// It mirrors the rules in supabase/migrations (unique SKUs, no negative stock,
// orders complete once, auto-reorder, read-only after the trial, expiry lots
// taken soonest-first, sales priced from the product and sold all-or-nothing)
// so the app behaves the same before Supabase is set up.
import { state, emit, canWrite } from "./state.js";
import { err } from "../i18n/index.js";
import * as apply from "./apply.js";

const KEY = "rapidewms.local";
const uid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

let db = load();
function load() {
  let d = null;
  try {
    d = JSON.parse(localStorage[KEY]);
  } catch {}
  if (!d || !d.shops) d = { shops: [], settings: {} };
  // Data saved before expiry tracking and the till existed lacks these lists.
  for (const k of ["items", "orders", "movements", "lots", "sales", "sale_lines"]) d[k] ||= [];
  return d;
}
const persist = () => (localStorage[KEY] = JSON.stringify(db));

// Errors carry a translation key so the UI can show them in any language.
const fail = (code, params) => {
  throw err(code, params);
};
const writable = () => canWrite() || fail("err.readonly");
const ownerOnly = () => state.role == "owner" || fail("err.noPerm");
const shopId = () => state.shop.id;
const mine = (list) => list.filter((x) => x.shop_id == shopId());

export const configured = false;
export const signOut = async () => {};
// The demo keeps everything in this browser already: nothing to queue or send.
export const sync = async () => ({ sent: [], stopped: false });
export const openCached = async () => false;
export const myTill = () => null;
export const retryFailed = async () => {};
export const discardFailed = async () => {};

// ---------- session & shop ----------

export async function myShops() {
  return db.shops.map((s) => ({ role: "owner", shops: s }));
}

export async function createShop(name) {
  name = String(name || "").trim() || fail("err.needShopName");
  const s = {
    id: uid(),
    name,
    plan: "trial",
    plan_until: new Date(Date.now() + 14 * 864e5).toISOString(),
    created_at: nowIso(),
  };
  db.shops.push(s);
  db.settings[s.id] = { shop_id: s.id, low_alert: true, auto_reorder: false };
  persist();
  return s.id;
}

export async function openShop(m) {
  state.shop = m.shops;
  state.role = m.role;
  localStorage.lastShop = state.shop.id;
  await reload();
}

export async function reload() {
  const since = Date.now() - 30 * 864e5,
    byNewest = (a, b) => (a.created_at < b.created_at ? 1 : -1);
  state.items = mine(db.items).sort((a, b) => a.sku.localeCompare(b.sku));
  state.orders = mine(db.orders).sort(byNewest);
  state.movements = mine(db.movements)
    .filter((m) => new Date(m.created_at) >= since)
    .sort(byNewest);
  state.lots = mine(db.lots).sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
  state.sales = mine(db.sales)
    .filter((x) => new Date(x.created_at) >= since)
    .sort(byNewest);
  const shown = new Set(state.sales.map((x) => x.id));
  state.saleLines = mine(db.sale_lines).filter((l) => shown.has(l.sale_id));
  state.settings = db.settings[shopId()];
  state.shop = db.shops.find((s) => s.id == shopId());
  emit();
}

const commit = async () => {
  persist();
  await reload();
};

// ---------- stock (mirrors adjust_stock / set_stock / complete_order) ----------

// The rules themselves live in apply.js, shared with the offline copy of a
// Supabase shop, so the demo and a real shop behave the same.
const ctx = () => ({ shopId: shopId(), userId: state.user?.id ?? null });
function moveRaw(itemId, delta, note, expiry = null, saleId = null) {
  writable();
  return apply.stockMove(db, ctx(), itemId, delta, note, expiry, saleId);
}

const adjustRaw = (itemId, delta, note, expiry) => moveRaw(itemId, delta, note, expiry);

const setStockRaw = (itemId, qty, note, expiry) => {
  const it = db.items.find((i) => i.id == itemId);
  if (it && +qty != +it.qty) adjustRaw(itemId, qty - it.qty, note, qty > it.qty ? expiry : null);
};

export async function adjust(id, delta, note = "manual", expiry = null) {
  adjustRaw(id, delta, note, expiry);
  await commit();
}

// Mirrors write_off_lot(): the whole lot leaves stock, logged as expired.
export async function writeOffLot(lotId, note = "expired") {
  writable();
  const lot = db.lots.find((l) => l.id == lotId && l.shop_id == shopId()) || fail("err.lotNotFound");
  apply.writeOff(db, ctx(), lot.item_id, lot.expiry, +lot.qty, note);
  await commit();
}

// ---------- items ----------

const skuTaken = (sku, exceptId) =>
  mine(db.items).some((i) => i.id != exceptId && i.sku.toLowerCase() == sku.toLowerCase());

export async function saveItem(id, f) {
  writable();
  const row = {
    sku: f.sku.trim(),
    name: f.name.trim(),
    category: f.category.trim() || "General",
    kind: f.kind == "consumable" ? "consumable" : "durable",
    barcode: f.barcode.trim() || f.sku.trim(),
    min_qty: Math.max(0, +f.min_qty || 0),
    cost: Math.max(0, +f.cost || 0),
    price: Math.max(0, +f.price || 0),
    price_wholesale: Math.max(0, +f.price_wholesale || 0),
    wholesale_min_qty: Math.max(0, +f.wholesale_min_qty || 0),
    updated_at: nowIso(),
  };
  if (!row.sku || !row.name) fail("err.needSkuName");
  if (skuTaken(row.sku, id)) fail("err.dupSku");
  let it = id && db.items.find((i) => i.id == id && i.shop_id == shopId());
  if (it) Object.assign(it, row);
  else db.items.push((it = { id: uid(), shop_id: shopId(), qty: 0, created_at: nowIso(), ...row }));
  setStockRaw(it.id, Math.max(0, +f.qty || 0), id ? "edit" : "initial", f.expiry || null);
  await commit();
}

export async function deleteItem(id) {
  writable();
  ownerOnly();
  db.items = db.items.filter((i) => !(i.id == id && i.shop_id == shopId()));
  db.orders = db.orders.filter((o) => o.item_id != id);
  db.lots = db.lots.filter((l) => l.item_id != id);
  db.sale_lines.forEach((l) => l.item_id == id && (l.item_id = null)); // receipts keep the name
  db.movements.forEach((m) => m.item_id == id && (m.item_id = null)); // history keeps the SKU
  await commit();
}

export async function importItems(list) {
  writable();
  let n = 0;
  for (const x of list) {
    if (skuTaken(x.sku)) continue;
    const it = {
      id: uid(),
      shop_id: shopId(),
      sku: x.sku,
      name: x.name,
      category: x.category || "General",
      kind: x.kind == "consumable" ? "consumable" : "durable",
      barcode: x.barcode || x.sku,
      qty: 0,
      min_qty: Math.max(0, +x.min_qty || 0),
      cost: Math.max(0, +x.cost || 0),
      price: Math.max(0, +x.price || 0),
      price_wholesale: Math.max(0, +x.price_wholesale || 0),
      wholesale_min_qty: Math.max(0, +x.wholesale_min_qty || 0),
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    db.items.push(it);
    if (x.qty > 0) setStockRaw(it.id, x.qty, "import", x.expiry || null);
    n++;
  }
  await commit();
  return n;
}

// ---------- orders ----------

export async function addOrder(o) {
  writable();
  if (!mine(db.items).some((i) => i.id == o.item_id)) fail("err.itemNotFound");
  if (!(o.qty > 0)) fail("err.qtyPositive");
  db.orders.push({
    id: uid(),
    shop_id: shopId(),
    item_id: o.item_id,
    type: o.type == "out" ? "out" : "in",
    qty: +o.qty,
    party: o.party || "",
    status: "pending",
    auto: false,
    created_at: nowIso(),
  });
  await commit();
}

export async function completeOrder(id) {
  const o = db.orders.find((x) => x.id == id && x.shop_id == shopId()) || fail("err.orderNotFound");
  if (o.status != "pending") fail("err.orderDone");
  adjustRaw(o.item_id, o.type == "in" ? o.qty : -o.qty, "order");
  o.status = "done";
  o.completed_at = nowIso();
  await commit();
}

export async function deleteOrder(id) {
  writable();
  ownerOnly();
  db.orders = db.orders.filter((o) => !(o.id == id && o.shop_id == shopId()));
  await commit();
}

// ---------- the till (mirrors create_sale / void_sale) ----------

// lines: [{ item_id, qty }]. Prices come from the product, never the till.
export async function createSale({ client_id, lines, discount = 0, method = "cash", paid = 0 }) {
  writable();
  // A failing line must leave stock and receipt numbers untouched: snapshot and roll back.
  const before = JSON.stringify(db);
  try {
    const shop = db.shops.find((x) => x.id == shopId()),
      known = db.sales.some((x) => x.shop_id == shopId() && x.client_id == client_id),
      lines0 = lines.map(({ item_id, qty }) => ({ item_id, qty })),
      sale = apply.sale(db, ctx(), { client_id, lines: lines0, discount, method, paid, receipt_no: (shop.receipt_seq || 0) + 1 });
    if (!known) shop.receipt_seq = sale.receipt_no;
    await commit();
    return sale;
  } catch (e) {
    db = JSON.parse(before);
    throw e;
  }
}

export async function voidSale(id) {
  writable();
  ownerOnly();
  const sale = db.sales.find((x) => x.id == id && x.shop_id == shopId()) || fail("err.saleNotFound");
  if (sale.status == "void") fail("err.saleVoided");
  apply.voidSale(db, ctx(), sale);
  await commit();
}

// ---------- settings / danger zone ----------

export async function setSetting(k, v) {
  ownerOnly();
  db.settings[shopId()][k] = !!v;
  await commit();
}

export async function eraseAll() {
  ownerOnly();
  const keep = (x) => x.shop_id != shopId();
  db.items = db.items.filter(keep);
  db.orders = db.orders.filter(keep);
  db.movements = db.movements.filter(keep);
  db.lots = db.lots.filter(keep);
  db.sales = db.sales.filter(keep);
  db.sale_lines = db.sale_lines.filter(keep);
  db.shops.find((x) => x.id == shopId()).receipt_seq = 0;
  await commit();
}

// Other tabs of this browser: pick up their changes.
addEventListener("storage", (e) => {
  if (e.key != KEY) return;
  db = load();
  if (state.shop) reload();
});
