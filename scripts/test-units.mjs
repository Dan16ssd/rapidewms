// Unit tests for pure front-end logic that needs no browser and no database.
// Run: npm run test:unit
import { pageAll, PAGE } from "../src/data/page.js";
import { backupDate, toKeep } from "./lib/retention.mjs";

let fails = 0;
const ok = async (name, fn) => {
  try {
    await fn();
    console.log("  pass  " + name);
  } catch (e) {
    fails++;
    console.log("  FAIL  " + name + " - " + (e.message || e));
  }
};
const eq = (a, b, what) => {
  if (String(a) !== String(b)) throw new Error(`${what}: expected ${b}, got ${a}`);
};

// A stand-in for PostgREST: holds `rows`, but never returns more than `maxRows`
// in one response, and reports the true total as `count`.
function server(total, { maxRows = PAGE, withCount = true, rows } = {}) {
  const data = rows ?? Array.from({ length: total }, (_, i) => ({ id: i }));
  const calls = [];
  return {
    calls,
    make: () => ({
      range(from, to) {
        calls.push([from, to]);
        const n = Math.min(to - from + 1, maxRows);
        return Promise.resolve({
          data: data.slice(from, from + n),
          error: null,
          count: withCount ? data.length : null,
        });
      },
    }),
  };
}

console.log("Paging reads the whole table");

await ok("a short table is one request", async () => {
  const s = server(12);
  const { rows, total } = await pageAll(s.make);
  eq(rows.length, 12, "rows");
  eq(total, 12, "total");
  eq(s.calls.length, 1, "requests");
});

await ok("an empty table is not an error", async () => {
  const { rows, total } = await pageAll(server(0).make);
  eq(rows.length, 0, "rows");
  eq(total, 0, "total");
});

// The actual bug this fixes: 1001 products, only 1000 ever reached the app.
await ok("1001 rows past a 1000 cap are all returned", async () => {
  const { rows, total } = await pageAll(server(1001).make);
  eq(rows.length, 1001, "rows");
  eq(total, 1001, "total");
  eq(rows[1000].id, 1000, "last row");
});

await ok("2500 rows come back in order with no gaps or repeats", async () => {
  const s = server(2500);
  const { rows } = await pageAll(s.make);
  eq(rows.length, 2500, "rows");
  eq(new Set(rows.map((r) => r.id)).size, 2500, "distinct rows");
  eq(
    rows.every((r, i) => r.id === i),
    true,
    "order preserved",
  );
  eq(JSON.stringify(s.calls), JSON.stringify([[0, 999], [1000, 1999], [2000, 2999]]), "ranges");
});

await ok("a row count that is an exact multiple of the page size terminates", async () => {
  const s = server(2000);
  const { rows } = await pageAll(s.make);
  eq(rows.length, 2000, "rows");
  eq(s.calls.length, 2, "requests"); // must not ask for a third empty page
});

// A project whose Max rows is set below 1000 would make naive paging stop on
// the first short page and silently lose the rest.
await ok("a server cap smaller than the page size still returns everything", async () => {
  const s = server(1200, { maxRows: 400 });
  const { rows, total } = await pageAll(s.make);
  eq(rows.length, 1200, "rows");
  eq(total, 1200, "total");
  eq(s.calls.length, 3, "requests");
});

console.log("Caps and truncation");

await ok("a cap stops the read but still reports the true total", async () => {
  const s = server(5000);
  const { rows, total } = await pageAll(s.make, 50);
  eq(rows.length, 50, "rows");
  eq(total, 5000, "total");
  eq(s.calls.length, 1, "requests");
  eq(rows.length < total, true, "truncation is detectable");
});

await ok("a cap above the table size is not truncation", async () => {
  const { rows, total } = await pageAll(server(30).make, 10000);
  eq(rows.length, 30, "rows");
  eq(rows.length < total, false, "not truncated");
});

await ok("a cap that is not a page multiple asks for exactly the cap", async () => {
  const s = server(5000);
  const { rows } = await pageAll(s.make, 1500);
  eq(rows.length, 1500, "rows");
  eq(JSON.stringify(s.calls), JSON.stringify([[0, 999], [1000, 1499]]), "ranges");
});

