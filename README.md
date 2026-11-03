# RAPIDÉWMS

Inventory and warehouse app for small shops in Laos, in **Lao and English**. Vanilla JS + Vite frontend, Supabase (Postgres, Auth, Realtime) backend.

**Online demo:** https://dan16ssd.github.io/rapidewms/ (demo mode: data stays in your browser).

## First-time setup

1. Create a free project at https://supabase.com (region: Singapore is closest to Laos).
2. In the Supabase dashboard open **SQL Editor**, paste the whole of `supabase/migrations/001_schema.sql` and run it.
3. **Project Settings → API**: copy the Project URL and the `anon` public key.
4. Copy `.env.example` to `.env` and paste both values in.
5. `npm install`, then `npm run dev` and open http://localhost:5173.

Optional: **Authentication → Providers → Email** lets you turn "Confirm email" off while testing.

**For password reset to work**, add the app's address to **Authentication → URL Configuration → Redirect URLs** (for example `http://localhost:5173/` while developing, and the deployed address in production). Supabase only honours a `redirectTo` that is on that list; otherwise the reset email sends people to the project's Site URL instead.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Local dev server with hot reload |
| `npm run build` | Production build into `dist/` (deploy to Cloudflare Pages) |
| `npm run test:db` | Runs the schema in an in-memory Postgres and checks shop isolation, stock rules, orders, automation and billing |
| `npm run check-i18n` | Checks that every text key exists in English, is translated into Lao, is still used, and that no visible text is hardcoded |
| `npm run test:unit` | Tests front-end logic that needs no browser (table paging) |
| `npm test` | Runs all three checks, the same as CI |

## How it fits together

- `supabase/migrations/` holds the database. Row-level security keeps every shop's data separate. Stock only changes through `adjust_stock` / `set_stock` / `complete_order`, so every change is logged and stock can't go negative.
- `src/data/store.js` picks the backend: `remote.js` (Supabase, with realtime refresh between devices) when `.env` has keys, otherwise `local.js` (in-browser demo). See `PROJECT.md` for the full overview.
- `src/views/` has one file per screen. Buttons use `data-act="..."`, handled in `src/main.js`.
- `src/lib/` holds escaping, CSV import/export, and PDF/Excel/ZIP export (loaded on demand).
- `src/i18n/` holds the text. `en.js` is the source of truth, `lo.js` the Lao translation; views call `t("key")`, so adding a language means adding one file. Lao is the default for Lao-language browsers. Export column headers stay English on purpose, because the CSV importer matches them and jsPDF has no Lao font yet.

## Billing (manual for now)

New shops get a 14-day trial (`shops.plan_until`). After a customer pays by bank QR, extend it in the SQL Editor:

```sql
update shops set plan = 'paid', plan_until = now() + interval '1 month' where name = 'Shop name';
```

Expired shops can still view and export their data but cannot change it.
