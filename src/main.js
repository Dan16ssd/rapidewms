import "./styles.css";
import { $, E, toast, form } from "./lib/util.js";
import { csvToItems } from "./lib/csv.js";
import { exportSet, exportZip } from "./lib/export.js";
import * as store from "./data/store.js";
import { state, canWrite, isOwner } from "./data/store.js";
import { showAuth, showCreateShop } from "./auth.js";
import * as scanner from "./scanner.js";
import dash from "./views/dash.js";
import inv, { ui as invUi, rows as invRows } from "./views/inv.js";
import ord from "./views/ord.js";
import scan from "./views/scan.js";
import rep, { conv, refreshRates } from "./views/rep.js";
import auto from "./views/auto.js";
import sys from "./views/sys.js";

const VIEWS = { dash, inv, ord, scan, rep, auto, sys };
const N = [
  ["dash", "Dashboard", "◔", "Stock value, units and recent movement."],
  ["inv", "Inventory", "▦", "Add, edit and count every product."],
  ["ord", "Orders", "⛟", "Create inbound and outbound orders, then complete them to update stock."],
  ["scan", "Scanner", "▥", "Scan barcodes or QR codes to receive, ship or look up stock."],
  ["rep", "Reports & export", "▤", "Export PDF, Excel or CSV and convert currencies."],
  ["auto", "Automation", "⚙", "Rules that watch your stock for you."],
  ["sys", "Shop & backup", "☰", "Your plan, backups and imports."],
];
let view = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : "dash";

// ---------- render ----------

function render() {
  if (!state.shop) return;
  $("#auth").hidden = true;
  $("#app").hidden = false;
  const lo = state.items.filter((i) => +i.qty < +i.min_qty).length,
    po = state.orders.filter((o) => o.status == "pending").length,
    days = Math.ceil((new Date(state.shop.plan_until) - Date.now()) / 864e5);

  $("#shopname").textContent = state.shop.name;
  $("#nav").innerHTML = `<h6>NAVIGATION</h6><div>${N.map(
    ([k, t, i]) =>
      `<a class="${k == view ? "on" : ""}" href="#${k}"><i>${i}</i>${t}${
        k == "inv" ? `<em>${state.items.length}</em>` : k == "ord" ? `<em>${po}</em>` : ""
      }</a>`,
  ).join("")}</div>`;
  $("#eng").innerHTML = `<div>Status<b>${state.online ? "● Online" : "○ Offline"}</b></div><p class="plan ${
    days <= 0 ? "expired" : ""
  }">${
    days <= 0
      ? "Plan expired – read-only"
      : `${state.shop.plan == "paid" ? "Paid plan" : "Free trial"} · ${days} day${days == 1 ? "" : "s"} left`
  }</p>`;

  // Don't wipe the camera view or an input the user is typing in.
  if (view == "scan" && scanner.active()) return;
  const focused = document.activeElement;
  if (focused && $("#main").contains(focused) && focused.matches("input,select")) {
    if (view == "inv") $("#tb").innerHTML = invRows(state);
    return;
  }
  if ($("#dlg").open) return;

  const [, title, , sub] = N.find((n) => n[0] == view);
  $("#main").innerHTML = `<div class="card top"><div><h2>${title}</h2><p>${sub}</p></div><div class="r"><button class="b" data-act="addItem">＋ Add product</button><button class="g" data-act="quickScan">📷 Quick scan</button></div></div>${
    !canWrite()
      ? `<div class="card warn">Your plan has expired. You can view and export your data; contact us to renew.</div>`
      : ""
  }${
    state.settings.low_alert && lo && view != "auto"
      ? `<div class="card warn">⚠ ${lo} product${lo == 1 ? "" : "s"} below minimum stock</div>`
      : ""
  }${VIEWS[view](state)}`;
  if (view == "rep") conv();
}
store.onChange(render);

async function go(v, camOn) {
  await scanner.cam(false);
  view = v;
  if (location.hash.slice(1) != v) history.replaceState(null, "", "#" + v);
  render();
  (innerWidth <= 900 ? $("#main") : document.body).scrollIntoView();
  if (camOn) scanner.cam(true);
}
addEventListener("hashchange", () => VIEWS[location.hash.slice(1)] && go(location.hash.slice(1)));

// ---------- actions ----------

const needWrite = () => {
  if (canWrite()) return true;
  toast("Your plan has expired. Data is read-only.", true);
  return false;
};

async function itemForm(id, code) {
  if (!needWrite()) return;
  const i = state.items.find((x) => x.id == id) || {
    sku: code || "",
    barcode: code || "",
    name: "",
    category: "",
    qty: 0,
    min_qty: 0,
    cost: 0,
  };
  const f = await form(id ? "Edit product" : "Add product", [
    { k: "sku", label: "SKU code", value: i.sku, required: true },
    { k: "name", label: "Product name", value: i.name, required: true },
    { k: "category", label: "Category", value: i.category },
    { k: "barcode", label: "Barcode / QR code (blank = SKU)", value: i.barcode ?? "" },
    { k: "qty", label: "Quantity in stock", type: "number", value: +i.qty },
    { k: "min_qty", label: "Minimum stock", type: "number", value: +i.min_qty },
    { k: "cost", label: "Unit cost (LAK)", type: "number", value: +i.cost },
  ]);
  if (!f) return;
  await store.saveItem(id, f);
  toast(id ? "Product saved" : "Product added");
}

