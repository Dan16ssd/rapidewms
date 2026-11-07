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
2. Open **SQL Editor**, paste all of `supabase/migrations/001_schema.sql` and run it, then `002_pos.sql`. An existing project only needs `002_pos.sql`; until it is run, the till, expiry and product-kind features fail with "column does not exist".
3. In **Project Settings → API**, copy the Project URL and the `anon` key.
4. Copy `.env.example` to `.env` and paste both values in.
5. Restart `npm run dev`.

---

## 4. Features

| Screen | What it does |
|---|---|
| **Dashboard** | Stock value, units, today's sales, products expiring within 30 days, recent in/out movement chart, low-stock banner |
| **Till (₭)** | Scan (camera or USB scanner), type a code, or search by name to add products. Change quantities; wholesale price applies automatically from its minimum quantity. Discount, cash or bank transfer, quick cash buttons and change due. Charge is refused if stock is short. Receipt on screen and printable (58 mm thermal or A4 browser print), sequential receipt numbers, today's sales list, owner-only void that restores stock |
| **Expiry (⏳)** | Every dated batch, soonest first: expired, within 30 days, later. Write off an expired batch in one tap. Lists consumables that have stock with no date yet. The nav shows a badge when something has expired |
| **Inventory** | Add, edit and delete products; search; filter by consumable / non-consumable / expiring / expired; +/− stock buttons. Product fields: SKU, name, category, **kind (consumable or non-consumable)**, barcode, quantity, **expiry date** (consumables), minimum, unit cost, **sell price, wholesale price and the quantity wholesale starts at** (all in ₭). **🤖 Identify** names a product from a photo |
| **Orders** | Inbound and outbound orders; completing an order updates stock, and an order can only be completed once |
| **Scanner** | Camera or USB/Bluetooth scanner. Modes: receive, ship, look up. Matches SKU (any case) or barcode, including GS1 codes (the expiry date in a GS1 DataMatrix or GS1-128 code is taken automatically). Receiving a consumable asks for its expiry date: type it (`1227`, `311227`, `31/12/2027`) or **📷 read it from a photo** of the package. Unknown code → "Add as new product" |
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

The camera uses the browser's own barcode reader where there is one (Android Chrome), otherwise zxing-cpp compiled to WebAssembly, bundled so it works offline. A green box is drawn over each code as it is read, with a beep and a vibration. zxing reads straight, sideways and upside-down codes; for diagonal ones each empty frame is tried again turned 45°.

| Check (headless Chrome, zxing engine, 2026-11-07) | Result |
|---|---|
| USB/Bluetooth scanner (types the code + Enter) | Works: receive, ship, look up, not-enough-stock refusal, unknown-code prompt all verified |
| EAN-13 on a cardboard background, every 15° from 0° to 345°, clean and with sensor noise | **48/48 read**; the box lands within 1 px of the barcode |
| Blur 1.5 px at 200°; 2 px bars at 20° | Read |
| Live camera (Chrome fake webcam) on the till and scanner screens | Starts at 1280×720 with the overlay, stops on the button, released when leaving the screen |
| Live camera on a real phone | **Not tested yet.** Open the online demo on a phone and try it |

Formats: EAN-13/8, UPC-A/E, Code 128, Code 39, ITF, QR, DataMatrix. Laptop webcams often can't focus on thin 1D barcodes; phones work better.

**Reading an expiry date from a photo** uses Tesseract (≈6 MB once, then offline). Rendered package labels tested: `EXP 31/12/2027` with an `MFG` date beside it (the MFG date is ignored), `Best before: 15 MAR 2027`, Thai `หมดอายุ 05/09/70` (Buddhist year → 2027), a sideways photo, and a Courier-font `EXP 12.08.27`: **5/5 correct, ~1.3 s each**.

Then whole-package phone photos (3000×4000, 2026-11-07): a small date, real **inkjet dot-matrix** print (one line, and MFG + EXP on two lines), blur, faint grey ink, white print on a dark band, a 12° tilt, `BB 31DEC27`, two unlabelled dates, and month-only `EXP 12/2027`: **11/11 correct, 0.3–2.8 s**; dot-matrix close-ups also read. The first version failed the dot-matrix and tilted photos. It now also tries the photo with the dots blurred together at several strengths and resolutions, and tilted ±10°. Real crinkled or curved packaging will do worse, so the date is shown for the person to confirm, never saved alone.

