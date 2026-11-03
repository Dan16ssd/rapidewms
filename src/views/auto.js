import { E, num } from "../lib/util.js";
import { t } from "../i18n/index.js";
import { isOwner } from "../data/store.js";

export default function auto(s) {
  const lo = s.items.filter((i) => +i.qty < +i.min_qty);
  return `<div class="card"><h3>${t("auto.title")}</h3>${["low_alert", "auto_reorder"]
    .map(
      (k) =>
        `<label class="row mt" style="font-size:15px;color:#ece8f8"><input type="checkbox" style="flex:0 0 22px;width:22px" ${
          s.settings[k] ? "checked" : ""
        } ${isOwner() ? "" : "disabled"} data-input="setting" data-key="${k}"><span style="flex:1 1 200px">${t(
          "auto." + k,
        )}</span></label>`,
    )
    .join("")}${
    isOwner() ? "" : `<p class="mut mt">${t("auto.ownerOnly")}</p>`
  }</div><div class="card ts"><h3>${t("auto.belowMin", { n: lo.length })}</h3><table>${
    lo
      .map(
        (i) =>
          `<tr><td><b>${E(i.sku)}</b></td><td>${E(i.name)}</td><td class="warn">${num(i.qty)} / ${num(
            i.min_qty,
          )}</td></tr>`,
      )
      .join("") || `<tr><td class="mut">${t("auto.nothingLow")}</td></tr>`
  }</table></div>`;
}
