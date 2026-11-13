import { $, E, toast, form, dateText, expiryNote, checkExpiry } from "./lib/util.js";
import { t, errText } from "./i18n/index.js";
import { state, adjust } from "./data/store.js";
import * as camera from "./lib/camera.js";
import { lookupCode, parseTyped, status } from "./lib/expiry.js";

let last = "",
  lt = 0,
  expFor = null; // the product the date in the scanner's expiry box was entered for

export const active = camera.active;

/** Camera on or off in the #rd box of the current screen. `handler` gets each code. */
export async function cam(on, handler = onScan) {
  await camera.stop();
  if (!on) return;
  const host = $("#rd");
  if (!host) return;
  try {
    await camera.start(host, handler);
  } catch {
    host.innerHTML = "";
    toast(t("scan.blocked"), true);
  }
}

const log = (h) => $("#res")?.insertAdjacentHTML("afterbegin", `<p style="margin-bottom:8px">${h}</p>`);

// The soonest date on the shelf for a product, for look-ups and results.
export function nextExpiry(itemId) {
  return state.lots.find((l) => l.item_id == itemId)?.expiry || null;
}
const expTag = (iso) =>
  iso ? ` · <span class="${status(iso) == "ok" ? "mut" : "warn"}">${t("exp.short")} ${dateText(iso)}${expiryNote(iso)}</span>` : "";

// "31/12/2027" — the form an expiry box shows a date in, and reads back.
export const typedDate = (iso) => (iso ? iso.split("-").reverse().join("/") : "");

/** Ask for the expiry date of stock being received. null = don't receive. */
export async function askExpiry(it, current = "") {
  const f = await form(
    t("scan.expTitle", { name: it.name }),
    [
      {
        k: "expiry",
        type: "expiry",
        label: t("f.expiry"),
        value: current,
        tools: [{ act: "readDate", label: t("btn.readDate") }],
        hint: t("scan.expHint"),
      },
    ],
    t("scan.expOk"),
  );
  return f ? f.expiry : null;
}

// "QR" or "Barcode EAN-13" in front of a result, when the camera read it.
const kindTag = (format) =>
  format ? `<span class="tag">${camera.isQr(format) ? t("scan.qr") : t("scan.barcode", { f: camera.formatName(format) })}</span> ` : "";

export async function onScan(c, format) {
  c = String(c).trim();
  const n = Date.now();
  if (!c || (c == last && n - lt < 2500) || $("#dlg").open) return;
  last = c;
  lt = n;
  navigator.vibrate?.(90);
  const { item: it, code, expiry: printed } = lookupCode(state.items, c),
    m = $("#mode").value,
    q = Math.max(1, +$("#sq").value || 1);
  // A QR that is no product is usually a link or a payment slip: show it, don't offer to add it.
  if (!it && camera.isQr(format))
    return log(`${kindTag(format)}<span class="mut">${t("scan.qrText", { text: `<b>${E(c.slice(0, 120))}</b>` })}</span>`);
  if (!it)
    return log(
      `${kindTag(format)}<span class="warn">${t("scan.unknown", { code: `<b>${E(code)}</b>` })}</span> <button class="g" data-act="addItem" data-code="${E(code)}">${t("scan.addNew")}</button>`,
    );
  if (m == "look")
    return log(
      kindTag(format) +
      t("scan.inStock", { name: E(it.name), sku: E(it.sku), qty: `<b>${+it.qty}</b>` }) +
        expTag(printed || nextExpiry(it.id)),
    );

  let expiry = null;
  if (m == "in") {
    const box = $("#sexp");
    // A GS1 barcode carries its own date. Otherwise use the box, asking when a
    // consumable arrives without one, or when the box was filled for another product.
    expiry = printed || parseTyped(box?.value) || null;
    if (!printed && it.kind == "consumable" && (!expiry || (expFor && expFor != it.id))) {
      const asked = await askExpiry(it, box?.value || "");
      if (asked === null) return log(`<span class="mut">${t("scan.cancelled", { sku: E(it.sku) })}</span>`);
      expiry = asked || null;
      if (box) {
        box.value = typedDate(expiry);
        checkExpiry(box);
      }
    }
    expFor = it.id;
  }
  try {
    await adjust(it.id, m == "in" ? q : -q, "scan", expiry);
    const now = state.items.find((i) => i.id == it.id);
    log(
      `${kindTag(format)}<span class="${m}">${t("scan.ok", {
        name: E(it.name),
        sku: E(it.sku),
        sign: m == "in" ? "+" : "−",
        q,
        qty: `<b>${+now.qty}</b>`,
      })}</span>${expTag(expiry)}`,
    );
  } catch (e) {
    log(`<span class="warn">${E(it.sku)}: ${E(errText(e))}</span>`);
  }
}

// A date typed into the scanner's box by hand applies to the next product scanned.
export const dateTyped = () => (expFor = null);
