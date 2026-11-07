// Logical backup of the live Supabase database.
//
// Supabase's own dashboard says "Free Plan does not include project backups",
// so until this runs there is exactly one copy of a shop's data: the live
// database. This script needs no pg_dump, Docker or Supabase CLI — it speaks
// the Postgres wire protocol directly and writes one gzipped NDJSON file.
//
//   npm run backup                      back up, then prune by the policy below
//   npm run backup -- --dir E:\backups  write somewhere else (USB stick, OneDrive)
//   npm run backup -- --with-secrets    also store password hashes
//   npm run backup -- --no-prune        delete nothing
//
// A backup nobody has restored is only a hope, so check it with:
//   npm run backup:verify
import postgres from "postgres";
import { createWriteStream, readFileSync, readdirSync, mkdirSync, unlinkSync, existsSync, statSync } from "node:fs";
import { createGzip } from "node:zlib";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { migrationsDir, migrationFiles } from "./lib/pgtest.mjs";
import { backupDate, toKeep } from "./lib/retention.mjs";

const root = fileURLToPath(new URL("..", import.meta.url)),
  argv = process.argv.slice(2),
  flag = (name) => argv.includes(name),
  opt = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };

const die = (msg) => {
  console.error("\n" + msg + "\n");
  process.exit(1);
};

// ---------- where backups go ----------
// Default is a sibling of the project, never inside it: a data file that lands
// in the working tree is one `git add -A` away from a public repository.
const dir = resolve(root, opt("--dir", process.env.BACKUP_DIR || "../rapidewms-backups"));
const inside = (child, parent) => {
  const r = relative(parent, child);
  return r && !r.startsWith("..") && !isAbsolute(r);
};
if (inside(dir, root) && !flag("--force"))
  die(
    `Refusing to write backups inside the project (${dir}).\n` +
      `This repository is public. Pass --dir with a folder outside it.`,
  );

// ---------- connection ----------
try {
  process.loadEnvFile(join(root, ".env"));
} catch {
  /* no .env: fall back to the real environment */
}
const url = process.env.SUPABASE_DB_URL;
if (!url)
  die(
    `SUPABASE_DB_URL is not set.\n\n` +
      `Supabase dashboard -> Connect -> Direct -> Session pooler, copy the URI,\n` +
      `replace [YOUR-PASSWORD] with the database password, and add it to .env:\n\n` +
      `  SUPABASE_DB_URL=postgresql://postgres.PROJECT:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres\n\n` +
      `.env is gitignored, and Vite only exposes VITE_-prefixed variables to the\n` +
      `browser, so this one never reaches the built app.`,
  );

// Transport security. Supabase publishes a CA certificate (Database settings ->
// SSL configuration -> Download certificate); with it we verify the server
// rather than merely encrypting to whoever answers.
const caPath = process.env.SUPABASE_DB_CA;
let ssl = "require";
if (caPath) {
  if (!existsSync(caPath)) die(`SUPABASE_DB_CA points at a file that does not exist: ${caPath}`);
  ssl = { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true };
} else {
  console.log("note  SUPABASE_DB_CA is not set: the connection is encrypted but the server is not verified.");
}

const sql = postgres(url, {
  ssl,
  max: 1,
  prepare: false, // the pooler does not keep prepared statements across sessions
  idle_timeout: 20,
  connect_timeout: 30,
  onnotice: () => {},
});

// ---------- what to back up ----------
// auth.users is not optional: members.user_id references it, so public data
// restored without these rows has no owner and cannot be used.
const AUTH_USER_COLS = [
  "id",
  "email",
  "phone",
  "created_at",
  "updated_at",
  "email_confirmed_at",
  "last_sign_in_at",
  "raw_user_meta_data",
  "raw_app_meta_data",
  "is_sso_user",
  "deleted_at",
];
const withSecrets = flag("--with-secrets");

