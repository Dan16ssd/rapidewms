// Supabase backend. The database (see supabase/migrations) enforces shop
// isolation and stock rules; this module just calls it and keeps a local copy
// of the current shop's data for rendering.
import { createClient } from "@supabase/supabase-js";
import { state, emit, canWrite } from "./state.js";
import { err } from "../i18n/index.js";
import { pageAll } from "./page.js";
import * as apply from "./apply.js";
import * as Q from "./queue.js";
import * as C from "./cache.js";

const url = import.meta.env.VITE_SUPABASE_URL,
  key = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const configured = !!(url && key);
export const sb = configured ? createClient(url, key) : null;

export const signOut = () => sb.auth.signOut();

// Turn Postgres / network errors into a translatable error a shop owner can act on.
// The SQL keeps raising English (001_schema.sql), so the sku and qty are parsed back out.
function friendly(e) {
  const m = (e && (e.message || e.error_description)) || String(e),
    stock = /not enough stock:\s*(.+?) has (\S+)/i.exec(m);
  if (stock) return err("err.stock", { sku: stock[1], qty: stock[2] });
  if (/not enough stock/i.test(m)) return err("err.stock", { sku: "", qty: "" });
  if (/items_shop_sku_uidx|duplicate key/i.test(m)) return err("err.dupSku");
  if (/read-only|row-level security|permission denied/i.test(m))
    return err(canWrite() ? "err.noPerm" : "err.readonly");
  if (/already completed/i.test(m)) return err("err.orderDone");
  const price = /no sell price:\s*(.+)$/i.exec(m);
  if (price) return err("err.noPrice", { sku: price[1] });
  if (/cash paid is less/i.test(m)) return err("err.cashShort");
  if (/discount must be/i.test(m)) return err("err.discount");
  if (/has no products/i.test(m)) return err("err.emptySale");
  if (/already voided/i.test(m)) return err("err.saleVoided");
  if (/only the owner/i.test(m)) return err("err.noPerm");
  if (/lot not found/i.test(m)) return err("err.lotNotFound");
  // Chrome, Safari and Firefox word a lost connection differently.
  if (/failed to fetch|load failed|network/i.test(m)) return err("err.offline");
  if (/unknown till/i.test(m)) return err("err.till");
  const full = /till limit reached: (\d+) of (\d+)/i.exec(m);
  if (full) return err("err.tillFull", { max: full[2] });
  if (/not a till/i.test(m)) return err("err.noTill");
  if (/till retired/i.test(m)) return err("err.tillRetired");
  if (/invite code not valid/i.test(m)) return err("err.badInvite");
  if (/already a member/i.test(m)) return err("err.alreadyMember");
  if (/too many open invites/i.test(m)) return err("err.manyInvites");
  return new Error(m);
}
const fail = (code, params) => {
  throw err(code, params);
};
const must = async (p) => {
  const { data, error } = await p;
  if (error) throw friendly(error);
  return data;
};

// ---------- session & shop ----------

export async function myShops() {
  return must(sb.from("members").select("role, shops(id, name, plan, plan_until, max_tills)").eq("user_id", state.user.id));
}

export const createShop = (name) => must(sb.rpc("create_shop", { p_name: name }));
/** A cashier joins a shop with the owner's one-time code. */
export const joinShop = (code) => must(sb.rpc("join_shop", { p_code: code }));

export async function openShop(m) {
  state.shop = m.shops;
  state.role = m.role;
  localStorage.lastShop = state.shop.id;
  server = null;
  await reload();
  watch();
  if (state.pending) sync().catch(() => {});
}

// Realtime: a change by another device in this shop brings a fresh copy.
let channel = null,
  reloadTimer = null;
function watch() {
  if (channel) sb.removeChannel(channel);
  const filter = `shop_id=eq.${state.shop.id}`;
  channel = sb.channel("shop-" + state.shop.id);
  for (const table of ["items", "orders", "movements", "settings", "lots", "sales", "sale_lines", "tills", "members"])
    channel.on("postgres_changes", { event: "*", schema: "public", table, filter }, () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => navigator.onLine && reload().catch(() => {}), 300);
    });
  channel.subscribe();
}

