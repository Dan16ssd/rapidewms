// PDF / Excel / CSV / ZIP exports. Heavy libraries load only when used.
import { toCsv } from "./csv.js";
import { $, E, dt, download } from "./util.js";
import { t } from "../i18n/index.js";
import { saleNo } from "../data/apply.js";
import regularUrl from "../assets/fonts/pdf-regular.ttf?url";
import boldUrl from "../assets/fonts/pdf-bold.ttf?url";

// CSV and Excel headers stay English on purpose: csvToItems() matches these
// header names when a shop re-imports its own export. PDF and print are for
// reading, so there they follow the app language (localised()).
export const SETS = ["Inventory", "Sales", "Expiry", "Orders", "Movements"];

export const sets = (s) => {
  const bySku = new Map(s.items.map((i) => [i.id, i.sku])),
    sku = (id) => bySku.get(id) ?? "",
    byId = new Map(s.items.map((i) => [i.id, i])),
    next = new Map();
  for (const l of s.lots || []) if (!next.has(l.item_id)) next.set(l.item_id, l.expiry);
  const sale = new Map((s.sales || []).map((x) => [x.id, x]));
  return {
    Inventory: [
      [
        "SKU",
        "Name",
        "Category",
        "Barcode",
        "Qty",
        "Min",
        "Cost (LAK)",
        "Price (LAK)",
        "Wholesale (LAK)",
        "Wholesale min",
        "Value (LAK)",
        // Appended, never inserted: older exports must still import.
        "Kind",
        "Next expiry",
        "Unit",
      ],
      ...s.items.map((i) => [
        i.sku,
        i.name,
        i.category,
        i.barcode ?? "",
        +i.qty,
        +i.min_qty,
        +i.cost,
        +i.price || 0,
        +i.price_wholesale || 0,
        +i.wholesale_min_qty || 0,
        i.qty * i.cost,
        i.kind == "consumable" ? "consumable" : "durable",
        next.get(i.id) || "",
        i.unit || "",
      ]),
    ],
    Sales: [
      // Pack and VAT appended, never inserted. VAT is the sale's VAT shared out
      // over its lines, so a sale's lines add up to its VAT.
      ["Date", "Receipt", "SKU", "Name", "Qty", "Unit price (LAK)", "Wholesale", "Line total (LAK)", "Method", "Status", "Pack", "VAT (LAK)"],
      ...(s.saleLines || [])
        .filter((l) => sale.has(l.sale_id))
        .map((l) => {
          const x = sale.get(l.sale_id);
          return [
            dt(x.created_at),
            saleNo(x),
            l.sku,
            l.name,
            +l.qty,
            +l.unit_price,
            l.wholesale ? "yes" : "",
            +l.line_total,
            x.method,
            x.status,
            l.pack_qty ? `${+l.pack_qty} × ${l.pack_name} (${+l.pack_size})` : "",
            +x.subtotal ? Math.round(((+x.vat || 0) * l.line_total * 100) / x.subtotal) / 100 : 0,
          ];
        }),
    ],
    Expiry: [
      ["SKU", "Name", "Expiry", "Qty", "Value (LAK)"],
      ...(s.lots || [])
        .filter((l) => byId.has(l.item_id))
        .map((l) => {
          const i = byId.get(l.item_id);
          return [i.sku, i.name, l.expiry, +l.qty, l.qty * i.cost];
        }),
    ],
    Orders: [
      ["Date", "Type", "SKU", "Qty", "Party", "Status"],
      ...s.orders.map((o) => [
        dt(o.created_at),
        o.type == "in" ? "Inbound" : "Outbound",
        sku(o.item_id),
        +o.qty,
        o.party,
        o.status == "done" ? "Done" : "Pending",
      ]),
    ],
    Movements: [
      ["Date", "SKU", "Type", "Qty", "Note"],
      ...s.movements.map((m) => [dt(m.created_at), m.sku, m.type == "in" ? "In" : "Out", +m.qty, m.note]),
    ],
  };
};

