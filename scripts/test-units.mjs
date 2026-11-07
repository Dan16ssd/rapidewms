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

console.log("\nProduct identify (type from the model's name)");
const { typeOf, cleanName, TYPES } = await import("../src/lib/identify.js");
// The model's own answers, recorded in the browser test, and names staff type.
for (const [said, name, type] of [
  ["Drinking Water.", "Drinking Water", "drink"],
  ["This product is a hammer.", "Hammer", "tool"],
  ["Potato Chips", "Potato Chips", "food"],
  ["Paracetamol.", "Paracetamol", "medicine"],
  ["T-Shirt", "T-Shirt", "clothing"],
  ["The product is a USB Charger.", "USB Charger", "electronics"],
  ["Rice cooker", "Rice cooker", "electronics"],
  ["Ice cream cone", "Ice cream cone", "food"],
  ["Face cream", "Face cream", "cosmetic"],
  ["Beefsteak", "Beefsteak", ""],
  ["ເບຍລາວ", "ເບຍລາວ", "drink"],
  ["สบู่ Lux", "สบู่ Lux", "cosmetic"],
])
  await ok(`"${said}" → ${name} (${type || "person picks"})`, () => {
    eq(cleanName(said), name, "name");
    eq(typeOf(cleanName(said)), type, "type");
  });
await ok("every type is consumable or durable", () =>
  eq(Object.values(TYPES).every((k) => k == "consumable" || k == "durable"), true, "kinds"),
);

console.log(fails ? `\n${fails} FAILED` : "\nAll unit checks passed");
process.exit(fails ? 1 : 0);
