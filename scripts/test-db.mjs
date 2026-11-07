// Runs the migrations in an in-memory Postgres (PGlite) with a minimal stand-in
// for Supabase's auth schema, then checks security and stock rules.
// Usage: npm run test:db
import { freshDb } from "./lib/pgtest.mjs";

const db = await freshDb();

const A = "00000000-0000-0000-0000-00000000000a",
  B = "00000000-0000-0000-0000-00000000000b";
await db.exec(`insert into auth.users values ('${A}'), ('${B}')`);

let failures = 0;
const as = async (user, sql, params) => {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user ?? ""}', false);
                 set role ${user ? "authenticated" : "anon"};`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec("reset role");
  }
};
const ok = async (name, fn) => {
  try {
    await fn();
    console.log("  pass ", name);
  } catch (e) {
    failures++;
    console.log("  FAIL ", name, "-", e.message);
  }
};
const rejects = (name, fn) =>
  ok(name, async () => {
    let threw = false;
    try {
      await fn();
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("expected an error, got success");
  });
const eq = (a, b, what) => {
  if (String(a) !== String(b)) throw new Error(`${what}: expected ${b}, got ${a}`);
};

const shopA = (await as(A, "select create_shop('Shop A') id")).rows[0].id;
const shopB = (await as(B, "select create_shop('Shop B') id")).rows[0].id;
const item = (
  await as(A, "insert into items (shop_id, sku, name, min_qty) values ($1, 'B-1', 'Bolt', 5) returning id", [shopA])
).rows[0].id;

console.log("Isolation");
await ok("owner sees own item", async () =>
  eq((await as(A, "select count(*) n from items")).rows[0].n, 1, "rows"));
await ok("other shop sees nothing", async () =>
  eq((await as(B, "select count(*) n from items")).rows[0].n, 0, "rows"));
await ok("anonymous sees nothing", async () =>
  eq((await as(null, "select count(*) n from shops").catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n, 0, "rows"));
await rejects("cannot insert into another shop", () =>
  as(B, "insert into items (shop_id, sku, name) values ($1, 'X', 'X')", [shopA]));
await rejects("cannot adjust another shop's stock", () =>
  as(B, "select adjust_stock($1, 5)", [item]));
await ok("cannot edit another shop's item (0 rows)", async () =>
  eq((await as(B, "update items set name = 'hacked' where id = $1", [item])).affectedRows ?? 0, 0, "rows"));

console.log("Stock rules");
await rejects("qty column not writable directly", () =>
  as(A, "update items set qty = 999 where id = $1", [item]));
await ok("adjust_stock adds and logs", async () => {
  eq((await as(A, "select adjust_stock($1, 10, 'test') q", [item])).rows[0].q, 10, "qty");
  eq((await as(A, "select count(*) n from movements")).rows[0].n, 1, "movements");
});
await rejects("cannot go negative", () => as(A, "select adjust_stock($1, -11)", [item]));
await ok("set_stock logs the difference", async () => {
  eq((await as(A, "select set_stock($1, 7) q", [item])).rows[0].q, 7, "qty");
  eq((await as(A, "select qty from movements order by created_at desc, type limit 1")).rows[0].qty, 3, "diff");
});

console.log("Orders");
const ord = (
  await as(A, "insert into orders (shop_id, item_id, type, qty) values ($1, $2, 'out', 2) returning id", [shopA, item])
).rows[0].id;
await rejects("order status not writable directly", () =>
  as(A, "update orders set status = 'done' where id = $1", [ord]));
await ok("complete_order ships stock", async () => {
  await as(A, "select complete_order($1)", [ord]);
  eq((await as(A, "select qty from items where id = $1", [item])).rows[0].qty, 5, "qty");
});
await rejects("cannot complete twice", () => as(A, "select complete_order($1)", [ord]));
await rejects("cannot order another shop's item", () =>
  as(B, "insert into orders (shop_id, item_id, type, qty) values ($1, $2, 'in', 1)", [shopB, item]));

console.log("Automation");
await ok("auto-reorder creates one pending order", async () => {
  await as(A, "update settings set auto_reorder = true where shop_id = $1", [shopA]);
  await as(A, "select adjust_stock($1, -2)", [item]); // 3 < min 5
  await as(A, "select adjust_stock($1, -1)", [item]); // still low, no duplicate
  const r = (await as(A, "select qty from orders where auto and status = 'pending'")).rows;
  eq(r.length, 1, "auto orders");
  eq(r[0].qty, 7, "reorder qty (2*5-3)");
});
await rejects("staff/other user cannot change settings", async () => {
  const r = await as(B, "update settings set auto_reorder = false where shop_id = $1 returning 1", [shopA]);
  if (!r.rows.length) throw new Error("no rows");
});

// ---------- expiry and the till ----------
// Run on shop B, so shop A keeps exactly the one item the Billing checks expect.
// C is staff in shop B.
const C = "00000000-0000-0000-0000-00000000000c";
await db.exec(`insert into auth.users values ('${C}'); insert into members values ('${shopB}', '${C}', 'staff')`);
const one = async (user, sql, params) => (await as(user, sql, params)).rows[0];
const qtyOf = async (id) => +(await one(B, "select qty from items where id = $1", [id])).qty;
const lotsOf = async (id) =>
  (await as(B, "select to_char(expiry, 'YYYY-MM-DD') e, qty::int q from lots where item_id = $1 order by expiry", [id]))
    .rows.map((r) => `${r.e}:${r.q}`)
    .join(" ");
// Stock equals its movements, and dated stock never exceeds stock.
const balanced = async () => {
  const bad = await as(B, `
    select i.sku from items i
    where i.qty <> coalesce((select sum(case when m.type = 'in' then m.qty else -m.qty end)
                             from movements m where m.item_id = i.id), 0)
       or coalesce((select sum(qty) from lots l where l.item_id = i.id), 0) > i.qty`);
  if (bad.rows.length) throw new Error("stock out of step for " + bad.rows.map((r) => r.sku).join(", "));
};
const milk = (
  await one(
    B,
    `insert into items (shop_id, sku, name, kind, price, price_wholesale, wholesale_min_qty)
     values ($1, 'MILK', 'Milk', 'consumable', 10000, 9000, 12) returning id`,
    [shopB],
  )
).id;
const soap = (
  await one(B, "insert into items (shop_id, sku, name, price) values ($1, 'SOAP', 'Soap', 5000) returning id", [shopB])
).id;

console.log("Expiry");
await ok("receiving with an expiry date makes a lot; the same date again adds to it", async () => {
  await as(B, "select adjust_stock($1, 5, 'in', '2099-03-01')", [milk]);
  await as(B, "select adjust_stock($1, 3, 'in', '2099-03-01')", [milk]);
  await as(B, "select adjust_stock($1, 4, 'in', '2099-01-01')", [milk]);
  await as(B, "select adjust_stock($1, 2)", [milk]); // no date recorded
  await as(B, "select adjust_stock($1, 6, 'in', '2000-01-01')", [milk]); // already expired
  eq(await qtyOf(milk), 20, "qty");
  eq(await lotsOf(milk), "2000-01-01:6 2099-01-01:4 2099-03-01:8", "lots");
  await balanced();
});
await ok("stock leaves soonest-in-date first, then undated, expired last", async () => {
  await as(B, "select adjust_stock($1, -5)", [milk]); // 4 of Jan, 1 of Mar
  eq(await lotsOf(milk), "2000-01-01:6 2099-03-01:7", "after 5");
  await as(B, "select adjust_stock($1, -8)", [milk]); // 7 of Mar, 1 undated
  eq(await lotsOf(milk), "2000-01-01:6", "after 13");
  await as(B, "select adjust_stock($1, -2)", [milk]); // last undated, then 1 expired
  eq(await lotsOf(milk), "2000-01-01:5", "after 15");
  eq(await qtyOf(milk), 5, "qty");
  await balanced();
});
await ok("write_off_lot takes the whole lot out of stock and logs it", async () => {
  const lot = (await one(B, "select id from lots where item_id = $1", [milk])).id;
  await as(C, "select write_off_lot($1)", [lot]); // staff may do it
  eq(await qtyOf(milk), 0, "qty");
  eq(await lotsOf(milk), "", "lots");
  eq(
    (await one(B, "select note from movements where item_id = $1 order by created_at desc limit 1", [milk])).note,
    "expired",
    "note",
  );
  await balanced();
});
await rejects("lots cannot be written directly", () =>
  as(B, "insert into lots (shop_id, item_id, expiry, qty) values ($1, $2, '2099-01-01', 1)", [shopB, milk]));
await rejects("stock_move is not callable by clients", () =>
  as(B, "select stock_move($1, 100, 'x', null, null)", [milk]));
await rejects("another shop cannot write off my lot", async () => {
  await as(B, "select adjust_stock($1, 1, 'in', '2099-05-05')", [milk]);
  const lot = (await one(B, "select id from lots where item_id = $1", [milk])).id;
  await as(A, "select write_off_lot($1)", [lot]);
});

console.log("Cashier");
await as(B, "select adjust_stock($1, 30, 'in', '2099-06-01')", [milk]); // milk 31
await as(B, "select adjust_stock($1, 10)", [soap]); // soap 10
const sell = (user, cid, lines, disc = 0, method = "cash", paid = 1e9) =>
  one(user, "select create_sale($1, $2, $3::jsonb, $4, $5, $6) id", [
    shopB,
    cid,
    JSON.stringify(lines),
    disc,
    method,
    paid,
  ]);
let sale1;
await ok("a sale takes stock and is priced on the server", async () => {
  sale1 = (
    await sell(
      C,
      "till-1-0001",
      [
        { item_id: milk, qty: 2 },
        { item_id: soap, qty: 1 },
        { item_id: milk, qty: 1 },
      ],
      0,
      "cash",
      50000,
    )
  ).id;
  const s = await one(
    B,
    "select receipt_no, subtotal::int, total::int, paid::int, change_due::int from sales where id = $1",
    [sale1],
  );
  eq(`${s.receipt_no} ${s.subtotal} ${s.total} ${s.paid} ${s.change_due}`, "1 35000 35000 50000 15000", "sale");
  eq((await one(B, "select count(*)::int n from sale_lines where sale_id = $1", [sale1])).n, 2, "lines (milk merged)");
  eq(await qtyOf(milk), 28, "milk");
  eq(await qtyOf(soap), 9, "soap");
  await balanced();
});
await ok("the same sale sent twice is sold once", async () => {
  eq((await sell(C, "till-1-0001", [{ item_id: milk, qty: 2 }])).id, sale1, "same sale");
  eq(await qtyOf(milk), 28, "milk unchanged");
});
await ok("the wholesale price applies from the wholesale quantity", async () => {
  const id = (await sell(B, "till-1-0002", [{ item_id: milk, qty: 12 }])).id;
  eq((await one(B, "select unit_price::int p from sale_lines where sale_id = $1", [id])).p, 9000, "price");
  eq((await one(B, "select receipt_no from sales where id = $1", [id])).receipt_no, 2, "receipt numbers run on");
});
await ok("a sale that fails on one line moves nothing and uses no receipt number", async () => {
  let threw = false;
  try {
    await sell(B, "till-1-0003", [
      { item_id: soap, qty: 1 },
      { item_id: milk, qty: 999 },
    ]);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("oversold");
  eq(await qtyOf(soap), 9, "soap untouched");
  eq((await one(B, "select receipt_seq from shops where id = $1", [shopB])).receipt_seq, 2, "receipt_seq");
});
await rejects("cash below the total is refused", () =>
  sell(B, "till-1-0004", [{ item_id: soap, qty: 1 }], 0, "cash", 4999));
await rejects("a discount above the subtotal is refused", () =>
  sell(B, "till-1-0005", [{ item_id: soap, qty: 1 }], 6000));
await rejects("a product with no sell price cannot be sold", async () => {
  const free = (await one(B, "insert into items (shop_id, sku, name) values ($1, 'FREE', 'No price') returning id", [shopB])).id;
  await as(B, "select adjust_stock($1, 1)", [free]);
  await sell(B, "till-1-0006", [{ item_id: free, qty: 1 }]);
});
await ok("a transfer is recorded for the exact total, after discount", async () => {
  const id = (await sell(B, "till-1-0007", [{ item_id: soap, qty: 2 }], 1000, "transfer", 0)).id;
  const s = await one(B, "select total::int, paid::int, change_due::int from sales where id = $1", [id]);
  eq(`${s.total} ${s.paid} ${s.change_due}`, "9000 9000 0", "sale");
});
await rejects("another shop cannot sell my products", () =>
  one(A, "select create_sale($1, 'x-till-0001', $2::jsonb, 0, 'cash', 1e9)", [
    shopA,
    JSON.stringify([{ item_id: soap, qty: 1 }]),
  ]));
await ok("another shop sees none of my sales", async () =>
  eq((await one(A, "select count(*)::int n from sales")).n, 0, "sales"));
await rejects("sales cannot be written directly", () => as(B, "update sales set total = 1 where id = $1", [sale1]));
await rejects("staff cannot void a sale", () => as(C, "select void_sale($1)", [sale1]));
await ok("void puts every unit back, into the lot it came from", async () => {
  const before = await lotsOf(milk);
  await as(B, "select void_sale($1)", [sale1]);
  eq(await qtyOf(milk), 16 + 3, "milk");
  eq(await qtyOf(soap), 7 + 1, "soap");
  eq((await one(B, "select status from sales where id = $1", [sale1])).status, "void", "status");
  if (before == (await lotsOf(milk))) throw new Error("lots did not change");
  await balanced();
});
await rejects("a sale cannot be voided twice", () => as(B, "select void_sale($1)", [sale1]));
await ok("erase removes sales, lines and lots too", async () => {
  await as(B, "select erase_shop_data($1)", [shopB]);
  const n = await one(
    B,
    "select (select count(*) from sales) + (select count(*) from sale_lines) + (select count(*) from lots) + (select count(*) from items) n",
  );
  eq(n.n, 0, "rows");
});

console.log("Billing");
await rejects("owner cannot extend own plan", () =>
  as(A, "update shops set plan_until = now() + interval '10 years' where id = $1", [shopA]));
await db.exec(`update shops set plan_until = now() - interval '1 day' where id = '${shopA}'`);
await ok("expired shop is still readable", async () =>
  eq((await as(A, "select count(*) n from items")).rows[0].n, 1, "rows"));
await rejects("expired shop cannot add items", () =>
  as(A, "insert into items (shop_id, sku, name) values ($1, 'N', 'N')", [shopA]));
await rejects("expired shop cannot adjust stock", () => as(A, "select adjust_stock($1, 1)", [item]));

console.log(failures ? `\n${failures} FAILED` : "\nAll database checks passed");
process.exit(failures ? 1 : 0);