console.log("Failure modes");

await ok("without a count it stops on a short page", async () => {
  const s = server(1500, { withCount: false });
  const { rows, total } = await pageAll(s.make);
  eq(rows.length, 1500, "rows");
  eq(total, 1500, "total falls back to what was read");
});

await ok("an error is mapped and thrown, not returned", async () => {
  const make = () => ({ range: () => Promise.resolve({ data: null, error: { message: "boom" } }) });
  let caught;
  try {
    await pageAll(make, Infinity, (e) => new Error("mapped: " + e.message));
  } catch (e) {
    caught = e;
  }
  eq(caught?.message, "mapped: boom", "thrown error");
});

await ok("a server that never satisfies its own count still terminates", async () => {
  // count says there is far more than the server ever hands over.
  const make = () => ({
    range: (from, to) =>
      Promise.resolve({
        data: Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i })),
        error: null,
        count: 1e9,
      }),
  });
  const { rows } = await pageAll(make);
  eq(rows.length, 500 * PAGE, "stops at the guard instead of looping for ever");
});

console.log("\nBackup retention");

// ---------- backup retention ----------
// This policy decides which backups get deleted, so it is worth being sure of.

const NOW = new Date("2026-11-03T12:00:00Z"),
  nameFor = (daysAgo) =>
    "rapidewms-" +
    new Date(NOW - daysAgo * 864e5)
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace(/-\d{3}Z$/, "Z") +
    ".ndjson.gz",
  // One backup a day going back `days` days.
  daily = (days) => Array.from({ length: days }, (_, i) => nameFor(i));

await ok("a filename round-trips back to its date", () => {
  const d = backupDate("rapidewms-2026-11-03T23-40-12Z.ndjson.gz");
  eq(d.toISOString(), "2026-11-03T23:40:12.000Z", "parsed date");
});

await ok("anything that is not a backup file is ignored", () => {
  eq(backupDate("notes.txt"), null, "plain file");
  eq(backupDate("rapidewms-nonsense.ndjson.gz"), null, "unparseable stamp");
  eq(toKeep(["notes.txt", "rapidewms-2026-11-03T23-40-12Z.ndjson.gz"], NOW).has("notes.txt"), false, "kept list");
});

await ok("a fortnight of daily backups is kept in full", () => {
  const names = daily(14);
  eq(toKeep(names, NOW).size, 14, "all kept");
});

await ok("past a fortnight it thins to one a week, not to nothing", () => {
  const keep = toKeep(daily(60), NOW);
  // 14 dailies, then roughly one per week for the remaining 46 days.
  if (keep.size >= 60) throw new Error("nothing was pruned");
  if (keep.size < 18) throw new Error(`pruned too hard: only ${keep.size} left`);
  for (let i = 0; i < 14; i++) if (!keep.has(nameFor(i))) throw new Error(`dropped a backup from ${i} days ago`);
});

await ok("a backup from years ago is never deleted", () => {
  const names = [nameFor(0), nameFor(400), nameFor(800), nameFor(1200)];
  const keep = toKeep(names, NOW);
  eq(keep.size, 4, "all four kept");
});

await ok("only the newest backup of an old year survives", () => {
  // Three from the same long-past year, plus a recent one.
  const old = [nameFor(900), nameFor(950), nameFor(1000)];
  const keep = toKeep([nameFor(0), ...old], NOW);
  eq(keep.has(nameFor(900)), true, "newest of that year kept");
  eq(keep.has(nameFor(1000)), false, "older one pruned");
});

await ok("it never prunes below three files, however old they are", () => {
  const names = [nameFor(900), nameFor(905), nameFor(910)];
  eq(toKeep(names, NOW).size, 3, "all three kept");
});

await ok("pruning is stable: running it twice changes nothing", () => {
  const first = [...toKeep(daily(120), NOW)],
    second = [...toKeep(first, NOW)];
  eq(second.length, first.length, "second pass keeps the same files");
});

