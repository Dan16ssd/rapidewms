import { E } from "../lib/util.js";
import { t, tn, lang, LANGS, fDate } from "../i18n/index.js";
import { isOwner, configured } from "../data/store.js";

export default function sys(s) {
  const until = new Date(s.shop.plan_until),
    days = Math.ceil((until - Date.now()) / 864e5),
    plan = t(s.shop.plan == "paid" ? "plan.paid" : "plan.trial");
  return `<div class="card"><h3>${t("sys.shop")}</h3><p class="mt"><b>${E(s.shop.name)}</b></p><p class="mut">${t(
    "sys.signedIn",
    { email: E(s.user.email), role: t(s.role == "owner" ? "role.owner" : "role.staff") },
  )}</p><p class="plan mt ${days <= 0 ? "expired" : ""}">${
    days > 0
      ? tn("sys.planLeft", days, { plan, date: fDate(until) })
      : t("sys.planExpired")
  }</p>${
    configured
      ? `<div class="row mt"><button class="g" data-act="signOut">${t("sys.signOut")}</button></div>`
      : `<p class="mut mt">${t("sys.localNote")}</p>`
  }</div>
<div class="card"><h3>${t("sys.lang")}</h3><div class="row mt"><select data-input="lang">${LANGS.map(
    ([c, n]) => `<option value="${c}" ${c == lang() ? "selected" : ""}>${n}</option>`,
  ).join("")}</select></div></div>
<div class="card"><h3>${t("sys.backup")}</h3><div class="row mt"><button class="g" data-act="zip">${t(
    "sys.zip",
  )}</button><label class="g">${t(
    "sys.importCsv",
  )}<input type="file" accept=".csv" hidden data-input="importCsv"></label>${
    isOwner() ? `<button class="g" data-act="erase">${t("sys.erase")}</button>` : ""
  }</div><p class="mut mt">${t("sys.csvNote")}</p></div>`;
}
