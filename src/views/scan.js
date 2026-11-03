import { E } from "../lib/util.js";
import { t } from "../i18n/index.js";

export default function scan() {
  return `<div class="card"><div class="row"><select id="mode"><option value="in">${t(
    "scan.in",
  )}</option><option value="out">${t("scan.out")}</option><option value="look">${t(
    "scan.look",
  )}</option></select><input id="sq" type="number" min="1" value="1" placeholder="${E(
    t("scan.qtyPer"),
  )}"></div><div class="row mt"><button class="b" data-act="camOn">${t(
    "scan.camOn",
  )}</button><button class="g" data-act="camOff">${t(
    "scan.camOff",
  )}</button></div><div id="rd"></div><input id="man" class="mt" placeholder="${E(
    t("scan.manual"),
  )}" data-input="manualScan"><div id="res" class="mt"></div></div>`;
}
