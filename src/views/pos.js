// The till. Scan or search to add products, take cash or a transfer, print a
// receipt. The cart lives here, not in the shop data, and this screen updates
// its own pieces: a till always has a field in focus, which would otherwise
// stop the page redrawing.
import { $, E, fmt, num, dt, toast, dateText } from "../lib/util.js";
import { t, tn, fTime } from "../i18n/index.js";
import * as store from "../data/store.js";
import { state, isOwner, canWrite } from "../data/store.js";
import { lookupCode, status } from "../lib/expiry.js";
import { receiptHtml, printReceipt } from "../lib/receipt.js";
import { isQr } from "../lib/camera.js";
import { linePrice, priceOf, vatOf, saleNo } from "../data/apply.js";

// cid: this sale's id for the database, made once and kept across retries, so
// a sale resent after a dropped connection is not sold twice. Any change to
// the cart makes it a different sale, with a new id.
// A cart line: { k, id, qty, pack, exp }. pack: a pack id (qty counts packs);
// exp: the expiry date of a batch sold at its expiring price. k tells lines apart.
// cust: the customer's id, or null for a walk-in.
const st = { cart: [], discount: "", method: "cash", paid: "", cid: null, q: "", cust: null };

const item = (id) => state.items.find((i) => i.id == id);
const keyOf = (id, pack, exp) => [id, pack || "", exp || ""].join("|");
const packOf = (l) => (l.pack ? state.packs.find((p) => p.id == l.pack) : null);
// The line's price as create_sale() will work it out; null when it can't be priced.
const priceLine = (it, l) => {
  try {
    return priceOf(state, it, { qty: l.qty, pack_id: l.pack, expiry: l.exp });
  } catch {
    return { price: 0, ws: false, pack: null, base: l.qty };
  }
};
// The cheapest batch of a product with an expiring price, if any.
const cutLot = (it) =>
  state.lots.filter((x) => x.item_id == it.id && x.price != null).sort((a, b) => a.price - b.price)[0] || null;

// linePrice: the same rule as create_sale() in the database; shown here, decided there.
export { linePrice };

function totals() {
  let sub = 0,
    problems = 0;
  const need = new Map(); // units each product needs, packs counted out
  for (const l of st.cart) {
    const it = item(l.id);
    if (!it) continue;
    const { price: p, base } = priceLine(it, l);
    sub += p * l.qty;
    need.set(it.id, (need.get(it.id) || 0) + base);
    if (!(p > 0)) problems++;
  }
  // Offline, the count on this device can be behind (another till received
  // stock): the goods are in the customer's hand, so the sale goes ahead and
  // the server flags it if the stock really wasn't there.
  if (state.online) for (const [id, n] of need) if (n > +item(id).qty) problems++;
  const discount = Math.min(Math.max(+st.discount || 0, 0), sub),
    total = sub - discount,
    paid = st.method == "cash" ? +st.paid || 0 : total;
  return { sub, discount, total, paid, change: paid - total, problems, need };
}

const changed = () => {
  st.cid = null;
  refresh();
};

export function add(id, qty = 1, pack = null, exp = null) {
  const it = item(id);
  if (!it) return;
  const k = keyOf(id, pack, exp),
    l = st.cart.find((x) => x.k == k);
  if (l) l.qty += qty;
  else st.cart.unshift({ k, id, qty, pack, exp });
  st.q = "";
  const q = $("#pq");
  if (q) q.value = "";
  changed();
}

/** A scanned or typed code: find the product and add it. */
export function addCode(code, format) {
  code = String(code || "").trim();
  if (!code) return;
  const { item: it, pack } = lookupCode(state.items, code, state.packs);
  if (it) return add(it.id, 1, pack?.id ?? null);
  // A camera QR that is no product (a payment slip, a link): say so, don't search names.
  if (isQr(format)) return toast(t("scan.qrText", { text: code.slice(0, 60) }), true);
  // Not a code: the first product whose name matches what was typed.
  const m = matches(code);
  if (m.length == 1 || (m.length && code.length >= 3)) return add(m[0].id);
  toast(t("pos.notFound", { code }), true);
}

function matches(q) {
  q = q.toLowerCase();
  if (!q) return [];
  return state.items
    .filter((i) => [i.sku, i.name, i.barcode, i.category].join(" ").toLowerCase().includes(q))
    .slice(0, 8);
}

