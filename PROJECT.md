# RAPIDÉWMS: project summary

_Last updated: 2026-10-31_

RAPIDÉWMS is an inventory and warehouse app for **small shops and warehouses in Laos**. Shops use it to track products and stock, scan barcodes to receive and ship goods, manage orders, get low-stock alerts and auto-reorders, and export reports (PDF, Excel, CSV, ZIP backup).

- **Goal:** a paid product within 7 weeks. Target 5+ pilot shops by week 3 and 10 paying shops by week 7.
- **Team:** owner + 1–2 helpers.
- **Status:** working app in **local demo mode** (no server). The Supabase backend is written and tested, but not connected yet.

---

## 1. Where it came from

The project started as a single `index.html` file (kept outside this repo, with a backup copy). It worked but couldn't be sold:

| Problem in the original | What we did |
|---|---|
| Fake "PRO" badge, fake user, fake 6% progress bar | Removed |
| Product names/data inserted into HTML unescaped (XSS risk) | Escaping everywhere; event delegation via `data-act` instead of inline `onclick` |
| Sync via a **publicly writable Firestore document** | Removed in the new app; the old file now scopes it and shows a warning |
| Sync via an ad-hoc WebSocket tunnel that **sent the whole database** and overwrote data | Removed in the new app; the old file now merges instead of overwrites and reconnects with backoff |
| CSV import relied on column position | Header-based import |
| All data in one browser, no accounts, no shop separation | New app: accounts + per-shop isolation (Supabase), or local demo mode |

The old file was patched for safety, but **all new work happens in this project**.

---

## 2. How to run it

Needs Node.js. First time: `npm install`.

| Command | What it does | Open |
|---|---|---|
| `npm run dev` | Dev server on this PC | http://localhost:5173 |
| `npm run build` | Production build into `dist/` | — |
| `npm run preview` | Serve the production build locally | — |
| `npm run test:db` | Tests the database schema in an in-memory Postgres | — |
| `npm run check-i18n` | Checks the Lao and English text are complete and in step | — |
| `npm run test:unit` | Tests front-end logic with no browser needed (table paging) | — |
| `npm test` | Runs all three checks, the same as the build does | — |

**Online demo:** https://dan16ssd.github.io/rapidewms/. It rebuilds automatically on every push to `master` (`.github/workflows/pages.yml`). It runs in demo mode, so each person's data stays in their own browser and teammates **don't see each other's stock**.

---

## 3. Two modes

The app picks its backend automatically in `src/data/store.js`:

| | Local demo mode (current) | Supabase mode |
|---|---|---|
| Turned on when | `.env` has no Supabase keys | `.env` has `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` |
| Accounts | None, straight into the app | Email + password sign up / sign in, with password reset by email |
| Data stored in | This browser's `localStorage` (`rapidewms.local`) | Postgres in the cloud |
| Shared between devices | No (only between tabs of the same browser) | Yes, with live updates |
| Rules (no negative stock, unique SKU, etc.) | Same rules, enforced in `src/data/local.js` | Enforced in the database |

### Switching to Supabase

1. Create a free project at https://supabase.com (Singapore region is closest to Laos).
2. Open **SQL Editor**, paste all of `supabase/migrations/001_schema.sql` and run it.
3. In **Project Settings → API**, copy the Project URL and the `anon` key.
4. Copy `.env.example` to `.env` and paste both values in.
5. Restart `npm run dev`.

---

## 4. Features

| Screen | What it does |
|---|---|
| **Dashboard** | Stock value, units, recent in/out movement chart, low-stock banner |
| **Inventory** | Add, edit and delete products; search; +/− stock buttons. Product fields: SKU, name, category, barcode, quantity, minimum, unit cost, **sell price, wholesale price and the quantity wholesale starts at** (all in ₭) |
| **Orders** | Inbound and outbound orders; completing an order updates stock, and an order can only be completed once |
| **Scanner** | Camera or USB/Bluetooth scanner. Modes: receive, ship, look up. Matches SKU (any case) or barcode. Unknown code → "Add as new product" |
| **Reports & export** | Inventory, orders and movements as PDF, Excel or CSV; currency converter (live rates) |
| **Automation** | Low-stock alerts; auto-reorder creates an inbound order for (minimum × 2 − stock) when stock drops below minimum and no inbound order is pending |
| **Shop & backup** | Plan and trial status, language, full ZIP backup, CSV product import, erase all data (owner only, must type ERASE) |

