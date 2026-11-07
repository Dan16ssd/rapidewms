// RFC 4180-ish: quoted fields, "" escapes, commas/newlines inside quotes
export function parseCsv(s) {
  const rows = [];
  let row = [],
    f = "",
    q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c == '"' && s[i + 1] == '"') (f += '"'), i++;
      else if (c == '"') q = false;
      else f += c;
    } else if (c == '"') q = true;
    else if (c == ",") row.push(f), (f = "");
    else if (c == "\n" || c == "\r") {
      if (c == "\r" && s[i + 1] == "\n") i++;
      row.push(f), rows.push(row), (row = []), (f = "");
    } else f += c;
  }
  if (f || row.length) row.push(f), rows.push(row);
  return rows.filter((r) => r.some((x) => x.trim()));
}

export const toCsv = (rows) =>
  rows
    .map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");

// Turns CSV text into item records. Accepts our own Inventory export and the
// documented sku,name,category,qty,min,cost layout.
export function csvToItems(text) {
  const [head = [], ...rows] = parseCsv(text.replace(/^﻿/, "")),
    h = head.map((x) => x.trim().toLowerCase()),
    col = (...names) =>
      h.findIndex((x) => names.some((n) => x == n || x.startsWith(n + " "))),
    ix = h.includes("sku")
      ? {
          sku: col("sku"),
          name: col("name"),
          category: col("category"),
          barcode: col("barcode"),
          qty: col("qty"),
          min_qty: col("min"),
          cost: col("cost"),
          price: col("price", "sell"),
          price_wholesale: col("wholesale"),
          wholesale_min_qty: col("wholesale min"),
          kind: col("kind"),
        }
      : // Headerless layout: new columns are appended, so old files keep working.
        {
          sku: 0,
          name: 1,
          category: 2,
          barcode: -1,
          qty: 3,
          min_qty: 4,
          cost: 5,
          price: 6,
          price_wholesale: 7,
          wholesale_min_qty: 8,
          kind: 9,
        },
    get = (r, k) => (ix[k] >= 0 ? (r[ix[k]] ?? "").trim() : "");
  return rows
    .map((r) => ({
      sku: get(r, "sku"),
      name: get(r, "name"),
      category: get(r, "category") || "General",
      barcode: get(r, "barcode") || null,
      qty: +get(r, "qty") || 0,
      min_qty: +get(r, "min_qty") || 0,
      cost: +get(r, "cost") || 0,
      price: +get(r, "price") || 0,
      price_wholesale: +get(r, "price_wholesale") || 0,
      wholesale_min_qty: +get(r, "wholesale_min_qty") || 0,
      kind: /^consum|^ບໍລິໂພກ|^ສິນຄ້າບໍລິໂພກ/i.test(get(r, "kind")) ? "consumable" : "durable",
    }))
    .filter((x) => x.sku && x.name);
}