// Read a whole table, not just the first page the server feels like giving us.
const all = (make, cap) => pageAll(make, cap, friendly);

// Products are never capped: a missing product is missing stock, and the
// inventory list, search and export all read from this copy. Orders and
// movements keep a ceiling so one long-running shop can't stall every reload;
// when it bites, state.truncated tells the UI to say so instead of quietly
// showing a partial history.
const CAP = { orders: 5000, movements: 10000, sales: 5000, saleLines: 20000 };

export async function reload() {
  const id = state.shop.id,
    since = new Date(Date.now() - 30 * 864e5).toISOString(),
    sel = (table) => sb.from(table).select("*", { count: "exact" }).eq("shop_id", id);
  const [items, orders, movements, settings, shop, lots, sales, saleLines, tills] = await Promise.all([
    all(() => sel("items").order("sku")),
    // created_at alone is not unique, so id breaks ties and keeps paging stable.
    all(() => sel("orders").order("created_at", { ascending: false }).order("id"), CAP.orders),
    all(
      () => sel("movements").gte("created_at", since).order("created_at", { ascending: false }).order("id"),
      CAP.movements,
    ),
    must(sb.from("settings").select("*").eq("shop_id", id).maybeSingle()),
    must(sb.from("shops").select("id, name, plan, plan_until, max_tills").eq("id", id).single()),
    // Lots are never capped: like products, a missing one is a missing expiry warning.
    all(() => sel("lots").order("expiry").order("id")),
    all(() => sel("sales").gte("created_at", since).order("created_at", { ascending: false }).order("id"), CAP.sales),
    all(() => sel("sale_lines").gte("created_at", since).order("created_at", { ascending: false }).order("id"), CAP.saleLines),
    all(() => sel("tills").order("created_at").order("id")),
  ]);
  server = {
    items: items.rows,
    orders: orders.rows,
    movements: movements.rows,
    shop,
    lots: lots.rows,
    sales: sales.rows,
    saleLines: saleLines.rows,
    tills: tills.rows,
    settings: settings || state.settings,
    truncated: [items, orders, movements, sales, saleLines].some((r) => r.rows.length < r.total),
  };
  sentSince = [];
  state.savedAt = new Date().toISOString();
  // Kept on the device, so the shop opens with no internet.
  await C.put("snap", id, { ...server, role: state.role, savedAt: state.savedAt }).catch(() => {});
  localStorage["rapidewms.lastShop." + state.user.id] = id;
  await loadPeople();
  await rebuild();
  await ensureTill();
}

// Who is in the shop and the unused invite codes: the owner's Staff card.
async function loadPeople() {
  state.people = state.role == "owner" ? await rpc("shop_people", { p_shop: state.shop.id }).catch(() => state.people) : null;
}

/** Owner: a one-time code a cashier types to join this shop. */
export async function createInvite() {
  const code = await rpc("create_invite", { p_shop: state.shop.id });
  await loadPeople();
  emit();
  return code;
}
export async function cancelInvite(code) {
  await rpc("cancel_invite", { p_shop: state.shop.id, p_code: code });
  await loadPeople();
  emit();
}
export async function removeMember(userId) {
  await rpc("remove_member", { p_shop: state.shop.id, p_user: userId });
  await loadPeople();
  emit();
}

/** Open the last shop this user had, from the copy on this device. */
export async function openCached() {
  const id = state.user && localStorage["rapidewms.lastShop." + state.user.id],
    snap = id && (await C.get("snap", id).catch(() => null));
  if (!snap) return false;
  server = snap;
  sentSince = [];
  Object.assign(state, { shop: snap.shop, role: snap.role, savedAt: snap.savedAt });
  await rebuild();
  watch();
  return true;
}

const write = async (p) => {
  const r = await must(p);
  await reload();
  return r;
};

// ---------- items ----------

