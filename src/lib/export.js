// PDF / Excel / CSV / ZIP exports. Heavy libraries load only when used.
import { toCsv } from "./csv.js";
import { dt, download } from "./util.js";

export const sets = (s) => {
  const sku = (id) => s.items.find((i) => i.id == id)?.sku ?? "";
  return {
    Inventory: [
      ["SKU", "Name", "Category", "Barcode", "Qty", "Min", "Cost (LAK)", "Value (LAK)"],
      ...s.items.map((i) => [
        i.sku,
        i.name,
        i.category,
        i.barcode ?? "",
        +i.qty,
        +i.min_qty,
        +i.cost,
        i.qty * i.cost,
      ]),
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
    JSON.stringify({ shop: s.shop, items: s.items, orders: s.orders, movements: s.movements }, null, 1),
  );
  download(await z.generateAsync({ type: "blob" }), "RAPIDEWMS-bundle.zip");
}