console.log("\nExpiry dates");
const X = await import("../src/lib/expiry.js");
const cases = (name, fn, table) =>
  ok(name, () => {
    for (const [input, want] of table) eq(fn(input), want, JSON.stringify(input));
  });

await cases("typed shortcuts at the counter", X.parseTyped, [
  ["1227", "2027-12-31"],
  ["0228", "2028-02-29"], // leap year: end of Feb is the 29th
  ["311227", "2027-12-31"],
  ["122027", "2027-12-31"], // 12/20/27 is no date, so it reads as MMYYYY
  ["31122027", "2027-12-31"],
  ["20271231", "2027-12-31"],
  ["2027-12-31", "2027-12-31"],
  ["31/12/27", "2027-12-31"],
  ["1399", null], // month 13
  ["310227", null], // 31 Feb
  ["", null],
]);
await cases("slashes added while typing digits (iPhone number pad has no /)", X.slashDigits, [
  ["3112", "31/12"],
  ["311227", "31/12/27"],
  ["31122027", "31/12/2027"],
  ["20122027", "20/12/2027"], // 20 Dec, not a year-first date
  ["20271231", "20271231"], // year first: left as typed
  ["1227", "12/27"],
  ["062026", "06/2026"], // month and 4-digit year
  ["31/12/27", "31/12/27"], // already slashed
  ["31.12.27", "31.12.27"], // other characters: left alone
]);
ok("the slashes never change which date is meant", () => {
  for (const d of ["1227", "0228", "311227", "122027", "31122027", "20271231", "20122027", "062026", "150626", "310227", "12345"])
    eq(X.parseTyped(X.slashDigits(d)), X.parseTyped(d), d);
});
await cases("dates as printed on packages", X.parseExpiry, [
  ["EXP 12/05/2027", "2027-05-12"], // day first, as in Laos and Thailand
  ["EXP: 05/12/2027", "2027-12-05"],
  ["BB 2027-03-15", "2027-03-15"],
  ["EXP 12.05.27", "2027-05-12"],
  ["EXP 12/27", "2027-12-31"], // month/year: good to the end of the month
  ["Best before 12 MAY 2027", "2027-05-12"],
  ["BEST BEFORE MAR 2028", "2028-03-31"],
  ["MFG 01/01/26 EXP 01/01/28", "2028-01-01"],
  ["EXP 01/01/28 MFG 01/01/26", "2028-01-01"],
  ["01/01/26 01/07/27", "2027-07-01"], // no words: the later date
  ["ผลิต 01/01/2569 หมดอายุ 01/01/2571", "2028-01-01"], // Thai Buddhist years
  ["ໝົດອາຍຸ 15/08/2027", "2027-08-15"],
  ["HSD 20/10/2026 NSX 20/10/2025", "2026-10-20"], // Vietnamese
  ["EXP O5/1O/2O27", "2027-10-05"], // camera read zeros as the letter O
  ["EXP 311227", "2027-12-31"],
  ["05/13/2027", "2027-05-13"], // a second number over 12: printed month-first
  ["PRICE 12.50 KIP", null],
  ["no date here", null],
]);
await ok("GS1 barcodes give up their expiry date and product number", () => {
  const a = X.parseGS1("(01)08850999320014(17)271231(10)LOT7");
  eq(`${a.gtin} ${a.expiry} ${a.batch}`, "08850999320014 2027-12-31 LOT7", "bracketed");
  const b = X.parseGS1("]d201088509993200141727120010LOT7\x1d21SER1");
  eq(`${b.gtin} ${b.expiry} ${b.batch}`, "08850999320014 2027-12-31 LOT7", "raw, day 00 = end of month");
  eq(X.parseGS1("5449000000996"), null, "a plain EAN-13 is not GS1");
});
await ok("a GS1 code finds the product filed under its EAN-13", () => {
  const items = [
    { sku: "COKE", barcode: "5449000000996" },
    { sku: "MILK", barcode: "8850999320014" },
  ];
  const r = X.lookupCode(items, "(01)08850999320014(17)280131");
  eq(`${r.item.sku} ${r.expiry}`, "MILK 2028-01-31", "match");
  eq(X.lookupCode(items, "coke").item.sku, "COKE", "by SKU");
  eq(X.lookupCode(items, "5449000000996").expiry, null, "plain code has no date");
  eq(X.lookupCode(items, "123").item, undefined, "unknown");
});
await ok("status: expired, expiring soon, fine", () => {
  eq(X.status("2026-01-09", "2026-01-10"), "expired", "yesterday");
  eq(X.status("2026-01-10", "2026-01-10"), "soon", "today");
  eq(X.status("2026-02-09", "2026-01-10"), "soon", "30 days");
  eq(X.status("2026-02-10", "2026-01-10"), "ok", "31 days");
  eq(X.daysLeft("2026-03-01", "2026-02-27"), 2, "across month end");
});