async function tableOrder(sql) {
  // Discover tables instead of listing them, so the POS tables added later are
  // backed up without anyone remembering to edit this file.
  const tables = (
    await sql`select c.relname as name
              from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind = 'r'
              order by c.relname`
  ).map((r) => r.name);

  const edges = await sql`select con.conrelid::regclass::text as child,
                                 con.confrelid::regclass::text as parent
                          from pg_constraint con
                          join pg_class c on c.oid = con.conrelid
                          join pg_namespace n on n.oid = c.relnamespace
                          where con.contype = 'f' and n.nspname = 'public'`;

  // Parents first, so a restore can insert rows with foreign keys enforced.
  const strip = (s) => s.replace(/^public\./, "").replace(/"/g, ""),
    deps = new Map(tables.map((t) => [t, new Set()]));
  for (const { child, parent } of edges) {
    const c = strip(child),
      p = strip(parent);
    if (c !== p && deps.has(c) && deps.has(p)) deps.get(c).add(p);
  }
  const out = [];
  while (out.length < tables.length) {
    const ready = tables.filter((t) => !out.includes(t) && [...deps.get(t)].every((d) => out.includes(d)));
    // A cycle would leave nothing ready; emit the rest and let restore sort it out.
    if (!ready.length) {
      out.push(...tables.filter((t) => !out.includes(t)));
      break;
    }
    out.push(...ready);
  }
  return out;
}

// ---------- run ----------
const startedAt = new Date(),
  stamp = startedAt.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z"),
  file = join(dir, `rapidewms-${stamp}.ndjson.gz`);

mkdirSync(dir, { recursive: true });

const gzip = createGzip({ level: 9 }),
  out = createWriteStream(file);
gzip.pipe(out);
const write = async (obj) => {
  if (!gzip.write(JSON.stringify(obj) + "\n")) await once(gzip, "drain");
};

const counts = {};
try {
  console.log(`\nBacking up to ${file}\n`);
  // One read-only snapshot for the whole dump. Without this each table would be
  // read at a different instant, and a sale landing mid-run would be recorded in
  // movements but not in items: a backup that restores into impossible stock.
  // (This is why the session pooler matters — the transaction pooler on 6543
  // hands out a different connection per statement.)
  await sql.begin("isolation level repeatable read read only", async (tx) => {
    const [{ version }] = await tx`select version()`;
    const order = await tableOrder(tx);

    await write({
      kind: "rapidewms-backup",
      format: 1,
      taken_at: startedAt.toISOString(),
      server: version,
      secrets: withSecrets,
      // Which schema this data belongs to. Restoring into a different schema is
      // the classic way a backup turns out to be unusable.
      migrations: migrationFiles().map((f) => ({
        file: f,
        sha256: createHash("sha256").update(readFileSync(new URL(f, migrationsDir))).digest("hex"),
      })),
      order: ["auth.users", "auth.identities", ...order.map((t) => "public." + t)],
    });

    const dump = async (label, query) => {
      let n = 0;
      await query.cursor(500, async (rows) => {
        for (const r of rows) {
          await write({ t: label, r });
          n++;
        }
      });
      counts[label] = n;
      console.log(`  ${String(n).padStart(7)}  ${label}`);
    };

    const cols = withSecrets ? [...AUTH_USER_COLS, "encrypted_password"] : AUTH_USER_COLS;
    await dump("auth.users", tx`select ${tx(cols)} from auth.users`);
    // Supabase looks up email logins through identities, so a restore without
    // these rows leaves accounts that exist but cannot sign in.
    await dump("auth.identities", tx`select * from auth.identities`);
    for (const t of order) await dump("public." + t, tx`select * from ${tx("public")}.${tx(t)}`);
  });

  // The trailer is written last, so a file that was cut short (full disk, laptop
  // closed mid-run) is detectably incomplete instead of quietly short.
  await write({ kind: "rapidewms-backup-end", finished_at: new Date().toISOString(), counts });
} catch (e) {
  gzip.destroy();
  out.destroy();
  try {
    unlinkSync(file);
  } catch {
    /* nothing was written */
  }
  await sql.end({ timeout: 5 }).catch(() => {});
  die(`Backup failed, no file kept.\n${e.message}`);
}

gzip.end();
await once(out, "finish");
await sql.end({ timeout: 5 });

const rows = Object.values(counts).reduce((a, b) => a + b, 0),
  kb = (statSync(file).size / 1024).toFixed(1);
console.log(`\n  ${rows} rows, ${kb} KB -> ${file}`);

// ---------- retention ----------
// The policy, and the reasoning behind it, live in lib/retention.mjs so that the
// code deciding what to delete can be unit-tested.
if (!flag("--no-prune")) {
  const names = readdirSync(dir).filter((f) => backupDate(f)),
    keep = toKeep(names, startedAt),
    dropped = names.filter((f) => !keep.has(f));
  for (const f of dropped) unlinkSync(join(dir, f));
  console.log(`  ${keep.size} kept, ${dropped.length} pruned\n`);
}
