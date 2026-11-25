# Golden Korean BBQ — Restaurant System (MVP)

Inventory + in-house POS + reservations PWA for Golden Baboy Taft and Golden Korean BBQ Candon, built from **SPEC v0.6** (`docs/SPEC.md`).
React + TypeScript + Vite PWA on Supabase (Postgres, RLS, Realtime, Edge Functions, pg_cron).
All business rules live in Postgres functions (`supabase/migrations`).

## Environments

| | Supabase project | Who connects | Data |
|---|---|---|---|
| **PROD** | `uhtakdvizeoquyvovusn` "Golden Korean BBQ" (Singapore) | the live site only | Taft and Candon, real data only |
| **TEST** | `infeezvecfqpugwtljjd` "Golden Korean BBQ – Test" (Singapore, free) | this laptop (`.env.local`), Vercel preview builds | demo branches and test data |

- Code: https://github.com/kylaroseba-ai/golden-kbbq (private). Live site: https://golden-kbbq.vercel.app
- Vercel environment variables: **Preview** → TEST. **Production** → PROD.
- Database changes always go **TEST first → tests pass → PROD**, after closing time.
- The Supabase CLI stays linked to TEST (`supabase/.temp/project-ref`). To change PROD, link it, push, and link back to TEST straight away.
- After a migration that adds functions, add a new `*_grants_supabase_only.sql` migration (see `0104`).

## Run on this laptop (against TEST)

```bash
npm install
npm run dev
```

`.env.local` (git-ignored) points at TEST. Test sign-ins for TEST are in `TEST_ACCOUNTS.local` (git-ignored, generated). Staff PINs of the demo seed are listed at the top of `supabase/seed.sql`.

## Accounts and roles

- **Owner, manager, admin:** email + password. A manager or the owner invites them from **Setup → People** (`invite-user` Edge Function). They choose their own password from the email link. Public sign-up is off.
- **Shared devices** (counter tablet, server phones, kitchen and dispatch screens): a manager signs in on the device once and taps **Setup → Devices → Register this device** (`register-device` Edge Function). Staff then tap their name and enter their 4–6 digit PIN.
- **Roles:** owner, admin, manager, cashier, server, kitchen, dispatch, utility (time clock only). A person can hold several roles. The database enforces what each role can see (§3.1): staff never get the dashboard, reports or costs.

## Setting up PROD

1. `supabase/setup/prod_setup.sql` loads the real structure (Taft and Candon branches, tables, menu and prices, discounts, refill items, the Taft team without PINs). It is safe to re-run.
2. Invite JD and the admin by email; register devices; managers set PINs in Setup → People.
3. Fill in the placeholders in Setup: addresses, business name/TIN, GCash number, reorder levels, suppliers, opening stock count.
4. Edge Function secrets for messages: `SEMAPHORE_API_KEY`, `SEMAPHORE_SENDER`, `RESEND_API_KEY`, `EMAIL_FROM`, `TURNSTILE_SECRET_KEY`, `VAPID_*`; then deploy `send-messages push-fanout public-booking` and run `supabase/setup/edge_function_cron.sql`.
5. Upgrade PROD to Supabase Pro before real service (no pausing, daily backups).

## Tests

```bash
npm test
```

There are 40 tests that run the real migrations and seed in PGlite (an in-memory Postgres; the app itself always uses Supabase). They cover the spec's acceptance criteria and the §14.1 must-pass list:
- delivery costing;
- prep run;
- low-stock alert de-duplication;
- near-expiry list;
- variance and reasons;
- dual reorder approval;
- the Table 7 refill scenario (80 g plates, 3-plate limit, next-round rule, 7:15 PM cutoff, manager override);
- merged tables;
- idempotency;
- concurrency;
- lunch/unli time windows;
- SC/PWD ₱499 → ₱356.43;
- invoice numbering, booklet fallback, voids, Z-reading and grand total;
- voids and stock reversal;
- PIN lockout with no PIN hashes leaked;
- device revocation;
- branch isolation (RPC and RLS);
- reservation alerts, SMS + reminder queueing, capacity across overlapping slots, and the short-notice reminder rule;
- time clock (late time-in, breaks, worked hours, absent detection), schedule permissions and overlap, manager corrections.

## Project layout

