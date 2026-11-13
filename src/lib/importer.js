// Import from another POS (Loyverse, SabaiPOS, 4B…) or a spreadsheet:
// read a CSV or Excel file, guess which column is which, let the owner fix the
// guesses, then turn the rows into products, customers or past sales.
import { parseCsv } from "./csv.js";

// What each kind of import needs. Each field lists the headers it is known by
// (lower case, punctuation as spaces), best first: our own export, Loyverse,
// then common spreadsheet words and Lao.
export const KINDS = {
  products: [
    { k: "sku", req: true, names: ["sku", "code", "item code", "product code", "handle", "ລະຫັດ", "ລະຫັດສິນຄ້າ"] },
    { k: "name", req: true, names: ["name", "item name", "product name", "item", "product", "ຊື່", "ຊື່ສິນຄ້າ"] },
    { k: "category", names: ["category", "group", "ໝວດ", "ໝວດໝູ່", "ປະເພດ"] },
    { k: "barcode", names: ["barcode", "ean", "upc", "ບາໂຄດ"] },
    { k: "qty", names: ["qty", "quantity", "in stock", "stock", "on hand", "ຈຳນວນ", "ຄົງເຫຼືອ"] },
    { k: "unit", names: ["unit", "uom", "ຫົວໜ່ວຍ"] },
    { k: "min_qty", names: ["min", "minimum", "low stock", "reorder point", "ຂັ້ນຕ່ຳ"] },
    { k: "cost", names: ["cost", "unit cost", "purchase cost", "cost price", "ຕົ້ນທຶນ", "ລາຄາຕົ້ນທຶນ"] },
    { k: "price", names: ["price", "sell price", "default price", "selling price", "sale price", "ລາຄາ", "ລາຄາຂາຍ"] },
    { k: "price_wholesale", names: ["wholesale price", "wholesale", "ລາຄາສົ່ງ"] },
    { k: "wholesale_min_qty", names: ["wholesale min qty", "wholesale min"] },
    { k: "kind", names: ["kind"] },
  ],
  customers: [
    { k: "name", req: true, names: ["name", "customer name", "customer", "full name", "ຊື່", "ຊື່ລູກຄ້າ"] },
    { k: "phone", names: ["phone", "phone number", "mobile", "tel", "telephone", "customer contacts", "contact", "ເບີໂທ"] },
    { k: "note", names: ["note", "notes", "comment", "address", "ໝາຍເຫດ", "ທີ່ຢູ່"] },
  ],
  sales: [
    {
      k: "ref",
      req: true,
      names: ["receipt number", "receipt no", "receipt", "bill no", "bill", "invoice no", "invoice", "order no", "order", "ref", "ເລກໃບບິນ", "ໃບບິນ"],
    },
    { k: "date", req: true, names: ["date", "date time", "datetime", "time", "created at", "ວັນທີ"] },
    { k: "sku", names: ["sku", "code", "item code", "ລະຫັດ"] },
    { k: "name", names: ["item", "item name", "product", "product name", "name", "ສິນຄ້າ", "ຊື່ສິນຄ້າ"] },
    { k: "qty", req: true, names: ["quantity", "qty", "ຈຳນວນ"] },
    { k: "price", names: ["price", "unit price", "ລາຄາ"] },
    // Before discount: the discount column is taken off separately.
    { k: "total", names: ["gross sales", "line total", "amount", "total", "net sales", "ລວມ"] },
    { k: "discount", names: ["discounts", "discount", "ສ່ວນຫຼຸດ"] },
    { k: "method", names: ["payment type", "payment method", "payment", "method", "ການຊຳລະ"] },
    { k: "customer", names: ["customer name", "customer", "ລູກຄ້າ"] },
    { k: "phone", names: ["customer contacts", "customer phone", "phone", "ເບີໂທ"] },
    // Refunds and cancelled receipts are left out.
    { k: "type", names: ["receipt type", "status", "type"] },
  ],
};

const norm = (h) =>
  String(h ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9຀-໿]+/g, " ")
    .trim();

/** Read the first sheet of a CSV or Excel file: { head, rows }. */
export async function readTable(file) {
  let table;
  if (/\.(xlsx|xls|ods)$/i.test(file.name)) {
    const XLSX = await import("xlsx"),
      wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
    table = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: "" });
  } else table = parseCsv((await file.text()).replace(/^﻿/, ""));
  table = table.filter((r) => r.some((v) => String(v ?? "").trim()));
  const [head = [], ...rows] = table;
  return { head: head.map((h) => String(h ?? "").trim()), rows };
}

/** Which kind of file this looks like. */
export function guessKind(head) {
  const h = head.map(norm);
  if (h.some((x) => /receipt|invoice|bill/.test(x))) return "sales";
  if (h.some((x) => /customer|phone|mobile/.test(x)) && !h.some((x) => /sku|price|cost|stock/.test(x))) return "customers";
  return "products";
}

/** field -> column index (-1 = none). A header matching a name exactly wins
 * over one that only starts with it ("In stock [Main shop]"). */
