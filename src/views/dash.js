import { E, fmt, num } from "../lib/util.js";
import { t, tn } from "../i18n/index.js";
import { status } from "../lib/expiry.js";

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
  return `<div class="stats">${[
    ["dash.products", num(I.length), "▥", ""],
    ["dash.units", num(units), "▦", ""],
    ["dash.low", num(lo), "⚠", "warn"],
    ["dash.value", fmt(val), "₭", "in"],
    ["dash.retail", fmt(retail), "₭", "in"],
    ["dash.sales", fmt(sold.reduce((a, x) => a + +x.total, 0)), "🧾", "in", tn("dash.sales.sub", sold.length)],
    ["dash.expiring", num(dated.reduce((a, l) => a + +l.qty, 0)), "⏳", dated.length ? "warn" : "", tn("dash.expiring.sub", dated.length)],
  ]
    .map(
      ([k, b, i, cl, v]) =>
        `<div class="card"><div class="sh">${t(k)}<i class="ic">${i}</i></div><b class="n ${cl}">${b}</b><small>${v ?? t(k + ".sub")}</small></div>`,
    )
    .join("")}</div>
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
