import { E, fmt, fmtIn, num } from "../lib/util.js";
import { CUR, SIGN } from "../lib/rates.js";
import { t, tn } from "../i18n/index.js";
import { status } from "../lib/expiry.js";
import { dt } from "../lib/util.js";
import { saleNo } from "../data/apply.js";
import { errText } from "../i18n/index.js";

// What needs a person after work done offline: stock that went below zero,
// sales the server flagged, and queued work it refused.
function checks(s) {
  const neg = s.items.filter((i) => +i.qty < 0),
    flagged = s.sales.filter((x) => x.status != "void" && x.flags?.length),
    failed = s.failed || [];
  if (!neg.length && !flagged.length && !failed.length) return "";
  const what = (r) =>
    r.op == "sale"
      ? t("sync.op.sale", { n: r.args.till ? `${r.args.till}-${String(r.args.till_no).padStart(4, "0")}` : "" })
      : t("sync.op." + r.op, { sku: s.items.find((i) => i.id == r.args.item_id)?.sku ?? "" });
  return `<div class="card ts"><h3>${t("chk.title")}<small>${t("chk.sub")}</small></h3><table class="rt">${[
    ...neg.map(
      (i) =>
        `<tr><td><b>${E(i.sku)}</b> ${E(i.name)}</td><td class="bad">${num(i.qty)}</td><td>${t(
          "chk.below",
        )}</td><td class="act"><button class="g" data-act="editItem" data-id="${E(i.id)}">${t("chk.recount")}</button></td></tr>`,
    ),
    ...flagged.map(
      (x) =>
        `<tr><td><b>#${E(saleNo(x))}</b> ${dt(x.created_at)}</td><td>${fmt(x.total)}</td><td class="warn">${x.flags
          .map((f) => t("chk.flag." + f))
          .join(", ")}</td><td class="act"><button class="g" data-act="posReceipt" data-id="${E(x.client_id)}">🧾</button></td></tr>`,
    ),
    ...failed.map(
      (r) =>
        `<tr><td><b>${E(what(r))}</b> ${dt(r.at)}</td><td colspan="2" class="bad">${E(
          errText(r.error?.code ? { code: r.error.code, params: r.error.params } : r.error?.message || ""),
        )}</td><td class="act"><button class="g" data-act="retryFailed" data-id="${E(r.id)}">${t(
          "sync.retry",
        )}</button> <button class="g" data-act="discardFailed" data-id="${E(r.id)}">${t("sync.discard")}</button></td></tr>`,
    ),
  ].join("")}</table></div>`;
}

// Which currency the money tiles show (this device only).
export const ui = { cur: "LAK" };
try {
  if (CUR.includes(localStorage.dashCur)) ui.cur = localStorage.dashCur;
} catch {}

const P = ["#8b5cf6", "#22d3ee", "#f472b6", "#fbbf24", "#34d399", "#fb923c"];

export default function dash(s) {
  const I = s.items,
    units = I.reduce((a, i) => a + +i.qty, 0),
    lo = I.filter((i) => +i.qty < +i.min_qty).length,
    val = I.reduce((a, i) => a + i.qty * i.cost, 0),
    retail = I.reduce((a, i) => a + i.qty * i.price, 0),
    day = new Date().toDateString(),
    sold = s.sales.filter((x) => x.status != "void" && new Date(x.created_at).toDateString() == day),
    dated = s.lots.filter((l) => status(l.expiry) != "ok"),
    c = {};
  I.forEach((i) => (c[i.category] = (c[i.category] || 0) + +i.qty));
  const ks = Object.keys(c).filter((k) => c[k] > 0),
    tot = ks.reduce((a, k) => a + c[k], 0),
    inb = s.movements.filter((m) => m.type == "in").reduce((a, m) => a + +m.qty, 0),
    ob = s.movements.filter((m) => m.type == "out").reduce((a, m) => a + +m.qty, 0),
    v = [inb, ob],
    mx = Math.max(1, ...v);
  let off = 0;
  const seg = ks.length
    ? ks
        .map((k, j) => {
          const l = (c[k] / tot) * 238.76,
            svg = `<circle r="38" cx="50" cy="50" fill="none" stroke="${P[j % 6]}" stroke-width="22" stroke-dasharray="${l} 238.76" stroke-dashoffset="${-off}" transform="rotate(-90 50 50)"/>`;
          off += l;
          return svg;
        })
        .join("")
    : `<circle r="38" cx="50" cy="50" fill="none" stroke="#2a1a5a" stroke-width="22"/>`;
  const pick = `<div class="row" style="justify-content:flex-end;margin-bottom:10px"><span class="mut">${t(
    "dash.showIn",
  )}</span><select data-input="dashCur" aria-label="${E(t("dash.showIn"))}">${CUR.map(
    (c) => `<option value="${c}"${c == ui.cur ? " selected" : ""}>${SIGN[c]} ${c}</option>`,
  ).join("")}</select></div>`;
  return `${pick}<div class="stats">${[
    ["dash.products", num(I.length), "▥", ""],
    ["dash.units", num(units), "▦", ""],
    ["dash.low", num(lo), "⚠", "warn"],
    ["dash.value", fmtIn(val, ui.cur), SIGN[ui.cur], "in"],
    ["dash.retail", fmtIn(retail, ui.cur), SIGN[ui.cur], "in"],
    ["dash.sales", fmtIn(sold.reduce((a, x) => a + +x.total, 0), ui.cur), "🧾", "in", tn("dash.sales.sub", sold.length)],
    ["dash.expiring", num(dated.reduce((a, l) => a + +l.qty, 0)), "⏳", dated.length ? "warn" : "", tn("dash.expiring.sub", dated.length)],
  ]
    .map(
      ([k, b, i, cl, v]) =>
        `<div class="card"><div class="sh">${t(k)}<i class="ic">${i}</i></div><b class="n ${cl}">${b}</b><small>${v ?? t(k + ".sub")}</small></div>`,
    )
    .join("")}</div>
${checks(s)}
<div class="charts"><div class="card"><h3>${t("dash.byCat")}<small>${t(
    "dash.unitsWord",
  )}</small></h3><svg viewBox="0 0 100 100" style="width:min(260px,70%);display:block;margin:20px auto">${seg}<circle r="27" cx="50" cy="50" fill="#0b0718"/></svg><div class="mut" style="text-align:center">${
    ks.length
      ? ks.map((k, j) => `<span style="color:${P[j % 6]}">■</span> ${E(k)} (${num(c[k])})`).join(" &nbsp; ")
      : t("dash.noStock")
  }</div></div>
<div class="card"><h3>${t("dash.move")}<small>${t(
    "dash.last30",
  )}</small></h3><div style="display:flex;align-items:flex-end;gap:8%;height:200px;margin:20px 0 8px;padding:0 6%;border-bottom:1px solid #33265f;background:repeating-linear-gradient(#1d153866 0 1px,transparent 1px 40px)">${v
    .map(
      (x, j) =>
        `<div style="flex:1;height:${(x / mx) * 100}%;min-height:2px;background:${["#4ade80", "#fb923c"][j]};border-radius:6px 6px 0 0"></div>`,
    )
    .join(
      "",
    )}</div><div class="mut" style="display:flex;justify-content:space-around;text-align:center;gap:6px"><span>${t(
    "dash.received",
    { n: num(inb) },
  )}</span><span>${t("dash.shipped", { n: num(ob) })}</span></div></div></div>`;
}
