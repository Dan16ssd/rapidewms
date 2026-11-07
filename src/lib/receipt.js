// One receipt, shown on screen and printed. The print copy is sized for an
// 80 mm receipt printer and still reads fine on A4.
import { $, E, fmt, num, dt } from "./util.js";
import { t } from "../i18n/index.js";

export function receiptHtml(shop, sale, lines) {
  const row = (a, b, cls = "") => `<tr class="${cls}"><td>${a}</td><td>${b}</td></tr>`;
  return `<div class="receipt"><h4>${E(shop.name)}</h4><p class="c">${t("rc.no", { n: sale.receipt_no })}<br>${dt(
    sale.created_at,
  )}</p>${sale.status == "void" ? `<p class="c void">${t("rc.void")}</p>` : ""}<table>${lines
    .map(
      (l) =>
        `<tr><td colspan="2">${E(l.name)}</td></tr>${row(
          `${num(l.qty)} × ${fmt(l.unit_price)}${l.wholesale ? ` <small>${t("pos.wholesale")}</small>` : ""}`,
          fmt(l.line_total),
          "sub",
        )}`,
    )
    .join("")}</table><table class="sum">${row(t("pos.subtotal"), fmt(sale.subtotal))}${
    +sale.discount ? row(t("pos.discount"), "−" + fmt(sale.discount)) : ""
  }${row(`<b>${t("pos.total")}</b>`, `<b>${fmt(sale.total)}</b>`, "big")}${row(
    t(sale.method == "cash" ? "pos.cash" : "pos.transfer"),
    fmt(sale.paid),
  )}${sale.method == "cash" ? row(t("pos.change"), fmt(sale.change_due)) : ""}</table><p class="c">${t("rc.thanks")}</p></div>`;
}

// Print just the receipt: the page hides everything else while printing.
export function printReceipt(html) {
  const box = $("#print");
  box.innerHTML = html;
  document.body.classList.add("printing");
  const done = () => {
    document.body.classList.remove("printing");
    removeEventListener("afterprint", done);
  };
  addEventListener("afterprint", done);
  print();
  setTimeout(done, 1500); // browsers without afterprint
}