console.log("\nOffline queue");
const Q = await import("../src/data/queue.js");
const net = Object.assign(new Error("Failed to fetch"), { code: "err.offline" });
const isNet = (e) => e.code == "err.offline";
const rec = (op, at, id) => ({ ...Q.record("shopQ", op, {}, id), at });
await ok("sends in the order things happened, not the order they were queued", async () => {
  for (const r of [
    rec("sale", "2026-11-07T10:05:00Z", "q-2"),
    rec("sale", "2026-11-07T10:01:00Z", "q-1"),
    rec("void", "2026-11-07T10:09:00Z", "q-3"),
  ])
    await Q.add(r);
  const seen = [];
  const out = await Q.flush("shopQ", async (r) => seen.push(r.id), isNet);
  eq(seen.join(","), "q-1,q-2,q-3", "order");
  eq(out.sent.length, 3, "sent");
  eq((await Q.pending("shopQ")).length, 0, "queue empty");
});
await ok("no connection: stops, keeps the rest, marks them offline", async () => {
  await Q.add(rec("sale", "2026-11-07T11:00:00Z", "n-1"));
  await Q.add(rec("adjust", "2026-11-07T11:01:00Z", "n-2"));
  const out = await Q.flush("shopQ", async (r) => {
    if (r.id == "n-2") throw net;
  }, isNet);
  eq(out.stopped, true, "stopped");
  eq((await Q.pending("shopQ")).map((r) => r.id + ":" + r.offline).join(","), "n-2:true", "left");
  await Q.flush("shopQ", async () => {}, isNet);
});
await ok("refused by the server: goes to the couldn't-send list, the rest still go", async () => {
  await Q.add(rec("writeoff", "2026-11-07T12:00:00Z", "r-1"));
  await Q.add(rec("sale", "2026-11-07T12:01:00Z", "r-2"));
  const seen = [];
  await Q.flush("shopQ", async (r) => {
    if (r.id == "r-1") throw new Error("lot not found");
    seen.push(r.id);
  }, isNet);
  eq(seen.join(","), "r-2", "sent");
  eq((await Q.failed("shopQ")).map((r) => r.id + ":" + r.error.message).join(","), "r-1:lot not found", "failed");
  await Q.retry("r-1");
  eq((await Q.pending("shopQ")).length, 1, "back in the queue");
  await Q.flush("shopQ", async () => {}, isNet);
  eq((await Q.failed("shopQ")).length, 0, "list empty");
});
await ok("refused while the person waits: the error goes back to them", async () => {
  await Q.add(rec("sale", "2026-11-07T13:00:00Z", "f-1"));
  const out = await Q.flush("shopQ", async () => {
    throw new Error("not enough stock");
  }, isNet, "f-1");
  eq(out.freshError?.message, "not enough stock", "error");
  eq((await Q.failed("shopQ")).length + (await Q.pending("shopQ")).length, 0, "not kept");
});

