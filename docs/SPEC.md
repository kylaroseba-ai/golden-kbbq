# SPEC — Golden Korean BBQ Restaurant System (PWA)

**Product:** Golden Korean BBQ Restaurant System — Inventory + in-house POS + Reservations (MVP)
**Business:** Golden Korean BBQ (Candon City, Ilocos Sur) under the Golden Baboy / Golden Korean BBQ group
**Owner / CEO:** JD (Jose Wilfredo John Dizon)
**Developer:** Kyla
**Target go-live:** First week of December 2026 (Ilocos Sur branch opening) — ⚠️ at risk: see §14.4 for what is still missing before production
**Spec version:** 0.6 (draft) — November 25, 2026
**Status legend:** ✅ Confirmed by JD · 🔄 Initial answer / still to confirm during build & testing · ⚠️ Developer default (change if JD disagrees)

### Change log
| Version | Date | Changes |
|---|---|---|
| 0.6 | Nov 25, 2026 | Answers to the §15.6 questions — see **§15.7, which overrides §15.5 and earlier sections**. Birthday 50% (₱324.50) any day in the birth month; "no unli before 3 PM" dropped; Candon last unli booking 8:30 PM; Taft closed Sundays; Athlete 20% off; same discount rules at each branch's prices; reservation fee deducted from the bill, non-refundable; Annalyn cashier only; Zion added; JD's login confirmed; Android tablet; **Vercel Pro**; **Taft switches fully** to this system; beef cuts same as Taft (Woo Samgyupsal = beef). |
| 0.5 | Nov 25, 2026 | Applied JD's answers from *QUESTIONS TO CONFIRM* (Nov 25) — see **§15.5, which overrides earlier sections where they differ**. Highlights: POS will **not** be BIR-registered (internal tracking only, unofficial receipt); public menu & promos **back to Phase 2**; Taft menu, rates and discounts; Candon solo-diner rates; portions 120 g (meat with sauce) / 80 g (meat without sauce) / 50 g (side dishes); side-dish refills unlimited; overtime ₱200 per table; last seating Taft 9:30 PM, Candon 8:30 PM; tables Candon 21 / Taft 20; online booking 50% of seats, up to 50 pax, 3 h lead time, ₱1,000 fee for 10+ pax; email + SMS; Poseidon 80 mm printer on a tablet; managers see food cost and may approve reorders when JD is away; Kitchen and Dispatch as separate stations (proposal, §15.5); unofficial receipt and shift report layouts. New questions in §15.6. |
| 0.4 | Nov 25, 2026 | **Backend and launch decisions:** two Supabase projects — PROD (real data) and TEST (developer laptop, previews, Taft pilot) (§13.1); demo mode removed from the live site; invited logins, no public sign-up. **Launch mode ✅:** the POS starts as an **internal sales tracker**; official BIR invoices stay on the manual booklet until JD decides on BIR registration (§6.7). **Email ✅:** Resend free plan; SMS optional at launch (§7.3, §9.1). **Taft ✅:** pilot branch on TEST with its own staff and prices, moves to PROD after checking (§13.1). **Prices ✅:** Unli Pork ₱499, Beef + Pork ₱599, lunch ₱149 / ₱270 / ₱350 (§15.3). **Roles:** screen-access table; staff never see the owner dashboard, enforced in the database (§3.1). **New MVP scope:** public menu and promos on the booking page, moved from Phase 2 (§7.5); booking site kept separate from POS and inventory (§7.0). Staff time clock and live shifts already built, moved into MVP (§2.3). Go-live readiness check (§14.4). Consolidated list of everything still needed before production (§15.4). |
| 0.3 | Oct 30, 2026 | Spec review fixes. **Design defaults ⚠️:** official invoices issued online only (manual booklet when offline); offline refill rule; shared-device sign-in with server-verified staff PINs; clock rule for offline actions; idempotency keys moved to action rows; moving weighted-average costing. **Contradictions fixed:** near-expiry default, `usage_import` movement type, `raw_meat_takeout` name, table status column, `branch_id` on child tables, prep-trim double deduction, `service_charge` removed. **Rules added:** plate limit for merged tables, stuck-round unlock, one package per session, discount/VAT/rounding order, leftover fee basis, reservation capacity over overlapping slots, short-notice reminders, variance threshold, opening-count adjustments, usage formula, kitchen sound unlock, persistent storage. **Appendix A** recomputed with consistent rounding (round up). Budget note on recurring costs. New open items in §15.2. |
| 0.2 | Oct 30, 2026 | Applied JD's initial answers: VAT-registered branch, POS prints BIR sales invoice; kitchen/dispatch screen replaces slips; all discounts carry over except Solo Diner; 80 g per plate for every cut and side dish; 3-plate limit; next round after served; last-refill cutoff 45 min before the 2-hour limit; ₱200 leftover fee; strict lunch/unli time windows; fresh meat & vegetables added to expiry alerts; dual approval (manager + JD) for reorders; hours 11 AM–10 PM; Semaphore SMS; React + Supabase confirmed; fiber internet; ₱30k covers development + hosting + SMS; JD's business email owns all accounts; English UI with Tagalog/Ilocano staff labels. Added Appendix A (proposed starting reorder levels from Taft data). |
| 0.1 | Oct 30, 2026 | First draft. |

---

## 0. How to read this spec

This document is the single source of truth for building the MVP. It is written so that a developer (or an AI coding assistant such as Claude Code) can build from it section by section.

- §1–3 explain **why** we are building this and **for whom**.
- §4–8 define **what** the MVP does (features, rules, acceptance criteria).
- §9–12 define **how** (architecture, offline, security, data model).
- §13–14 cover **data import, testing, and the timeline** to the December opening.
- §15 lists **everything still unconfirmed**. Anything marked 🔄 or ⚠️ must not be treated as final; all open items are confirmed during building and testing.

---

## 1. Background and problem

Golden Baboy Taft currently runs on Excel: one workbook per year for daily sales (one sheet per day, plus monthly expense sheets) and one for inventory (one sheet per day with opening / new delivery / closing / daily usage / waste per item). The POS (LoyVerse) is not connected to inventory.

The new Golden Korean BBQ branch in Candon City opens in the first week of December. JD wants one centralized system, starting with the backbone: **inventory connected to sales**, plus **reservations that actually notify staff**.

### 1.1 Pain points this MVP solves

| # | Pain point (from JD) | MVP answer |
|---|---|---|
| PP1 | Inventory, sales and cost reports are scattered across Excel; no real-time view | Owner dashboard (starting version): live stock, today's sales, reservations, alerts |
| PP2 | Booking website doesn't alert staff; customers get no confirmation and don't show up | Reservation module: instant staff alert, one-tap confirm, automatic email/SMS confirmation + reminder |
| PP4 | No real-time monitoring of perishables and expiry | Batch-level expiry dates, near-expiry alerts, FIFO view, waste log |
| PP5 | Usage and cost reports are slow and error-prone by hand | Automatic weekly usage, monthly consumption, simple + weighted average cost, waste summary |
| PP6 | POS not linked to inventory; 1–2 hour manual tally nightly; run-outs mid-service; discrepancies found too late | In-house POS that deducts stock on every sale and refill; live stock; low-stock alerts; variance report |
| PP7 | No single place to find suppliers and reorder | Basic supplier directory + reorder list |
| PP9 | Refills not recorded, no per-round limits, no handheld ordering | Refill recording per table per round on company phones/tablets, plate limit per round |
| PP16 | Second branch makes scattered data worse | One database, every record tagged by branch, strict branch-level access |

### 1.2 Evidence from the current spreadsheets (why automation matters)

Observed while reviewing the uploaded files; these also become import-cleaning rules (§13):

- Daily-sheet names are typed by hand and inconsistent (`JUNE 2O` with letter O, `0CT 24` with zero, `MAR28`, `SEPT9`, `JAN 25 CLOSED`).
- Formulas are copied per row and have drifted (e.g. the Jan 5 inventory sheet computes Y-Sam usage as `C14+D14+E46-E14`, pulling in a sauce cell).
- The sales sheet's **Credit Card** column still multiplies by old January prices (₱549 unli, ₱384.30 bday) while Cash/GCash/PayMaya use ₱649 / ₱454.30.
- Package prices and discount types changed during the year (Happy Hour Promo ₱499 and Regular ₱549 in January → Regular ₱649 by October), so **price history must be kept per transaction**, not looked up from today's price.
- The same item name appears in more than one section with different meanings (e.g. `KIMCHI` as a served side dish and as a raw Korean ingredient; `LETTUCE` as a vegetable and as a served side; `PINEAPPLE JUICE` twice).
- Units are mixed in one column: grams for meat and veg, PACK for enoki, PCS for eggs, bottles/cans for drinks.

---

## 2. Goals, non-goals and success measures

### 2.1 MVP goals
1. Every sale and every refill deducts stock automatically during service.
2. Staff and managers see live stock and get low-stock alerts **before** core items run out.
3. Closing takes a physical count; the system produces the variance report and shift summary with no manual tally.
4. Expiry is tracked per delivery batch for items that need it, with near-expiry alerts.
5. Every new reservation alerts staff instantly; customers always receive a confirmation.
6. The owner can check stock, sales, reservations and alerts from his phone.

### 2.2 Success measures (from the proposal)
- End-of-day stock update: from 1–2 hours to **under 15 minutes**.
- Low-stock alerts fire before core items (pork belly, beef, banchan, sauces) run out.
- Every item with a recorded expiry date is flagged before it expires.
- Weekly variance report is generated with zero manual calculation.
- Every new booking alerts staff immediately; every customer receives a confirmation by email or SMS.

### 2.3 Non-goals for the MVP
CRM / loyalty, marketing & SEO tracking, accounting (expenses, payables, P&L), CCTV link, online delivery (Grab), sales-by-channel dashboard, corporate directory (contractors, maintenance), payroll, and the multi-business (SaaS) rollout. The **data model is designed so these plug in later** without rework (branch tagging, supplier table, customer fields on reservations, payment records).

**Moved into the MVP in v0.4 ✅:** **staff time clock + live shift schedule** (already built: time in/out, breaks, weekly schedule, live shift board, attendance report). Payroll itself stays out of scope; the attendance report gives payroll the hours.

---

## 3. Users, roles and devices

| Role | Who | MVP permissions (summary) | Typical device |
|---|---|---|---|
| **Owner** | JD | Everything for all branches he owns; **final approval on every reorder**; sees all reports | Phone, laptop |
| **Manager / Head Chef** | Branch manager, head chef | Everything for **their branch**: inventory, counts, waste, production, POS overrides, reservations, reports, reorder list | Tablet, phone |
| **Cashier** | Front desk | POS billing and payments, reservations (confirm, seat), table open/close | Tablet / laptop at counter |
| **Server** | Floor staff | Open tables, take orders, tap refills, mark rounds served, view own branch's live stock for refill items | Company phone |
| **Kitchen / Dispatch** | Kitchen staff | **Kitchen/Dispatch screen** (new orders + refill rounds, mark Served), receive deliveries, log production (marinating/prep), log waste, do counts | Own tablet or phone at dispatch |
| **Admin** | Developer (Kyla) | Users, roles, branches, settings, menu & portion setup, imports, audit log | Laptop |
| **Customer** | Diners (no login) | Public booking page only | Own phone |

Rules:
- A user belongs to one or more branches with one role per branch (`user_branch_roles`). Data visibility is enforced in the database (§11), not only in the UI.
- Shared company devices are expected. Staff switch the active user with a **4–6 digit PIN** so every action is attributed to a person. ⚠️ How this works (§11.1): each shared device signs in once with its own **device account**; staff identity comes from a PIN that the **server** verifies. Owner, Manager and Admin also have personal email + password logins for their own phones and laptops.
- Devices: laptop, tablet, phone ✅; exact number of each 🔄. Internet: **fiber** ✅. The POS and counts still work offline for short outages (§10).
- UI language: **English by default** ✅, with **Tagalog/Ilocano labels for staff** screens 🔄 (§9.5).

### 3.1 Screen access by role ✅ (v0.4)
Staff only see the screens for their own job. The **owner dashboard is never shown to servers, kitchen staff or cashiers**, and the admin login is never listed on the sign-in screen.

| Screen | Server | Kitchen | Cashier | Manager | Owner (JD) | Admin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Time clock (own time in/out, own schedule) | ✓ | ✓ | ✓ | ✓ | — | — |
| Tables & POS (open table, orders, refills) | ✓ | — | ✓ | ✓ | view | ✓ |
| Billing, payments, cashier shift, X/Z reading | — | — | ✓ | ✓ | view | ✓ |
| Kitchen / Dispatch screen | — | ✓ | — | ✓ | — | ✓ |
| Reservations (staff list, confirm, seat) | — | — | ✓ | ✓ | ✓ | ✓ |
| Live stock (levels only, **no costs**) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Deliveries, prep, counts | — | ✓ | — | ✓ | — | ✓ |
| Waste log | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Item costs, suppliers | — | ✓ (entering deliveries) | — | ✓ | ✓ | ✓ |
| Reorder list and approvals | — | — | — | ✓ (1st approval) | ✓ (final) | ✓ |
| Staff & shifts board, schedule editor | — | — | — | ✓ | ✓ | ✓ |
| Reports | — | — | — | ✓ (own branch) | ✓ (all branches) | ✓ |
| **Owner dashboard** (sales, food cost %, all branches) | — | — | — | own branch only ⚠️ | ✓ | ✓ |
| Setup (menu, prices, promos, staff, devices) | — | — | — | ✓ (own branch) | ✓ | ✓ |

Rules:
- The table is enforced **in the database**, not only by hiding menu items. Every dashboard and report function must check the caller's role (`app.require_role`) as well as the branch. ❗ **Gap found Nov 25:** `get_dashboard` and the `report_*` functions currently check the branch only, so a server on a shared device could fetch them through the API. Fix before production (§14.4).
- Servers and cashiers see stock **levels and status** (OK / low / out), not unit costs.
- ✅ The branch manager sees the dashboard for **their branch only**, including food cost and profit (JD, v0.5).

---

## 4. Domain model in plain language

Understanding these ideas is required before building:

- **Branch** — a restaurant location. Every business record carries `branch_id`.
- **Item** — anything we stock and count: raw meat, prepped meat, vegetables, side dishes, sauces, beverages, Korean ingredients, janitorial supplies, charcoal/LPG, packaging. Each item has one **base unit** (g, ml, pc). Counts may be entered in kg/L/packs and are converted.
- **Item stage** — where the item sits in the flow:
  - `raw` (e.g. frozen Pork Belly, Beef Shortplate, Chicken; fresh vegetables)
  - `prepared` (ready to serve: Samgyupsal, Daepae, Moksal, Y-Sam w/ sauce, Gochujang w/ sauce, Plain Beef, Y-Woo Beef w/ sauce, Enoki; side dishes like Kimchi, Japchae, Fishcake, Potato Marbles, Steam Egg; dipping and meat sauces)
  - `resale` (drinks, bottled water, ice cream cones)
  - `supply` (janitorial, packaging, charcoal, LPG, butane — tracked and counted but not deducted by sales in the MVP)