export const setQty = (k, q) => {
  const l = st.cart.find((x) => x.k == k);
  if (!l) return;
  q = Math.round(+q * 1000) / 1000;
  if (q > 0) l.qty = q;
  else st.cart = st.cart.filter((x) => x != l);
  changed();
};
export const inc = (k, d) => {
  const l = st.cart.find((x) => x.k == k);
  if (l) setQty(k, l.qty + d);
};
/** Switch a line between the normal price and its batch's expiring price. */
export function toggleCut(k) {
  const l = st.cart.find((x) => x.k == k),
    it = l && item(l.id);
  if (!it || l.pack) return;
  const lot = l.exp ? null : cutLot(it);
  st.cart = st.cart.filter((x) => x != l);
  add(it.id, l.qty, null, lot ? lot.expiry : null);
}
export const remove = (id) => setQty(id, 0);
export const clear = () => {
  st.cart = [];
  st.discount = st.paid = "";
  st.cust = null;
  changed();
  for (const s of ["#pdisc", "#ppaid"]) if ($(s)) $(s).value = "";
};
// The customer box: what the datalist offers, and the customer it names.
const custLabel = (c) => c.name + (c.phone ? " · " + c.phone : "");
export function setCustomer(id) {
  st.cust = id;
  const box = $("#pcust");
  if (box) (box.value = ""), box.blur(); // let refresh() swap the box for the name
  refresh();
}
export function setMethod(m) {
  st.method = m;
  refresh();
}
export function quick(v) {
  st.paid = String(v);
  $("#ppaid").value = st.paid;
  refresh();
}
export function typed(el) {
  if (el.id == "pq") {
    st.q = el.value;
    return suggest();
  }
  if (el.id == "pcust") {
    const v = el.value.trim().toLowerCase(),
      c = v && state.customers.find((x) => custLabel(x).toLowerCase() == v || x.phone == el.value.trim());
    if (c) setCustomer(c.id);
    return;
  }
  if (el.id == "pdisc") st.discount = el.value;
  if (el.id == "ppaid") st.paid = el.value;
  if (el.dataset.qty) return setQty(el.dataset.qty, el.value);
  if (el.id == "pdisc") st.cid = null;
  refresh();
}

function suggest() {
  const box = $("#psug");
  if (!box) return;
  box.innerHTML = matches(st.q)
    .map(
      (i) =>
        `<button class="g" data-act="posAdd" data-id="${E(i.id)}"><b>${E(i.name)}</b><small>${E(i.sku)} · ${fmt(
          i.price,
        )} · ${t("pos.inStock", { n: num(i.qty) })}</small></button>`,
    )
    .join("");
}

// With a server, only a device registered as a till sells (004_till_limit.sql).
const noTill = () => store.configured && !store.myTill();
const tillProblem = () => t(state.tillFull ? "err.tillFull" : "err.noTill", { max: state.shop?.max_tills ?? "" });

export async function charge() {
  if (!canWrite()) return toast(t("err.readonly"), true);
  if (noTill()) return toast(tillProblem(), true);
  const tt = totals();
  if (!st.cart.length) return toast(t("err.emptySale"), true);
  if (st.method == "cash" && tt.paid < tt.total) {
    $("#ppaid")?.focus();
    return toast(t("err.cashShort"), true);
  }
  st.cid ||= crypto.randomUUID();
  const sale = await store.createSale({
    client_id: st.cid,
    lines: st.cart.map((l) => ({ item_id: l.id, qty: l.qty, pack_id: l.pack, expiry: l.exp })),
    discount: tt.discount,
    method: st.method,
    paid: tt.paid,
    customer_id: st.cust,
  });
  clear();
  if (sale?.pending) toast(t("sync.savedHere"));
  showReceipt(sale.client_id);
}

// Receipts are found by the till's id for the sale (client_id), which stays
// the same when a sale made offline reaches the server and gets its own id.
const find = (cid) => state.sales.find((x) => x.client_id == cid || x.id == cid);

export function showReceipt(cid) {
  const sale = find(cid);
  if (!sale) return;
  const id = sale.client_id,
    lines = state.saleLines.filter((l) => l.sale_id == sale.id),
    html = receiptHtml(state.shop, sale, lines, state.customers.find((c) => c.id == sale.customer_id)),
    dlg = $("#dlg");
  dlg.innerHTML = `${html}<div class="row mt"><button class="b" data-act="posPrint" data-id="${E(id)}">${t(
    "pos.print",
  )}</button><button class="g" data-act="closeDlg">${t(sale.status == "void" ? "btn.close" : "pos.next")}</button></div>`;
  dlg.showModal();
  dlg.querySelector(".b").focus();
}

export function printSale(cid) {
  const sale = find(cid);
  if (sale)
    printReceipt(
      receiptHtml(
        state.shop,
        sale,
        state.saleLines.filter((l) => l.sale_id == sale.id),
        state.customers.find((c) => c.id == sale.customer_id),
      ),
    );
}

export async function voidIt(cid) {
  const sale = find(cid);
  if (!sale || !confirm(t("pos.askVoid", { n: saleNo(sale), total: fmt(sale.total) }))) return;
  await store.voidSale(sale.id);
  toast(t("pos.voided", { n: saleNo(sale) }));
}