export async function saveItem(id, f) {
  const row = {
    sku: f.sku.trim(),
    name: f.name.trim(),
    category: f.category.trim() || "General",
    kind: f.kind == "consumable" ? "consumable" : "durable",
    barcode: f.barcode.trim() || f.sku.trim(),
    min_qty: +f.min_qty || 0,
    cost: +f.cost || 0,
    price: +f.price || 0,
    price_wholesale: +f.price_wholesale || 0,
    wholesale_min_qty: +f.wholesale_min_qty || 0,
  };
  let itemId = id;
  if (id) await must(sb.from("items").update({ ...row, updated_at: new Date().toISOString() }).eq("id", id));
  else itemId = (await must(sb.from("items").insert({ ...row, shop_id: state.shop.id }).select("id").single())).id;
  const qty = +f.qty || 0,
    cur = state.items.find((i) => i.id == id)?.qty ?? 0;
  const note = id ? "edit" : "initial";
  // Stock going up may carry an expiry date, which set_stock has no room for.
  if (qty > cur)
    await must(sb.rpc("adjust_stock", { p_item: itemId, p_delta: qty - cur, p_note: note, p_expiry: f.expiry || null }));
  else if (qty < cur) await must(sb.rpc("set_stock", { p_item: itemId, p_qty: qty, p_note: note }));
  await reload();
}

export const deleteItem = (id) => write(sb.from("items").delete().eq("id", id));

// ---------- work that also runs offline ----------
//
// Sales, voids, stock changes and write-offs go through the queue (queue.js):
// stored on this device first, then sent. Offline they stay queued and show
// at once, worked out by apply.js on top of the last copy from the server.

export const adjust = (id, delta, note = "manual", expiry = null) =>
  queued("adjust", { item_id: id, delta, note, expiry: expiry || null });

// Keyed by product and date, not lot id: a lot received offline has no
// server id yet.
export async function writeOffLot(id, note = "expired") {
  const lot = state.lots.find((l) => l.id == id) || fail("err.lotNotFound");
  await queued("writeoff", { item_id: lot.item_id, expiry: lot.expiry, qty: +lot.qty, note });
}

// lines: [{ item_id, qty }]. The till's price goes along: the server uses it
// only for a sale that happened offline, since that is what the customer paid.
export async function createSale({ client_id, lines, discount = 0, method = "cash", paid = 0 }) {
  const known = state.sales.find((x) => x.client_id == client_id && !x.pending);
  if (known) return known;
  const till = myTill(),
    args = {
      client_id,
      lines: lines.map((l) => {
        const it = state.items.find((i) => i.id == l.item_id);
        return { item_id: l.item_id, qty: l.qty, price: it ? apply.linePrice(it, l.qty).price : null };
      }),
      discount,
      method,
      paid,
      till: till?.code ?? null,
      till_no: till ? nextTillNo(till) : null,
    };
  await queued("sale", args, client_id);
  return state.sales.find((x) => x.client_id == client_id);
}

export async function voidSale(id) {
  const s = state.sales.find((x) => x.id == id) || fail("err.saleNotFound");
  if (s.status == "void") fail("err.saleVoided");
  if (state.role != "owner") fail("err.noPerm");
  await queued("void", { sale_client_id: s.client_id });
}

// The server call for one queued record.
const SEND = {
  sale: (r, a) =>
    rpc("create_sale", {
      p_shop: r.shop,
      p_client_id: a.client_id,
      p_lines: a.lines,
      p_discount: a.discount,
      p_method: a.method,
      p_paid: a.paid,
      p_at: r.at,
      p_till: a.till,
      p_till_no: a.till_no,
      p_offline: r.offline,
    }),
  void: (r, a) => rpc("void_sale_by_client", { p_shop: r.shop, p_sale_client_id: a.sale_client_id, p_at: r.at }),
  adjust: (r, a) =>
    rpc("adjust_stock", {
      p_item: a.item_id,
      p_delta: a.delta,
      p_note: a.note,
      p_expiry: a.expiry,
      p_client_id: r.id,
      p_at: r.at,
      p_offline: r.offline,
    }),
  writeoff: (r, a) =>
    rpc("write_off_expiry", {
      p_item: a.item_id,
      p_expiry: a.expiry,
      p_qty: a.qty,
      p_note: a.note,
      p_client_id: r.id,
      p_at: r.at,
    }),
};
const rpc = (fn, args) => must(sb.rpc(fn, args));

