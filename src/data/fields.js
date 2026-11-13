// Form values -> table rows, shared by both backends (remote.js, local.js).
import { err } from "../i18n/index.js";
import { kipPer } from "../lib/rates.js";

const fail = (code, params) => {
  throw err(code, params);
};

/** The product form's unit and cost. A cost typed in THB, USD or CNY is
 * stored in Kip at the shop's rate; what was typed is kept beside it. */
export function costFields(f) {
  const cur = ["THB", "USD", "CNY"].includes(f.cost_currency) ? f.cost_currency : "LAK",
    typed = Math.max(0, +f.cost || 0),
    rate = kipPer(cur);
  if (cur != "LAK" && !(rate > 0)) fail("err.noRate", { cur });
  return {
    unit: String(f.unit || "").trim().slice(0, 20),
    cost_currency: cur,
    cost_orig: cur == "LAK" ? null : typed,
    cost: Math.round(typed * rate * 100) / 100,
  };
}
/** A pack form ({ name, size, barcode, price }). */
export function packRow(f) {
  const name = String(f.name || "").trim().slice(0, 30),
    size = +f.size;
  if (!name) fail("err.packName");
  if (!(size > 1)) fail("err.packSize");
  return { name, size, barcode: String(f.barcode || "").trim() || null, price: Math.max(0, +f.price || 0) };
}