| Path | What |
|---|---|
| `supabase/migrations/0001_schema.sql` | Tables (§12). `branch_id` on every table, ledger, BIR documents |
| `0002_core.sql` | Settings, clock, actors/roles, idempotency, FIFO stock ledger, moving-average cost, alerts, audit, immutability guards |
| `0003_access_inventory.sql` | PIN sign-in, bootstrap, admin upserts, deliveries, prep, waste, counts, suppliers, reorder |
| `0004_pos.sql` | Pricing/VAT, time windows, open table, orders, refill rounds, kitchen tickets, voids, billing, invoices, X/Z readings |
| `0005_reservations_reports.sql` | Booking, capacity, messages, notifications, reports, dashboard |
| `0006_rls.sql` | Branch-isolation read policies |
| `0007_attendance.sql` | Time clock, shift schedules, live shift board, attendance report, nav badge counts |
| `0099_supabase_only.sql` | Grants, Realtime publication, pg_cron jobs, fixed production clock (always runs last) |
| `supabase/seed.sql` | Demo/staging data (Candon from the spec + tiny Taft branch). **Not production data** |
| `supabase/functions/` | `send-messages` (Semaphore SMS + Resend email), `push-fanout` (Web Push), `public-booking` (Turnstile) |
| `src/lib/` | Supabase backend (staff token header), offline outbox (Dexie), auth and roles, i18n, hooks |
| `src/pages/` | Floor, Session (refill / order / bill), Kitchen, Inventory, Reservations + public booking, Dashboard/Reports/Admin |

## Status against the spec

**Built:**
- item master;
- deliveries with batches and expiry;
- prep runs (trim handled per §5.3);
- live stock;
- low/out alerts with re-arming;
- near-expiry and FIFO, with one-tap expired waste;
- waste log and plate waste after the leftover fee;
- opening/closing/spot counts with variance, reasons and approval, plus the shift summary;
- supplier directory with call/Viber/Messenger links;
- reorder lists with manager → JD approval and a share message;
- floor view;
- open/merge tables;
- 2-hour timer and 45-minute refill cutoff;
- strict lunch/unli windows;
- pax types and discounts (SC/PWD VAT-exempt formula, no stacking, per-line rounding);
- refill rounds (limit, next-round rule, stuck-round unlock, offline one-round rule);
- Kitchen/Dispatch screen (chime, Start-service button, wake lock, amber/red timers, low-stock badges);
- orders and voids;
- billing with split payments;
- server-issued invoice numbers bound to the registered terminal, with booklet fallback;
- non-official bill, reprint and void;
- cashier shift with X-reading, and Z-reading;
- public booking page (capacity, lead time, consent);
- staff booking list (confirm/decline/seat/no-show), SMS/email queue with reminder rule, 15-minute re-alert;
- owner dashboard;
- reports with CSV export (sales, usage, average cost, waste, variance, refills);
- offline outbox with idempotency keys and sync-conflict flags;
- corrected device clock;
- PWA install and update prompt;
- English with draft Tagalog/Ilocano staff labels;
- staff time clock, live shift board, weekly schedule and attendance report;
- brand logo, icons and the black-and-gold design from the mockups;
- audit log, plus immutable ledger, invoices and readings.

**Not done yet / needs work before go-live:**
- **Web Push on phones.** The server side (`push_subscriptions`, `save_push_subscription`, the `push-fanout` function) is written. The app does not yet subscribe devices, and the service worker has no `push` handler. In-app alerts with sound and the backup email to the branch inbox do work.
- **Taft Excel import scripts** (§13.2–13.3) for the staging copy: not written.
- **Not yet tested against a live Supabase project:** RLS was tested in PGlite, but Realtime, grants, cron, Semaphore, Resend and Turnstile have not been tested end to end.
- **Printing.** The thermal printer has not been tested. Chrome kiosk-printing setup and the 80 mm layout need a check on the chosen printer (§6.7). Invoice fields must be confirmed by the accountant/RDO.
- **Admin screens.** Not yet built:
  - registering a device and setting its login;
  - editing portion rules, prep recipes, package cuts, discount types and message templates. Edit those in the database for now.
- **Smaller items:**
  - receipt photo upload;
  - translations need staff review;
  - the overtime fee is off (open item);
  - data-retention jobs (anonymising contacts after 12 months) are not scheduled.
- **Open items in SPEC §15.2** still decide several defaults (prices, package cuts, plate limit for merged tables, budget period, and others). They are all settings or data, not code.
