// Proves a backup file can actually be restored.
//
// It builds a fresh database from supabase/migrations, replays the backup into
// it with every foreign key, check constraint and unique index enforced, and
// then re-derives stock from the movement history. An untested backup is only a
// hope, and the usual way to discover that is the day you need it.
//
//   npm run backup:verify                       newest file in the backup folder
//   npm run backup:verify -- --file path.gz     a specific one
//   npm run backup:verify -- --dir E:\backups   newest in another folder
//
// Scope: this verifies the shop data (the public schema) and that auth user ids
// are present and referenced correctly. It cannot verify Supabase's own auth
// service, which is not part of Postgres and has no local stand-in.
import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb, migrationsDir, migrationFiles } from "./lib/pgtest.mjs";

const root = fileURLToPath(new URL("..", import.meta.url)),
  argv = process.argv.slice(2),
  opt = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };

const die = (msg) => {
  console.error("\n" + msg + "\n");
  process.exit(1);
};

// ---------- pick a file ----------
const dir = resolve(root, opt("--dir", process.env.BACKUP_DIR || "../rapidewms-backups"));
let file = opt("--file", null);
if (!file) {
  let names = [];
  try {
    names = readdirSync(dir).filter((f) => /^rapidewms-.*\.ndjson\.gz$/.test(f)).sort();
  } catch {
    die(`No backup folder at ${dir}.\nRun: npm run backup`);
  }
  if (!names.length) die(`No backup files in ${dir}.\nRun: npm run backup`);
  file = join(dir, names[names.length - 1]);
}
file = resolve(root, file);

console.log(`\nVerifying ${file}\n`);

// ---------- read it ----------
let header = null,
  trailer = null;
const rowsByTable = new Map();
const lines = createInterface({
  input: createReadStream(file).pipe(createGunzip()),
  crlfDelay: Infinity,
});
let lineNo = 0;
for await (const line of lines) {
  lineNo++;
  if (!line.trim()) continue;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch (e) {
    die(`Line ${lineNo} is not valid JSON, so the file is damaged.\n${e.message}`);
  }
  if (obj.kind === "rapidewms-backup") header = obj;
  else if (obj.kind === "rapidewms-backup-end") trailer = obj;
  else if (obj.t) {
    if (!rowsByTable.has(obj.t)) rowsByTable.set(obj.t, []);
    rowsByTable.get(obj.t).push(obj.r);
  }
}

if (!header) die("No header line: this is not a RAPIDEWMS backup.");
// The trailer is written last, so its absence means the run was cut short.
if (!trailer) die("No trailer line: the backup is incomplete and must not be relied on.\nTake a fresh one: npm run backup");

const age = (Date.now() - new Date(header.taken_at)) / 864e5;
console.log(`  taken       ${header.taken_at} (${age < 1 ? "today" : Math.floor(age) + " days ago"})`);
console.log(`  size        ${(statSync(file).size / 1024).toFixed(1)} KB`);
console.log(`  secrets     ${header.secrets ? "password hashes included" : "no password hashes"}`);

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};
const pass = (msg) => console.log(`  pass  ${msg}`);

// ---------- does it match the schema we have today? ----------
const now = migrationFiles().map((f) => ({
  file: f,
  sha256: createHash("sha256").update(readFileSync(new URL(f, migrationsDir))).digest("hex"),
}));
const same =
  now.length === (header.migrations || []).length &&
  now.every((m, i) => m.file === header.migrations[i].file && m.sha256 === header.migrations[i].sha256);
if (same) pass("schema in this checkout matches the one the backup came from");
else
  console.log(
    `  note  the schema has changed since this backup was taken.\n` +
      `        Restoring it needs the migrations as of ${header.taken_at}, not today's.`,
  );

// ---------- replay into a real database ----------
const db = await freshDb();

// The stub auth.users holds only ids; that is all the public schema references.
const users = rowsByTable.get("auth.users") || [];
for (const u of users) await db.query("insert into auth.users (id) values ($1)", [u.id]);
pass(`${users.length} auth user${users.length === 1 ? "" : "s"} restored`);