**Language:** the whole interface is in **Lao and English**. A Lao-language browser gets Lao automatically; the header button and the setting in Shop & backup switch it instantly, and the choice is remembered. Prices show as whole kip (₭12,000, not ₭12,000.00). Export column headers stay English so a shop can re-import its own CSV, and because PDF export has no Lao font yet.

**Business rules:**
- Stock can never go below zero ("Not enough stock: SKU has N").
- SKUs are unique per shop, ignoring case.
- Every stock change is logged as a movement.
- 14-day free trial; after it expires the shop is **read-only** (view and export still work, data is never deleted).
- Owner vs staff: only owners can delete products/orders, change settings or erase data.

---

## 5. Barcode scanning: what's tested

| Check | Result |
|---|---|
| USB/Bluetooth scanner (types the code + Enter) | Works: receive, ship, look up, not-enough-stock refusal, unknown-code prompt all verified |
| Camera decoder on a real EAN-13 barcode image (5449000000996) | Read back exactly |
| Camera allowed on `localhost` | Yes |
| Live camera on a real phone | **Not tested yet.** Open the online demo on a phone and try it |

Formats: EAN-13, UPC, Code 128, QR and others supported by html5-qrcode. Laptop webcams often can't focus on thin 1D barcodes; phones and QR codes work better.

---

## 6. Code layout

```
index.html                 App shell (header, nav, main, dialog, toast)
vite.config.js             Vite settings
.github/workflows/pages.yml  Builds and publishes the online demo
src/main.js                Startup, routing (#dash, #inv…), render, all button actions
src/auth.js                Sign in / sign up / name-your-shop screens
src/scanner.js             Camera (html5-qrcode) + scan handling
src/styles.css
src/data/state.js          In-memory app state + change events
src/data/store.js          Chooses remote or local backend (same functions)
src/data/remote.js         Supabase: queries, RPC calls, realtime refresh
src/data/local.js          Local demo backend (localStorage), same rules as the SQL
src/lib/util.js            Escaping, formatting, toast, form dialog, download
src/lib/csv.js             CSV parse/write, product import
src/lib/export.js          PDF / Excel / CSV / ZIP export (libraries load on demand)
src/views/*.js             One file per screen: dash, inv, ord, scan, rep, auto, sys
src/i18n/{en,lo,index}.js  All interface text + the t() lookup
supabase/migrations/001_schema.sql   Tables, row-level security, stock functions
scripts/test-db.mjs        Database tests (PGlite)
scripts/check-i18n.mjs     Translation completeness + hardcoded-text check
```

**Conventions:**
- Buttons use `data-act="name"`; inputs use `data-input="name"`. Handlers are in the `A` and `INPUT` maps in `src/main.js`.
- Always escape user data with `E()` before putting it into HTML.
- Stock only changes through `adjust`, `saveItem` or `completeOrder`, never by editing `qty` directly.
- **Never write interface text in a view.** Add a key to `src/i18n/en.js` and `lo.js` and call `t("key")`, or `tn("key", n)` when a count changes the wording. `npm run check-i18n` fails the build otherwise.
- Errors carry a key, not a sentence: `fail("err.stock", { sku, qty })` in `local.js`, mapped from Postgres messages in `remote.js` `friendly()`, and shown with `errText(e)`. This keeps messages translatable.

---

## 7. Database (Supabase)

**Tables** (every one has `shop_id`):
- `shops`: name, plan, plan_until.
- `members`: user ↔ shop, role owner/staff.
- `settings`: low_alert, auto_reorder.
- `items`: qty ≥ 0, SKU unique per shop ignoring case.
- `orders`: status pending/done, auto flag.
- `movements`: the stock history; it keeps the SKU even after the product is deleted.

**Security:**
- Row-level security: users only see shops they're members of.
- Clients can't write `qty` or order status directly; only the functions below can.
- Writes are blocked when `plan_until` has passed.

**Functions:**
- `create_shop`
- `adjust_stock`: locks the row, refuses negative stock, logs the movement, auto-reorders.
- `set_stock`
- `complete_order`: completes only once.
- `erase_shop_data`: owner only.

