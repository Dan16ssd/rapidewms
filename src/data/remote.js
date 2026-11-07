// Supabase backend. The database (see supabase/migrations) enforces shop
// isolation and stock rules; this module just calls it and keeps a local copy
// of the current shop's data for rendering.
import { createClient } from "@supabase/supabase-js";
import { state, emit, canWrite } from "./state.js";
import { err } from "../i18n/index.js";
import { pageAll } from "./page.js";

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
  if (/failed to fetch|network/i.test(m)) return err("err.offline");
  return new Error(m);
}
const must = async (p) => {
  const { data, error } = await p;
  if (error) throw friendly(error);
  return data;
};

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
  const [items, orders, movements, settings, shop, lots, sales, saleLines] = await Promise.all([
    all(() => sel("items").order("sku")),
    // created_at alone is not unique, so id breaks ties and keeps paging stable.
    all(() => sel("orders").order("created_at", { ascending: false }).order("id"), CAP.orders),
    all(
      () => sel("movements").gte("created_at", since).order("created_at", { ascending: false }).order("id"),
      CAP.movements,
    ),
    must(sb.from("settings").select("*").eq("shop_id", id).maybeSingle()),
    must(sb.from("shops").select("id, name, plan, plan_until").eq("id", id).single()),
    // Lots are never capped: like products, a missing one is a missing expiry warning.
    all(() => sel("lots").order("expiry").order("id")),
    all(() => sel("sales").gte("created_at", since).order("created_at", { ascending: false }).order("id"), CAP.sales),
    all(() => sel("sale_lines").gte("created_at", since).order("created_at", { ascending: false }).order("id"), CAP.saleLines),
  ]);
  Object.assign(state, {
    items: items.rows,
    orders: orders.rows,
    movements: movements.rows,
    shop,
    lots: lots.rows,
    sales: sales.rows,
    saleLines: saleLines.rows,
    truncated: [items, orders, movements, sales, saleLines].some((r) => r.rows.length < r.total),
  });
  if (settings) state.settings = settings;
  emit();
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

export const adjust = (id, delta, note = "manual", expiry = null) =>
  write(sb.rpc("adjust_stock", { p_item: id, p_delta: delta, p_note: note, p_expiry: expiry }));

export const writeOffLot = (id, note = "expired") => write(sb.rpc("write_off_lot", { p_lot: id, p_note: note }));

// ---------- the till ----------

// One call, one transaction: the database prices each line and moves the stock.
export async function createSale({ client_id, lines, discount = 0, method = "cash", paid = 0 }) {
  const id = await must(
    sb.rpc("create_sale", {
      p_shop: state.shop.id,
      p_client_id: client_id,
      p_lines: lines.map((l) => ({ item_id: l.item_id, qty: l.qty })),
      p_discount: discount,
      p_method: method,
      p_paid: paid,
    }),
  );
  await reload();
  return state.sales.find((x) => x.id == id) || (await must(sb.from("sales").select("*").eq("id", id).single()));
}

export const voidSale = (id) => write(sb.rpc("void_sale", { p_sale: id }));

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
