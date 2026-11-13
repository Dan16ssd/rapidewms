// Exchange rates. Two sources:
//   - the shop's own rates (settings.rates: Kip per 1 THB / USD / CNY), set by
//     the owner, shared by every device, and what costs and the dashboard use;
//   - internet rates (per 1 USD), the fallback while the owner hasn't set one.
import { state } from "../data/state.js";

export const CUR = ["LAK", "THB", "USD", "CNY"];
export const SIGN = { LAK: "₭", THB: "฿", USD: "$", CNY: "¥" };
export const R = { USD: 1, LAK: 21700, THB: 35, CNY: 7.1 };
try {
  Object.assign(R, JSON.parse(localStorage.rates));
} catch {}

/** Kip per 1 unit of `cur`: the shop's rate, else today's internet rate. */
export function kipPer(cur) {
  if (cur == "LAK") return 1;
  const own = +state.settings?.rates?.[cur];
  return own > 0 ? own : R.LAK / R[cur];
}
/** The internet's rate, rounded the way a shop would write it. */
export const marketKipPer = (cur) => Math.round((R.LAK / R[cur]) * 100) / 100;

/** Fetch today's internet rates. Returns false with no connection. */
export async function fetchRates() {
  try {
    const j = await (await fetch("https://open.er-api.com/v6/latest/USD")).json();
    ["LAK", "THB", "CNY"].forEach((c) => (R[c] = j.rates[c]));
    localStorage.rates = JSON.stringify(R);
    return true;
  } catch {
    return false;
  }
}