**Tests:** `npm run test:db` runs 20 checks covering shop isolation, stock rules, orders, automation and billing. All pass.

**Manual billing** (after the customer pays by BCEL One / LAPNet QR), run in the SQL Editor:
```sql
update shops set plan = 'paid', plan_until = now() + interval '1 month' where name = 'Shop name';
```

---

## 8. Decisions

| Area | Choice | Why |
|---|---|---|
| Backend | Supabase (Postgres, Auth, RLS, Realtime) | Real per-shop isolation; free tier to start |
| Frontend | Vanilla JS + Vite | Reuses the original code; no framework rewrite |
| Hosting | Cloudflare Pages (planned) | Free, HTTPS (needed for the camera) |
| Billing | BCEL One / LAPNet QR transfer, activated manually | Stripe/PayPal don't pay out to Lao merchants |
| Price (to validate) | 14-day trial, then ~150,000–250,000 ₭/month per shop | Test in customer interviews |
| Language | Lao + English (planned) | Main advantage over foreign apps |

---

## 9. The 7-week plan

The full written plan is kept outside the repo; this table is the summary.

| Week | Build | Sell |
|---|---|---|
| 1 | Vite project, module split, schema + RLS, accounts, remove Firestore/WebSocket | Interview 10–15 shop owners in Vientiane; shortlist 5 pilots |
| 2 | Stock changes in the database, realtime, offline write queue, Lao/English translation | — |
| 3 | Installable PWA, bundled libraries, Lao font in PDFs, staff invites, Excel/CSV import with column mapping | Set up 5 pilot shops in person (free) |
| 4 | Fix pilot bugs; trial/paid status + admin "mark paid"; Lao landing page; Sentry error tracking | Collect feedback daily |
| 5 | Barcode label printing, stock-count mode, daily summary, terms/privacy, backups | — |
| 6 | — | Convert pilots (founding discount), Facebook demo videos + ads, referrals, 5 shop visits/day |
| 7 | Fix top support issues | Close trials, collect payments, review results |

### Progress

**Done:**
- Vite project and module split; code on GitHub with an auto-deploying demo.
- Database schema with row-level security, stock functions and 20 passing tests.
- Accounts and shop creation (code ready, needs Supabase keys).
- Firestore and WebSocket removed.
- Trial / read-only billing logic.
- Local demo mode.
- Scanner verified with a keyboard scanner and a barcode image.
- **Lao + English interface**, with a build-time check that keeps the two in step.
- **Sell price, wholesale price and wholesale threshold** on every product, through the form, CSV import and export.
- Mobile table row labels fixed (they were lost when the single file was split into modules).
- **Password reset by email** — request a link, set a new password, and the app will not let a recovery session walk past that screen into the shop.
- **Large shops load completely.** Reads are paged, so a shop is no longer cut off at the server's 1000-row response cap; when orders or movement history does hit the app's own ceiling, the screen says so instead of quietly showing part of it.
- First front-end tests (`npm run test:unit`, 12 checks on the paging logic), and CI now also runs them, `npm audit` and the build.

**Not done yet** (the POS plan covers these; see section 9's blocks):
- The till itself: sell screen, payments, receipts, customers and credit, shifts.
- Offline write queue and PWA install.
- Automatic backups, and applying migrations with the Supabase CLI against a separate staging project rather than pasting SQL into the dashboard.
- Error tracking (Sentry), so a bug in a shop reaches us without a phone call.
- Showing **who** made each stock change: `movements.created_by` is recorded but never displayed.
- Lao font in PDF exports, and receipt printing.
- Connect a real Supabase project.
- Staff invites; import with column mapping.
- Landing page, admin page and Sentry.
- Barcode labels, stock-count mode and daily summary.
- The benchmark and proof pages.
- Test the camera on real Android and iPhone devices.

---

## 10. Next steps

1. **Phone camera test:** open the online demo on an Android and an iPhone and scan real products.
2. **Build the till** (POS plan, block 3 onwards): the sales schema with offline-safe idempotency keys comes first, because retrofitting it later means a data migration.
3. **Shared team testing:** create the Supabase project (section 3) so the team works on the same stock.
4. **Start customer interviews** (week 1 of the sales plan) while the build continues, and confirm the 10% VAT rules with the Department of Taxation before claiming tax compliance.
