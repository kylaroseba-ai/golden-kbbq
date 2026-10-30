# Golden Korean BBQ — Restaurant System (MVP)

Inventory + in-house POS + reservations PWA for the Candon City branch, built from **SPEC v0.3**.
React + TypeScript + Vite PWA on Supabase (Postgres, RLS, Realtime, Edge Functions, pg_cron).

All business rules live in Postgres functions (`supabase/migrations`). The same SQL runs:
- on **Supabase** in production, and
- **in the browser** (PGlite) for the demo and in the tests. No server is needed to try it.

## Try the demo

```bash
npm install
npm run dev
```

Open http://localhost:5173. Pick a demo device or a personal login. The demo database rebuilds itself whenever the SQL changes. The demo bar at the top lets you:
- move the clock (lunch 12 PM, unli 6 PM, 7:16 PM after the refill cutoff),
- simulate this device going offline,
- reset all demo data.

**Each browser tab is its own device.** Open a server phone in one tab and the kitchen tablet in another. Refill rounds tapped in the first appear in the second.

| Demo device / login | Staff PINs (test values only) |
|---|---|
| Front counter (registered POS terminal T1) | Carlo 2222 (cashier) · Mara 1111 (manager) |
| Server phone 1 / 2 | Ben 3333 · Liza 4444 (servers) |
| Kitchen tablet | Rico 5555 (kitchen) |
| Owner (JD), Branch manager (Mara) | personal logins, no PIN |

The system admin and the Taft test-branch logins are not shown on the sign-in screen. Open `/?staff=all` to see them in the demo. In production there is only an email and password form.

Staff land on **Time clock** after their PIN: time in, start/end break, time out, and their schedule for the week. Managers see **Staff & shifts**: a live board (scheduled, working, on break, late, absent) with a timeline, a weekly schedule editor, and corrections for missed time-outs. The **Attendance** report (Reports) gives scheduled vs worked hours and lateness for payroll.

Invoice printing on T1 is **off** in the seed (BIR permit pending), so settling asks for the manual booklet number. To try official invoice numbering, turn it on for the terminal (`pos_terminals.invoice_printing_enabled`). The tests cover that path.

## Tests

```bash
npm test
```

There are 26 tests that run the real migrations and seed in PGlite. They cover the spec's acceptance criteria and the §14.1 must-pass list:
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
| `src/lib/` | Backends (Supabase / local PGlite), offline outbox (Dexie), auth, i18n, hooks |
| `src/pages/` | Floor, Session (refill / order / bill), Kitchen, Inventory, Reservations + public booking, Dashboard/Reports/Admin |

## Production setup (Week 0 checklist)

All accounts belong to JD's business email (§9.1).
1. Create a **paid** Supabase project. Free projects pause when idle.
2. Run the migrations with `supabase link --project-ref <ref>`, then `supabase db push`. Do **not** load `seed.sql` into production. It is for staging/testing.
3. **Accounts.** In Supabase Auth, create:
   - one email/password user per shared device (counter, each server phone, kitchen tablet);
   - personal logins for JD, the manager and the admin.

   Then insert matching rows in `devices` (`auth_user_id`) and `profiles` (`auth_user_id` for personal logins), and add `user_branch_roles`. Set staff PINs from Admin → Staff on a shared device.
4. Edge Function secrets:
   - `SEMAPHORE_API_KEY`, `SEMAPHORE_SENDER`;
   - `RESEND_API_KEY`, `EMAIL_FROM`;
   - `TURNSTILE_SECRET_KEY`;
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.

   Deploy them with `supabase functions deploy send-messages push-fanout public-booking`.
5. Vault secrets `project_url` and `service_role_key` (used by the cron jobs in `0007`).
6. Frontend: deploy `dist/` to Vercel or Cloudflare Pages with `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and `VITE_TURNSTILE_SITE_KEY`.
7. Fill in the real Candon data per §13.4:
   - items and levels;
   - menu, portions and package cuts;
   - suppliers;
   - tables;
   - BIR header fields on `branches`;
   - the terminal record;
   - the opening count.

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
