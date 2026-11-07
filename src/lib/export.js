// PDF / Excel / CSV / ZIP exports. Heavy libraries load only when used.
import { toCsv } from "./csv.js";
import { dt, download } from "./util.js";
import { saleNo } from "../data/apply.js";

// Headers and type words stay English on purpose: csvToItems() matches these
// header names when a shop re-imports its own export, and jsPDF has no Lao font
// yet. Localise both together once the font is bundled.
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
      ]),
    ],
    Sales: [
      ["Date", "Receipt", "SKU", "Name", "Qty", "Unit price (LAK)", "Wholesale", "Line total (LAK)", "Method", "Status"],
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

export async function exportSet(s, k, f) {
  const r = sets(s)[k];
  if (f == "csv") return download(new Blob(["﻿" + toCsv(r)], { type: "text/csv" }), k + ".csv");
  if (f == "xlsx") {
    const XLSX = await import("xlsx");
    const w = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(w, XLSX.utils.aoa_to_sheet(r), k);
    return XLSX.writeFile(w, k + ".xlsx");
  }
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const d = new jsPDF({ orientation: "landscape" });
  d.text(`RAPIDÉWMS - ${s.shop.name} - ${k} (${new Date().toLocaleDateString()})`, 14, 14);
  autoTable(d, { head: [r[0]], body: r.slice(1), startY: 20 });
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