console.log("\nOffline copy (apply.js, the same rules as the database)");
const AP = await import("../src/data/apply.js");
const shopDb = () => ({
  items: [
    { id: "i1", shop_id: "s", sku: "MILK", name: "Milk", qty: 20, min_qty: 0, price: 10000, price_wholesale: 9000, wholesale_min_qty: 12 },
  ],
  lots: [
    { id: "l1", shop_id: "s", item_id: "i1", expiry: "2000-01-01", qty: 6 },
    { id: "l2", shop_id: "s", item_id: "i1", expiry: "2099-01-01", qty: 4 },
    { id: "l3", shop_id: "s", item_id: "i1", expiry: "2099-03-01", qty: 8 },
  ],
  movements: [],
  sales: [],
  sale_lines: [],
  orders: [],
  settings: {},
});
const lotList = (d) => d.lots.map((l) => `${l.expiry}:${l.qty}`).join(" ");
const C0 = { shopId: "s", at: "2026-11-07T10:00:00Z" };
await ok("takes in-date lots soonest first, then undated, then expired (as test-db)", async () => {
  const d = shopDb();
  AP.stockMove(d, C0, "i1", -5, "x");
  eq(lotList(d), "2000-01-01:6 2099-03-01:7", "after 5");
  AP.stockMove(d, C0, "i1", -8, "x");
  eq(lotList(d), "2000-01-01:6", "after 13");
  AP.stockMove(d, C0, "i1", -2, "x");
  eq(lotList(d), "2000-01-01:5", "after 15");
});
await ok("online it refuses to go below zero; offline it goes below and drops every lot", async () => {
  const d = shopDb();
  let threw = false;
  try {
    AP.stockMove(d, C0, "i1", -21, "x");
  } catch (e) {
    threw = e.code == "err.stock";
  }
  eq(threw, true, "refused");
  AP.stockMove(d, { ...C0, short: true }, "i1", -21, "x");
  eq(`${d.items[0].qty} [${lotList(d)}]`, "-1 []", "below zero");
  AP.stockMove(d, C0, "i1", 5, "in", "2099-05-01");
  eq(`${d.items[0].qty} [${lotList(d)}]`, "4 [2099-05-01:4]", "hole filled first");
});
await ok("an offline sale keeps its price and time; a resend is the same sale", async () => {
  const d = shopDb(),
    args = { id: "q-c1", client_id: "c1", lines: [{ item_id: "i1", qty: 2, price: 7000 }], paid: 1e9 };
  const s = AP.sale(d, { ...C0, short: true }, args);
  eq(`${s.total} ${s.created_at} ${d.items[0].qty}`, "14000 2026-11-07T10:00:00Z 18", "sale");
  eq(AP.sale(d, { ...C0, short: true }, args) === s, true, "same sale");
  eq(d.items[0].qty, 18, "stock once");
  AP.voidSale(d, C0, s);
  AP.voidSale(d, C0, s);
  eq(`${d.items[0].qty} ${s.status}`, "20 void", "voided once");
});
await ok("receipt numbers: the till's own when it has one", async () => {
  eq(AP.saleNo({ till: "B", till_no: 42 }), "B-0042", "till");
  eq(AP.saleNo({ receipt_no: 7 }), "7", "server");
  eq(AP.saleNo({}), "…", "not yet");
});