// English header -> i18n key, for the PDF and printed copies.
const HEAD = {
  SKU: "sku",
  Name: "name",
  Category: "category",
  Barcode: "barcode",
  Qty: "qty",
  Min: "min",
  "Cost (LAK)": "cost",
  "Price (LAK)": "price",
  "Wholesale (LAK)": "wholesale",
  "Wholesale min": "wholesaleMin",
  "Value (LAK)": "value",
  Kind: "kind",
  "Next expiry": "nextExpiry",
  Date: "date",
  Receipt: "receipt",
  "Unit price (LAK)": "unitPrice",
  Wholesale: "wsYes",
  "Line total (LAK)": "lineTotal",
  Method: "method",
  Status: "status",
  Expiry: "expiry",
  Type: "type",
  Party: "party",
  Note: "note",
  Unit: "unit",
  Pack: "pack",
  "VAT (LAK)": "vat",
};
// Type and status words in the cells.
const WORD = {
  consumable: "kind.consumable",
  durable: "kind.durable",
  Inbound: "xw.inbound",
  Outbound: "xw.outbound",
  In: "xw.in",
  Out: "xw.out",
  Done: "xw.done",
  Pending: "xw.pending",
  cash: "xw.cash",
  transfer: "xw.transfer",
  paid: "xw.paid",
  void: "xw.void",
  yes: "xw.yes",
};
const localised = (r) => [
  r[0].map((h) => (HEAD[h] ? t("xh." + HEAD[h]) : h)),
  ...r.slice(1).map((row) => row.map((v) => (typeof v == "string" && WORD[v] ? t(WORD[v]) : v))),
];
const title = (s, k) => `RAPIDÉWMS · ${s.shop.name} · ${t("rep.set." + k)} · ${new Date().toLocaleDateString()}`;

// The PDF font: Phetsarath for Lao, DejaVu for Latin (scripts/make-pdf-font.py).
let fontData = null;
function pdfFont() {
  const b64 = async (url) => {
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  };
  return (fontData ||= Promise.all([b64(regularUrl), b64(boldUrl)]).catch((e) => {
    fontData = null;
    throw e;
  }));
}

/** Print a set on paper (the print dialog can also save it as a PDF). */
export async function printSet(s, k) {
  // The print font loads only when first used: wait for it, or the first
  // printout comes out in the fallback font.
  await Promise.all([
    document.fonts.load('10px "RAPIDEWMS PDF"'),
    document.fonts.load('bold 10px "RAPIDEWMS PDF"'),
  ]).catch(() => {});
  const [head, ...body] = localised(sets(s)[k]);
  const box = $("#print");
  box.innerHTML = `<div class="report"><h4>${E(title(s, k))}</h4><table><thead><tr>${head
    .map((h) => `<th>${E(h)}</th>`)
    .join("")}</tr></thead><tbody>${body
    .map((r) => `<tr>${r.map((v) => `<td>${E(String(v ?? ""))}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
  document.body.classList.add("printing");
  const done = () => {
    document.body.classList.remove("printing");
    removeEventListener("afterprint", done);
  };
  addEventListener("afterprint", done);
  print();
  setTimeout(done, 1500); // browsers without afterprint
}

export async function exportSet(s, k, f) {
  if (f == "print") return printSet(s, k);
  const r = sets(s)[k];
  if (f == "csv") return download(new Blob(["﻿" + toCsv(r)], { type: "text/csv" }), k + ".csv");
  if (f == "xlsx") {
    const XLSX = await import("xlsx");
    const w = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(w, XLSX.utils.aoa_to_sheet(r), k);
    return XLSX.writeFile(w, k + ".xlsx");
  }
  const [{ jsPDF }, { autoTable }, [regular, bold]] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
    pdfFont(),
  ]);
  const d = new jsPDF({ orientation: "landscape" });
  d.addFileToVFS("rp-regular.ttf", regular);
  d.addFont("rp-regular.ttf", "RP", "normal");
  d.addFileToVFS("rp-bold.ttf", bold);
  d.addFont("rp-bold.ttf", "RP", "bold");
  d.setFont("RP", "bold");
  d.setFontSize(13);
  d.text(title(s, k), 14, 14);
  const [head, ...body] = localised(r);
  autoTable(d, {
    head: [head],
    body,
    startY: 20,
    styles: { font: "RP", fontSize: 9, textColor: 20, lineColor: 200 },
    // Plain heading row: bold text and a rule under it, no coloured band.
    headStyles: { font: "RP", fontStyle: "bold", fillColor: false, textColor: 0, lineWidth: { bottom: 0.4 }, lineColor: 0 },
    bodyStyles: { lineWidth: { bottom: 0.1 } },
    alternateRowStyles: { fillColor: false },
  });
  d.save(k + ".pdf");
}

export async function exportZip(s) {
  const { default: JSZip } = await import("jszip");
  const z = new JSZip(),
    all = sets(s);
  for (const k in all) z.file(k + ".csv", "﻿" + toCsv(all[k]));
  z.file(
    "backup.json",
    JSON.stringify(
      {
        shop: s.shop,
        items: s.items,
        packs: s.packs,
        lots: s.lots,
        orders: s.orders,
        movements: s.movements,
        sales: s.sales,
        sale_lines: s.saleLines,
      },
      null,
      1,
    ),
  );
  download(await z.generateAsync({ type: "blob" }), "RAPIDEWMS-bundle.zip");
}