- **Production (prep run)** — converts raw items into prepared items using a **prep recipe**. Example from the Taft sheet: 4 kg Y-Sam meat + 1.5 kg Yangnyeom sauce → 5.5 kg *Y-Sam w/ sauce*. Production deducts inputs and adds the output.
- **Batch** — a quantity of an item received on one delivery (or produced in one prep run) with its unit cost and optional expiry date. FIFO uses batches.
- **Stock movement** — the immutable ledger row for every change in stock (delivery in, production in/out, sale deduction, refill deduction, waste, count adjustment, manual adjustment). **Live stock = sum of movements.** Nothing edits stock directly.
- **Menu item** — something sold: unlimited package per person, lunch set, add-on, drink, fee.
- **Portion rule (recipe / BOM)** — how much of which item a menu item or refill consumes, e.g. 1 meat plate of Samgyupsal = 80 g of *Samgyupsal (prepared)*.
- **Table session** — one seating of one group at one table, from open to bill settled. Holds headcount, package, timer, orders, refill rounds and payments.
- **Refill round** — one submission of meat plates (and optionally side dishes) for a table. Limited to N meat plates per round.
- **Business date** — the operating day a record belongs to. Late-night closing counts belong to that day. Cutoff hour configurable (default 04:00). ⚠️
- **Expected stock** — what the ledger says should be on hand. **Counted stock** — what staff weigh/count. **Variance** = counted − expected.
- **Costing rule** ⚠️ — each item keeps a **moving weighted-average cost** per branch (updated on every delivery and production-in). Every outgoing movement (sale, refill, waste, production-out, count adjustment) is valued at the item's moving average at that moment. Batches track **quantity and expiry only** (FIFO for freshness, not for cost). A production output's cost = Σ(inputs × their moving average). The *Average ingredient cost* report (§8.2) separately shows the period's simple and weighted purchase averages.

---

## 5. MVP features — Inventory Management

### 5.1 Item master
- Fields: name, category, stage, base unit, count unit + conversion (e.g. counted in kg, stored in g), reorder level, par level (target to restock up to), default supplier, `tracks_expiry`, default shelf life (days), near-expiry threshold (days), active flag, sort order (matches the physical count route).
- Categories (seeded from the Taft sheet, editable): Frozen Meats · Ready-to-Serve Meats · Vegetables · Side Dishes (dispatch) · Sauces · Local Ingredients · Korean Ingredients · Beverages · Janitorial · Charcoal & Fuel · Delivery / Packaging Materials.
- Expiry tracking defaults ON ✅ for:
  - **fresh and frozen meats** and **vegetables** — **highest priority** for alerts ✅ (use-by dates);
  - **powders and ingredients** ✅ (frying powder, ice cream powder, iced tea powder, chili powder, Dashida, MSG, sauces, etc.);
  - prepared items (marinated meats, side dishes) get a use-by date from the prep run (prep date + shelf life) ⚠️.
- Expiry stays switchable per item. Default near-expiry thresholds ⚠️ (tuned during testing 🔄): fresh vegetables and chilled meat 1 day; marinated meats and side dishes 1 day; frozen meat 7 days; powders, sauces and dry goods 14 days.
- Duplicate names across stages must be made distinct (e.g. *Kimchi (raw, 1 kg pack)* vs *Kimchi (served side dish)*).

**Acceptance:** Admin/Manager can create, edit, deactivate items; deactivated items disappear from POS and count sheets but keep their history.

### 5.2 Stock in — deliveries
- Record a delivery: supplier, date/time, received by, reference/invoice no., payment method (cash, GCash, bank, etc.), and lines: item, quantity (in count unit), unit price **or** line total, expiry date (required when `tracks_expiry`), notes.
- Each line creates a **batch** and a `delivery_in` movement.
- Optional: attach a photo of the delivery receipt. ⚠️
- Update the supplier's **last price** for that item.

**Acceptance:** After saving a delivery of 40.35 kg Pork Belly at ₱325/kg, live stock rises by 40,350 g, a batch exists with unit cost ₱0.325/g, and the supplier directory shows ₱325/kg as last price.

### 5.3 Production / prep (marinating, side-dish cooking)
- Prep recipes define inputs and output, e.g. *Y-Sam w/ sauce* batch: 4,000 g pork + 1,500 g Yangnyeom meat sauce → 5,500 g. Taft standards to seed: Y-Sam (4 kg meat + 1.5 kg sauce = 5.5 kg), Y-Woo (8 kg + 4 kg = 12 kg), Gochu (6 kg + 2 kg = 8 kg).
- Kitchen logs a prep run by choosing the recipe and entering the **actual output weight**. Inputs are deducted by recipe ratio (scaled to the actual output, or entered actual inputs if different). Output creates a prepared batch whose cost = cost of inputs (costing rule, §4).
- Simple slicing (Pork Belly → Samgyupsal) is also a prep recipe with a yield %. **Trim loss is not a separate waste movement** — the full raw input is already deducted and the output is smaller, so posting waste too would deduct the trim twice. Trim (= inputs − output) is shown in the Waste summary under reason `prep_trim`, computed from `production_runs`. 🔄 Yields per cut and the Y-Sam / Y-Woo / Gochu batch standards are **adjusted during testing** — they are editable data, not code.

**Acceptance:** A prep run of 5.5 kg Y-Sam removes 4 kg raw pork and 1.5 kg sauce from stock and adds 5.5 kg Y-Sam w/ sauce, all in one transaction.

### 5.4 Live stock
- Live stock view per branch: item, on-hand (in a friendly unit), status chip (OK / Low / Out / Near-expiry), last movement time. Filter by category; search.
- Updates in real time when any device posts a sale, refill, delivery, waste or count (Supabase Realtime, §9).
- Owner can open this on his phone.

### 5.5 Low-stock alerts
- An item is **Low** when on-hand ≤ reorder level; **Out** when ≤ 0.
- During service, a Low/Out on any prepared meat or side dish triggers: in-app banner + push notification to Manager/Head Chef and Kitchen roles on that branch, and the item is highlighted on the server's refill screen.
- Alerts are de-duplicated (one alert per item per threshold crossing, re-armed after restock).
- For **prepared** items, `reorder_level` holds the *service low alert* and `par_level` holds the *prep target at opening* from Appendix A.2; for purchased items they hold the A.1 reorder and par levels.
- Starting reorder levels, par levels and service low-stock alerts are **proposed from Taft usage in Appendix A** ✅ (JD asked for proposed values); they are tuned after the first two weeks of Ilocos data 🔄.
- Fresh meat and vegetable **near-expiry** alerts are shown with the same priority as low-stock alerts ✅.

### 5.6 Expiry tracking and FIFO
- Near-expiry list: batches whose expiry is within the item's `near_expiry_days` (defaults per category in §5.1), sorted by soonest.
- Expired batches are flagged red and a one-tap action logs them as waste (`expired`).
- FIFO view per item shows batches oldest-first with remaining quantity; deductions consume the oldest non-expired batch first.
- Daily digest notification at opening: "N items are near expiry" (each item judged by its own threshold), listing expired batches first.
- If stock goes negative (late offline sync, §10), the excess deduction is posted with `batch_id = null`; the next delivery or count adjustment clears it. Batches never hold negative quantities.

### 5.7 Waste log
- Fields: item, quantity, reason (`spoilage`, `expired`, `over_portioning`, `plate_waste`, `dropped/damaged`, `other` + note), batch (optional, defaults FIFO), logged by, optional photo. (`prep_trim` is reported from production runs, not logged here — §5.3.)
- Waste posts a `waste` movement valued at the moving weighted-average cost (§4).
- The POS **Leftover fee** (₱200 at Taft) prompts the server to log plate waste for that table (estimated grams). ⚠️

### 5.8 Physical counts (opening / closing / spot)
- Count sheet lists items in the configured route order (same grouping as today's sheet), entered in count units (kg, packs, pcs, bottles).
- **Opening count** pre-fills from the previous closing count; staff confirm or correct; differences are flagged. An opening count **posts no movements by default** (the approved closing count already reconciled the ledger). A manager may approve a flagged opening difference with a reason, which then posts a `count_adjustment` for that item only. ⚠️
- **Closing count**: staff weigh/count everything (Taft rule: weigh marinated meats *with* sauce). On submit, the system snapshots **expected** quantity and computes **variance**. A reason is required when the variance exceeds **both** 5% of expected **and** the absolute minimum for the item's base unit (200 g · 200 ml · 2 pc; v0.2's 500 g would let 6 missing plates of a 2 kg item pass) — so tiny items aren't flagged for a few grams. All values configurable ⚠️.
- Manager approves the closing count; approval posts `count_adjustment` movements so the ledger matches reality, and generates the **shift summary**.
- Counts can be saved as draft offline and submitted later.

### 5.9 Supplier directory (basic)
- Supplier: name, contact person, phone(s), Viber/Messenger/WhatsApp handle, email, address, payment terms, notes, branch.
- Items supplied with last price, last delivery date, simple and weighted average price.
- One-tap call / open Viber / open Messenger from the phone.
- Seed examples from Taft expenses (PJC Meat Trading, 3KA Vegetables Store, JK Essentials, YMOO Consumer Goods Trading, Fortunes Mart, Top Creamery, Flame 1 Gas Corp, Aurea Ventures) — **Ilocos will have its own suppliers** ✅.

### 5.10 Reorder list
- Auto-suggested list: items at or below reorder level, suggested quantity = par level − on-hand, grouped by default supplier, with last price and estimated cost.
- **Dual approval ✅:** the branch manager reviews and approves first, and **JD gives the final approval**. A manager's approval alone never releases an order. Status: `draft → manager_approved → owner_approved → ordered → received` (or `rejected` with reason at either step). JD gets a push notification when a list is waiting for him.
- Manager edits quantities before approving; JD can adjust quantities when approving (changes are audited). Receiving links to a delivery.
- From an approved list, generate a message per supplier (copy to clipboard / share sheet) for sending via Viber/Messenger. The system does **not** send it automatically.

---

## 6. MVP features — In-house POS (order screen)

Replaces LoyVerse ✅. The POS has three jobs in the MVP: **capture what was sold and served so inventory is right**, **send orders and refills to kitchen/dispatch instantly**, and **bill the table with a BIR-compliant sales invoice** (the Ilocos branch will be VAT-registered ✅).

### 6.1 Menu and pricing setup (Admin/Manager)
- **Menu item types:** `unli_package` (priced per person), `set_meal` (lunch bowl, bento, solo set), `add_on`, `drink`, `fee` (leftover fee, takeout fee), `raw_meat_takeout`.
- **Prices are per branch** and **snapshotted** onto each order line at the time of sale.
- **Proposed Ilocos menu** (from the brand proposal — *prices pending costing* 🔄):
  - Unlimited Grill 3 PM–10 PM: **Pork ₱499/person**, **Beef + Pork ₱599/person**; refills only with unlimited; staff-served.
  - Lunch 11 AM–3 PM (single serving, no refills): **Korean Bowls ₱149** (Bulgogi, Gochujang, Chicken), **Bento ₱270**, **Solo Set ₱350**.
- **Time windows are strictly enforced ✅** ("follow business rules"):
  - 11:00–14:59 → lunch sets only; unli packages are hidden/disabled.
  - 15:00–22:00 → unli packages only; lunch sets are hidden/disabled.
  - Enforcement uses the **time the order line is created**, measured on the corrected device clock (§10.1). Time windows apply only to lunch sets and unli packages; drinks, add-ons and fees can be added at any time while the session is open. A lunch table still seated after 3 PM can keep eating but cannot add lunch sets or start unli without opening a new unli session (manager decision).
  - Manager PIN can override in exceptional cases; every override is audited.
  - 🔄 Last unli seating: with a 2-hour timer and a 10 PM close, what is the latest time a new unli table may be opened (e.g. 8:00 PM, or allowed with a shorter timer)?
- **One unli package per session** ⚠️ 🔄: everyone at a table is on the same package (pax *types* and discounts can still differ). A group that wants both Pork and Beef + Pork opens two sessions. This keeps the allowed refill items unambiguous.
- **Package → allowed refill items:** e.g. Pork package cannot order beef plates. 🔄 Exact cuts and side dishes per package for Ilocos. Until confirmed, the setup screen allows all items and the restriction is turned on once JD confirms.

### 6.2 Discounts and pax types
All Taft discount types **carry over to Ilocos except the Solo Diner rate** ✅. The POS models them as **discount rules** applied per person on a package or per set:

| Pax / discount type | Rule | Notes |
|---|---|---|
| Regular | full price | |
| Senior Citizen / PWD | price ÷ 1.12 × 0.80 (VAT-exempt + 20%) — e.g. ₱499 → ₱356.43 | Legally required; record SC/PWD ID no. and name on the invoice |
| Kids | 50% | 🔄 age/height rule |
| Athlete | 20% | 🔄 proof required? |
| Employee / Birthday | 30% | 🔄 birthday proof rule |
| Manager discount | 10% | Requires manager PIN |
| SC/PWD on sets (Bento PWD, Solo Set PWD) | SC/PWD formula on the set price | |
| ~~Solo diner rate~~ | **Not used at Ilocos** ✅ | Solo guests pay the regular per-person price |