const A = {
  addItem: (el) => itemForm(null, el.dataset.code),
  editItem: (el) => itemForm(el.dataset.id),
  async delItem(el) {
    const it = state.items.find((x) => x.id == el.dataset.id);
    if (!needWrite() || !confirm(`Delete ${it.sku} – ${it.name}? Its orders are deleted too.`)) return;
    await store.deleteItem(it.id);
    toast("Deleted");
  },
  async adj(el) {
    if (!needWrite()) return;
    const it = state.items.find((x) => x.id == el.dataset.id),
      dir = +el.dataset.dir,
      f = await form(`${dir > 0 ? "Add" : "Remove"} stock – ${it.sku}`, [
        { k: "q", label: `How many units? (now ${+it.qty})`, type: "number", value: 1, required: true },
      ]);
    const q = f && +f.q;
    if (!q || q < 0) return;
    await store.adjust(it.id, dir * q);
    toast(`${it.sku}: ${dir > 0 ? "+" : "−"}${q}`);
  },
  async addOrder() {
    if (!needWrite()) return;
    const item_id = $("#o_s").value,
      qty = +$("#o_q").value;
    if (!item_id || !(qty > 0)) return toast("Pick a product and enter a quantity", true);
    await store.addOrder({ item_id, qty, type: $("#o_t").value, party: $("#o_p").value.trim() });
    toast("Order created");
  },
  async doneOrder(el) {
    if (!needWrite()) return;
    await store.completeOrder(el.dataset.id);
    toast("Order completed, stock updated");
  },
  async delOrder(el) {
    if (!needWrite() || !confirm("Delete this order?")) return;
    await store.deleteOrder(el.dataset.id);
  },
  quickScan: () => go("scan", true),
  scanView: () => go("scan"),
  camOn: () => scanner.cam(true),
  camOff: () => scanner.cam(false),
  export: (el) => exportSet(state, el.dataset.set, el.dataset.fmt),
  zip: () => exportZip(state),
  rates: () => refreshRates(),
  async erase() {
    if (
      !needWrite() ||
      !confirm(`Erase ALL products, orders and history of “${state.shop.name}”?`) ||
      prompt('Type ERASE to confirm') !== "ERASE"
    )
      return;
    await store.eraseAll();
    toast("All data erased");
  },
  signOut: () => store.signOut(),
};

const INPUT = {
  search(el) {
    invUi.q = el.value;
    $("#tb").innerHTML = invRows(state);
  },
  conv,
  async setting(el) {
    await store.setSetting(el.dataset.key, el.checked);
  },
  async importCsv(el) {
    const f = el.files[0];
    el.value = "";
    if (!f || !needWrite()) return;
    const list = csvToItems(await f.text());
    if (!list.length) return toast("No products found in this file", true);
    const n = await store.importItems(list);
    toast(n ? `Imported ${n} new product${n == 1 ? "" : "s"}` : "All SKUs in this file already exist");
  },
};

// One delegated handler for every button; errors become a toast.
const run = async (fn, el) => {
  if (el.tagName == "BUTTON") el.disabled = true;
  try {
    await fn(el);
  } catch (e) {
    toast(e.message || String(e), true);
  } finally {
    if (el.tagName == "BUTTON") el.disabled = false;
  }
};
document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-act]");
  if (el && A[el.dataset.act]) run(A[el.dataset.act], el);
});
document.addEventListener("input", (ev) => {
  const k = ev.target.dataset?.input;
  if (k == "search" || k == "conv") INPUT[k](ev.target);
});
document.addEventListener("change", (ev) => {
  const k = ev.target.dataset?.input;
  if (k == "setting" || k == "importCsv" || (k == "conv" && ev.target.tagName == "SELECT")) run(INPUT[k], ev.target);
});
document.addEventListener("keydown", (ev) => {
  if (ev.key == "Enter" && ev.target.dataset?.input == "manualScan") {
    scanner.onScan(ev.target.value);
    ev.target.value = "";
  }
});

// ---------- start ----------

async function enter() {
  const shops = await store.myShops();
  if (!shops.length) return showCreateShop(enter);
  const m = shops.find((x) => x.shops.id == localStorage.lastShop) || shops[0];
  await store.openShop(m);
  if (view == "rep") refreshRates();
}

const tick = () =>
  ($("#clk").textContent = new Date().toLocaleDateString("en-US") + " " + new Date().toLocaleTimeString("en-US"));
tick();
setInterval(tick, 1000);

if (!store.configured) {
  // No Supabase keys in .env: run the in-browser demo backend.
  state.user = { id: "local", email: "local demo (this browser only)" };
  enter().catch((e) => toast(e.message, true));
} else {
  store.sb.auth.onAuthStateChange((ev, session) => {
    // Supabase advises not awaiting its calls inside this callback.
    setTimeout(async () => {
      if (!session) {
        Object.assign(state, { user: null, shop: null, items: [], orders: [], movements: [] });
        await scanner.cam(false);
        return showAuth();
      }
      if (state.user?.id == session.user.id && state.shop) return;
      state.user = session.user;
      try {
        await enter();
      } catch (e) {
        toast(e.message, true);
      }
    });
  });
}
