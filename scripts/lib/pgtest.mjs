// A throwaway in-memory Postgres with just enough of Supabase's auth schema for
// the migrations to run. Shared by test-db.mjs and restore-check.mjs so the two
// can never drift apart on what "a fresh database" means.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";

export const migrationsDir = new URL("../../supabase/migrations/", import.meta.url);

export const migrationFiles = () =>
  readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

// PGlite is real Postgres compiled to WebAssembly, so constraints, row-level
// security and plpgsql all behave; only Supabase's own auth service is absent.
export async function freshDb() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  for (const f of migrationFiles()) await db.exec(readFileSync(new URL(f, migrationsDir), "utf8"));
  return db;
}