console.log("Packs, expiring price, VAT (apply.js = create_sale)");
const packDb = () => {
  const d = shopDb();
  d.packs = [{ id: "p1", shop_id: "s", item_id: "i1", name: "Crate", size: 6, barcode: "CR-1", price: 54000 }];
  d.settings = { s: { vat_rate: 10 } };
  return d;
};
await ok("a pack line takes size × packs, at the pack price, and records the pack", async () => {
  const d = packDb(),
    s = AP.sale(d, C0, { client_id: "pk1", paid: 1e9, lines: [{ item_id: "i1", qty: 2, pack_id: "p1" }] });
  eq(d.items[0].qty, 8, "stock");
  eq(`${s.total} ${d.sale_lines[0].qty} ${d.sale_lines[0].pack_qty} ${d.sale_lines[0].pack_name}`, "108000 12 2 Crate", "line");
});
await ok("VAT inside the total, rounded like the database", async () => {
  const d = packDb(),
    s = AP.sale(d, C0, { client_id: "pk2", paid: 1e9, lines: [{ item_id: "i1", qty: 2, pack_id: "p1" }] });
  eq(`${s.vat} ${s.vat_rate}`, "9818.18 10", "vat");
  eq(AP.vatOf(210000, 10), 19090.91, "as test-db");
  eq(AP.vatOf(5000, 0), 0, "no VAT");
});
await ok("an expiring-price batch sells first, at its price", async () => {
  const d = packDb();
  d.lots.find((l) => l.expiry == "2099-03-01").price = 4000;
  const s = AP.sale(d, C0, { client_id: "cut1", paid: 1e9, lines: [{ item_id: "i1", qty: 3, expiry: "2099-03-01" }] });
  eq(s.total, 12000, "total");
  eq(lotList(d), "2000-01-01:6 2099-01-01:4 2099-03-01:5", "that batch");
});
await ok("pack and plain lines of one product stay separate lines", async () => {
  const d = packDb(),
    s = AP.sale(d, C0, { client_id: "mix1", paid: 1e9, lines: [{ item_id: "i1", qty: 1, pack_id: "p1" }, { item_id: "i1", qty: 2 }] });
  eq(`${d.sale_lines.length} ${s.total}`, "2 74000", "lines");
});
await ok("lookupCode finds a product by its pack's barcode", async () => {
  const d = packDb(),
    r = X.lookupCode(d.items, "CR-1", d.packs);
  eq(`${r.item?.sku} ${r.pack?.name}`, "MILK Crate", "found");
  eq(X.lookupCode(d.items, "CR-1").item, undefined, "not without packs");
});