// "Try again later" rather than "the server said no": no connection, or a
// login that expired while offline and is refreshed before the next try.
const isNet = (e) =>
  !navigator.onLine || e?.code == "err.offline" || /jwt|token|401|auth session/i.test(e?.message || "");

// What this device did, shown on top of the server's copy: what is still
// queued, plus what was sent since the copy was taken.
const ctxFor = (r) => ({ shopId: r.shop, userId: state.user?.id ?? null, at: r.at, short: true });
function applyRecord(db, r) {
  const a = r.args,
    ctx = ctxFor(r);
  try {
    if (r.op == "sale") {
      const s = apply.sale(db, ctx, { ...a, id: "q-" + a.client_id });
      if (s.id == "q-" + a.client_id) s.pending = true; // not on the server yet
    }
    if (r.op == "void") {
      const s = db.sales.find((x) => x.client_id == a.sale_client_id);
      if (s) apply.voidSale(db, ctx, s);
    }
    if (r.op == "adjust") apply.stockMove(db, ctx, a.item_id, a.delta, a.note, a.expiry);
    if (r.op == "writeoff") apply.writeOff(db, ctx, a.item_id, a.expiry, a.qty, a.note);
  } catch {
    // The product is gone from this copy, say. The server decides when it's sent.
  }
}

let server = null, // the last copy from the server
  sentSince = []; // records the server has that the copy doesn't yet

async function rebuild() {
  if (!server || server.shop.id != state.shop?.id) return emit();
  const s = structuredClone(server);
  Object.assign(state, {
    items: s.items,
    orders: s.orders,
    movements: s.movements,
    lots: s.lots,
    sales: s.sales,
    saleLines: s.saleLines,
    tills: s.tills || [],
    shop: s.shop,
    truncated: s.truncated,
  });
  if (s.settings) state.settings = s.settings;
  const queue = await Q.pending(state.shop.id),
    db = {
      items: state.items,
      lots: state.lots,
      movements: state.movements,
      sales: state.sales,
      sale_lines: state.saleLines,
      orders: state.orders,
      settings: { [state.shop.id]: state.settings },
    };
  for (const r of [...sentSince, ...queue]) applyRecord(db, r);
  const newest = (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0);
  state.sales.sort(newest);
  state.movements.sort(newest);
  state.lots.sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
  state.pending = queue.length;
  state.failed = await Q.failed(state.shop.id);
  emit();
}

let timer = null;
/** Send what is queued. Called when the network returns, every 30 s while
 * something waits, and by the "waiting to send" button. */
export async function sync(freshId = null) {
  if (!state.shop) return { sent: [], stopped: true };
  if (!navigator.onLine) {
    await rebuild();
    return { sent: [], stopped: true };
  }
  await sb.auth.getSession().catch(() => {});
  const out = await Q.flush(state.shop.id, (r) => SEND[r.op](r, r.args), isNet, freshId);
  sentSince.push(...out.sent);
  if (!out.stopped && navigator.onLine) await reload().catch(() => rebuild());
  else await rebuild();
  clearTimeout(timer);
  if (state.pending) timer = setTimeout(() => sync().catch(() => {}), 30e3);
  return out;
}

async function queued(op, args, id) {
  if (!canWrite()) fail("err.readonly");
  const rec = Q.record(state.shop.id, op, args, id);
  rec.offline = !navigator.onLine;
  await Q.add(rec);
  if (rec.offline) return sync(); // shows it now, sends it when the network returns
  const out = await sync(rec.id);
  if (out.freshError) throw out.freshError;
}