const publicTables = (header.order || []).filter((t) => t.startsWith("public."));
for (const label of publicTables) {
  const rows = rowsByTable.get(label) || [],
    table = label.slice("public.".length);
  if (!rows.length) {
    pass(`${label}: empty`);
    continue;
  }
  // Insert with constraints live. A foreign key, check or unique violation here
  // is the backup telling us it does not hold together.
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const sqlText =
    `insert into public."${table}" (${cols.map((c) => `"${c}"`).join(", ")}) ` +
    `values (${cols.map((_, i) => "$" + (i + 1)).join(", ")})`;
  try {
    for (const r of rows) {
      const vals = cols.map((c) => {
        const v = r[c] ?? null;
        // jsonb and arrays arrive as parsed JSON; hand them back as text.
        return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
      });
      await db.query(sqlText, vals);
    }
    pass(`${label}: ${rows.length} row${rows.length === 1 ? "" : "s"} restored`);
  } catch (e) {
    fail(`${label}: ${e.message}`);
  }
}

// ---------- counts match what the backup claims ----------
for (const [label, n] of Object.entries(trailer.counts || {})) {
  if (!label.startsWith("public.")) continue;
  const table = label.slice("public.".length);
  let got;
  try {
    got = Number((await db.query(`select count(*)::int c from public."${table}"`)).rows[0].c);
  } catch (e) {
    fail(`${label}: could not count (${e.message})`);
    continue;
  }
  if (got !== n) fail(`${label}: trailer says ${n} rows, restored ${got}`);
}
if (!failures) pass("row counts match the trailer");

// ---------- is the data coherent? ----------
// Stock only ever moves through adjust_stock(), which writes a movement every
// time. So each item's quantity must equal its movements in minus out. If this
// drifts, the backup captured a torn read or something wrote to items directly.
const drift = await db.query(`
  select i.sku, i.qty::text qty, coalesce(sum(case when m.type = 'in' then m.qty else -m.qty end), 0)::text net
  from public.items i
  left join public.movements m on m.item_id = i.id
  group by i.id, i.sku, i.qty
  having i.qty <> coalesce(sum(case when m.type = 'in' then m.qty else -m.qty end), 0)
`);
if (drift.rows.length)
  for (const r of drift.rows) fail(`stock for ${r.sku} is ${r.qty} but its movements add up to ${r.net}`);
else pass("every item's stock matches its movement history");

// Units with a recorded expiry date are part of the stock, never more than it.
// (Backups taken before expiry tracking existed have no lots table to check.)
const hasLots = (await db.query("select to_regclass('public.lots') t")).rows[0].t;
if (hasLots) {
  const over = await db.query(`
    select i.sku, i.qty::text qty, sum(l.qty)::text dated
    from public.items i join public.lots l on l.item_id = i.id
    group by i.id, i.sku, i.qty
    having sum(l.qty) > i.qty
  `);
  if (over.rows.length)
    for (const r of over.rows) fail(`${r.sku} has ${r.dated} units with expiry dates but only ${r.qty} in stock`);
  else pass("no item has more dated units than stock");
}

// Shops without an owner would restore into data nobody can reach.
const orphans = await db.query(`
  select s.name from public.shops s
  where not exists (select 1 from public.members m where m.shop_id = s.id and m.role = 'owner')
`);
if (orphans.rows.length) for (const r of orphans.rows) fail(`shop "${r.name}" has no owner and would be unreachable`);
else pass("every shop has an owner");

const total = Object.values(trailer.counts || {}).reduce((a, b) => a + b, 0);
console.log(
  failures
    ? `\n${failures} problem${failures === 1 ? "" : "s"}: this backup is NOT safe to rely on\n`
    : `\nRestored and checked ${total} rows. This backup is good.\n`,
);

// Shut the database down and let Node exit by itself. Calling process.exit()
// here instead aborts on Windows with a libuv assertion *after* the result is
// printed, turning a good backup into a non-zero exit — the kind of false alarm
// people quickly learn to ignore, which would defeat the point of checking.
process.exitCode = failures ? 1 : 0;
await db.close();