// ---------- drawing ----------

function cartHtml(need) {
  if (!st.cart.length) return `<p class="mut c pad">${t("pos.empty")}</p>`;
  return `<table class="cart">${st.cart
    .map((l) => {
      const it = item(l.id);
      if (!it) return "";
      const { price, ws } = priceLine(it, l),
        pack = packOf(l),
        cut = !l.pack && cutLot(it),
        expired = state.lots.find((x) => x.item_id == it.id && status(x.expiry) == "expired"),
        k = E(l.k),
        notes = [
          pack ? `<span class="tag">${E(pack.name)} × ${num(pack.size)}${it.unit ? " " + E(it.unit) : ""}</span>` : "",
          ws ? `<span class="tag in">${t("pos.wholesale")}</span>` : "",
          l.exp ? `<span class="tag warn">${t("pos.cutTag", { d: dateText(l.exp) })}</span>` : "",
          // A batch of this product sells for less: one tap switches the line to it.
          cut
            ? `<button class="g" data-act="posCut" data-id="${k}">${
                l.exp ? t("pos.cutOff") : t("pos.cutOn", { p: fmt(cut.price), n: num(cut.qty) })
              }</button>`
            : "",
          (need.get(it.id) || 0) > +it.qty ? `<span class="bad">${t("pos.onlyN", { n: num(it.qty) })}</span>` : "",
          price > 0 ? "" : `<span class="bad">${t("pos.noPrice")}</span>`,
          expired ? `<span class="warn">${t("pos.expiredStock", { d: dateText(expired.expiry) })}</span>` : "",
        ].join(" ");
      return `<tr><td class="nm"><b>${E(it.name)}</b><br><small class="mut">${E(it.sku)} · ${fmt(
        price,
      )}</small> ${notes}</td><td class="qty"><button class="g" data-act="posDec" data-id="${k}">−</button><input type="number" min="0" step="any" value="${l.qty}" data-input="pos" data-qty="${k}"><button class="g" data-act="posInc" data-id="${k}">＋</button></td><td class="lt">${fmt(
        price * l.qty,
      )}</td><td><button class="g" data-act="posDel" data-id="${k}" title="${E(t("tip.delete"))}">✕</button></td></tr>`;
    })
    .join("")}</table>`;
}

// Notes a cashier hands over: 5,000 up to 100,000 kip.
const NOTES = [10000, 20000, 50000, 100000];

function quickHtml(total) {
  const up = new Set([total]);
  for (const n of NOTES) if (total > 0) up.add(Math.ceil(total / n) * n);
  return [...up]
    .filter((v) => v > 0)
    .sort((a, b) => a - b)
    .slice(0, 4)
    .map((v) => `<button class="g" data-act="posQuick" data-v="${v}">${fmt(v)}</button>`)
    .join("");
}

const isToday = (iso) => new Date(iso).toDateString() == new Date().toDateString();

function salesHtml() {
  const today = state.sales.filter((x) => isToday(x.created_at)),
    ok = today.filter((x) => x.status != "void"),
    sum = (L) => L.reduce((a, x) => a + +x.total, 0),
    count = new Map();
  for (const l of state.saleLines) count.set(l.sale_id, (count.get(l.sale_id) || 0) + +l.qty);
  return `<h3>${t("pos.today")}<small>${tn("pos.todaySum", ok.length, {
    total: fmt(sum(ok)),
    cash: fmt(sum(ok.filter((x) => x.method == "cash"))),
    transfer: fmt(sum(ok.filter((x) => x.method != "cash"))),
  })}</small></h3>${
    today.length
      ? `<table class="rt">${today
          .map(
            (x) =>
              `<tr class="${x.status == "void" ? "void" : ""}"><td data-l="${E(t("th.receipt"))}"><b>#${E(saleNo(x))}</b>${
                x.pending ? ` <span class="tag wait">${t("sync.tag")}</span>` : ""
              }</td><td data-l="${E(
                t("th.time"),
              )}">${fTime(x.created_at, false)}</td><td data-l="${E(t("th.qty"))}">${num(
                count.get(x.id) || 0,
              )}</td><td data-l="${E(t("th.total"))}">${fmt(x.total)}</td><td data-l="${E(t("th.method"))}">${t(
                x.status == "void" ? "pos.voidTag" : x.method == "cash" ? "pos.cash" : "pos.transfer",
              )}</td><td class="act"><button class="g" data-act="posReceipt" data-id="${E(x.client_id)}" title="${E(
                t("pos.receipt"),
              )}">🧾</button>${
                isOwner() && x.status != "void"
                  ? ` <button class="g" data-act="posVoid" data-id="${E(x.client_id)}">${t("pos.void")}</button>`
                  : ""
              }</td></tr>`,
          )
          .join("")}</table>`
      : `<p class="mut mt">${t("pos.noSales")}</p>`
  }`;
}

