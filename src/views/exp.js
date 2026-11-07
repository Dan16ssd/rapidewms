// Expiry dates: every dated batch on the shelf, soonest first, so staff check
// the few products the list points at instead of every shelf.
import { E, num, fmt, dateText } from "../lib/util.js";
import { t, tn } from "../i18n/index.js";
import { daysLeft, status, SOON_DAYS } from "../lib/expiry.js";

const COLS = ["th.sku", "th.name", "th.expiry", "th.left", "th.qty", "th.value"];

export default function exp(s) {
  const byId = new Map(s.items.map((i) => [i.id, i])),
    lots = s.lots.filter((l) => byId.has(l.item_id)),
    expired = lots.filter((l) => status(l.expiry) == "expired"),
    soon = lots.filter((l) => status(l.expiry) == "soon"),
    // consumables with stock but no date recorded: what to date next
    undated = s.items.filter(
      (i) =>
        i.kind == "consumable" &&
        +i.qty > lots.filter((l) => l.item_id == i.id).reduce((a, l) => a + +l.qty, 0),
    ),
    l = COLS.map((k) => E(t(k))),
    td = (j, v, cls) => `<td data-l="${l[j]}"${cls ? ` class="${cls}"` : ""}>${v}</td>`;
  const row = (lot) => {
    const it = byId.get(lot.item_id),
      d = daysLeft(lot.expiry),
      st = status(lot.expiry);
    return `<tr>${td(0, `<b>${E(it.sku)}</b>`)}${td(1, E(it.name))}${td(2, dateText(lot.expiry), st == "ok" ? "" : "warn")}${td(
      3,
      d < 0 ? t("exp.agoN", { n: -d }) : d == 0 ? t("exp.today") : t("exp.inN", { n: d }),
      st == "expired" ? "bad" : st == "soon" ? "warn" : "",
    )}${td(4, num(lot.qty))}${td(5, fmt(lot.qty * it.cost))}<td class="act"><button class="g" data-act="writeOff" data-id="${E(
      lot.id,
    )}">${t("exp.writeOff")}</button></td></tr>`;
  };
  const table = (list, empty) =>
    `<table class="rt"><thead><tr>${COLS.map((k) => `<th>${t(k)}</th>`).join("")}<th></th></tr></thead><tbody>${
      list.length ? list.map(row).join("") : `<tr><td colspan="7" class="mut">${empty}</td></tr>`
    }</tbody></table>`;
  return `<div class="stats">${[
    ["exp.expired", expired, "bad"],
    ["exp.soon", soon, "warn"],
    ["exp.dated", lots, "in"],
  ]
    .map(
      ([k, L, cl]) =>
        `<div class="card"><div class="sh">${t(k, { n: SOON_DAYS })}</div><b class="n ${cl}">${num(
          L.reduce((a, x) => a + +x.qty, 0),
        )}</b><small>${tn("exp.batches", L.length)}</small></div>`,
    )
    .join("")}</div>
<div class="card ts"><h3>${t("exp.listExpired")}</h3>${table(expired, t("exp.noneExpired"))}</div>
<div class="card ts"><h3>${t("exp.listSoon", { n: SOON_DAYS })}</h3>${table(soon, t("exp.noneSoon"))}</div>
<div class="card ts"><h3>${t("exp.listAll")}</h3>${table(
    lots.filter((x) => status(x.expiry) == "ok"),
    t("exp.noneDated"),
  )}</div>${
    undated.length
      ? `<div class="card"><h3>${t("exp.undated", { n: undated.length })}</h3><p class="mut mt">${t(
          "exp.undatedNote",
        )}</p><p class="mt">${undated.map((i) => `<span class="tag">${E(i.sku)} · ${E(i.name)}</span>`).join(" ")}</p></div>`
      : ""
  }`;
}