console.log("Import from another POS");
const IM = await import("../src/lib/importer.js");
const F = await import("../src/data/fields.js");
await ok("Loyverse item columns are recognised", async () => {
  const head = ["Handle", "SKU", "Name", "Category", "Sold by weight", "Default price", "Cost", "Barcode", "In stock [Main shop]", "Low stock [Main shop]"],
    m = IM.guessColumns(head, "products");
  eq(`${m.sku} ${m.name} ${m.category} ${m.price} ${m.cost} ${m.barcode} ${m.qty} ${m.min_qty} ${m.unit}`, "1 2 3 5 6 7 8 9 -1", "map");
  eq(IM.guessKind(head), "products", "kind");
});
await ok("this app's own Inventory export is recognised", async () => {
  const head = ["SKU", "Name", "Category", "Barcode", "Qty", "Min", "Cost (LAK)", "Price (LAK)", "Wholesale (LAK)", "Wholesale min", "Value (LAK)", "Kind", "Next expiry", "Unit"],
    m = IM.guessColumns(head, "products");
  eq(`${m.qty} ${m.min_qty} ${m.cost} ${m.price} ${m.price_wholesale} ${m.wholesale_min_qty} ${m.kind} ${m.unit}`, "4 5 6 7 8 9 11 13", "map");
});
await ok("customer and receipt files are told apart", async () => {
  eq(IM.guessKind(["Customer name", "Email", "Phone", "Note"]), "customers", "customers");
  eq(IM.guessKind(["Date", "Receipt number", "Receipt type", "SKU", "Item", "Quantity", "Gross sales"]), "sales", "sales");
});
await ok("money and dates as other systems write them", async () => {
  eq(IM.number("₭12,000"), 12000, "kip");
  eq(IM.number("฿1,234.50"), 1234.5, "baht");
  eq(isNaN(IM.number("")), true, "blank");
  const d = IM.parseDate("14/11/2026 13:05", "dmy");
  eq(`${d.getDate()}/${d.getMonth() + 1} ${d.getHours()}:${d.getMinutes()}`, "14/11 13:5", "day first");
  eq(IM.dateOrder(["11/02/26 1:05 PM", "11/14/26 9:00 AM"]), "mdy", "month first seen");
  const m = IM.parseDate("11/14/26 1:05 PM", "mdy");
  eq(`${m.getFullYear()} ${m.getMonth() + 1} ${m.getDate()} ${m.getHours()}`, "2026 11 14 13", "US with PM");
  eq(IM.parseDate("12 AM", "dmy"), null, "not a date");
  eq(IM.parseDate("31/02/2026", "dmy"), null, "no 31 February");
});
await ok("receipt rows become sales; refunds are left out", async () => {
  const head = ["Date", "Receipt number", "Receipt type", "SKU", "Item", "Quantity", "Gross sales", "Discounts", "Payment type", "Customer name"],
    rows = [
      ["05/01/2026 10:00", "1-1001", "Sale", "CAN", "Soda", "3", "27,000", "0", "Cash", "Mr Somchai"],
      ["05/01/2026 10:00", "1-1001", "Sale", "", "Bread", "1", "5000", "1000", "Cash", ""],
      ["06/01/2026 11:00", "1-1002", "Refund", "CAN", "Soda", "1", "9000", "0", "Cash", ""],
      ["07/01/2026 12:00", "1-1003", "Sale", "CAN", "Soda", "2", "18000", "0", "BCEL OnePay", ""],
    ],
    { records } = IM.build("sales", rows, IM.guessColumns(head, "sales"));
  eq(records.map((s) => `${s.ref}:${s.lines.length}:${s.discount}:${s.method}`).join(" "), "1-1001:2:1000:cash 1-1003:1:0:transfer", "sales");
  eq(`${records[0].lines[0].price} ${records[0].customer.name}`, "9000 Mr Somchai", "price from the line total");
});
await ok("a customer list drops what is already here and repeats in the file", async () => {
  const have = [{ name: "Noy", phone: "020 1" }],
    list = [{ name: "Noy again", phone: "020 1" }, { name: "Bee" }, { name: "bee" }, { name: "" }, { name: "Kham", phone: "020 2" }];
  eq(F.newCustomers(list, have).map((c) => c.name).join(","), "Bee,Kham", "fresh");
});
await ok("an imported sale is history: no stock moves, a repeat adds nothing (as test-db)", async () => {
  const d = { ...shopDb(), customers: [], settings: { s: { vat_rate: 10 } } },
    row = { ref: "R-1", at: "2026-01-05T03:00:00Z", customer: { name: "Mr Somchai", phone: "020 9" }, discount: 1000,
      lines: [{ sku: "milk", qty: 2, price: 10000 }, { name: "Gone", qty: 1, price: 1000 }] };
  eq(AP.importSale(d, C0, row, 1), true, "added");
  eq(AP.importSale(d, C0, row, 2), false, "repeat");
  const s = d.sales[0];
  eq(`${s.total} ${s.till} ${s.flags} ${s.client_id} ${d.items[0].qty} ${d.movements.length}`, "20000 IMP imported import:R-1 20 0", "sale");
  eq(d.sale_lines.map((l) => `${l.item_id || "none"}:${l.sku}`).join(" "), "i1:MILK none:-", "lines");
  eq(`${d.customers.length} ${s.customer_id == d.customers[0].id}`, "1 true", "customer added");
  AP.importSale(d, C0, { ...row, ref: "R-2", customer: { phone: "020 9" } }, 3);
  eq(d.customers.length, 1, "matched by phone");
});
await ok("a future date or a bad line stops the import", async () => {
  const d = { ...shopDb(), customers: [], settings: {} };
  let n = 0;
  for (const bad of [{ at: "2099-01-01" }, { lines: [{ sku: "MILK", qty: 0, price: 1 }] }, { discount: 1e9 }])
    try {
      AP.importSale(d, C0, { ref: "B", at: "2026-01-01", lines: [{ sku: "MILK", qty: 1, price: 1 }], ...bad }, 1);
    } catch {
      n++;
    }
  eq(n, 3, "refused");
});
await ok("a till sale keeps its customer, or drops one from another shop", async () => {
  const d = { ...shopDb(), customers: [{ id: "c1", shop_id: "s", name: "A" }, { id: "c2", shop_id: "x", name: "B" }] };
  eq(AP.sale(d, C0, { client_id: "cs1", paid: 1e9, customer_id: "c1", lines: [{ item_id: "i1", qty: 1 }] }).customer_id, "c1", "mine");
  eq(AP.sale(d, C0, { client_id: "cs2", paid: 1e9, customer_id: "c2", lines: [{ item_id: "i1", qty: 1 }] }).customer_id, null, "other shop");
});

console.log(fails ? `\n${fails} FAILED` : "\nAll unit checks passed");
process.exit(fails ? 1 : 0);