/** Redraw the parts that change, never the fields being typed in. */
export function refresh() {
  if (!$("#pos")) return;
  const tt = totals(),
    focus = document.activeElement;
  // Not while a qty is being typed: redrawing would drop the cursor.
  if (!($("#cart").contains(focus) && focus.tagName == "INPUT")) $("#cart").innerHTML = cartHtml(tt.need);
  $("#psub").textContent = fmt(tt.sub);
  $("#ptot").textContent = fmt(tt.total);
  const rate = +state.settings.vat_rate || 0;
  if ($("#pvat")) $("#pvat").textContent = rate ? t("pos.vatIn", { r: rate, v: fmt(vatOf(tt.total, rate)) }) : "";
  $("#pchg").textContent = tt.change >= 0 ? fmt(tt.change) : "−" + fmt(-tt.change);
  $("#pchg").className = "n " + (tt.change >= 0 ? "in" : "bad");
  $("#pcashbox").hidden = st.method != "cash";
  $("#pquick").innerHTML = quickHtml(tt.total);
  document.querySelectorAll("[data-act=posMethod]").forEach((b) => b.classList.toggle("on", b.dataset.m == st.method));
  $("#ptill").hidden = !noTill();
  $("#ptill").textContent = noTill() ? tillProblem() : "";
  $("#pcharge").disabled =
    noTill() ||
    !st.cart.length || tt.problems > 0 || (st.method == "cash" && tt.paid < tt.total);
  const who = st.cust && state.customers.find((c) => c.id == st.cust);
  if (st.cust && !who) st.cust = null; // deleted meanwhile
  const cb = $("#pcustbox");
  const custHtml = who
      ? `<div class="sh">${t("pos.customer")}<span><b>${E(who.name)}</b> <button class="g" data-act="posNoCust" title="${E(
          t("pos.noCust"),
        )}">✕</button></span></div>`
      : `<label>${t("pos.customer")}<span class="tools"><input id="pcust" list="pcustl" data-input="pos" autocomplete="off" placeholder="${E(
          t("pos.custPh"),
        )}"><button class="g" data-act="posNewCust" title="${E(t("cust.add"))}">＋</button></span></label><datalist id="pcustl">${state.customers
          .map((c) => `<option value="${E(custLabel(c))}"></option>`)
          .join("")}</datalist>`;
  // Only when it changed, so a half-typed name and the open suggestion list survive.
  if (cb && cb.dataset.html != custHtml && !cb.contains(document.activeElement)) {
    cb.innerHTML = custHtml;
    cb.dataset.html = custHtml;
  }
  $("#pcount").textContent = st.cart.length ? t("pos.lines", { n: [...tt.need.values()].reduce((a, n) => a + n, 0) }) : "";
  $("#psales").innerHTML = salesHtml();
}

export default function pos() {
  queueMicrotask(() => {
    refresh();
    suggest();
  });
  return `<div id="pos" class="pos"><div><div class="card"><div class="tools"><input id="pq" data-input="pos" autocomplete="off" placeholder="${E(
    t("pos.search"),
  )}" value="${E(st.q)}"><button class="g" data-act="posCam">${t("pos.cam")}</button></div><div id="psug" class="sug"></div><div id="rd"></div></div><div class="card ts"><h3>${t(
    "pos.cart",
  )}<small id="pcount"></small></h3><div id="cart"></div></div></div><div class="card pay"><div id="pcustbox"></div><div class="sh">${t(
    "pos.subtotal",
  )}<b id="psub"></b></div><label class="mt">${t("pos.discount")}<input id="pdisc" type="number" min="0" step="any" data-input="pos" value="${E(
    st.discount,
  )}" placeholder="0"></label><div class="sh">${t("pos.total")}</div><b class="n big" id="ptot"></b><small class="mut" id="pvat"></small><div class="row seg"><button class="g" data-act="posMethod" data-m="cash">${t(
    "pos.cash",
  )}</button><button class="g" data-act="posMethod" data-m="transfer">${t(
    "pos.transfer",
  )}</button></div><div id="pcashbox"><label class="mt">${t(
    "pos.received",
  )}<input id="ppaid" type="number" min="0" step="any" data-input="pos" value="${E(
    st.paid,
  )}" placeholder="0"></label><div class="row quick" id="pquick"></div><div class="sh mt">${t(
    "pos.change",
  )}</div><b class="n" id="pchg"></b></div><p class="plan expired mt" id="ptill" hidden></p><button class="b charge" id="pcharge" data-act="posCharge">${t(
    "pos.charge",
  )}</button><button class="g mt" data-act="posClear">${t("pos.clear")}</button></div><div class="card ts wide" id="psales"></div></div>`;
}
