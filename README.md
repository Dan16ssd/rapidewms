# RAPIDÉWMS

Inventory and warehouse app for small shops in Laos. Vanilla JS + Vite frontend, Supabase (Postgres, Auth, Realtime) backend.

## First-time setup

1. Create a free project at https://supabase.com (region: Singapore is closest to Laos).
2. In the Supabase dashboard open **SQL Editor**, paste the whole of `supabase/migrations/001_schema.sql` and run it.
3. **Project Settings → API**: copy the Project URL and the `anon` public key.
4. Copy `.env.example` to `.env` and paste both values in.
5. `npm install`, then `npm run dev` and open http://localhost:5173.

Optional: **Authentication → Providers → Email** lets you turn "Confirm email" off while testing.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Local dev server with hot reload |
| `npm run build` | Production build into `dist/` (deploy to Cloudflare Pages) |
| `npm run test:db` | Runs the schema in an in-memory Postgres and checks shop isolation, stock rules, orders, automation and billing |

## How it fits together

- `supabase/migrations/` holds the database. Row-level security keeps every shop's data separate. Stock only changes through `adjust_stock` / `set_stock` / `complete_order`, so every change is logged and stock can't go negative.
- `src/data/store.js` picks the backend: `remote.js` (Supabase, with realtime refresh between devices) when `.env` has keys, otherwise `local.js` (in-browser demo). See `PROJECT.md` for the full overview.
- `src/views/` has one file per screen. Buttons use `data-act="..."`, handled in `src/main.js`.
- `src/lib/` holds escaping, CSV import/export, and PDF/Excel/ZIP export (loaded on demand).

## Billing (manual for now)

New shops get a 14-day trial (`shops.plan_until`). After a customer pays by bank QR, extend it in the SQL Editor:

```sql
update shops set plan = 'paid', plan_until = now() + interval '1 month' where name = 'Shop name';
```

Expired shops can still view and export their data but cannot change it.
