import "./styles.css";
import { $, E, toast, form } from "./lib/util.js";
import { t, tn, errText, setLang, other, applyStatic, locale } from "./i18n/index.js";
import { csvToItems } from "./lib/csv.js";
import { exportSet, exportZip } from "./lib/export.js";
import * as store from "./data/store.js";
import { state, canWrite, isOwner } from "./data/store.js";
import { showAuth, showCreateShop, showNewPassword } from "./auth.js";
import * as scanner from "./scanner.js";
import dash from "./views/dash.js";
import inv, { ui as invUi, rows as invRows } from "./views/inv.js";
import ord from "./views/ord.js";
import scan from "./views/scan.js";
import rep, { conv, refreshRates } from "./views/rep.js";
import auto from "./views/auto.js";
import sys from "./views/sys.js";

const VIEWS = { dash, inv, ord, scan, rep, auto, sys };
// [view key, icon]; the label and subtitle come from nav.<key> / nav.<key>.sub
const N = [
  ["dash", "◔"],
  ["inv", "▦"],
  ["ord", "⛟"],
  ["scan", "▥"],
  ["rep", "▤"],
  ["auto", "⚙"],
  ["sys", "☰"],
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
  $("#nav").innerHTML = `<h6>${t("nav.title")}</h6><div>${N.map(
    ([k, i]) =>
      `<a class="${k == view ? "on" : ""}" href="#${k}"><i>${i}</i>${t("nav." + k)}${
        k == "inv" ? `<em>${state.items.length}</em>` : k == "ord" ? `<em>${po}</em>` : ""
      }</a>`,
  ).join("")}</div>`;
  $("#eng").innerHTML = `<div>${t("eng.status")}<b>${t(
    state.online ? "eng.online" : "eng.offline",
  )}</b></div><p class="plan ${days <= 0 ? "expired" : ""}">${
    days <= 0
      ? t("plan.expiredShort")
      : tn("plan.left", days, { plan: t(state.shop.plan == "paid" ? "plan.paid" : "plan.trial") })
  }</p>`;

  // Don't wipe the camera view or an input the user is typing in.
  if (view == "scan" && scanner.active()) return;
  const focused = document.activeElement;
  if (focused && $("#main").contains(focused) && focused.matches("input,select")) {
    if (view == "inv") $("#tb").innerHTML = invRows(state);
    return;
  }
  if ($("#dlg").open) return;

  $("#main").innerHTML = `<div class="card top"><div><h2>${t("nav." + view)}</h2><p>${t(
    "nav." + view + ".sub",
  )}</p></div><div class="r"><button class="b" data-act="addItem">${t(
    "btn.addItem",
  )}</button><button class="g" data-act="quickScan">${t("btn.quickScan")}</button></div></div>${
    !canWrite() ? `<div class="card warn">${t("plan.expiredCard")}</div>` : ""
  }${
    // Only on the screens built from orders/movements; products are never capped.
    state.truncated && ["dash", "ord", "rep"].includes(view)
      ? `<div class="card warn">${t("msg.truncated")}</div>`
      : ""
  }${
    state.settings.low_alert && lo && view != "auto"
      ? `<div class="card warn">${tn("msg.low", lo)}</div>`
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
  toast(t("err.readonly"), true);
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
    price: 0,
    price_wholesale: 0,
    wholesale_min_qty: 0,
  };
  const f = await form(t(id ? "title.editItem" : "title.addItem"), [
    { k: "sku", label: t("f.sku"), value: i.sku, required: true },
    { k: "name", label: t("f.name"), value: i.name, required: true },
    { k: "category", label: t("f.category"), value: i.category },
    { k: "barcode", label: t("f.barcode"), value: i.barcode ?? "" },
    { k: "qty", label: t("f.qty"), type: "number", value: +i.qty },
    { k: "min_qty", label: t("f.min"), type: "number", value: +i.min_qty },
    { k: "cost", label: t("f.cost"), type: "number", value: +i.cost },
    { k: "price", label: t("f.price"), type: "number", value: +i.price || 0 },
    { k: "price_wholesale", label: t("f.wprice"), type: "number", value: +i.price_wholesale || 0 },
    { k: "wholesale_min_qty", label: t("f.wmin"), type: "number", value: +i.wholesale_min_qty || 0 },
  ]);
  if (!f) return;
  await store.saveItem(id, f);
  toast(t(id ? "msg.itemSaved" : "msg.itemAdded"));
}

const A = {
  addItem: (el) => itemForm(null, el.dataset.code),
  editItem: (el) => itemForm(el.dataset.id),
  async delItem(el) {
    const it = state.items.find((x) => x.id == el.dataset.id);
    if (!needWrite() || !confirm(t("ask.delItem", { sku: it.sku, name: it.name }))) return;
    await store.deleteItem(it.id);
    toast(t("msg.deleted"));
  },
  async adj(el) {
    if (!needWrite()) return;
    const it = state.items.find((x) => x.id == el.dataset.id),
      dir = +el.dataset.dir,
      f = await form(t(dir > 0 ? "title.addStock" : "title.removeStock", { sku: it.sku }), [
        { k: "q", label: t("f.howMany", { qty: +it.qty }), type: "number", value: 1, required: true },
      ]);
    const q = f && +f.q;
    if (!q || q < 0) return;
    await store.adjust(it.id, dir * q);
    toast(t("msg.adjusted", { sku: it.sku, sign: dir > 0 ? "+" : "−", q }));
  },
  async addOrder() {
    if (!needWrite()) return;
    const item_id = $("#o_s").value,
      qty = +$("#o_q").value;
    if (!item_id || !(qty > 0)) return toast(t("msg.pickProduct"), true);
    await store.addOrder({ item_id, qty, type: $("#o_t").value, party: $("#o_p").value.trim() });
    toast(t("msg.orderCreated"));
  },
  async doneOrder(el) {
    if (!needWrite()) return;
    await store.completeOrder(el.dataset.id);
    toast(t("msg.orderDone"));
  },
  async delOrder(el) {
    if (!needWrite() || !confirm(t("ask.delOrder"))) return;
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
      !confirm(t("ask.erase", { shop: state.shop.name })) ||
      prompt(t("ask.eraseType")) !== "ERASE"
    )
      return;
    await store.eraseAll();
    toast(t("msg.erased"));
  },
  signOut: () => store.signOut(),
  lang: () => switchLang(other()),
  top: () => scrollTo({ top: 0, behavior: "smooth" }),
};

// Language is only ever a redraw: every view reads t() at render time.
function switchLang(l) {
  setLang(l);
  applyStatic();
  tick();
  if (state.shop) render();
}

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
    if (!list.length) return toast(t("msg.importEmpty"), true);
    const n = await store.importItems(list);
    toast(n ? tn("msg.imported", n) : t("msg.importNone"));
  },
  lang: (el) => switchLang(el.value),
};

// One delegated handler for every button; errors become a toast.
const run = async (fn, el) => {
  if (el.tagName == "BUTTON") el.disabled = true;
  try {
    await fn(el);
  } catch (e) {
    toast(errText(e), true);
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
  if (k == "setting" || k == "importCsv" || k == "lang" || (k == "conv" && ev.target.tagName == "SELECT"))
    run(INPUT[k], ev.target);
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

const tick = () => {
  const d = new Date();
  $("#clk").textContent = d.toLocaleDateString(locale()) + " " + d.toLocaleTimeString(locale());
};
applyStatic();
tick();
setInterval(tick, 1000);

if (!store.configured) {
  // No Supabase keys in .env: run the in-browser demo backend.
  state.user = { id: "local", email: t("auth.localUser") };
  enter().catch((e) => toast(errText(e), true));
} else {
  // A password-reset link arrives as #type=recovery and carries a real session,
  // so without this guard the app would walk straight past the new-password
  // screen. Read the hash now: supabase-js clears it once it has parsed it.
  let recovering = /type=recovery/.test(location.hash),
    asked = false;
  store.sb.auth.onAuthStateChange((ev, session) => {
    if (ev == "PASSWORD_RECOVERY") recovering = true;
    if (!session) recovering = false; // expired or already-used link
    if (recovering) {
      if (asked) return; // the form is already on screen; don't wipe it
      asked = true;
      return showNewPassword(async () => {
        recovering = false;
        state.user = session.user;
        try {
          await enter();
        } catch (e) {
          toast(errText(e), true);
        }
      });
    }
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
        toast(errText(e), true);
      }
    });
  });
}
