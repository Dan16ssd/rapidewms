// Runs the migrations in an in-memory Postgres (PGlite) with a minimal stand-in
// for Supabase's auth schema, then checks security and stock rules.
// Usage: npm run test:db
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";

const db = new PGlite();
const dir = new URL("../supabase/migrations/", import.meta.url);

await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth, public to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`);
for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort())
  await db.exec(readFileSync(new URL(f, dir), "utf8"));

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
