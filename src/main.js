import "./styles.css";
// Lao glyphs, bundled with the app rather than fetched from a CDN, so Lao still
// renders with no internet. Only the Lao subset is pulled in: ~9 KB a weight.
import "@fontsource/noto-sans-lao/lao-400.css";
import "@fontsource/noto-sans-lao/lao-500.css";
import "@fontsource/noto-sans-lao/lao-600.css";
import "@fontsource/noto-sans-lao/lao-700.css";
import { $, E, toast, form, pickPhoto, checkExpiry, dateText } from "./lib/util.js";
import { t, tn, errText, setLang, other, applyStatic, fDateTime, fTime } from "./i18n/index.js";
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
import pos, * as till from "./views/pos.js";
import exp from "./views/exp.js";
import { status, SOON_DAYS } from "./lib/expiry.js";
import { MODEL_MB, isCached, identify, shrink, crashedBefore } from "./lib/identify.js";
import { detectImage } from "./lib/camera.js";

const VIEWS = { dash, pos, inv, exp, ord, scan, rep, auto, sys };
// [view key, icon]; the label and subtitle come from nav.<key> / nav.<key>.sub
const N = [
  ["dash", "◔"],
  ["pos", "₭"],
  ["inv", "▦"],
  ["exp", "⏳"],
  ["ord", "⛟"],
  ["scan", "▥"],
  ["rep", "▤"],
  ["auto", "⚙"],
  ["sys", "☰"],
];
let view = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : "dash";

// ---------- render ----------

