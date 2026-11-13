import { E } from "../lib/util.js";
import { t, tn, lang, LANGS, fDate, fDateTime } from "../i18n/index.js";
import { isOwner, configured, myTill, canWrite } from "../data/store.js";
import { marketKipPer } from "../lib/rates.js";

// The devices that sell. The plan sets how many can be in use; the owner
// retires an old phone to make room for a new one.
function tills(s) {
  if (!configured) return "";
  const used = s.tills.filter((x) => !x.retired_at),
    mine = myTill(),
    max = s.shop.max_tills ?? "";
  const rows = used
    .map(
      (x) =>
        `<div class="row mt"><b>${t("sys.tillName", { code: E(x.code) })}</b><span class="mut">${E(x.name || "")}</span>${
          mine?.code == x.code ? `<span class="tag">${t("sys.thisDevice")}</span>` : ""
        }${isOwner() ? `<button class="g" data-act="retireTill" data-code="${E(x.code)}">${t("sys.retire")}</button>` : ""}</div>`,
    )
    .join("");
  return `<div class="card"><h3>${t("sys.tills")}</h3><p class="mut">${t("sys.tillsUsed", { n: used.length, max })}</p>${rows}<p class="mut mt">${
    mine ? t("sys.till", { code: E(mine.code) }) : s.tillFull ? t("err.tillFull", { max }) : t("sys.noTill")
  }</p>${
    !mine && canWrite() && s.online ? `<div class="row mt"><button class="g" data-act="registerTill">${t("sys.useAsTill")}</button></div>` : ""
  }</div>`;
}

// Owner only: who can log in to this shop, and codes for new cashiers.
const showCode = (c) => c.slice(0, 4) + "-" + c.slice(4);
function staff(s) {
  if (!configured || !isOwner() || !s.people) return "";
  const people = s.people.members
    .map(
      (m) =>
        `<div class="row mt"><b>${E(m.email || "")}</b><span class="tag">${t(m.role == "owner" ? "role.owner" : "role.staff")}</span>${
          m.user_id == s.user.id ? `<span class="mut">${t("sys.you")}</span>` : ""
        }${m.role == "staff" ? `<button class="g" data-act="removeStaff" data-id="${E(m.user_id)}" data-email="${E(m.email || "")}">${t("sys.remove")}</button>` : ""}</div>`,
    )
    .join("");
  const codes = s.people.invites
    .map(
      (i) =>
        `<div class="row mt"><b class="code">${E(showCode(i.code))}</b><span class="mut">${t("sys.codeUntil", {
          d: fDateTime(new Date(i.expires_at)),
        })}</span><button class="g" data-act="cancelInvite" data-code="${E(i.code)}">${t("sys.cancel")}</button></div>`,
    )
    .join("");
  return `<div class="card"><h3>${t("sys.staff")}</h3><p class="mut">${t("sys.staffNote")}</p>${people}${
    codes ? `<p class="mut mt">${t("sys.codesOpen")}</p>${codes}` : ""
  }<div class="row mt"><button class="g" data-act="addStaff">${t("sys.addStaff")}</button></div></div>`;
}

// VAT inside the shelf price, and the shop's exchange rates (Kip per 1 unit),
// used for costs typed in another currency and the dashboard. An empty rate
// means "use today's internet rate", shown as the placeholder.
function prices(s) {
  const own = !isOwner() ? " disabled" : "",
    rates = s.settings.rates || {};
  return `<div class="card"><h3>${t("sys.prices")}</h3><label class="mt">${t("sys.vatRate")}<input type="number" min="0" max="100" step="any" data-input="setting" data-key="vat_rate" data-num="1" value="${E(
    s.settings.vat_rate ?? 10,
  )}"${own}></label><p class="mut">${t("sys.vatNote")}</p><p class="mt"><b>${t("sys.rates")}</b></p><div class="row">${["THB", "USD", "CNY"]
    .map(
      (c) =>
        `<label style="flex:1 1 140px">1 ${c} = (₭)<input type="number" min="0" step="any" data-input="setting" data-key="rates" data-cur="${c}" value="${E(
          rates[c] ?? "",
        )}" placeholder="${E(marketKipPer(c))}"${own}></label>`,
    )
    .join("")}</div><p class="mut">${t("sys.ratesNote")}</p></div>`;
}

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
  }</div>${prices(s)}${staff(s)}${tills(s)}
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
