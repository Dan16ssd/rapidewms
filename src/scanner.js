import { $, E, toast } from "./lib/util.js";
import { t, errText } from "./i18n/index.js";
import { state, adjust } from "./data/store.js";

let scn = null,
  last = "",
  lt = 0;

export const active = () => !!scn;

export async function cam(on) {
  if (scn) {
    try {
      await scn.stop();
    } catch {}
    scn = null;
  }
  if (!on) return;
  const { Html5Qrcode } = await import("html5-qrcode");
  scn = new Html5Qrcode("rd", { experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
  try {
    await scn.start(
      { facingMode: "environment" },
      {
        fps: 12,
        qrbox: (w, h) => ({
          width: Math.floor(Math.min(w, 420) * 0.88),
          height: Math.floor(Math.min(h, 300) * 0.7),
        }),
      },
      onScan,
      () => {},
    );
  } catch {
    scn = null;
    toast(t("scan.blocked"), true);
  }
}

const log = (h) => $("#res")?.insertAdjacentHTML("afterbegin", `<p style="margin-bottom:8px">${h}</p>`);

export async function onScan(c) {
  c = String(c).trim();
  const n = Date.now();
  if (!c || (c == last && n - lt < 2500)) return;
  last = c;
  lt = n;
  navigator.vibrate?.(90);
  const lc = c.toLowerCase(),
    it = state.items.find((i) => i.sku.toLowerCase() == lc || i.barcode == c),
    m = $("#mode").value,
    q = Math.max(1, +$("#sq").value || 1);
  if (!it)
    return log(
      `<span class="warn">${t("scan.unknown", { code: `<b>${E(c)}</b>` })}</span> <button class="g" data-act="addItem" data-code="${E(c)}">${t("scan.addNew")}</button>`,
    );
  if (m == "look")
    return log(t("scan.inStock", { name: E(it.name), sku: E(it.sku), qty: `<b>${+it.qty}</b>` }));
  try {
    await adjust(it.id, m == "in" ? q : -q, "scan");
    const now = state.items.find((i) => i.id == it.id);
    log(
      `<span class="${m}">${t("scan.ok", {
        name: E(it.name),
        sku: E(it.sku),
        sign: m == "in" ? "+" : "−",
        q,
        qty: `<b>${+now.qty}</b>`,
      })}</span>`,
    );
  } catch (e) {
    log(`<span class="warn">${E(it.sku)}: ${E(errText(e))}</span>`);
  }
}