/** Put work the server refused back in the queue, or drop it. */
export async function retryFailed(id) {
  await Q.retry(id);
  await sync();
}
export async function discardFailed(id) {
  await Q.discard(id);
  await rebuild();
}

// ---------- tills: receipt numbers that work offline ----------
//
// Each device registers once as a till of the shop (A, B, C...) and numbers
// its own receipts, so two tills offline at the same time never hand out the
// same number. Kept per shop in this browser.
const tillKey = () => "rapidewms.till." + state.shop.id;
// Kept as {code, next}, or {retired: true} once the owner retired it: that
// device then waits for someone to tap "Use as a till" instead of taking the
// place back by itself.
function savedTill() {
  try {
    return JSON.parse(localStorage[tillKey()]);
  } catch {
    return null;
  }
}
export function myTill() {
  const t = savedTill();
  return t && t.code ? t : null;
}
function nextTillNo(till) {
  const no = till.next;
  localStorage[tillKey()] = JSON.stringify({ ...till, next: no + 1 });
  return no;
}
// Run after every fresh copy from the server. The plan sets how many tills can
// be in use (shops.max_tills); a device past that can look but not sell.
async function ensureTill() {
  const mine = myTill();
  // The owner retired this device's till: it lets go of the letter.
  if (mine && server?.tills && !server.tills.some((x) => x.code == mine.code && !x.retired_at))
    localStorage[tillKey()] = JSON.stringify({ retired: true });
  if (myTill() || savedTill()?.retired || !navigator.onLine || !canWrite()) return setFull(false);
  await register().catch(() => {});
}
async function register() {
  try {
    const code = await rpc("register_till", { p_shop: state.shop.id, p_name: deviceName() });
    if (!myTill()) localStorage[tillKey()] = JSON.stringify({ code, next: 1 });
    setFull(false);
  } catch (e) {
    setFull(e.code == "err.tillFull");
    throw e;
  }
}
/** "Use as a till" on a device that has none, e.g. after its till was retired. */
export async function registerTill() {
  await register();
  await reload();
}
function setFull(full) {
  if (state.tillFull == full && !full) return;
  state.tillFull = full;
  emit();
}
// A short name for the till list, so the owner can tell the devices apart.
function deviceName() {
  const ua = navigator.userAgent;
  return /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows PC" : /Mac/.test(ua) ? "Mac" : "";
}

/** Owner: free a till's place, for a phone that is lost, broken or replaced. */
export async function retireTill(code) {
  await rpc("retire_till", { p_shop: state.shop.id, p_code: code });
  await reload();
}

// Bulk import: new SKUs only, existing ones are skipped. Returns count added.
export async function importItems(list) {
  const have = new Set(state.items.map((i) => i.sku.toLowerCase())),
    fresh = list.filter((x) => !have.has(x.sku.toLowerCase()) && have.add(x.sku.toLowerCase()));
  if (!fresh.length) return 0;
  const rows = await must(
    sb
      .from("items")
      .insert(fresh.map(({ qty, ...r }) => ({ ...r, barcode: r.barcode || r.sku, shop_id: state.shop.id })))
      .select("id, sku"),
  );
  for (const r of rows) {
    const q = fresh.find((x) => x.sku == r.sku)?.qty;
    if (q > 0) await must(sb.rpc("set_stock", { p_item: r.id, p_qty: q, p_note: "import" }));
  }
  await reload();
  return rows.length;
}

// ---------- orders ----------

export const addOrder = (o) => write(sb.from("orders").insert({ ...o, shop_id: state.shop.id }));
export const completeOrder = (id) => write(sb.rpc("complete_order", { p_order: id }));
export const deleteOrder = (id) => write(sb.from("orders").delete().eq("id", id));

// ---------- settings / danger zone ----------

export const setSetting = (k, v) =>
  write(
    sb
      .from("settings")
      .update({ [k]: v, updated_at: new Date().toISOString() })
      .eq("shop_id", state.shop.id),
  );

export const eraseAll = () => write(sb.rpc("erase_shop_data", { p_shop: state.shop.id }));