// force: rebuild the till too (a language switch); otherwise it only refreshes.
function render(force) {
  if (!state.shop) return;
  $("#auth").hidden = true;
  $("#app").hidden = false;
  const expired = state.lots.filter((l) => status(l.expiry) == "expired").length,
    alerts = expired + state.lots.filter((l) => status(l.expiry) == "soon").length;
  const lo = state.items.filter((i) => +i.qty < +i.min_qty).length,
    po = state.orders.filter((o) => o.status == "pending").length,
    days = Math.ceil((new Date(state.shop.plan_until) - Date.now()) / 864e5);

  $("#shopname").textContent = state.shop.name;
  $("#nav").innerHTML = `<h6>${t("nav.title")}</h6><div>${N.map(
    ([k, i]) =>
      `<a class="${k == view ? "on" : ""}" href="#${k}"><i>${i}</i>${t("nav." + k)}${
        k == "inv"
          ? `<em>${state.items.length}</em>`
          : k == "ord"
            ? `<em>${po}</em>`
            : k == "exp" && alerts
              ? `<em class="warn">${alerts}</em>`
              : ""
      }</a>`,
  ).join("")}</div>`;
  $("#eng").innerHTML = `<div>${t("eng.status")}<b>${t(
    state.online ? "eng.online" : "eng.offline",
  )}</b></div><p class="plan ${days <= 0 ? "expired" : ""}">${
    days <= 0
      ? t("plan.expiredShort")
      : tn("plan.left", days, { plan: t(state.shop.plan == "paid" ? "plan.paid" : "plan.trial") })
  }</p>`;

  // Offline, or work not yet on the server: say so, and how old the data is.
  const sy = $("#sync"),
    failed = state.failed.length;
  sy.hidden = state.online && !state.pending && !failed;
  sy.className = "btn sync" + (state.online ? "" : " off") + (failed ? " bad" : "");
  sy.textContent = [
    state.online ? "" : t("sync.offline", { time: !state.savedAt ? "–" : new Date(state.savedAt).toDateString() == new Date().toDateString() ? fTime(state.savedAt, false) : fDateTime(state.savedAt) }),
    state.pending ? tn("sync.waiting", state.pending) : "",
    failed ? tn("sync.failed", failed) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  // The till draws its own changes, so a sale in progress is never wiped.
  if (view == "pos" && $("#pos") && !force) return till.refresh();
  // Don't wipe the camera view or an input the user is typing in.
  if (view == "scan" && scanner.active()) return;
  const focused = document.activeElement;
  if (focused && $("#main").contains(focused) && focused.matches("input,select")) {
    if (view == "inv") $("#tb").innerHTML = invRows(state);
    return;
  }
  if ($("#dlg").open && !force) return;

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
    expired && !["exp", "pos"].includes(view)
      ? `<div class="card warn">${t("msg.expired", { n: expired })} <a href="#exp">${t("msg.openExp")}</a></div>`
      : ""
  }${
    state.settings.low_alert && lo && !["auto", "pos"].includes(view)
      ? `<div class="card warn">${tn("msg.low", lo)}</div>`
      : ""
  }${VIEWS[view](state)}`;
  if (view == "rep") conv();
  if (view == "scan") syncScanView();
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
    kind: "durable",
    qty: 0,
    min_qty: 0,
    cost: 0,
    price: 0,
    price_wholesale: 0,
    wholesale_min_qty: 0,
  };
  const f = await form(t(id ? "title.editItem" : "title.addItem"), [
    { k: "sku", label: t("f.sku"), value: i.sku, required: true },
    {
      k: "name",
      label: t("f.name"),
      value: i.name,
      required: true,
      // "✓ AI ready" once the model is on this device and works offline.
      tools: [{ act: "identify", label: t((await isCached()) ? "btn.identifyReady" : "btn.identify") }],
    },
    { k: "category", label: t("f.category"), value: i.category },
    {
      k: "kind",
      label: t("f.kind"),
      type: "select",
      value: i.kind || "durable",
      options: [
        ["consumable", t("kind.consumableLong")],
        ["durable", t("kind.durableLong")],
      ],
    },
    { k: "barcode", label: t("f.barcode"), value: i.barcode ?? "" },
    { k: "qty", label: t("f.qty"), type: "number", value: +i.qty },
    {
      k: "expiry",
      label: t(id ? "f.expiryAdded" : "f.expiry"),
      type: "expiry",
      showIf: ["kind", "consumable"],
      tools: [{ act: "readDate", label: t("btn.readDate") }],
      hint: t("f.expiryHint"),
    },
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
      dated = dir > 0 && it.kind == "consumable",
      f = await form(t(dir > 0 ? "title.addStock" : "title.removeStock", { sku: it.sku }), [
        { k: "q", label: t("f.howMany", { qty: +it.qty }), type: "number", value: 1, required: true },
        ...(dated
          ? [
              {
                k: "expiry",
                label: t("f.expiry"),
                type: "expiry",
                tools: [{ act: "readDate", label: t("btn.readDate") }],
                hint: t("f.expiryHint"),
              },
            ]
          : []),
      ]);
    const q = f && +f.q;
    if (!q || q < 0) return;
    await store.adjust(it.id, dir * q, "manual", (dated && f.expiry) || null);
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
  // ---- expiry ----
  async readDate(el) {
    const box = el.form?.elements[el.dataset.for] || $("#" + el.dataset.for);
    const photo = await pickPhoto();
    if (!photo) return;
    const label = el.textContent;
    try {
      const { readExpiry } = await import("./lib/ocr.js");
      const r = await readExpiry(photo, (stage) => (el.textContent = t("ocr." + stage)));
      if (!r.expiry) return toast(t("ocr.none"), true);
      box.value = scanner.typedDate(r.expiry);
      checkExpiry(box);
      if (box.id == "sexp") scanner.dateTyped();
      toast(t("ocr.found", { d: dateText(r.expiry) }));
    } finally {
      el.textContent = label;
    }
  },
  async writeOff(el) {
    if (!needWrite()) return;
    const lot = state.lots.find((l) => l.id == el.dataset.id),
      it = lot && state.items.find((i) => i.id == lot.item_id);
    if (!it || !confirm(t("ask.writeOff", { n: +lot.qty, name: it.name, d: dateText(lot.expiry) }))) return;
    const n = +lot.qty; // read first: the lot is emptied by the write-off
    await store.writeOffLot(lot.id);
    toast(t("msg.writtenOff", { n, sku: it.sku }));
  },
  // ---- product photo: barcode + on-device model ----
  async identify(el) {
    const fm = el.form;
    // The camera must open first, straight from the tap: iPhone Safari ignores
    // a file picker opened after anything is awaited, and nothing happens.
    let photo = await pickPhoto();
    if (!photo) return;
    // Last time the page closed while the AI was working: say so, don't loop.
    if (crashedBefore() && !confirm(t("ai.crashed"))) return;
    if (!(await isCached()) && !confirm(t("ai.ask", { mb: MODEL_MB }))) return;
    let label = el.textContent;
    try {
      photo = await shrink(photo);
      // The same photo often shows the barcode: fill it in if the form has none.
      const codes = await detectImage(photo).catch(() => []);
      if (codes[0] && !fm.elements.barcode.value) {
        fm.elements.barcode.value = codes[0].rawValue;
        if (!fm.elements.sku.value) fm.elements.sku.value = codes[0].rawValue;
      }
      el.textContent = t("ai.loading");
      const mb = (b) => Math.round(b / 1e6);
      const r = await identify(
        photo,
        // At 100% the files are in but the model still has to start up.
        (p) =>
          (el.textContent =
            p.pct < 100 ? t("ai.download", { pct: p.pct, mb: mb(p.loaded), total: mb(p.total) }) : t("ai.loading")),
        () => (el.textContent = t("ai.thinking")),
      );
      label = t("btn.identifyReady");
      if (r.name) fm.elements.name.value = r.name;
      // The type is only filled when the name gives it away; otherwise the
      // person picks it, rather than the app guessing consumable or not.
      if (r.type) {
        if (!fm.elements.category.value) fm.elements.category.value = t("cat." + r.type);
        fm.elements.kind.value = r.kind;
        fm.elements.kind.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const s = (r.ms / 1000).toFixed(1);
      toast(r.type ? t("ai.done", { name: r.name, type: t("cat." + r.type), s }) : t("ai.pickType", { name: r.name, s }));
    } finally {
      el.textContent = label;
    }
  },
  // ---- offline work ----
  async syncNow() {
    if (!state.online) return toast(t("sync.stillOffline"), true);
    const out = await store.sync();
    toast(out.stopped ? t("sync.stillOffline") : tn("sync.sent", out.sent.length), out.stopped);
  },
  async retryFailed(el) {
    await store.retryFailed(el.dataset.id);
  },
  async discardFailed(el) {
    if (!confirm(t("sync.askDiscard"))) return;
    await store.discardFailed(el.dataset.id);
  },
  // ---- the till ----
  posAdd: (el) => till.add(el.dataset.id),
  posInc: (el) => till.inc(el.dataset.id, 1),
  posDec: (el) => till.inc(el.dataset.id, -1),
  posDel: (el) => till.remove(el.dataset.id),
  posClear: () => till.clear(),
  posMethod: (el) => till.setMethod(el.dataset.m),
  posQuick: (el) => till.quick(el.dataset.v),
  async posCharge() {
    try {
      await till.charge();
    } finally {
      setTimeout(till.refresh); // after run() re-enables the button, set it right
    }
  },
  posReceipt: (el) => till.showReceipt(el.dataset.id),
  posPrint: (el) => till.printSale(el.dataset.id),
  posVoid: (el) => till.voidIt(el.dataset.id),
  posCam: () => (scanner.active() ? scanner.cam(false) : scanner.cam(true, till.addCode)),
  closeDlg: () => $("#dlg").close(),
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
  // Queued work stays on this device and is sent after the next sign-in,
  // but nobody should leave a till believing it is already on the server.
  signOut: () => (!state.pending || confirm(tn("sync.askSignOut", state.pending))) && store.signOut(),
  lang: () => switchLang(other()),
  install: () => installApp(),
  top: () => scrollTo({ top: 0, behavior: "smooth" }),
};

// ---------- install as an app ----------
// Chrome offers an install button in the address bar, which most shop owners
// never notice, so put one in the header. The browser only lets us ask once it
// has decided the app qualifies, hence the saved event.
let installPrompt = null;
const installBtn = () => $("#install");

addEventListener("beforeinstallprompt", (ev) => {
  ev.preventDefault(); // keep the browser's own mini-bar from appearing
  installPrompt = ev;
  installBtn().hidden = false;
});
addEventListener("appinstalled", () => {
  installPrompt = null;
  installBtn().hidden = true;
});

async function installApp() {
  if (!installPrompt) return;
  const p = installPrompt;
  installPrompt = null; // the event can only be used once
  installBtn().hidden = true;
  await p.prompt();
  await p.userChoice;
  // Whether they accepted or not, this event is spent. The button stays hidden
  // until the browser offers another one, which it does on a later visit;
  // showing it again now would leave a button that does nothing.
}

// Language is only ever a redraw: every view reads t() at render time.
function switchLang(l) {
  setLang(l);
  applyStatic();
  tick();
  if (state.shop) render(true);
}

// The scanner's expiry box only matters when receiving.
function syncScanView() {
  const l = $("#sexpl");
  if (l) l.hidden = $("#mode").value != "in";
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
  invFilter(el) {
    invUi.f = el.value;
    $("#tb").innerHTML = invRows(state);
  },
  pos: (el) => till.typed(el),
  scanMode: () => syncScanView(),
  scanExpiry(el) {
    checkExpiry(el);
    scanner.dateTyped();
  },
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
  if (["search", "conv", "pos", "scanExpiry"].includes(k)) INPUT[k](ev.target);
});
document.addEventListener("change", (ev) => {
  const k = ev.target.dataset?.input;
  if (
    ["setting", "importCsv", "lang", "invFilter", "scanMode"].includes(k) ||
    (k == "conv" && ev.target.tagName == "SELECT")
  )
    run(INPUT[k], ev.target);
});
document.addEventListener("keydown", (ev) => {
  if (ev.key != "Enter") return;
  const el = ev.target;
  if (el.dataset?.input == "manualScan") {
    scanner.onScan(el.value);
    el.value = "";
  }
  // The till: a USB scanner types the code and presses Enter.
  if (el.id == "pq") {
    ev.preventDefault();
    till.addCode(el.value);
  }
  if (el.id == "ppaid" || el.id == "pdisc") {
    ev.preventDefault();
    run(A.posCharge, $("#pcharge"));
  }
  if (el.dataset?.qty) el.blur();
});

// ---------- start ----------

function storedSession() {
  try {
    const k = Object.keys(localStorage).find((x) => /^sb-.+-auth-token$/.test(x)),
      s = k && JSON.parse(localStorage[k]);
    return s?.user ? s : null;
  } catch {
    return null;
  }
}

async function enter() {
  let shops;
  try {
    shops = await store.myShops();
  } catch (e) {
    // No connection: open the copy of the shop kept on this device.
    if (await store.openCached()) return;
    throw e;
  }
  if (!shops.length) return showCreateShop(enter);
  const m = shops.find((x) => x.shops.id == localStorage.lastShop) || shops[0];
  await store.openShop(m);
  if (view == "rep") refreshRates();
}

const tick = () => {
  const d = new Date();
  $("#clk").textContent = fDateTime(d);
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
      // Offline with a login that needs renewing: supabase-js can't renew it
      // without the network and reports no session, but it is still stored.
      // Work from it; it is renewed when the network returns.
      if (!session && !navigator.onLine && ev != "SIGNED_OUT") session = storedSession();
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
