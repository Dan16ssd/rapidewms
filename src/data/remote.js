// Supabase backend. The database (see supabase/migrations) enforces shop
// isolation and stock rules; this module just calls it and keeps a local copy
// of the current shop's data for rendering.
import { createClient } from "@supabase/supabase-js";
import { state, emit, canWrite } from "./state.js";

const url = import.meta.env.VITE_SUPABASE_URL,
  key = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const configured = !!(url && key);
export const sb = configured ? createClient(url, key) : null;

export const signOut = () => sb.auth.signOut();

// Turn Postgres / network errors into something a shop owner can act on.
function friendly(e) {
  const m = (e && (e.message || e.error_description)) || String(e);
  if (/not enough stock/i.test(m)) return m.replace(/^.*?(not enough stock)/i, "Not enough stock");
  if (/items_shop_sku_uidx|duplicate key/i.test(m)) return "This SKU already exists";
  if (/read-only|row-level security|permission denied/i.test(m))
    return canWrite() ? "You don't have permission to do that" : "Your plan has expired. Data is read-only.";
  if (/already completed/i.test(m)) return "This order is already completed";
  if (/failed to fetch|network/i.test(m)) return "No internet connection. Try again when you're back online.";
  return m;
}
const must = async (p) => {
  const { data, error } = await p;
  if (error) throw new Error(friendly(error));
  return data;
};

// ---------- session & shop ----------

export async function myShops() {
  return must(
    sb.from("members").select("role, shops(id, name, plan, plan_until)").eq("user_id", state.user.id),
  );
}

export async function createShop(name) {
  return must(sb.rpc("create_shop", { p_name: name }));
}

let channel = null,
  reloadTimer = null;

export async function openShop(m) {
  state.shop = m.shops;
  state.role = m.role;
  localStorage.lastShop = state.shop.id;
  await reload();
  // Realtime: any change by another device in this shop triggers a refresh.
  if (channel) sb.removeChannel(channel);
  const filter = `shop_id=eq.${state.shop.id}`;
  channel = sb.channel("shop-" + state.shop.id);
  for (const table of ["items", "orders", "movements", "settings"])
    channel.on("postgres_changes", { event: "*", schema: "public", table, filter }, () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => reload().catch(() => {}), 300);
    });
  channel.subscribe();
}

export async function reload() {
  const id = state.shop.id,
    since = new Date(Date.now() - 30 * 864e5).toISOString();
  const [items, orders, movements, settings, shop] = await Promise.all([
    must(sb.from("items").select("*").eq("shop_id", id).order("sku")),
    must(sb.from("orders").select("*").eq("shop_id", id).order("created_at", { ascending: false }).limit(500)),
    must(
      sb
        .from("movements")
        .select("*")
        .eq("shop_id", id)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(2000),
    ),
    must(sb.from("settings").select("*").eq("shop_id", id).maybeSingle()),
    must(sb.from("shops").select("id, name, plan, plan_until").eq("id", id).single()),
  ]);
  Object.assign(state, { items, orders, movements, shop });
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
    barcode: f.barcode.trim() || f.sku.trim(),
    min_qty: +f.min_qty || 0,
    cost: +f.cost || 0,
  };
  let itemId = id;
  if (id) await must(sb.from("items").update({ ...row, updated_at: new Date().toISOString() }).eq("id", id));
  else itemId = (await must(sb.from("items").insert({ ...row, shop_id: state.shop.id }).select("id").single())).id;
  const qty = +f.qty || 0,
    cur = state.items.find((i) => i.id == id)?.qty ?? 0;
  if (qty != cur) await must(sb.rpc("set_stock", { p_item: itemId, p_qty: qty, p_note: id ? "edit" : "initial" }));
  await reload();
}

export const deleteItem = (id) => write(sb.from("items").delete().eq("id", id));

export const adjust = (id, delta, note = "manual") =>
  write(sb.rpc("adjust_stock", { p_item: id, p_delta: delta, p_note: note }));

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