**Identifying a product from a photo** uses SmolVLM-256M on the device: **215 MB download once** (asked first; Wi-Fi recommended), then offline. Measured on a PC with WebGPU: ~1 s per photo after loading. Phones without WebGPU run on the CPU and will be several times slower; not yet measured. The model names products well but sorts them badly (asked "can people eat this?" it said yes to a hammer, a shirt and a charger), so it only gives the name, and the type comes from keywords in that name (English, Lao, Thai). When no keyword matches, the person picks consumable or not. Six test products (water, hammer, chips, paracetamol, T-shirt, USB charger): **6/6 named and typed correctly**. It reads Lao and Thai print poorly.

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
src/views/*.js             One file per screen: dash, pos (till), exp (expiry), inv, ord, scan, rep, auto, sys
src/lib/camera.js          Camera barcode reader + green AR box (native or zxing WebAssembly)
src/lib/expiry.js          Expiry-date reading: typed shortcuts, package text, GS1 codes
src/lib/ocr.js             Read an expiry date from a photo (Tesseract, loaded on demand)
src/lib/identify.js        Name a product from a photo (SmolVLM, loaded on demand)
src/lib/receipt.js         Receipt HTML and printing
src/i18n/{en,lo,index}.js  All interface text + the t() lookup
supabase/migrations/001_schema.sql   Tables, row-level security, stock functions
supabase/migrations/002_pos.sql      Product kind, expiry lots, sales, receipts, void, write-off
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

**Backups:** the free plan includes none ("Free Plan does not include project backups"), so `npm run backup` takes its own: a gzipped NDJSON dump of every `public` table plus `auth.users` and `auth.identities`, read in one repeatable-read snapshot so stock and history can't disagree. Tables are discovered from the catalogue and written parents-first, so the POS tables will be included without editing the script. It needs no `pg_dump`, Docker or Supabase CLI, and connects through the session pooler because direct connections are IPv6-only on the free plan.

`npm run backup:verify` restores the newest file into a throwaway Postgres built from `supabase/migrations`, with every constraint enforced, then re-derives each product's stock from its movements. It rejects a truncated file, a file whose rows break a foreign key, and one whose stock no longer matches its history — all three are covered by tests. Backups are written outside the repository, and `*.ndjson.gz` is gitignored, because the repository is public.

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
- First front-end tests (`npm run test:unit`, 20 checks on paging and backup retention), and CI now also runs them, `npm audit` and the build.
- **A real Supabase project** (Singapore), with the schema applied and verified.
- **Bundled Lao font.** Noto Sans Lao (Lao subset, ~9 KB a weight) ships with the app instead of coming from a CDN, so Lao renders the same on every device and still renders offline. Lao also gets its own leading and a larger floor for small text, because its vowel signs sit above the letter and its tone marks below.
- **Installs as an app on Windows and Android.** One PWA build, no separate desktop project and no `.exe` to sign. The service worker precaches the shell, the fonts and the scanner (674 KB); the export libraries (~1.4 MB) are cached on first use instead, so installing over a phone connection stays small. Supabase responses are never cached, on purpose.
- **Backups that are checked, not assumed.** `npm run backup` dumps the live database to a file outside this repo; `npm run backup:verify` restores it into a throwaway database and fails if it is truncated, inconsistent or missing its users. A daily Windows task takes them, which also stops the free project pausing after a week idle.

**Not done yet** (the POS plan covers these; see section 9's blocks):
- The till itself: sell screen, payments, receipts, customers and credit, shifts.
- **The offline write queue.** The app now opens and runs offline, but a change made with no connection is still refused rather than stored and replayed. This needs the `client_id` idempotency keys to be in the schema from the first sales migration, or a queued write can apply twice on reconnect.
- Applying migrations with the Supabase CLI against a separate staging project, rather than pasting SQL into the dashboard. This has to exist before the POS tables touch a database with real shop data.
- An **off-machine** copy of the backups. Today they only live on one laptop, so a stolen or dead machine loses them; the folder needs to be inside OneDrive, a USB stick or similar.
- Error tracking (Sentry), so a bug in a shop reaches us without a phone call.
- Showing **who** made each stock change: `movements.created_by` is recorded but never displayed.
- Lao font in PDF exports, and receipt printing.
- Staff invites; import with column mapping.
- Landing page, admin page and Sentry.
- Barcode labels, stock-count mode and daily summary.
- The benchmark and proof pages.
- Test the camera on real Android and iPhone devices.

---

## 10. Next steps

1. **Run `002_pos.sql` on the Supabase project**, then test the till with two devices at once.
2. **Phone test in a real shop:** scan real products at odd angles, read real expiry labels, and time the product identify on a cheap Android. The numbers in section 5 are from a PC.
3. **Still to build for the till:** customers and credit sales, shifts with cash count, refunds of part of a sale, Bluetooth thermal printing, and the offline write queue (sales already carry the `client_id` it needs).
4. **Shared team testing:** create the Supabase project (section 3) so the team works on the same stock.
5. **Start customer interviews** (week 1 of the sales plan) while the build continues, and confirm the 10% VAT rules with the Department of Taxation before claiming tax compliance.
