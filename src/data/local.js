// Local demo backend: no server, data lives in this browser's localStorage.
// It mirrors the rules in supabase/migrations/001_schema.sql (unique SKUs,
// no negative stock, orders complete once, auto-reorder, read-only after the
// trial) so the app behaves the same before Supabase is set up.
import { state, emit, canWrite } from "./state.js";

const KEY = "rapidewms.local";
const uid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

let db = load();
function load() {
  try {
    const d = JSON.parse(localStorage[KEY]);
    if (d && d.shops) return d;
  } catch {}
  return { shops: [], settings: {}, items: [], orders: [], movements: [] };
}
const persist = () => (localStorage[KEY] = JSON.stringify(db));

const fail = (m) => {
  throw new Error(m);
};
const writable = () => canWrite() || fail("Your plan has expired. Data is read-only.");
const ownerOnly = () => state.role == "owner" || fail("You don't have permission to do that");
const shopId = () => state.shop.id;
const mine = (list) => list.filter((x) => x.shop_id == shopId());

export const configured = false;
export const signOut = async () => {};

// ---------- session & shop ----------

export async function myShops() {
  return db.shops.map((s) => ({ role: "owner", shops: s }));
}

export async function createShop(name) {
  name = String(name || "").trim() || fail("Shop name is required");
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
  state.settings = db.settings[shopId()];
  state.shop = db.shops.find((s) => s.id == shopId());
  emit();
}

const commit = async () => {
  persist();
  await reload();
};

// ---------- stock (mirrors adjust_stock / set_stock / complete_order) ----------

function adjustRaw(itemId, delta, note) {
  writable();
  const it = db.items.find((i) => i.id == itemId && i.shop_id == shopId()) || fail("Product not found");
  if (!delta) fail("Quantity must not be zero");
  const q = +it.qty + delta;
  if (q < 0) fail(`Not enough stock: ${it.sku} has ${+it.qty}`);
  it.qty = q;
  it.updated_at = nowIso();
  db.movements.push({
    id: uid(),
    shop_id: it.shop_id,
    item_id: it.id,
    sku: it.sku,
    type: delta > 0 ? "in" : "out",
    qty: Math.abs(delta),
    note: note || "",
    created_at: nowIso(),
  });
  if (
    db.settings[it.shop_id]?.auto_reorder &&
    q < +it.min_qty &&
    !db.orders.some((o) => o.item_id == it.id && o.type == "in" && o.status == "pending")
  )
    db.orders.push({
      id: uid(),
      shop_id: it.shop_id,
      item_id: it.id,
      type: "in",
      qty: it.min_qty * 2 - q,
      party: "Auto-reorder",
      status: "pending",
      auto: true,
      created_at: nowIso(),
    });
  return q;
}

const setStockRaw = (itemId, qty, note) => {
  const it = db.items.find((i) => i.id == itemId);
  if (it && +qty != +it.qty) adjustRaw(itemId, qty - it.qty, note);
};

export async function adjust(id, delta, note = "manual") {
  adjustRaw(id, delta, note);
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
    barcode: f.barcode.trim() || f.sku.trim(),
    min_qty: Math.max(0, +f.min_qty || 0),
    cost: Math.max(0, +f.cost || 0),
    updated_at: nowIso(),
  };
  if (!row.sku || !row.name) fail("SKU code and product name are required");
  if (skuTaken(row.sku, id)) fail("This SKU already exists");
  let it = id && db.items.find((i) => i.id == id && i.shop_id == shopId());
  if (it) Object.assign(it, row);
  else db.items.push((it = { id: uid(), shop_id: shopId(), qty: 0, created_at: nowIso(), ...row }));
  setStockRaw(it.id, Math.max(0, +f.qty || 0), id ? "edit" : "initial");
  await commit();
}

export async function deleteItem(id) {
  writable();
  ownerOnly();
  db.items = db.items.filter((i) => !(i.id == id && i.shop_id == shopId()));
  db.orders = db.orders.filter((o) => o.item_id != id);
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
      barcode: x.barcode || x.sku,
      qty: 0,
      min_qty: Math.max(0, +x.min_qty || 0),
      cost: Math.max(0, +x.cost || 0),
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    db.items.push(it);
    if (x.qty > 0) setStockRaw(it.id, x.qty, "import");
    n++;
  }
  await commit();
  return n;
}

// ---------- orders ----------

export async function addOrder(o) {
  writable();
  if (!mine(db.items).some((i) => i.id == o.item_id)) fail("Product not found");
  if (!(o.qty > 0)) fail("Quantity must be more than zero");
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
  const o = db.orders.find((x) => x.id == id && x.shop_id == shopId()) || fail("Order not found");
  if (o.status != "pending") fail("This order is already completed");
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
  await commit();
}

// Other tabs of this browser: pick up their changes.
addEventListener("storage", (e) => {
  if (e.key != KEY) return;
  db = load();
  if (state.shop) reload();
});