- **Calculation order** ⚠️ (verify with JD's accountant 🔄):
  1. Menu prices are **VAT-inclusive**.
  2. **SC/PWD:** price ÷ 1.12 (removes VAT; the line becomes VAT-exempt) × 0.80.
  3. **Other percentage discounts** (Kids, Athlete, Employee/Birthday, Manager): applied to the VAT-inclusive price; VAT is then extracted from the discounted amount (net ÷ 1.12 × 0.12), so the line stays VATable.
  4. **No stacking:** one discount type per person. If a guest qualifies for several, staff pick one (SC/PWD takes priority when it applies).
  5. **Rounding:** every line is computed and rounded to the centavo (round half up) when it is created; bill totals and the VAT breakdown are sums of rounded lines, never recomputed from the total.
- Discounts that need authority (manager discount, comp, void) require a **manager PIN** and are written to the audit log.
- The discount table is data, not code: rates can be changed per branch without a new release.

### 6.3 Tables and sessions
- Floor view: grid of tables (label, seats — 4 per table per proposal, status: free / seated / billing / dirty, timer). 🔄 Number of tables, labels and seats for Candon (~80 seats target, unverified). Tables are set up in Admin, so the layout can be entered when the floor plan is final.
- **Open table:** choose table → enter headcount by pax type → choose package (or lunch sets) → link a reservation if any. Merging tables (Taft records "1&2") is supported as one session over several tables.
- **Unli timer ✅:** opening an unli session starts a **2-hour countdown** (configurable per branch).
- **Last-refill cutoff ✅:** refills close **45 minutes before the 2-hour limit**, i.e. at **1 h 15 min** after the table opened. The server's Refill button shows the time left until cutoff, warns 10 minutes before ("Last call for refills"), and is disabled after cutoff. Manager PIN can allow one late round (audited).
- **End of time:** warnings at 15 and 5 minutes left; overtime shown in red on the floor view. 🔄 Overtime charge (amount and rule) — the bill supports an `overtime fee` line, switched off until JD confirms.
- **Close / reset:** after payment the table becomes `dirty`, then `free` when bussed. Table status is stored on `dining_tables.status` (§12.3).

### 6.4 Refills — the core cost-control feature
- Servers use a company phone. Tap table → **Refill** → tap meat plates and side-dish plates → submit. One submission = one **round**.
- **Limit ✅:** max **3 meat plates per table per round** (configurable per branch). The order screen blocks exceeding it; manager PIN can override (logged).
  - **Merged tables** ⚠️ 🔄: a session over several tables gets the limit × number of tables (e.g. tables 1&2 → 6 plates per round). JD to confirm, or whether the limit should scale with pax instead.
- **Next-round rule ✅:** a table can submit a new round only after the previous round is marked **Served** on the Kitchen/Dispatch screen (§6.5).
  - The next round unlocks when **all meat lines** of the previous round are served; unserved side-dish lines don't block it ⚠️.
  - **Stuck round:** if a round is still unserved after `stuck_round_minutes` (default 10 ⚠️, same as the red ticket colour), the server's screen shows "Waiting on dispatch — ask the kitchen", and a manager PIN can mark it served from the server's phone (audited). The refill cutoff clock keeps running either way.
- **Offline refills** ⚠️: an offline phone can't see whether the kitchen marked the last round served. It may queue **at most one unsynced round per table**, and only when its last-synced data shows the previous round served. The server re-checks every rule on sync; a rejected round is flagged to the manager, never silently dropped. While offline, the server tells dispatch verbally (§6.5).
- **Deduction (v0.5 ✅, replaces 80 g for all):** **meat with sauce 120 g, meat without sauce 80 g, side dishes 50 g** per plate. *Earlier v0.2 text:* every plate deducts 80 g — this applies to **every meat cut and every side-dish refill plate** (JD: average from weighing 100 plates). The value is stored per item (`grams_per_plate`, default 80) so a cut can be changed later after re-weighing without code changes.
- 🔄 Side-dish plates per round: do side-dish refills count toward the 3-plate limit, or have their own limit? Default: **separate**, no limit, still recorded and deducted ⚠️.
- The **first serving** at table open is Round 1 (same limit and deduction). 🔄 The **initial banchan set and rice** per head or per table is a portion rule on the package, to be confirmed during testing.
- After cutoff, the Refill button is disabled (see §6.3).

**Acceptance:** Table 7 (4 pax, Pork package, opened 6:00 PM) submits Round 2 with 2 Samgyupsal + 1 Daepae + 1 Kimchi. Samgyupsal stock drops by 160 g, Daepae by 80 g and Kimchi (served) by 80 g immediately on all devices; a 4th meat plate is blocked with "Limit is 3 plates per round"; Round 3 cannot be submitted until Round 2 is marked Served; at 7:15 PM the Refill button is disabled with "Refill cutoff reached".

### 6.5 Kitchen / Dispatch screen (no paper slips ✅)
Kitchen and dispatch use **their own tablet or phone** running the same PWA. New orders from the cashier and refill rounds tapped by servers **appear automatically** — no printed slips.
- **Queue:** cards in order of arrival, each showing table label, type (New order / Refill round N), items and plates, server name, and a waiting-time counter (turns amber after 5 min, red after 10 min ⚠️).
- **Alert:** loud chime + flashing card for every new ticket (kitchens are noisy); volume setting per device. Screen Wake Lock keeps the tablet on.
- **Start service button:** browsers block sound until someone taps the page, so the screen opens on a full-screen "Start service" button that unlocks audio and wake lock. If sound or wake lock is lost (e.g. after a reload), the button comes back.
- **Actions:** tap **Served** (whole ticket) or tap individual lines; served time is recorded and unlocks the table's next refill round.
- **Low stock on the line:** if an item on a ticket is Low/Out, the card shows a badge so dispatch can tell the server immediately.
- **Views:** filter by station if needed later (meat dispatch / hot kitchen / drinks); MVP has one combined queue ⚠️.
- **Offline caveat:** a ticket only reaches the kitchen screen once the server's phone is online. If a server's screen shows "pending sync", the server tells dispatch verbally. Fiber internet ✅ makes this rare.
- Kitchen/dispatch tickets are **not printed** in the MVP. Station printing can be added later without changing the data model.

### 6.6 Orders for sets, add-ons, drinks
- Add to the session at any time, subject to time windows (§6.1). Each line deducts by its portion rule (e.g. Bulgogi Bowl = rice g + bulgogi g + sides; Coke can = 1 pc; Steamed egg = steam egg g) and creates a kitchen ticket when the item needs preparation.
- **Voids:** before served — server can void with reason; after served — manager PIN; voids reverse the stock movement only if the item was not served/prepared. ⚠️ Voids **after an invoice is issued** follow the BIR void process (§6.7).

### 6.7 Billing, payment and BIR sales invoice
**Launch mode ✅ (v0.4): internal sales tracking.** ✅ v0.5: JD will **not** register the POS with BIR. The system is an internal sales tracker only:
- The POS is the restaurant's **internal record** of every sale: tables, pax, orders, refills, discounts, payments and stock deductions. X-reading and Z-reading still run as internal end-of-shift and end-of-day reports.
- Official invoices are written from the **existing BIR-registered manual booklet**, as today. The cashier types the booklet invoice number into the POS when settling, so the two records can be matched.
- The cashier printer prints only an **unofficial receipt ("Order Summary — NOT AN OFFICIAL RECEIPT")** with no BIR invoice fields (layout in §15.5). 🔄 The accountant confirms the exact wording BIR requires on such slips, and whether using a computerized system internally must be reported to the RDO. (Not tax advice — the accountant decides.)
- Tax records for BIR stay with JD's accountant, outside this system. The daily sales journal can be exported for them.
- Hardware needed at launch: one cashier device running Chrome (Windows laptop/mini-PC recommended) and one **80 mm ESC/POS thermal printer**; phones for servers; a tablet for the kitchen; Wi-Fi with mobile-data backup; optional cash drawer.
- If JD later registers the POS with BIR, official invoice printing is switched on per terminal in Setup; the invoice rules below are already built and tested.

**Earlier decision (v0.2), now on hold:** the Ilocos branch is VAT-registered and the in-house POS **prints the official sales invoice**.

**Payment**
- Bill preview shows: per-person package lines by pax type, sets, add-ons, fees (leftover ₱200 ✅, takeout), discounts, VAT breakdown, total.
- **Payment methods:** Cash, GCash, Maya (PayMaya), Credit/Debit Card, Bank transfer; **split payments** allowed. Record reference no. for non-cash. Cash: amount tendered → change.
- MVP records payments only; it does **not** integrate with GCash/Maya/card terminals.
- **Leftover fee ✅ ₱200:** adding it prompts the server to log estimated plate waste for that table (§5.7). Charged **once per table session** and treated as a **VATable** sale ⚠️ 🔄 (confirm per-table vs per-person with JD, VAT treatment with the accountant).

**Sales invoice requirements** (typical BIR rules for a VAT-registered POS — the exact list must be **verified with JD's accountant and the BIR Revenue District Office** before printing the first invoice) 🔄:
- Header: registered business name, trade name ("Golden Korean BBQ"), branch address, **VAT REG TIN** with branch code, document title **SALES INVOICE**.
- **Serial number**: sequential per terminal, never reset, never reused, no gaps (a voided invoice keeps its number and is marked VOID).
- **Official invoices are issued online only** ⚠️. The server assigns the number in `issue_invoice` (§9.3), in the same transaction that updates the accumulated grand total. Keeping a gap-free sequence on the device is fragile (cleared browser data or a replaced device would cause gaps or duplicates), so it is not used. If the cashier device is offline when a bill is settled, the cashier issues the invoice from the **manual booklet** (same fallback as before BIR approval, below) and types the booklet number into the POS; the payment syncs later.
- Date and time, cashier, table, items with quantity and price.
- VAT breakdown: **VATable sales, VAT amount (12%), VAT-exempt sales, zero-rated sales**, discounts by type, total amount due.
- SC/PWD sales: customer name, ID number (and signature line) printed on the invoice.
- Machine/terminal details required by BIR (e.g. Permit to Use no. and date, machine identification no., serial no.) and software provider details, as stated in the BIR permit.
- A PWA runs in a browser on any device, so invoice issuing is **bound to the registered terminal**: `issue_invoice` only accepts calls from the device account linked to that `pos_terminals` row (§11.1).
- **Reprints** are marked "REPRINT" and logged; finalized invoices can never be edited — only voided with reason and manager PIN, and the void is itself recorded.
- **X-reading** (per cashier shift) and **Z-reading** (end of day) with an **accumulated grand total** that never resets; daily sales journal kept and exportable for the accountant.

**BIR registration risk ❗:** the POS software and each cashier terminal must be registered/approved by the BIR before they issue invoices, and this can take weeks. Until approval:
- the POS still runs everything (orders, refills, inventory, payments) and prints a **non-official "Bill / Statement of Account"** clearly marked "THIS IS NOT AN INVOICE";
- the cashier issues the official invoice from a **BIR-approved manual invoice booklet** (or another registered method), and the booklet invoice number is typed into the POS so both records match (ask the accountant whether the booklet may also be used during internet outages after the POS permit is approved 🔄);- when the permit arrives, invoice printing is switched on per terminal in Settings (no code change).
- JD/accountant should **start the BIR application in Week 0** (§14.3).

**Printer (cashier only) 🔄:** model still undecided. Only the cashier station needs a printer now that kitchen slips are dropped.
- Requirement: 80 mm thermal, ESC/POS compatible, reliable driver for the cashier device.
- Simplest setup to recommend: cashier station on a **Windows laptop or mini-PC + USB thermal printer** using the OS driver; the PWA prints an 80 mm invoice layout via the browser, with Chrome's kiosk-printing mode so it prints without a dialog. Avoid Bluetooth-only printers if the cashier device will be an iPad.
- Test the chosen printer in Week 3 before the dry run.

### 6.8 Shift and day close
- **Cashier shift:** opening cash float, cash-in/out, expected cash vs counted cash, **X-reading** at end of shift.
- **Day close:** **Z-reading** (BIR) + sales summary in the structure JD already reads: pax by type, sets, add-ons, totals by payment method (Cash / GCash / Maya / Card / Bank), over/short, invoice number range used, voids and reprints.

---

## 7. MVP features — Reservations

### 7.0 Keeping customer booking separate from POS and inventory ✅ (v0.4)
The customer side and the staff side share one database but are **walled off**:
- **Separate address.** Customers use the public site (e.g. `goldenkoreanbbq.ph` → booking, menu, promos). Staff use the app (`app.goldenkoreanbbq.ph`). The public site has no login and no link to staff screens. It can be deployed as its own Vercel project so a problem in one never takes down the other.
- **No direct table access.** Customers never read or write POS, inventory, staff or sales tables. The booking form goes through one Edge Function (`public-booking`) with Turnstile anti-spam and rate limits. The menu and promos come from **read-only public views** (`public_menu`, `public_promos`, availability) that expose only names, photos, descriptions, prices and dates — never costs, stock or recipes.
- **One-way link into the POS.** A booking lands in `reservations` as *pending*. Staff confirm it. When guests arrive, **Seat** opens a table session linked to the reservation. Nothing in POS or inventory changes until a staff member acts.
- **Customer data stays minimal:** name, mobile, optional email, notes, consent. Contacts are anonymised after the retention period (§15.4).

### 7.1 Public booking page (replaces the current ChatGPT-made site ✅)
- Mobile-first page in brand style (§9.5), linkable from Facebook/Instagram/TikTok bios.
- Fields: date, time slot, party size, package interest (Unli Pork / Unli Beef+Pork / Lunch / Not sure), full name, mobile number (PH format), email (optional ⚠️), notes (birthday, high chair, PWD access), **privacy consent checkbox** (Data Privacy Act).
- **Operating hours ✅: 11:00 AM – 10:00 PM** daily (lunch 11–3, unli 3–10, per the proposal).
- Rules (configurable per branch; developer defaults ⚠️ until confirmed 🔄): slots every 30 min; last bookable slot 8:00 PM for unli (so a 2-hour session ends by 10 PM); booking lead time ≥ 2 hours; max party size online = 16 (larger → "call us"); capacity per slot by number of tables/seats available; same-day bookings allowed.
- **Capacity over overlapping slots** ⚠️: a booking holds seats for its whole seating — **120 min** for unli, **60 min** for lunch — so it counts against every 30-min slot it overlaps, not just its start slot. Online bookings may use at most **70% of seats** per slot (`online_capacity_pct`); the rest is kept for walk-ins and phone bookings, which staff enter themselves and which are not blocked by the online limit.
- Anti-spam: rate limit + Cloudflare Turnstile (or hCaptcha).
- On submit: customer sees "Request received — we'll confirm shortly" with a reference code (e.g. `GKB-7Q4K`).
- 🔄 Deposits/down-payments for large groups — not in the MVP unless JD requires it.

### 7.2 Instant staff alert + one-tap confirm
- New booking → **realtime in-app alert with sound** on the front-desk device, **web push** to Cashier/Manager phones of that branch, and an **email** to the branch inbox as backup.
- Staff open it and tap **Confirm** (optionally assign a table) or **Decline** (with reason, e.g. fully booked → suggest another time).
- Unconfirmed bookings older than 15 minutes re-alert the Manager. ⚠️

### 7.3 Customer messages
- On **Confirm**: automatic confirmation by **SMS via Semaphore ✅** (primary — most local guests use mobile) and **email** if given.
- **Reminder**: SMS/email before the booking (default 3 hours before ⚠️). If the booking is confirmed less than 3 h 30 min before the reserved time, **no reminder is sent** — the confirmation already states the time, and it saves an SMS.
- **After-hours bookings** ⚠️: staff alerts for bookings made while the restaurant is closed are held until 30 minutes before opening (the email backup still goes out at once); the 15-minute re-alert (§7.2) counts from opening.
- On **Decline/Cancel**: message with reason and the restaurant's contact number.
- Message templates editable by Admin. Every send is logged (status: queued / sent / failed).
- Paid PH SMS gateway approved ✅ — **Semaphore**, account under JD's business email ✅. Register the sender name (e.g. "GOLDENKBBQ") in Week 0 because approval can take several days; until approved, messages go out with the gateway's default sender.
- Branch email for backup alerts ✅ (address to be created under the new domain 🔄).
- SMS cost control: 2 SMS per booking (confirmation + reminder); a monthly SMS cap with a warning to the Owner at 80% ⚠️.

### 7.4 Reservation list (staff)
- Today / upcoming list with status: `pending → confirmed → seated → completed`, or `declined`, `cancelled`, `no_show`.
- **Seat** links the reservation to a table session (so reservation guests are countable later for sales-by-channel).
- No-show: mark manually, or auto-suggest after 15 minutes past the time ⚠️.
- Staff can also create reservations taken by phone or Facebook (source field).

**Acceptance:** A customer books for 6 pax at 7:00 PM. Within seconds the front-desk tablet chimes and the manager's phone gets a push. The cashier taps Confirm; the customer receives an SMS confirmation; at 4:00 PM they receive a reminder; when they arrive, the cashier taps Seat and the table session opens pre-filled with 6 pax.

---

### 7.5 Public menu and promos — **Phase 2** (v0.5: back out of the MVP; design kept for later)
Customers can browse the menu and current promos before booking.
- **Menu page:** unli packages (Pork ₱499, Beef + Pork ₱599), lunch sets (₱149 / ₱270 / ₱350), add-ons and drinks, grouped by category, with photo, short description, price and when it is served (e.g. "Unli from 3 PM"). Prices come from the same `menu_items` the POS uses, so the website never shows a stale price.
- Each menu item has a **"Show on website"** switch, a photo, a public description and a sort order. Items that are switched off or unavailable are hidden.
- **Promos:** title, banner photo, description, terms, branch, start and end date/time, and optional days and hours (e.g. weekdays 3–5 PM). Expired or future promos are hidden automatically. A promo can optionally link to a POS discount type so the cashier applies the same rule; otherwise it is display-only.
- **Booking link:** "Book a table" from the menu or a promo opens the booking form with the package or promo pre-selected as *package interest*. No online ordering or payment in the MVP.
- **Who edits:** Manager (own branch) and Owner in Setup → Menu & promos. Changes appear on the website at once. Photos are stored in Supabase Storage, resized for phones.
- Branch selector shows Candon only on PROD at launch; Taft appears once it moves to PROD.

**Acceptance:** JD adds a "Birthday Treat" promo valid Dec 1–31 with a photo. It appears on the public page on Dec 1, disappears on Jan 1, and a customer tapping "Book with this promo" lands on the booking form with the promo noted on the reservation the cashier sees.

## 8. MVP reports and owner dashboard

### 8.1 Owner dashboard (starting version)
Per branch (switcher ready for multiple branches):
- **Today's sales** (gross, discounts, net), pax served, tables active now, sales by payment method.
- **Live stock** of key items (configurable "watch list": e.g. Samgyupsal, Y-Sam, Y-Woo, Plain Beef, Kimchi, Rice, Sauces).
- **Alerts:** low/out of stock, near-expiry, large variances, unconfirmed reservations.
- **Reservations** today: count by status, next arrivals.
- **Theoretical food cost today** = Σ(deductions × weighted average cost) and food cost % of net sales. ⚠️ (stretch, uses data we already have)
- Must load fast on a phone over mobile data.

### 8.2 Reports (filter by branch, date range; export CSV/Excel)
| Report | Definition |
|---|---|
| **Weekly usage tracker** | Per item per week: **actual usage** = opening + stock in + production in − production out − logged waste − closing (from counts); **theoretical usage** = POS sale + refill deductions. Shows both, waste in its own column, and the **gap** = actual − theoretical (unexplained loss: over-portioning, unrecorded waste, theft, count errors). |
| **Monthly consumption summary** | Per item per month: total used (qty and ₱ at weighted cost), waste, number of delivery days. Mirrors the "WEEKLY CONSUMPTION / MONTH CONSUME" layout in the Taft sheet. |
| **Average ingredient cost** | Per item and per supplier for the period: **simple average** = mean of unit prices on deliveries; **weighted average** = total spent ÷ total quantity. **Weighted average is the costing basis** ✅; both are shown ✅. Includes min/max price and trend chart. |
| **Waste summary** | Waste by item, reason, staff, day; quantity and ₱ value; % of usage. |
| **Variance report** | Per count: expected vs counted, variance qty, variance %, ₱ value, reason; weekly roll-up highlighting repeat offenders. |
| **Sales summary** | Per day: pax by type, packages, sets, add-ons, discounts, payment methods (same view as today's sheet) + refills served per table and plates per pax. |
| **Refill analytics** | Plates per pax by package, by cut, by hour; tables that hit the limit most. |
| **Shift summary** | Generated on closing approval: sales, waste, variances, low stock, notes. |

---

## 9. Architecture and technology

### 9.1 Technology stack ✅ (confirmed)
| Layer | Choice | Why |
|---|---|---|
| Frontend | **React + TypeScript + Vite**, `vite-plugin-pwa` (Workbox), React Router, TanStack Query, Tailwind CSS | Installable PWA on phones/tablets/laptops, one codebase |
| Offline store | **IndexedDB via Dexie** | Local copy of menu/items/tables and an outbox of unsynced actions |
| Backend | **Supabase**: Postgres, Auth, Row Level Security, Realtime, Edge Functions, Storage, scheduled jobs (pg_cron) | Realtime stock and alerts; branch isolation in the database; little server code to maintain |
| Hosting | Vercel or Cloudflare Pages (frontend) + Supabase (managed) | Cheap; HTTPS by default (required for PWA) |
| Email | **Resend, free plan ✅ (v0.4)** — about 3,000 emails/month and 100/day (verify current limits); needs our own domain verified by DNS before it can email customers | Reservation confirmations, reminders and staff backup alerts |
| SMS | **Semaphore** ✅ | Confirmations and reminders to PH mobile numbers |
| Push | Web Push (VAPID) sent from an Edge Function | Staff alerts on phones; on iPhone/iPad, push works only after the PWA is added to the Home Screen |
| Anti-spam | Cloudflare Turnstile | Public booking form |

The earlier Streamlit + MySQL prototype is **not used** ✅; this is a fresh build.

**Accounts and ownership ✅:** domain, Supabase, Semaphore, email provider, hosting and the Git repository are all registered under **JD's business email**. The developer is added as a member/collaborator, never the sole owner.

**Domain ✅:** a dedicated domain for the booking page and app (e.g. `goldenkoreanbbq.ph` or `goldenkoreanbbq.com`) 🔄 final name to choose and buy in Week 0. Suggested layout: `goldenkoreanbbq.xx` → public booking page; `app.goldenkoreanbbq.xx` → staff PWA.

**Budget ✅: ₱30,000 covers development *and* hosting/SMS.** Recurring costs come out of the same budget, so track them monthly:

| Recurring item | Notes (verify current pricing before buying) |
|---|---|
| Supabase | Use the paid production tier — free-tier projects can pause when idle, which is unacceptable for a POS |
| Domain | Yearly; `.ph` usually costs more than `.com` |
| Semaphore SMS | Prepaid credits; ≈ 2 SMS per booking |
| Frontend hosting, email | Free tiers are enough at this volume |

**Budget check ⚠️ 🔄:** Supabase's paid tier has been about **US$25/month** (verify current pricing), roughly **₱17,000 per year** — more than half the budget for one year of hosting alone, before domain and SMS. JD needs to confirm **how many months of hosting and SMS the ₱30,000 is meant to cover**, and who pays recurring costs after that.

Devices, the thermal printer and BIR registration fees are **not** covered by the ₱30,000 ⚠️ (confirm with JD).

### 9.2 High-level flow
```
[Server phone]  [Cashier tablet]  [Kitchen tablet]  [Owner phone]      [Customer phone]
      \               |                 |                /                    |
       +------- PWA (React, offline outbox in IndexedDB) +             Public booking page
                         |  HTTPS / WebSocket                                 |
                 Supabase: Auth · Postgres (RLS by branch) · Realtime ·   Edge Function
                 Edge Functions (deduction RPCs, notifications) · pg_cron    (create booking)
                         |                                   |
                 Web Push / Email (Resend) / SMS gateway  ←--+
```

### 9.3 Key server-side rules (Postgres functions / RPC)
All stock-changing actions go through **database functions** that run in one transaction and write `stock_movements`. The client never inserts movements directly.
- `post_refill_round(session_id, lines[], client_uuid)` — validates the 3-plate limit, previous-round-served rule, package-allowed items and the last-refill cutoff; writes round + lines + movements + kitchen ticket.
- `mark_ticket_served(ticket_id, line_ids[])` — records served time and unlocks the next round.
- `post_order_lines(session_id, lines[], client_uuid)` — validates the lunch/unli time window; writes lines + portion-rule deductions + kitchen ticket when needed.
- `receive_delivery(...)`, `run_production(...)`, `log_waste(...)`, `submit_count(...)`, `approve_count(...)`.
- `settle_bill(session_id, payments[])` → `issue_invoice(...)` assigns the next invoice number for the terminal and updates the accumulated grand total in the same transaction.
- `approve_reorder(list_id, level)` — `level` = manager or owner; owner approval requires prior manager approval (or is done by JD as both when no manager exists ⚠️).
- `x_reading(shift_id)`, `z_reading(terminal_id, business_date)`.
- Each accepts a `client_uuid` (idempotency key) so a retried offline action is applied **exactly once**. The key belongs to the **action**, not to stock movements: one action writes many movement rows (several lines, a split across FIFO batches, production in and out). Keys are stored in `idempotency_keys` (§12.1) and on the action row itself (`refill_rounds`, `order_lines`, `production_runs`, `deliveries`, `waste_logs`, `stock_counts`, `payments`); a repeated key returns the original result without writing anything.
- Every RPC called from a shared device also takes the `staff_token` from PIN verification (§11.1) and records that person as `created_by`.
- After commit, a trigger evaluates thresholds and inserts `notifications` (low stock, out of stock), which Realtime pushes to clients and an Edge Function fans out to Web Push.

### 9.4 PWA requirements
- Web app manifest (name "Golden Korean BBQ", short name "Golden", gold **G** emblem icons 192/512 + maskable, theme color black, `display: standalone`).
- Service worker precaches the app shell; staff app opens with no internet.
- Call `navigator.storage.persist()` on every staff device so the browser doesn't evict the offline outbox. Install the PWA to the Home Screen on iPhone/iPad (Safari may clear storage for sites that aren't installed). The outbox screen shows a warning if persistent storage was refused.
- Install prompts/instructions for Android (Chrome) and iOS (Share → Add to Home Screen).
- **Screen Wake Lock** on POS, Kitchen/Dispatch and count screens so tablets don't sleep mid-service.
- Large tap targets (min 48 px), works one-handed on a phone, readable in a bright room.
- Update flow: "New version available — tap to refresh" (never auto-reload during an open order).

### 9.5 Brand and UI
- Palette from the brand proposal: **Ivory** (backgrounds), **Gold** (primary actions, highlights), **Silver** (secondary), **Black/Charcoal** (staff app chrome, text). Public booking page: ivory/gold/black, premium and bright; staff app: dark theme option for kitchen glare. ⚠️
- Wordmark **GOLDEN** + "Korean BBQ"; Korean lettering (골든) optional pending language review per proposal.
- Status colors must not rely on color alone (icons + text: OK / LOW / OUT / EXPIRING).
- Language ✅: **English is the default** for all screens. Staff screens (POS, refills, kitchen/dispatch, counts, waste) also get **Tagalog and Ilocano labels** 🔄. All UI text goes through translation keys from day 1 (e.g. `react-i18next`), so adding a language is a data task; translations are added during testing and can follow after launch if time is short. Each user picks their language in their profile.

---

## 10. Offline behavior and failure fallback

| Function | Offline? | Behavior |
|---|---|---|
| Open table, take orders, mark served | ✅ Yes | Saved to outbox, shown as "pending sync", posted in order when online |
| Refill rounds | Partial | At most one unsynced round per table, and only if the last-synced data shows the previous round served (§6.4) |
| Live stock on that device | Partial | Shows last-synced stock minus this device's pending deductions; other devices' changes appear after reconnect |
| Refill plate-limit check | ✅ Yes | Enforced on device; re-validated on server (server wins; conflicts flagged to manager, never silently dropped) |
| Billing & cash payment | ✅ Yes | Bill computed locally from cached prices; payment queued |
| Official sales invoice | ❌ Needs internet ⚠️ | Numbers are assigned by the server (§6.7). Offline → cashier uses the **manual invoice booklet** and types the booklet number into the POS; a non-official bill can still be printed |
| Staff PIN switching | Partial | Only to staff who already verified their PIN on this device during the current business day (§11.1) |
| Kitchen/Dispatch screen | Partial | Shows tickets already received; new tickets arrive only when the sending device is online (§6.5) |
| Counts, waste, deliveries | ✅ Yes | Draft locally, submit when online |
| Reservations (public page, alerts, SMS) | ❌ Needs internet | Public page is cloud-hosted, so it works even if the restaurant's internet is down; staff see bookings when back online |
| Reports & dashboard | ❌ Needs internet | |

- Stock is allowed to go negative when offline actions sync late; negative stock is flagged, not rejected.
- Sync uses the `online` event and app-foreground triggers (Background Sync isn't available on iOS Safari).
- **Paper fallback:** if devices or power fail, use pre-printed blank refill/order sheets (handwritten); a **backfill mode** lets the manager enter them afterward with the original time.
- Primary internet is **fiber** ✅. A mobile-data pocket WiFi as backup is still recommended ⚠️ so the kitchen screen, invoices and reservations keep working during a fiber outage.

### 10.1 Which clock counts ⚠️
Time rules (lunch/unli windows, refill cutoff, backfill times) depend on when an action happened, and device clocks can be wrong.
- Every server response carries the server time; each device stores its **clock offset** and uses **corrected device time** for every timestamp and every on-device rule check.
- Each action records both the corrected device time (`occurred_at`) and the server receive time. The server applies time rules to `occurred_at` when the device synced within the last 12 hours and its offset was measured.
- An action whose `occurred_at` differs from its receive time by more than **10 minutes** (late sync) is accepted but **flagged for manager review** if it would have broken a time rule at receive time. Backfill-mode entries (paper fallback) are always flagged and carry the manager who entered them.

---

## 11. Security, privacy and audit

- **Authentication:** Supabase Auth (email + password) for Owner/Manager/Admin on their own devices; shared devices use a device account plus staff PINs (§11.1).
- **Branch isolation (hard requirement ✅):** every business table, including child tables, has `branch_id NOT NULL` (§12); **Row Level Security** policies allow access only where the user has a role on that branch (Owner sees his branches). Tested explicitly (§14).
- **Role permissions** enforced in RLS and in RPCs (e.g. only Manager/Owner can approve counts, override limits, apply manager discount, void served items).
- **Audit log:** every insert/update/delete on business tables and every override/void/discount records who, when, device, before/after values. Append-only.
- **Customer data (Data Privacy Act, RA 10173):** booking form collects only what's needed, shows a privacy notice and consent checkbox, data used only for the reservation (marketing use needs separate opt-in for the future CRM). Retention: 🔄 (default: anonymize contact details 12 months after the visit ⚠️).
- SC/PWD discount records (name, ID number) are printed on the invoice as required and otherwise visible only to Manager/Owner and the accountant export. Retention follows BIR record-keeping rules 🔄 (confirm period with accountant).
- Invoice, X/Z-reading and journal records are **never deleted or edited**; corrections are voids with reasons.
- Backups: Supabase daily backups + weekly CSV export to the owner's Google Drive. ⚠️
- Secrets (SMS/email keys) live only in Edge Function environment variables.

### 11.1 Shared devices and staff PINs ⚠️
- Each shared device (counter, server phones, kitchen tablet) is registered by a manager and signs in with its own **device account** (a Supabase Auth user linked to `devices`, with access to that one branch only). The device session lasts until a manager revokes it.
- Staff pick their name and enter their PIN. The PIN is checked **on the server** by `verify_pin(device_id, user_id, pin)`, which returns a short-lived **staff token** (valid until the end of the business day). RPCs accept the token, check that person's role on the branch, and record them as `created_by`. RLS limits the device account to its branch; the staff token decides which actions are allowed.
- **PIN hashes never leave the server.** A 4–6 digit PIN can be cracked in seconds from a hash, so devices cache only staff tokens. Offline, a device can switch only to staff who already verified on it that business day.
- Brute-force protection: 5 wrong PINs locks that user on that device for 15 minutes and notifies the manager.
- Manager overrides (plate limit, late round, voids, manager discount) use the same check: the manager enters their PIN on the server's device, and the override is recorded under the manager's name.
- Lost or stolen device: a manager revokes the device account from Admin; all its tokens stop working.

---

## 12. Data model (PostgreSQL)

Conventions: `id uuid primary key default gen_random_uuid()`, `created_at timestamptz default now()`, `created_by uuid`, `branch_id uuid not null references branches` on every business table, quantities in **base units** as `numeric(14,3)`, money as `numeric(12,2)` (₱), unit costs as `numeric(14,6)` per base unit. Soft-delete via `is_active` for master data; transactional data is never deleted (voids/reversals instead).

**`branch_id` on child tables too:** child tables listed below without `branch_id` (e.g. `delivery_lines`, `refill_rounds`, `refill_lines`, `order_lines`, `session_pax`, `payments`, `bills`, `stock_count_lines`, `reorder_lines`, `supplier_items`, `portion_rules`, `prep_recipe_inputs`, `production_run_inputs`, `sc_pwd_records`, `x_readings`, `z_readings`) **also get `branch_id NOT NULL`**, copied from the parent and checked by a trigger. Every table then has the same one-line RLS rule, with no joins to get wrong. The column lists below omit it for brevity. Likewise, every action table synced from devices (orders, refills, payments, waste, counts, deliveries) carries `occurred_at` (corrected device time) next to `created_at` (server receive time) — §10.1.

### 12.1 Organization and access
```
organizations(id, name)                                   -- future multi-business
branches(id, organization_id, code, name, address, timezone default 'Asia/Manila',
         business_day_cutoff time default '04:00', settings jsonb)
profiles(id = auth.users.id, full_name, phone, pin_hash, is_active)   -- pin_hash: server-only, never readable by clients
user_branch_roles(user_id, branch_id, role)               -- role: owner|manager|cashier|server|kitchen|admin
devices(id, branch_id, label, kind, auth_user_id, revoked_at, clock_offset_ms, last_seen_at)  -- kind: cashier|server|kitchen|owner
pos_terminals(id, branch_id, device_id, terminal_code, bir_min, bir_serial_no, bir_ptu_no,
              bir_ptu_date, invoice_prefix, next_invoice_no, accumulated_grand_total,
              invoice_printing_enabled bool)                        -- false until BIR approval
audit_log(id, branch_id, user_id, device_id, table_name, record_id, action, before jsonb, after jsonb, at)
idempotency_keys(client_uuid primary key, branch_id, rpc_name, device_id, result jsonb, created_at)
staff_tokens(id, user_id, device_id, branch_id, issued_at, expires_at, revoked_at)   -- from verify_pin (§11.1)
pin_attempts(user_id, device_id, failed_count, locked_until)
```

### 12.2 Inventory
```
item_categories(id, branch_id, name, sort_order)
items(id, branch_id, category_id, name, stage,            -- raw|prepared|resale|supply
      base_unit,                                           -- g|ml|pc
      count_unit, count_unit_factor,                       -- e.g. kg, 1000
      reorder_level, par_level, default_supplier_id,
      tracks_expiry bool, shelf_life_days, near_expiry_days,
      grams_per_plate numeric null,                        -- for refillable items
      is_refillable bool, sort_order, is_active)
-- moving weighted-average cost (§4) lives on item_stock_levels(branch_id, item_id, qty_on_hand, avg_unit_cost, updated_at)
suppliers(id, branch_id, name, contact_person, phones text[], viber, messenger, whatsapp,
          email, address, payment_terms, notes, is_active)
supplier_items(supplier_id, item_id, last_unit_price, last_purchase_at)
deliveries(id, branch_id, supplier_id, received_at, business_date, reference_no,
           payment_method, total_amount, received_by, photo_path, notes)
delivery_lines(id, delivery_id, item_id, qty_base, unit_cost, line_total, expiry_date, batch_id)
stock_batches(id, branch_id, item_id, source_type, source_id,   -- delivery|production|opening
              received_at, expiry_date, qty_initial, qty_remaining, unit_cost)
prep_recipes(id, branch_id, output_item_id, standard_output_qty, notes, is_active)
prep_recipe_inputs(recipe_id, item_id, qty)               -- e.g. 4000 g pork, 1500 g sauce → 5500 g
production_runs(id, branch_id, recipe_id, business_date, output_qty_actual, made_by, output_batch_id)
production_run_inputs(run_id, item_id, qty_used)
waste_logs(id, branch_id, business_date, item_id, batch_id, qty, reason, note, photo_path,
           session_id null, logged_by, unit_cost_at_time)
stock_counts(id, branch_id, business_date, count_type,    -- opening|closing|spot
             status,                                       -- draft|submitted|approved
             counted_by, approved_by, approved_at, notes)
stock_count_lines(count_id, item_id, counted_qty, expected_qty, variance_qty, variance_value, reason)
stock_movements(id, branch_id, business_date, item_id, batch_id null,
                movement_type,                             -- delivery_in|production_in|production_out|
                                                           -- sale|refill|waste|count_adjustment|
                                                           -- manual_adjustment|void_reversal|opening_balance|
                                                           -- usage_import (staging Taft import only, §13.2)
                qty_delta, unit_cost, ref_table, ref_id, created_by, occurred_at, created_at)
                -- no client_uuid here: one action writes many movements; idempotency is per action (§9.3)
-- view: stock_on_hand(branch_id, item_id, qty) = sum(qty_delta)
-- materialized/cached table item_stock_levels updated by trigger for fast reads
reorder_lists(id, branch_id, status,                       -- draft|manager_approved|owner_approved|ordered|received|rejected
              created_by, manager_approved_by, manager_approved_at,
              owner_approved_by, owner_approved_at, rejected_by, reject_reason)
reorder_lines(list_id, item_id, supplier_id, suggested_qty, final_qty, est_unit_price)
```

### 12.3 POS
```
dining_tables(id, branch_id, label, seats, zone, sort_order, is_active,
              status)                                      -- free|seated|billing|dirty
menu_categories(id, branch_id, name, sort_order)
menu_items(id, branch_id, category_id, name, item_type,  -- unli_package|set_meal|add_on|drink|fee|raw_meat_takeout
           price, priced_per_person bool, available_from time, available_to time, is_active)
menu_item_price_history(menu_item_id, price, effective_from)
package_refill_items(package_id, item_id)                 -- which cuts/banchan each unli package allows
portion_rules(id, menu_item_id, item_id, qty, basis)      -- basis: per_unit|per_person|per_table
discount_types(id, branch_id, name, kind,                 -- percent|sc_pwd_vat_exempt|fixed_price
               value, requires_manager_pin, requires_id_record, is_active)
table_sessions(id, branch_id, business_date, table_ids uuid[], reservation_id null,
               opened_by, opened_at, timer_minutes, timer_ends_at,
               status,                                     -- open|billing|closed|voided
               closed_at, notes)
session_pax(session_id, discount_type_id null, menu_item_id, pax_count)  -- e.g. 3 Regular + 1 SC on Pork
order_lines(id, session_id, menu_item_id, qty, unit_price, discount_type_id, discount_amount,
            status, voided_by, void_reason, client_uuid unique, created_by, created_at)
refill_rounds(id, session_id, round_no, requested_by, requested_at, served_by, served_at,
              status, override_by null, client_uuid unique)
refill_lines(round_id, item_id, plates, grams_per_plate_at_time)
-- table_sessions also stores: refill_cutoff_at (= opened_at + timer − 45 min), sales_channel, overtime_minutes
kitchen_tickets(id, branch_id, session_id, source,          -- order|refill_round
                source_id, created_at, served_at, served_by, status) -- queued|partially_served|served|voided
bills(id, session_id, subtotal, discount_total, vat_amount, vat_exempt_sales, total,
      printed_count, finalized_at)                         -- no service charge in the MVP
payments(id, bill_id, method,                             -- cash|gcash|maya|card|bank
         amount, reference_no, tendered, change, received_by, at)
sc_pwd_records(id, bill_id, kind, id_number, full_name)   -- restricted access
cash_shifts(id, branch_id, terminal_id, cashier_id, opened_at, opening_float, closed_at, counted_cash, expected_cash, over_short)
invoices(id, branch_id, terminal_id, bill_id, invoice_no,  -- unique (terminal_id, invoice_no); never reused
         issued_at, vatable_sales, vat_amount, vat_exempt_sales, zero_rated_sales, discount_total, total,
         status,                                            -- issued|voided
         void_reason, voided_by, voided_at, reprint_count, manual_booklet_no null)
x_readings(id, shift_id, terminal_id, generated_at, totals jsonb)
z_readings(id, terminal_id, business_date, generated_at, first_invoice_no, last_invoice_no,
           gross_sales, vat_amount, vat_exempt_sales, discounts jsonb, voids_total,
           accumulated_grand_total_start, accumulated_grand_total_end, reset_counter)
```

### 12.4 Reservations and notifications
```
reservations(id, branch_id, code, customer_name, phone, email, party_size,
             reserved_for timestamptz, package_interest, notes, source,  -- web|phone|facebook|walk_in
             status,               -- pending|confirmed|declined|seated|completed|cancelled|no_show
             table_id null, session_id null, confirmed_by, confirmed_at, decline_reason,
             consent_privacy bool, consent_marketing bool, created_at)
reservation_slots_config(branch_id, weekday, open_time, close_time, slot_minutes, max_covers_per_slot)
message_templates(id, branch_id, channel, event, body)    -- sms|email × confirmed|reminder|declined
outbound_messages(id, branch_id, reservation_id, channel, to_address, body, status, provider_id, error, sent_at)
notifications(id, branch_id, target_role, target_user null, kind, title, body, ref_table, ref_id,
              read_by uuid[], created_at)
push_subscriptions(id, user_id, device_id, endpoint, keys jsonb)
```

### 12.5 Settings (per branch, `branches.settings` jsonb)
| Setting | Value | Status |
|---|---|---|
| `opening_time` / `closing_time` | 11:00 / 22:00 | ✅ |
| `lunch_window` / `unli_window` | 11:00–15:00 / 15:00–22:00, strictly enforced | ✅ |
| `unli_timer_minutes` | 120 | ✅ |
| `last_refill_cutoff_minutes_before_end` | 45 (refills close at 1 h 15 min) | ✅ |
| `max_meat_plates_per_round` | 3 per table; × number of tables for merged sessions | ✅ / ⚠️ 🔄 |
| `require_prev_round_served` | true | ✅ |
| `stuck_round_minutes` | 10 | ⚠️ |
| `max_unsynced_rounds_per_table` | 1 | ⚠️ |
| `late_sync_flag_minutes` | 10 | ⚠️ |
| `invoice_requires_online` | true (manual booklet when offline) | ⚠️ |
| `pin_max_attempts` / `pin_lockout_minutes` | 5 / 15 | ⚠️ |
| `default_grams_per_plate` (meat and side dishes) | 80 | ✅ |
| `leftover_fee` | ₱200 | ✅ |
| `overtime_fee_enabled` / amount | false / — | 🔄 |
| `last_unli_seating_time` | 20:00 | ⚠️ |
| `near_expiry_days_default` | per category (§5.1) | ⚠️ |
| `variance_threshold_pct` / `_abs` | 5% **and** 200 g · 200 ml · 2 pc (both must be exceeded) | ⚠️ |
| `leftover_fee_basis` | per table session | ⚠️ 🔄 |
| `reservation_slot_minutes` / `lead_minutes` / `max_online_party` | 30 / 120 / 16 | ⚠️ 🔄 |
| `reservation_seating_minutes` (unli / lunch) | 120 / 60 | ⚠️ |
| `online_capacity_pct` | 70% | ⚠️ 🔄 |
| `reservation_reminder_minutes` / `no_show_grace_minutes` | 180 / 15 (no reminder if confirmed < 210 min before) | ⚠️ |
| `vat_registered` | true | ✅ |
| `kitchen_ticket_amber_min` / `red_min` | 5 / 10 | ⚠️ |
| `monthly_sms_cap` | set by JD | 🔄 |

### 12.5b Added in v0.4
- `menu_items`: `show_on_website` bool, `public_description`, `photo_path`, `public_sort`.
- `promos`: `id, branch_id, title, description, terms, photo_path, starts_at, ends_at, days_of_week int[], start_time, end_time, discount_type_id (nullable), show_on_website, created_by, created_at`.
- Read-only views for the public site: `public_menu`, `public_promos` (no costs, no stock, no recipes).
- `reservations.promo_id` (nullable) — promo the customer booked with.
- `profiles.email` and invite status for personal logins; device registration records the device name and who registered it.
- Storage bucket `public-media` (menu and promo photos, public read, manager/owner write).

### 12.6 Ready for later phases (do not build, just don't block)
`customers` (CRM) can be linked from `reservations.phone`; `expenses`/`payables` can reference `deliveries` and `suppliers`; `sales_channel` column on `table_sessions` (walk_in | reservation | delivery) is included now with default derived from `reservation_id`.

---

## 13. Data import and setup

### 13.1 Two environments, two purposes ✅ (updated v0.4)
Two separate Supabase projects in Singapore:

| Environment | Who connects | Data | Purpose |
|---|---|---|---|
| **PROD** (existing project) | The live site only | **Taft** (first to go live) and **Ilocos Sur (Candon)** as separate branches: real staff, menu, prices, stock, sales. No demo data | Live operations |
| **TEST** (new free project) | Developer laptop, Vercel preview builds | Demo branches (fake staff and stock) + Taft history import | Building, testing, checking data accuracy before changes reach PROD |

- *(Superseded Nov 25 — Taft now goes on PROD, §15.8.)* **Taft pilot:** Taft is operating now, so it uses the system on **TEST** with its **own staff, menu and prices** before it moves to PROD. Because TEST then holds real Taft data:
  - TEST is never wiped or reseeded without the owner's OK; the demo data lives in its own branch, and branch isolation keeps it apart from Taft.
  - Database changes are applied to TEST **after closing time** and only after the automated tests pass; then to PROD.
  - Free projects have no backups: a **nightly export** of Taft's data is kept until Taft moves to PROD.
  - **Moving to PROD:** start Taft fresh on PROD (staff, menu, opening stock count); TEST keeps the pilot history for comparison.
- Demo mode (in-browser database) is **removed** from the live site, previews and the developer laptop. It stays only inside the automated tests.
- Database changes always go TEST → tests pass → PROD.

### 13.2 Import from `GB_KYLA_.xlsx` (Taft inventory, Jan 2 – Oct 29, 2026, ~250 daily sheets)
- **Item master:** from the `INVENTORY SHEET` template (≈130 items) with section → category mapping; assign stage, base unit and count unit per item (grams for weighed items; PCS/PACK/bottle for counted items).
- **Daily history:** each dated sheet → one `stock_counts` (closing) + derived movements: `opening_balance` on day 1, `delivery_in` from NEW DELIVERY, `production_in` from NEW PREP/MARINATED/NEW PRODUCE, `waste` from WASTE (where present), and a computed `usage_import` movement so the ledger reconciles to CLOSING (this type exists only for the staging import; production usage comes from sale/refill movements).
- **Prices:** `Sheet4` (October purchase dates and price/kg for Pork Belly, Pork Shoulder, Beef Shortplate, Chicken LQ; kg purchased only for the two pork cuts so far) → historical deliveries with unit costs, used to validate simple vs weighted averages.
- **Prep standards:** the "STANDARD PER BATCH" block → seed prep recipes.
- **Cleaning rules:** parse dates from sheet names tolerantly (`JUNE 2O`, `0CT 24`, `MAR28`, `SEPT9`); skip `CLOSED` days; ignore whitespace/blank rows; re-key duplicate item names by section; recompute usage instead of trusting cell formulas; flag rows where closing > opening + in (possible missing delivery entry).

### 13.3 Import from `2026 DAILY SALES SUMMARY.xlsx` (Taft sales)
- **Menu & discounts:** price row (row 6) of each daily sheet → `menu_items`, `discount_types` with `menu_item_price_history` so January prices (₱549, Happy Hour ₱499) and October prices (₱649) are both correct.
- **Daily sales:** each table row (time, table #, customer no., pax, counts per pax type and add-on) → historical `table_sessions` + `session_pax` + `order_lines` (no refill data exists historically ✅).
- **Payments:** payment summary block (Cash / GCash / PayMaya / Credit Card) → daily payment totals. Note the Credit Card column uses outdated prices — recompute from the current price list and flag differences.
- **Expenses** (monthly `… EXPENSES` sheets: particulars, supplier/address, voucher #, payment type, category Ingredients/Meal Allowance/LPG/Supplies/ETC, VAT, OR #, sales invoice): **not imported into the MVP**, but useful now to **seed the Taft supplier list** and later for Phase 3 accounting.

### 13.4 Ilocos Sur production setup checklist (with JD)
1. Branch record, operating hours, tables (labels, seats), settings.
2. Users and roles; PINs; device registration; install PWA on each device.
3. Item master (reuse Taft structure, adjusted), reorder/par levels, expiry flags.
4. Menu, prices, discount types, package → allowed cuts, **portion rules** (grams per plate per cut, banchan set per head, lunch set recipes), prep recipes and yields.
5. Suppliers and starting prices.
6. **Opening stock count** (becomes `opening_balance` batches with cost and expiry).
7. Reservation slots, message templates, Semaphore sender name, branch inbox.
8. **BIR:** registered business details on the invoice header, POS terminal record(s) with BIR permit details, invoice numbering start, manual invoice booklet as fallback until the permit is approved.
9. Kitchen/Dispatch device(s), cashier printer, language per user.
10. Starting reorder/par/low-alert levels from Appendix A, scaled for Candon.

---

## 14. Testing, launch plan and timeline

### 14.1 Must-pass tests before opening
- **Deduction correctness:** scripted service (e.g. 20 tables, mixed packages, 3–6 refill rounds each, sets and drinks) → stock movements equal the expected grams exactly.
- **Plate limit and round rule:** cannot exceed limit; override requires manager PIN and is audited.
- **Offline:** airplane-mode a server phone for 20 minutes during a simulated service; all actions sync once, none duplicated (idempotency), none lost. The phone allows only one unsynced refill round per table; a round rejected on sync appears in the manager's conflict list. Set a device clock 30 minutes wrong and confirm time rules still use the corrected time.
- **Idempotency:** resend the same refill, order, delivery and payment 3 times each → exactly one action and one set of movements (including FIFO batch splits).
- **Staff PINs:** 5 wrong PINs lock the user on that device; no API response or local storage contains a PIN hash; a revoked device can no longer call any RPC.
- **Concurrency:** two servers refill the same table at the same moment → second is rejected or queued by the round rule.
- **Variance:** closing count with deliberate differences → correct variance qty, %, ₱ value; reason required above threshold.
- **Averages:** reproduce Taft October pork belly simple and weighted averages from `Sheet4` exactly.
- **Branch isolation:** an Ilocos test user cannot read, list, or infer any Taft row via UI, API, Realtime or reports ✅.
- **Reservations:** booking → push + sound + email to staff within 10 seconds; confirm → SMS/email delivered; reminder fires at the configured time.
- **Expiry:** batches expiring within threshold appear in the list and the daily digest.
- **PWA:** installs on Android Chrome and iPad/iPhone; works after reload with no internet; wake lock keeps POS on.
- **Kitchen/Dispatch screen:** a refill tapped on a server phone appears on the kitchen screen within 2 seconds with a chime; marking Served unlocks the next round.
- **Time rules:** lunch sets cannot be ordered at 3:00 PM or later; unli cannot be opened before 3:00 PM; refills are blocked 45 min before the 2-hour limit; overrides need manager PIN and are audited.
- **Sales invoice:** invoice numbers are sequential with no gaps; with the cashier device offline, the POS refuses to issue an official invoice and records the manual booklet number instead; only the registered terminal can call `issue_invoice`; voids keep their number, reprints are marked, Z-reading totals equal the sum of invoices and the accumulated grand total never decreases; SC/PWD computation matches the formula to the centavo.
- **Reorder approval:** a list approved only by the manager cannot be marked ordered; JD's approval releases it.

### 14.2 Dry run ✅
In the last week before opening, run a **full dry-run service day** on the Ilocos setup (deliveries, prep, table service with refills, billing, waste, closing count, reports), then **delete all test records** and re-enter the real opening count.

### 14.3 Timeline to the December opening (≈5 weeks, one developer) ⚠️
| Week | Dates (2026) | Developer deliverables | JD / business actions (parallel) |
|---|---|---|---|
| 0 | Oct 31 – Nov 4 | Repo, Supabase project, auth, roles, branches, RLS skeleton, PWA shell, i18n setup, item master CRUD | **Start BIR POS registration with the accountant**; buy domain; create Semaphore account + sender name; create accounts under JD's business email |
| 1 | Nov 5 – Nov 11 | Deliveries + batches, prep runs, waste, live stock, counts + variance, low-stock & expiry alerts; Taft import scripts (test copy) | Decide packages → cuts/side dishes; table count and labels |
| 2 | Nov 12 – Nov 18 | POS: tables, sessions, timer + refill cutoff, time windows, pax/discounts, refill rounds + limits, order lines, deductions, **Kitchen/Dispatch screen**, offline outbox | Buy and deliver test devices; choose cashier printer |
| 3 | Nov 19 – Nov 25 | Billing & payments, **sales invoice + X/Z readings**, cashier shift/day close, printer test; reservations (public page, alerts, confirm, Semaphore SMS/email, reminders) | Confirm final prices; reservation rules |
| 4 | Nov 26 – Dec 1 | Reports + owner dashboard, supplier directory + reorder list with dual approval; full test suite; Ilocos setup with JD; staff training; Tagalog/Ilocano labels; **dry run** | Opening stock count; supplier list and prices |
| Launch | Dec 1 – Dec 7 | Go live; developer on-site/on-call during first services (hypercare); daily check of variances, invoice sequence and sync errors | Manual invoice booklet ready if BIR permit is not yet approved |

**If behind schedule, cut in this order (latest first):** refill analytics → Tagalog/Ilocano labels (English only at launch) → theoretical food cost on dashboard → weekly Google Drive CSV export (Supabase daily backups remain) → receipt photos → reorder message generator (keep list + dual approval).

**Schedule risk ⚠️:** 5 weeks is tight for one developer. v0.3 removes the two riskiest pieces of offline work (offline invoice numbering and unlimited offline refill rounds); keep those out of scope even if time frees up. **Never cut:** sale/refill deductions, kitchen/dispatch screen, counts + variance, expiry alerts, branch isolation, reservation alerts + confirmations, offline POS, BIR-safe invoice handling (official invoice or manual-booklet fallback).

---

### 14.4 Go-live readiness — status on Nov 25, 2026 ❗
**The live site is not ready for real use.** It still runs in **demo mode**: each browser keeps its own private copy of the data, so phones, the counter and the kitchen do not share orders, and nothing reaches the owner. There are no real logins.

| Area | Status |
|---|---|
| Business rules (POS, refills, inventory, reservations, time clock) | Built in the database; 26 automated tests pass in the in-browser test database |
| Live site performance | Loads in about 5 s on first visit; the demo database adds about 15 MB of downloads. Removing demo mode cuts the download to under 1 MB |
| Shared database for every device | ❌ Not connected — PROD has the tables but the site does not use it |
| TEST project | ❌ Not created |
| Real logins (invites, device registration, staff PINs, Setup screens for people and devices) | ❌ Not built |
| Role checks on dashboard and reports in the database | ❌ Gap (§3.1) |
| Setup screens for menu, prices, promos, portions, recipes, discounts, templates | Partly built |
| Public menu and promos (§7.5) | Phase 2 — not in MVP |
| Email (Resend + domain), SMS, web push | ❌ Not connected; push not wired on phones |
| Thermal printer test | ❌ No printer chosen |
| Tested end-to-end on Supabase (Realtime, cron, grants) | ❌ Not yet |
| Supabase Pro on PROD (no pausing, daily backups) | ❌ Free plan |

**Build order:** (1) TEST project + migrations + tests on it; (2) accounts: invites, device registration, staff/PIN setup, role checks; (3) remaining Setup screens incl. menu & promos; (4) remove demo mode, connect laptop to TEST; (5) Vercel: live site → PROD, previews → TEST; (6) public menu/promos page; (7) Taft pilot on TEST; (8) Candon setup on PROD, dry run, Pro upgrade, go live.

## 15. Decisions and open items (initial answers — all to be re-confirmed during building and testing)

### 15.1 Initial answers received (v0.2)
| # | Topic | Answer | Status | Spec |
|---|---|---|---|---|
| 1 | BIR / VAT | Ilocos branch will be VAT-registered; POS prints official sales invoices | ✅ (registration timing 🔄) | §6.7 |
| 2 | Kitchen slips / printer | No kitchen slips — kitchen/dispatch use their own phone/tablet; printer model undecided | ✅ / 🔄 | §6.5, §6.7 |
| 3 | Discounts | All Taft discounts carry over **except Solo Diner rate**; prices still proposed | ✅ / 🔄 | §6.1, §6.2 |
| 4 | Grams per plate | 80 g for every meat cut and every side-dish plate; cuts/side dishes per package still open | ✅ / 🔄 | §6.4 |
| 5 | Side-dish refill | 80 g per side-dish refill plate; initial banchan/rice set still open | ✅ / 🔄 | §6.4 |
| 6 | Rounds | Wait until previous round is served; limit 3 plates | ✅ | §6.4 |
| 7 | Time limit | Leftover fee ₱200; last-refill cutoff 45 min before the 2-hour limit; overtime charge open | ✅ / 🔄 | §6.3 |
| 8 | Time windows | No unli before 3 PM, no lunch sets after 3 PM | ✅ | §6.1 |
| 10 | Expiry | Fresh meats and vegetables are also priority for expiry alerts | ✅ | §5.1 |
| 11 | Yields & batch standards | Adjust during testing | 🔄 | §5.3 |
| 12 | Reorder / par levels | Developer to propose starting values | ✅ (Appendix A) | App. A |
| 13 | Reorder approval | Branch manager and JD — manager approval only counts together with JD's | ✅ | §5.10 |
| 14 | Hours | 11 AM – 10 PM | ✅ | §7.1 |
| 15 | SMS / email | Paid PH gateway OK (Semaphore); branch email for backup alerts | ✅ | §7.3 |
| 16 | Stack | React + Supabase PWA; ignore Streamlit prototype | ✅ | §9.1 |
| 17 | Internet | Fiber | ✅ | §3, §10 |
| 18 | Budget & ownership | ₱30k covers development + hosting/SMS; JD's business email owns domain, Supabase, Semaphore | ✅ | §9.1 |
| 19 | Domain | Own domain (.ph or .com) | ✅ (name 🔄) | §9.1 |
| 20 | Language | English default; Tagalog/Ilocano labels for staff | ✅ | §9.5 |

Numbers follow *QUESTIONS_TO_CONFIRM*. **#9 has no row here** — check whether it was skipped in the questionnaire or its answer is missing (§15.2 item 14).

### 15.2 Still open (confirm during building and testing)
1. ❗ **BIR registration timing** — when will the POS permit be filed/approved? Exact invoice fields per the accountant/RDO. Until approved, use the manual-booklet fallback (§6.7).
2. **Cashier thermal printer** brand, model and connection; cashier device type (laptop, mini-PC, tablet).
3. **Final prices** (Pork ₱499 / Beef+Pork ₱599 / Bowl ₱149 / Bento ₱270 / Solo Set ₱350 are proposals) and rules for Kids (age/height), Athlete and Birthday proof.
4. **Meat cuts and side dishes per package** (Pork vs Beef+Pork).
5. **Initial banchan and rice set** per head or per table; whether side-dish refills count toward the 3-plate limit (default: separate ⚠️).
6. **Overtime charge** after 2 hours (amount and rule); **last unli seating** time (default 8:00 PM ⚠️).
7. **Number of tables, labels and seats** at Candon.
8. **Prep yields** and batch standards (adjusted during testing).
9. **Reservation rules:** slot length, max covers per slot, max online party size, lead time, deposit for big groups.
10. **Monthly SMS cap**, branch email address, final **domain name**.
11. **Number of devices** (phones, tablets, laptops) per role; whether devices/printer/BIR fees are outside the ₱30k budget.
12. **Data retention** for customer contacts and SC/PWD records.
13. Who approves reorders when JD is unreachable (e.g. travel)? Default: nothing is ordered without JD ⚠️.
14. **Question #9** in *QUESTIONS_TO_CONFIRM* — missing from §15.1.

**Added in v0.3 — developer defaults for JD (and the accountant where noted) to confirm:**

15. **Invoices online only** — during an internet outage the cashier uses the manual booklet (§6.7). Accountant: is the booklet allowed for outages after the POS permit is approved?
16. **Offline refills** — at most one unsynced round per table (§6.4).
17. **Plate limit for merged tables** — 3 × number of tables, or scale with pax? (§6.4)
18. **One unli package per table session** — or must mixed Pork / Beef + Pork tables be supported? (§6.1)
19. **Discount and VAT calculation order, no stacking, per-line rounding** — accountant to confirm (§6.2).
20. **Leftover fee** — per table or per person; VATable? (§6.7)
21. **Online reservation capacity** — 70% of seats held for online bookings; seating length 120 min unli / 60 min lunch (§7.1).
22. **Budget period** — how many months of Supabase, domain and SMS the ₱30,000 covers, and who pays after (§9.1).
23. **Shared-device sign-in** — device accounts + server-verified PINs, 5-attempt lockout (§11.1).

---

### 15.3 Answers received (v0.4, Nov 4 – Nov 25, 2026)
| # | Topic | Answer | Status | Spec |
|---|---|---|---|---|
| 24 | Email provider | Resend free plan | ✅ | §9.1 |
| 25 | BIR at launch | Not yet decided by JD; POS starts as internal sales tracker, manual booklet for official invoices, accountant keeps BIR records | ✅ (registration 🔄) | §6.7 |
| 26 | Taft | Pilot on TEST with its own staff and prices; moves to PROD after checking | ✅ | §13.1 |
| 27 | Prices | Unli Pork ₱499, Beef + Pork ₱599; lunch Bowl ₱149, Bento ₱270, Solo Set ₱350 — final for now, editable later | ✅ | §6.1 |
| 28 | Staff screens | Staff only see their role's screens; never the owner dashboard | ✅ | §3.1 |
| 29 | Menu & promos | Customers see menu and promos on the booking page — in the MVP | ✅ | §7.5 |
| 30 | Environments | PROD for real data, TEST for laptop and testing; demo mode removed | ✅ | §13.1 |

### 15.4 Everything still needed before production (consolidated)
Items from §15.2 that are now answered are left out. ❗ = blocks go-live.

**Accounts and access**
1. ❗ Email for **JD's owner login** (his business email) and for the **admin** login. Invites are sent only after these are confirmed.
2. ❗ **Candon opening team:** names and roles (server, cashier, kitchen, manager). PINs are set by the manager in the app, never sent to the developer.
3. ❗ **Taft pilot team:** names and roles, and who the Taft manager is.
4. Should the branch manager see **food cost and profit** on their branch dashboard? (default: yes, own branch only ⚠️)
5. Who approves reorders when JD is unreachable? (default: nothing is ordered without JD ⚠️)

**Business and BIR**
6. ❗ Accountant: wording on the non-official slip, and whether internal computerized sales tracking must be reported to the RDO.
7. Registered business name, address and VAT REG TIN with branch code (for slips now, invoices later).
8. Will JD register the POS with BIR later, and when? (decides when invoice printing is switched on)

**Menu, POS rules and promos**
9. ❗ **Taft menu and prices** (they differ from Candon).
10. ❗ Add-on and drink list with prices; menu photos and short descriptions for the website.
11. Promos to show at launch (title, dates, terms, photo).
12. Meat cuts and side dishes per package; initial banchan and rice set; whether side-dish refills count toward the 3-plate limit.
13. Kids (age/height), Athlete and Birthday rules and proof.
14. Overtime charge after 2 hours; last unli seating (default 8:00 PM ⚠️).
15. Plate limit for merged tables; one unli package per table or mixed packages.
16. Leftover fee per table or per person.
17. ❗ Number of tables, labels and seats at Candon (and Taft).

**Reservations and messages**
18. ❗ **Domain name** (needed for Resend to email customers) and the branch email address.
19. SMS at launch or email only? If SMS: Semaphore account, sender name, monthly cap.
20. Reservation rules: slot length, online capacity (default 70% ⚠️), max online party, lead time, deposits for big groups.

**Hardware and hosting**
21. ❗ Cashier device and **thermal printer** model (80 mm, ESC/POS); number of phones and tablets per role.
22. ❗ When to upgrade PROD to **Supabase Pro** (about US$25/month; free projects pause and have no backups). Recommended: before the dry run.
23. Budget period — how many months of hosting, domain and SMS the ₱30,000 covers, and who pays after.

**Data**
24. Data retention for customer contacts and SC/PWD records (default: anonymise after 12 months ⚠️).
25. Opening stock count date for Candon; Taft opening count for the pilot.
26. Prep yields and batch standards (tuned during the Taft pilot).
27. Question #9 in *QUESTIONS_TO_CONFIRM* — still missing.

### 15.5 Answers received (v0.5, Nov 25, 2026) — these override earlier sections
**Accounts and ownership**
| Topic | Answer |
|---|---|
| Admin / developer | Kyla owns Vercel and Supabase (keiii.businessacc3@gmail.com) and GitHub (kylarose.ba@gmail.com); JD is added as collaborator/editor. Replaces "all accounts under JD" (§9.1). ⚠️ Vercel Hobby is for non-commercial use — production hosting plan to confirm (§15.6). |
| JD | Signs up for **Resend** and **Semaphore** himself; GitHub collaborator as johndizonbusiness@gmail.com. His owner login email for the app: to confirm (§15.6). |
| Domain | **goldenkoreanbbq.com** (available as of Nov 25). Booking site at the root, staff app at `app.goldenkoreanbbq.com`, email from `@goldenkoreanbbq.com`. |
| Candon staff | Not hired yet — added later by the manager in Setup (name, role, PIN). Planned team: 2 kitchen, 1 dishwasher, 1 dispatch, 1 cashier, 4 servers (9). |
| Taft pilot staff | Jessie Dayawon (Head Chef / Kitchen Head), Robin (Server / Dispatch), Norjay Magboo (Kitchen), Mary Rose Guevarra (Dispatch), Annalyn Roxas (Assistant Restaurant Manager / Cashier), Jenny (Server), Elbe (Server), JD / Zion (Manager / Owner). |
| Roles needed | One person may hold **more than one role** in a branch (e.g. Robin server + dispatch, Annalyn cashier + assistant manager). New roles: **Dispatch** (separate from Kitchen) and **Utility** (dishwasher: time clock only). |
| Manager sees food cost/profit | ✅ Yes, own branch. |
| Reorder approval | ✅ The branch manager may give the **final approval** when JD is away. Default design ⚠️: JD switches on "Managers can approve alone" while away (or it applies automatically if JD has not acted within a set time); JD is notified of every manager-only approval. |

**BIR and receipts**
| Topic | Answer |
|---|---|
| BIR | ✅ JD will **not** register the POS. Internal sales tracking only. Invoice numbering, X/Z "BIR" wording and booklet number entry are switched off; the booklet field becomes an optional "Official receipt no. (manual)" for matching. |
| Business details | To follow (not printed on the unofficial receipt anyway). |
| Unofficial receipt | Proposed layout below. Must **not** look like a BIR invoice: no "Sales Invoice"/"Official Receipt" title, no TIN, no VATable / VAT-exempt / VAT amount breakdown, no serial, permit, MIN or accreditation numbers, no accumulated grand total. |

```
        GOLDEN KOREAN BBQ – CANDON
     Unli Korean Grill · FB: @goldenkbbq
------------------------------------------
            ORDER SUMMARY
     *** NOT AN OFFICIAL RECEIPT ***
------------------------------------------
Bill #: C-000123      Table: T7
Date: 11/25/26  7:42 PM   Pax: 4
Server: Ben           Cashier: Carlo
------------------------------------------
Unli Beef + Pork  x4 @599      2,396.00
Soft drinks       x2 @60         120.00
Leftover fee (table)             200.00
------------------------------------------
Subtotal                       2,716.00
SC/PWD discount (1 pax)         -171.14
TOTAL                        ₱ 2,544.86
GCash  ref 1234                2,544.86
------------------------------------------
   Please ask for your official receipt
       Thank you! Book: goldenkoreanbbq.com
     *** NOT AN OFFICIAL RECEIPT ***
```
(Sample numbers only: 4 pax at ₱599, one of them SC/PWD at ₱599 ÷ 1.12 × 0.80 = ₱427.86.)

**Shift report** — match Taft's current printout: shift number, branch, terminal, opened/closed by and time; **cash drawer** (starting cash, cash payments, cash refunds, paid in, paid out, expected cash, actual cash, difference); **sales summary** (gross sales, refunds, discounts, net sales, totals per payment method, VAT included for internal reference). Printed on the 80 mm printer at shift close; internal use only.

**Menu and prices**
| Branch | Item | Price |
|---|---|---|
| Candon | Unli Pork | ₱499 / head; **Solo diner ₱599** |
| Candon | Unli Beef + Pork | ₱599 / head; **Solo diner ₱699** |
| Candon | Bowl / Bento / Solo Set (lunch) | ₱149 / ₱270 / ₱350 |
| Taft | Unli Korean Grill (pork + beef) | ₱649 / head, minimum 2; **Solo diner ₱749** |
| Taft | Solo Set (150 g chosen meat + kimchi, fishcake, potato marble, leek salad, meatballs, kimchi soup, lettuce, steamed egg, 3 sauce dips) | ₱350 |
| Taft | Bento Set (150 g chosen meat + kimchi, fishcake, meatballs, kimchi soup, rice, 2 sauce dips) | ₱270 |
| Taft | Add-ons: 1 kg Kimchi ₱200 · 500 g Meat ₱300 · Steamed Egg ₱60 · Soft drinks ₱60 | |
| Taft | Free ice cream upon billing out (₱0 line, deducts stock) | free |

- **Taft side dishes:** Kimchi, Potato Marble, Chicken Poppers, Japchae, Korean Salad, Salad, Meatballs, Kimchi Soup, Radish, Fishcake, Lettuce, Cheese, Steamed Egg. **Taft meats:** Samgyupsal, Yangyum Samgyupsal, Woo Samgyupsal, Yangyum Woo Samgyupsal (the two "Woo" cuts are beef). Taft days: Monday–Saturday, 11:00 AM–11:00 PM.
- **Packages:** every meat cut and side dish is included in both Pork and Beef + Pork (Beef + Pork adds the beef cuts). Initial banchan and rice scale with the number of pax. **Side-dish refills are unlimited** and do not count toward the plate limit.
- **Portions (deduction per plate):** meat with sauce 120 g, meat without sauce 80 g, side dishes 50 g.

**Discounts (rules shared by both branches, each at its own prices)**
| Type | Rule | Taft price |
|---|---|---|
| Senior / PWD | VAT-exempt formula (price ÷ 1.12 × 0.80) | ₱463.57; solo ₱535 |
| Kids | Under 3 ft free; 3 ft to under 4 ft half price; 4 ft and above full price | free / ₱324.50 / ₱649 |
| Birthday | 50% off the celebrant with 3 full-paying adults; **free** with 7 full-paying adults. Once during birth month, valid ID, not combinable | see §15.6 (₱454.30 conflict) |
| Solo diner | One guest at an unli table pays the solo rate | ₱749 |

**Service rules**
| Topic | Answer |
|---|---|
| Overtime | ₱200 per table after the 2-hour limit |
| Leftover fee | ₱200 per table |
| Last seating | Taft 9:30 PM; Candon 8:30 PM |
| Merged tables | 3 meat plates per round **per table** joined (2 tables → 6) |
| Packages per table | One offer per table session (no mixing Pork and Beef + Pork) |
| Tables | **Candon:** 21 tables, 108 seats — 9 × 4-seaters, 12 × 6-seaters. **Taft:** 20 tables, 88 seats — 16 × 4-seaters, 4 × 6-seaters. Labels T1… by default |

**Reservations and messages**
| Topic | Answer |
|---|---|
| Channels | Email (Resend) **and** SMS (Semaphore, paid by JD) |
| Online share | 50% of seats per slot (Candon 54, Taft 44) |
| Max online party | 50 pax (limited in practice by the 50% share at each branch) |
| Lead time | At least 3 hours before the booking |
| Big groups | 10 pax and above pay a **₱1,000 reservation fee**. MVP design ⚠️: the customer pays by GCash/bank and enters the reference number on the form; staff check it before confirming; the fee is recorded as a deposit and deducted on the bill (or kept on no-show — rule in §15.6). No online card payments |
| Booking windows | Lunch 11 AM – 3 PM; Unli 11 AM – 9 PM |
| Menu & promos online | **Phase 2** (§7.5) |

**Hardware**
| Topic | Answer |
|---|---|
| Printer | **Poseidon 80 mm thermal**, USB + Bluetooth |
| Cashier device | Tablet |
| Devices (Candon) | 3 tablets, 3 phones. Suggested: tablets for cashier, kitchen, dispatch; phones for servers (4 servers share 3 phones via PIN) |

**Kitchen vs Dispatch (proposal ⚠️, answers JD's question)** — two stations, two screens:
- **Dispatch** (prepares and plates): raw meat refill plates, side-dish refills, initial banchan and rice, lettuce, sauces, drinks, ice cream.
- **Kitchen** (cooks): cooked items such as steamed egg, kimchi soup, bento and solo-set cooking, and batch prep (marinating, side-dish cooking) through the Prep screen.
- Each menu item and refill item has a **station** setting. A round or order with items for both stations shows its own lines on each screen. The next refill round unlocks when the **meat lines** are marked served.
- Branches with one combined area can point both stations to one screen.

**Data:** contact retention — default accepted (anonymise after 12 months). Opening stock counts — not scheduled yet. Supabase Pro and budget period — not decided.

### 15.6 New questions from the v0.5 answers
1. **Birthday price:** ₱454.30 is 30% off ₱649, but the promo says 50% off (₱324.50). Which is right? And is it valid on the **birthday date** or any day in the **birth month**?
2. **Unli before 3 PM:** booking windows say Unli 11 AM – 9 PM and Taft serves unli from 11 AM. Is the old rule "no unli before 3 PM" (§6.1) dropped? Does it differ between Taft and Candon?
3. **Last booking vs last seating:** unli bookings until 9 PM, but Candon's last seating is 8:30 PM. Is Candon's last unli booking 8:30 PM?
4. **Candon hours** (the answer was cut off: "since Candon …"). Still 11 AM – 10 PM daily? Is Taft closed on Sundays?
5. **Athlete discount** — still used? Rule and proof?
6. **"For Taft – follow the price for Candon"** — does this mean Candon uses the same discount rules with its own prices (e.g. SC/PWD ₱356.43 on ₱499)?
7. **Kids 3–4 ft:** half price, as above?
8. **Reservation fee:** refundable? Deducted from the bill or kept? Kept on no-show? How do customers pay (GCash number)?
9. **Annalyn Roxas** — manager rights (approvals, overrides) or cashier only? **JD / Zion** — one person or two?
10. **JD's owner login email** for the app (johndizonbusiness@gmail.com?).
11. **Tablet model** (Android or iPad). Android + USB cable to the Poseidon printer is the most reliable browser setup; Bluetooth printing from a browser needs a helper app.
12. **Production hosting:** Vercel Pro (about US$20/month) or Cloudflare Pages (free, commercial use allowed).
13. **Taft during the pilot:** does Taft keep its current POS in parallel, or switch fully to this system? (Running both doubles the cashier's work.)
14. **Beef cuts at Candon** — names of the beef cuts in Beef + Pork.

### 15.7 Answers received (v0.6, Nov 25, 2026) — these override §15.5 and earlier sections
| # | Topic | Answer |
|---|---|---|
| 1 | Birthday | **50% off the celebrant (₱324.50 at Taft, ₱249.50 / ₱299.50 at Candon)** with 3 full-paying adults; **free** with 7. Valid **once, any day in the birth month**, valid ID, not combinable. |
| 2 | Time windows | "No unli before 3 PM" is **dropped**. Unli is available from opening (11 AM) until last seating. **Lunch sets 11 AM – 3 PM only**, never after 3 PM. Same at both branches. ⚠️ Taft's Bento and Solo Set follow the lunch window. |
| 3 | Last unli booking / seating | **Candon 8:30 PM**; Taft last seating 9:30 PM (online unli bookings until 9:00 PM). |
| 4 | Hours | **Candon 11 AM – 10 PM daily. Taft 11 AM – 11 PM, Monday – Saturday, closed Sundays** (no bookings on Sundays). |
| 5 | Athlete | **20% off**. ⚠️ Default: valid athlete/team ID, not combinable with other discounts. |
| 6 | Discount rules per branch | Same rules at both branches, each at its own prices (e.g. Candon SC/PWD ₱356.43 on ₱499). |
| 7 | Kids | Under 3 ft **free**; 3 ft to under 4 ft **half price**; 4 ft and above **regular price**. |
| 8 | Reservation fee (10+ pax) | ₱1,000 paid to **JD's GCash number** (entered in Setup, shown on the booking form). **Deducted from the bill. Non-refundable; kept on no-show or cancellation.** |
| 9 | People | **Annalyn Roxas: cashier only** (no manager powers). **Zion: JD's older sister** — role to confirm (§15.8). **JD: Owner and manager of both branches.** |
| 10 | JD's app login | **johndizonbusiness@gmail.com** (Owner, both branches). |
| 11 | Tablets | **Android.** Cashier tablet prints to the Poseidon by **USB cable** (OTG adapter); Bluetooth only as a backup with a print-helper app. |
| 12 | Hosting | **Vercel Pro** (about US$20 per paid member per month; verify current pricing). |
| 13 | Taft pilot | **Switches fully** to this system (no parallel POS). See §15.8 — this makes Taft's data live business records. |
| 14 | Beef cuts | Same as Taft: **Woo Samgyupsal** and **Yangyum Woo Samgyupsal** (beef); pork: **Samgyupsal** and **Yangyum Samgyupsal**. Candon Pork package = the 2 pork cuts; Beef + Pork = all 4. |

### 15.8 Still open after v0.6
1. ✅ **Taft lives on PROD** (decided Nov 25) as its own branch, kept apart from Candon by branch isolation. **TEST is for testing only** (demo data, developer laptop, previews). Supabase **Pro must be on before Taft goes live**. This replaces the Taft-pilot-on-TEST rows in §13.1.
2. **Zion's role** — does she need a login, and as what (manager at Taft, owner view, none)?
3. **Taft go-live date** and Taft opening stock count date.
4. Supabase Pro timing; budget period (§15.4 #22–23).
5. Business details for the receipt header (optional) and JD's GCash number (entered in Setup, not sent to the developer).

## 16. Glossary

| Term | Meaning |
|---|---|
| Samgyupsal | Sliced pork belly for grilling |
| Daepae | Thin-sliced pork (Taft "DAEPAE") |
| Moksal | Pork neck/shoulder cut |
| Y-Sam / Y-Woo | Yangnyeom (marinated) samgyupsal / marinated beef (*woo* = beef) |
| Banchan | Korean side dishes served with the meal |
| Pax | Number of persons at a table |
| Round | One refill submission for a table |
| Plate | One serving of a meat cut (default 80 g) |
| SC / PWD | Senior Citizen / Person With Disability (VAT-exempt + 20% discount) |
| Business date | Operating day a record belongs to (cutoff 04:00 by default) |
| Variance | Counted stock − expected stock |
| Weighted average cost | Total spent ÷ total quantity bought in the period |
| Kitchen/Dispatch screen | Tablet/phone screen that receives new orders and refill rounds instantly (replaces paper slips) |
| Refill cutoff | Time after which no more refills are allowed (45 min before the 2-hour limit) |
| VAT REG TIN | The VAT-registered Taxpayer Identification Number printed on invoices |
| PTU | BIR Permit to Use for a POS/cash register machine |
| X-reading / Z-reading | Per-shift / end-of-day sales reports required for BIR-registered POS |
| Accumulated grand total | Running total of all sales on a terminal that never resets |
| Simple average cost | Average of the unit prices paid, ignoring quantity |
| PWA | Progressive Web App — a website that installs like an app and works offline |
| RLS | Row Level Security — database rules that limit rows by user/branch |

---

## 17. Source documents
- *Proposed Centralized Restaurant Management System (Updated)* — pain points, MVP scope, flows, JD's answers to open items (Oct 29–30, 2026).
- *Golden Korean BBQ — Brand & Restaurant Concept Proposal* — menu, hours, prices (proposed), brand palette, seating.
- *2026 Daily Sales Summary* (Taft) — pax types, discounts, add-ons, payment methods, expenses.
- *GB_KYLA_* (Taft inventory) — item list, categories, daily opening/delivery/closing/usage/waste, prep standards, October purchase prices.
- Golden Korean BBQ logo (gold wordmark on black, 골든 Korean lettering).
- *QUESTIONS_TO_CONFIRM* — JD's initial answers to the open questions (v0.2).

---

## Appendix A — Proposed starting stock levels (from Taft data) ✅ proposed / 🔄 tune at Candon

**Source:** `GB_KYLA_.xlsx`, Taft daily sheets **Aug 1 – Oct 29, 2026** (≈76 operating days). Daily usage per item = opening + new delivery/prep − closing.

**How to use these numbers**
- These are **Taft (Manila) volumes**. Before go-live, multiply by a **Candon volume factor** = expected Candon pax ÷ Taft pax (e.g. 0.6 if Candon expects 60% of Taft's guests) ⚠️. JD sets the factor; the system stores the scaled values.
- After the **first 2 weeks** of Ilocos data, the system recalculates the same figures from Candon's own usage and suggests updates (Manager reviews, JD approves).
- Days of cover assume deliveries are available within 1–2 days. If a supplier delivers less often (e.g. frozen meat shipped from Manila), raise the levels for that item.

### A.1 Purchased items — reorder level and par level
Reorder level = **3 days** of average usage (an alert to order). Par level = **7 days** (order up to this amount). Both are **rounded up** to the next 0.5 kg (10 pcs for eggs) — never down, so the alert never comes later than 3 days of cover. *(v0.3: Beef Shortplate, Onion Leeks, White Onion, Carrots, Cabbage and Eggs corrected; v0.2 had rounded some of them down.)*

| Item | Avg daily use (Taft) | Reorder level | Par level |
|---|---|---|---|
| Pork Belly (frozen) | 5.0 kg | 15 kg | 35 kg |
| Pork Shoulder (frozen) | 3.8 kg | 11.5 kg | 27 kg |
| Beef Shortplate (frozen) | 5.2 kg | 16 kg | 36.5 kg |
| Chicken (frozen) | 0.8 kg | 2.5 kg | 6 kg |
| Rice | 5.1 kg | 15.5 kg | 36 kg |
| Kimchi (1 kg packs, raw stock) | 2.0 kg | 6 kg | 14 kg |
| Lettuce | 1.0 kg | 3 kg | 7 kg |
| Potato Marble 🔄 | 1.9 kg | 6 kg | 13.5 kg |
| Onion Leeks | 0.6 kg | 2 kg | 4.5 kg |
| White Onion | 0.4 kg | 1.5 kg | 3 kg |
| Carrots | 0.3 kg | 1 kg | 2.5 kg |
| Cabbage | 0.2 kg | 1 kg | 1.5 kg |
| Eggs | 61 pcs | 190 pcs | 430 pcs |

🔄 **Potato Marble** shows exactly 1.9 kg/day both here (purchased) and in A.2 (prepared side dish). This is probably one spreadsheet row counted twice — the duplicate-name problem in §1.2. Check the import before using either value.

For fresh vegetables, keep par levels low and order more often — expiry alerts matter more than running out ✅ (§5.1).

### A.2 Prepared items — prep target and service low-stock alert
Prep target at opening = a **busy day** (80th-percentile daily usage) **rounded up** to the next 0.5 kg, so the kitchen preps enough for most days. Service low alert = **25% of the prep target**, rounded to the nearest 0.1 kg (minimum 0.1 kg) (≈ 2–3 hours of rush), which triggers the in-service alert in §5.5 so the kitchen can prep more before running out. Plates are at 80 g ✅. In the item master, the prep target is stored as `par_level` and the service low alert as `reorder_level` (§5.5).

*(v0.3: recomputed with one rule. v0.2 rounded several prep targets down below busy-day use, and some alerts were 25% of busy-day use instead of 25% of the prep target.)*

| Item | Avg daily use | Busy-day use | Prep target at opening | Service low alert |
|---|---|---|---|---|
| Samgyupsal | 1.5 kg | 2.0 kg | 2 kg | 0.5 kg (≈6 plates) |
| Daepae | 3.3 kg | 4.4 kg | 4.5 kg | 1.1 kg (≈14 plates) |
| Moksal | 1.2 kg | 1.7 kg | 2 kg | 0.5 kg (≈6 plates) |
| Y-Sam w/ sauce | 1.6 kg | 2.2 kg | 2.5 kg | 0.6 kg (≈8 plates) |
| Gochujang w/ sauce | 1.7 kg | 2.3 kg | 2.5 kg | 0.6 kg (≈8 plates) |
| Plain Beef | 2.8 kg | 3.6 kg | 4 kg | 1.0 kg (≈13 plates) |
| Y-Woo Beef w/ sauce | 3.5 kg | 4.6 kg | 5 kg | 1.3 kg (≈16 plates) |
| Enoki | 1.7 kg | 2.5 kg | 2.5 kg | 0.6 kg (≈8 plates) |
| Kimchi (served) | 1.7 kg | 2.2 kg | 2.5 kg | 0.6 kg (≈8 plates) |
| Potato Marbles 🔄 | 1.9 kg | 2.6 kg | 3 kg | 0.8 kg (≈10 plates) |
| Japchae | 1.0 kg | 1.4 kg | 1.5 kg | 0.4 kg (≈5 plates) |
| Meat Balls | 1.0 kg | 1.3 kg | 1.5 kg | 0.4 kg (≈5 plates) |
| Fishcake | 0.9 kg | 1.1 kg | 1.5 kg | 0.4 kg (≈5 plates) |
| Chicken (side) | 0.9 kg | 1.0 kg | 1 kg | 0.3 kg (≈4 plates) |
| Radish (side) | 0.7 kg | 1.1 kg | 1.5 kg | 0.4 kg (≈5 plates) |
| Korean Salad | 0.3 kg | 0.4 kg | 0.5 kg | 0.1 kg (≈1 plate) |
| Sliced Cheese | 1.3 kg | 2.0 kg | 2 kg | 0.5 kg |
| Steam Egg | 3.9 kg | 5.2 kg | 5.5 kg | 1.4 kg |
| Samjang Dip Sauce | 0.4 kg | 0.5 kg | 0.5 kg | 0.1 kg |
| Bulgogi Dip Sauce | 0.5 kg | 0.7 kg | 1 kg | 0.3 kg |
| Hot Dip Sauce | 0.5 kg | 0.7 kg | 1 kg | 0.3 kg |

Rounding up raises prep targets for items with short shelf lives (side dishes are cooked daily). If a target looks too high for Candon's volume, lower it with the Candon volume factor rather than rounding down.

**Data caveats:** some Taft rows have missing or zero counts, prep and deliveries are entered in batches (which makes single days spiky), and items counted in packs/bottles/pieces (drinks, janitorial, packaging) had too few usable entries — set those by hand with JD. Validate the import (§13.2) before relying on any of these values.