export function guessColumns(head, kind) {
  const h = head.map(norm),
    used = new Set(),
    map = {};
  for (const exact of [true, false])
    for (const f of KINDS[kind]) {
      if (map[f.k] >= 0) continue;
      for (const n of f.names) {
        const i = h.findIndex((x, j) => !used.has(j) && (exact ? x == n : x.startsWith(n + " ")));
        if (i >= 0) {
          map[f.k] = i;
          used.add(i);
          break;
        }
      }
    }
  for (const f of KINDS[kind]) map[f.k] ??= -1;
  return map;
}

/** "₭12,000", "12 000", "฿1,234.50" -> number; blank -> NaN. */
export function number(v) {
  if (typeof v == "number") return v;
  const s = String(v ?? "").replace(/[^\d.\-]/g, "");
  return s ? +s : NaN;
}

// Dates come as Date objects (Excel), ISO text, or d/m/y or m/d/y text. Day
// and month order is decided once per file: a first part above 12 means
// day first, a second part above 12 means month first; Laos writes day first.
const DMY = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?)?/i;
export function dateOrder(values) {
  for (const v of values) {
    const m = DMY.exec(String(v ?? "").trim());
    if (m && +m[1] > 12) return "dmy";
    if (m && +m[2] > 12) return "mdy";
  }
  return "dmy";
}
export function parseDate(v, order = "dmy") {
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v == "number" && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 864e5)); // Excel serial
  const s = String(v ?? "").trim();
  if (!s) return null;
  const m = DMY.exec(s);
  if (m) {
    let [, a, b, y, hh = 0, mm = 0, ss = 0, ap] = m;
    const [d, mo] = order == "mdy" ? [b, a] : [a, b];
    y = +y < 100 ? 2000 + +y : +y;
    hh = ap ? (+hh % 12) + (/p/i.test(ap) ? 12 : 0) : +hh;
    const out = new Date(y, mo - 1, d, hh, +mm, +ss);
    return isNaN(out) || out.getMonth() != mo - 1 ? null : out;
  }
  const iso = new Date(s);
  return isNaN(iso) ? null : iso;
}

const TRANSFER = /transfer|bank|qr|bcel|onepay|ldb|jdb|card|wallet|ໂອນ/i;
const SKIP = /refund|cancel|void|return|ຍົກເລີກ|ຄືນ/i;

/** Rows -> records for the store, with how many rows were left out.
 * products -> importItems(), customers -> importCustomers(), sales -> importSales(). */
export function build(kind, rows, map) {
  const get = (r, k) => (map[k] >= 0 ? r[map[k]] : ""),
    text = (r, k) => String(get(r, k) ?? "").trim(),
    num = (r, k, d = 0) => {
      const n = number(get(r, k));
      return isNaN(n) ? d : n;
    };
  let out = [];
  if (kind == "products")
    out = rows
      .map((r) => ({
        sku: text(r, "sku") || text(r, "barcode"),
        name: text(r, "name"),
        category: text(r, "category") || "General",
        barcode: text(r, "barcode") || null,
        qty: Math.max(0, num(r, "qty")),
        unit: text(r, "unit").slice(0, 20),
        min_qty: Math.max(0, num(r, "min_qty")),
        cost: Math.max(0, num(r, "cost")),
        price: Math.max(0, num(r, "price")),
        price_wholesale: Math.max(0, num(r, "price_wholesale")),
        wholesale_min_qty: Math.max(0, num(r, "wholesale_min_qty")),
        kind: /^consum|^ບໍລິໂພກ|^ສິນຄ້າບໍລິໂພກ/i.test(text(r, "kind")) ? "consumable" : "durable",
      }))
      .filter((x) => x.sku && x.name);
  else if (kind == "customers")
    out = rows
      .map((r) => ({ name: text(r, "name"), phone: text(r, "phone"), note: text(r, "note") }))
      .filter((x) => x.name);
  else {
    const order = dateOrder(rows.map((r) => get(r, "date"))),
      byRef = new Map();
    for (const r of rows) {
      const ref = text(r, "ref"),
        qty = num(r, "qty", NaN);
      if (!ref || !(qty > 0) || SKIP.test(text(r, "type"))) continue;
      const at = parseDate(get(r, "date"), order);
      if (!at) continue;
      const total = num(r, "total", NaN),
        price = map.price >= 0 ? num(r, "price") : isNaN(total) ? 0 : total / qty;
      let s = byRef.get(ref);
      if (!s) byRef.set(ref, (s = { ref, at: at.toISOString(), method: "cash", discount: 0, customer: null, lines: [] }));
      if (TRANSFER.test(text(r, "method"))) s.method = "transfer";
      s.discount += Math.max(0, num(r, "discount"));
      const cname = text(r, "customer"),
        phone = text(r, "phone");
      if (!s.customer && (cname || phone)) s.customer = { name: cname, phone };
      s.lines.push({ sku: text(r, "sku"), name: text(r, "name"), qty, price: Math.max(0, Math.round(price * 100) / 100) });
    }
    out = [...byRef.values()];
    // A discount can't be more than the receipt: the file is off, so cap it.
    for (const s of out) s.discount = Math.min(s.discount, s.lines.reduce((a, l) => a + l.qty * l.price, 0));
  }
  return { records: out, dropped: kind == "sales" ? null : rows.length - out.length };
}
