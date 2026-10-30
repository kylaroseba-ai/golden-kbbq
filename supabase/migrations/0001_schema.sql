-- Golden Korean BBQ — schema (SPEC v0.3 §12)
-- Conventions: uuid ids, branch_id NOT NULL on every business table (child tables too),
-- quantities in base units numeric(14,3), money numeric(12,2), unit costs numeric(14,6).

create schema if not exists app;

-- Clock used by every rule. The local demo and tests can move it (app.fake_now); Supabase pins it to now() (0007).
create or replace function app.now() returns timestamptz language sql stable as $$
  select coalesce(nullif(current_setting('app.fake_now', true), '')::timestamptz, now())
$$;

-- ───────────────────────── 12.1 Organization and access ─────────────────────────
create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default app.now()
);

create table branches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations,
  code text not null unique,
  name text not null,
  address text,
  timezone text not null default 'Asia/Manila',
  business_day_cutoff time not null default '04:00',
  settings jsonb not null default '{}',
  registered_name text,
  vat_reg_tin text,
  contact_phone text,
  email text,
  created_at timestamptz not null default app.now()
);

-- Staff people. auth_user_id is set only for people with a personal email login
-- (owner / manager / admin). PIN-only staff have no auth user (§11.1).
create table profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,
  full_name text not null,
  phone text,
  pin_salt text,
  pin_hash text,                     -- server-only; never returned by any RPC
  language text not null default 'en',
  is_active boolean not null default true,
  created_at timestamptz not null default app.now()
);

create table user_branch_roles (
  user_id uuid not null references profiles,
  branch_id uuid not null references branches,
  role text not null check (role in ('owner','manager','cashier','server','kitchen','admin')),
  primary key (user_id, branch_id)
);

create table devices (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  label text not null,
  kind text not null check (kind in ('cashier','server','kitchen','owner')),
  auth_user_id uuid unique,          -- the device account (§11.1)
  revoked_at timestamptz,
  clock_offset_ms integer,
  last_seen_at timestamptz,
  created_at timestamptz not null default app.now()
);

create table pos_terminals (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  device_id uuid references devices,
  terminal_code text not null,
  bir_min text, bir_serial_no text, bir_ptu_no text, bir_ptu_date date,
  invoice_prefix text not null default '',
  next_invoice_no bigint not null default 1,
  accumulated_grand_total numeric(14,2) not null default 0,
  invoice_printing_enabled boolean not null default false,   -- false until BIR approval
  unique (branch_id, terminal_code)
);

create table audit_log (
  id bigint generated always as identity primary key,
  branch_id uuid,
  user_id uuid,
  device_id uuid,
  table_name text not null,
  record_id text,
  action text not null,
  before jsonb,
  after jsonb,
  at timestamptz not null default app.now()
);

create table idempotency_keys (
  client_uuid uuid primary key,
  branch_id uuid not null references branches,
  rpc_name text not null,
  device_id uuid,
  result jsonb,
  created_at timestamptz not null default app.now()
);

create table staff_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles,
  device_id uuid not null references devices,
  branch_id uuid not null references branches,
  purpose text not null default 'session' check (purpose in ('session','override')),
  issued_at timestamptz not null default app.now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create table pin_attempts (
  user_id uuid not null references profiles,
  device_id uuid not null references devices,
  failed_count integer not null default 0,
  locked_until timestamptz,
  primary key (user_id, device_id)
);

-- ───────────────────────── 12.2 Inventory ─────────────────────────
create table item_categories (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  name text not null,
  sort_order integer not null default 0
);

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  name text not null,
  contact_person text,
  phones text[] not null default '{}',
  viber text, messenger text, whatsapp text, email text, address text,
  payment_terms text, notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default app.now()
);

create table items (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  category_id uuid references item_categories,
  name text not null,
  stage text not null check (stage in ('raw','prepared','resale','supply')),
  base_unit text not null check (base_unit in ('g','ml','pc')),
  count_unit text not null,
  count_unit_factor numeric(14,3) not null default 1,
  reorder_level numeric(14,3) not null default 0,
  par_level numeric(14,3) not null default 0,
  default_supplier_id uuid references suppliers,
  tracks_expiry boolean not null default false,
  shelf_life_days integer,
  near_expiry_days integer not null default 3,
  grams_per_plate numeric(14,3),
  is_refillable boolean not null default false,
  is_meat boolean not null default false,        -- counts toward the plate limit
  is_watch boolean not null default false,       -- owner dashboard watch list
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default app.now(),
  unique (branch_id, name)
);

create table supplier_items (
  branch_id uuid not null references branches,
  supplier_id uuid not null references suppliers,
  item_id uuid not null references items,
  last_unit_price numeric(14,6),          -- per base unit
  last_purchase_at timestamptz,
  primary key (supplier_id, item_id)
);

create table deliveries (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  supplier_id uuid references suppliers,
  received_at timestamptz not null,
  business_date date not null,
  reference_no text,
  payment_method text,
  total_amount numeric(12,2) not null default 0,
  received_by uuid references profiles,
  photo_path text,
  notes text,
  client_uuid uuid unique,
  occurred_at timestamptz,
  created_at timestamptz not null default app.now()
);

create table stock_batches (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  item_id uuid not null references items,
  source_type text not null check (source_type in ('delivery','production','opening','count')),
  source_id uuid,
  received_at timestamptz not null default app.now(),
  expiry_date date,
  qty_initial numeric(14,3) not null,
  qty_remaining numeric(14,3) not null check (qty_remaining >= 0),
  unit_cost numeric(14,6) not null default 0
);
create index on stock_batches (branch_id, item_id, received_at) where qty_remaining > 0;

create table delivery_lines (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  delivery_id uuid not null references deliveries,
  item_id uuid not null references items,
  qty_base numeric(14,3) not null check (qty_base > 0),
  unit_cost numeric(14,6) not null,
  line_total numeric(12,2) not null,
  expiry_date date,
  batch_id uuid references stock_batches
);

create table prep_recipes (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  output_item_id uuid not null references items,
  standard_output_qty numeric(14,3) not null check (standard_output_qty > 0),
  notes text,
  is_active boolean not null default true
);

create table prep_recipe_inputs (
  branch_id uuid not null references branches,
  recipe_id uuid not null references prep_recipes,
  item_id uuid not null references items,
  qty numeric(14,3) not null,
  primary key (recipe_id, item_id)
);

create table production_runs (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  recipe_id uuid not null references prep_recipes,
  business_date date not null,
  output_qty_actual numeric(14,3) not null check (output_qty_actual > 0),
  made_by uuid references profiles,
  output_batch_id uuid references stock_batches,
  client_uuid uuid unique,
  occurred_at timestamptz,
  created_at timestamptz not null default app.now()
);

create table production_run_inputs (
  branch_id uuid not null references branches,
  run_id uuid not null references production_runs,
  item_id uuid not null references items,
  qty_used numeric(14,3) not null,
  primary key (run_id, item_id)
);

create table table_sessions (
  id uuid primary key,                         -- client-generated so tables open offline
  branch_id uuid not null references branches,
  business_date date not null,
  table_ids uuid[] not null,
  package_id uuid,                             -- one unli package per session (§6.1)
  reservation_id uuid,
  opened_by uuid references profiles,
  opened_at timestamptz not null,
  timer_minutes integer,
  timer_ends_at timestamptz,
  refill_cutoff_at timestamptz,
  status text not null default 'open' check (status in ('open','billing','closed','voided')),
  sales_channel text not null default 'walk_in' check (sales_channel in ('walk_in','reservation','delivery')),
  overtime_minutes integer,
  closed_at timestamptz,
  notes text,
  client_uuid uuid unique,
  created_at timestamptz not null default app.now()
);

create table waste_logs (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  business_date date not null,
  item_id uuid not null references items,
  batch_id uuid references stock_batches,
  qty numeric(14,3) not null check (qty > 0),
  reason text not null check (reason in ('spoilage','expired','over_portioning','plate_waste','dropped_damaged','other')),
  note text,
  photo_path text,
  session_id uuid references table_sessions,
  logged_by uuid references profiles,
  unit_cost_at_time numeric(14,6),
  client_uuid uuid unique,
  occurred_at timestamptz,
  created_at timestamptz not null default app.now()
);

create table stock_counts (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  business_date date not null,
  count_type text not null check (count_type in ('opening','closing','spot')),
  status text not null default 'submitted' check (status in ('draft','submitted','approved')),
  counted_by uuid references profiles,
  approved_by uuid references profiles,
  approved_at timestamptz,
  notes text,
  client_uuid uuid unique,
  occurred_at timestamptz,
  created_at timestamptz not null default app.now()
);

create table stock_count_lines (
  branch_id uuid not null references branches,
  count_id uuid not null references stock_counts,
  item_id uuid not null references items,
  counted_qty numeric(14,3) not null,
  expected_qty numeric(14,3) not null,
  variance_qty numeric(14,3) not null,
  variance_value numeric(12,2) not null,
  needs_reason boolean not null default false,
  reason text,
  approve_adjustment boolean not null default true,   -- opening counts: manager picks which differences post
  primary key (count_id, item_id)
);

create table stock_movements (
  id bigint generated always as identity primary key,
  branch_id uuid not null references branches,
  business_date date not null,
  item_id uuid not null references items,
  batch_id uuid references stock_batches,
  movement_type text not null check (movement_type in (
    'delivery_in','production_in','production_out','sale','refill','waste',
    'count_adjustment','manual_adjustment','void_reversal','opening_balance','usage_import')),
  qty_delta numeric(14,3) not null,
  unit_cost numeric(14,6) not null default 0,
  ref_table text,
  ref_id uuid,
  created_by uuid references profiles,
  occurred_at timestamptz not null default app.now(),
  created_at timestamptz not null default app.now()
  -- no client_uuid: one action writes many movements; idempotency is per action (§9.3)
);
create index on stock_movements (branch_id, item_id, business_date);
create index on stock_movements (ref_table, ref_id);

create table item_stock_levels (
  branch_id uuid not null references branches,
  item_id uuid not null references items primary key,
  qty_on_hand numeric(14,3) not null default 0,
  avg_unit_cost numeric(14,6) not null default 0,
  low_armed boolean not null default true,
  out_armed boolean not null default true,
  last_movement_at timestamptz
);

create table reorder_lists (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  status text not null default 'draft' check (status in ('draft','manager_approved','owner_approved','ordered','received','rejected')),
  created_by uuid references profiles,
  manager_approved_by uuid references profiles, manager_approved_at timestamptz,
  owner_approved_by uuid references profiles, owner_approved_at timestamptz,
  ordered_at timestamptz,
  rejected_by uuid references profiles, reject_reason text,
  delivery_id uuid references deliveries,
  created_at timestamptz not null default app.now()
);

create table reorder_lines (
  branch_id uuid not null references branches,
  list_id uuid not null references reorder_lists,
  item_id uuid not null references items,
  supplier_id uuid references suppliers,
  suggested_qty numeric(14,3) not null,
  final_qty numeric(14,3) not null,
  est_unit_price numeric(14,6),
  primary key (list_id, item_id)
);

-- ───────────────────────── 12.3 POS ─────────────────────────
create table dining_tables (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  label text not null,
  seats integer not null default 4,
  zone text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  status text not null default 'free' check (status in ('free','seated','billing','dirty'))
);

create table menu_categories (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  name text not null,
  sort_order integer not null default 0
);

create table menu_items (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  category_id uuid references menu_categories,
  name text not null,
  item_type text not null check (item_type in ('unli_package','set_meal','add_on','drink','fee','raw_meat_takeout')),
  price numeric(12,2) not null,
  priced_per_person boolean not null default false,
  needs_kitchen boolean not null default false,
  vat_exempt boolean not null default false,
  sort_order integer not null default 0,
  is_active boolean not null default true
);
alter table table_sessions add foreign key (package_id) references menu_items;

create table menu_item_price_history (
  branch_id uuid not null references branches,
  menu_item_id uuid not null references menu_items,
  price numeric(12,2) not null,
  effective_from timestamptz not null default app.now()
);

create table package_refill_items (
  branch_id uuid not null references branches,
  package_id uuid not null references menu_items,
  item_id uuid not null references items,
  primary key (package_id, item_id)
);

create table portion_rules (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  menu_item_id uuid not null references menu_items,
  item_id uuid not null references items,
  qty numeric(14,3) not null,
  basis text not null default 'per_unit' check (basis in ('per_unit','per_person','per_table'))
);

create table discount_types (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  name text not null,
  kind text not null check (kind in ('none','percent','sc_pwd_vat_exempt','fixed_price')),
  value numeric(8,4) not null default 0,     -- percent as 0.20; fixed_price as amount
  requires_manager_pin boolean not null default false,
  requires_id_record boolean not null default false,
  sort_order integer not null default 0,
  is_active boolean not null default true
);

create table session_pax (
  branch_id uuid not null references branches,
  session_id uuid not null references table_sessions,
  discount_type_id uuid not null references discount_types,
  menu_item_id uuid references menu_items,
  pax_count integer not null check (pax_count > 0),
  primary key (session_id, discount_type_id)
);

create table order_lines (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  session_id uuid not null references table_sessions,
  menu_item_id uuid not null references menu_items,
  qty numeric(10,3) not null check (qty > 0),
  unit_price numeric(12,2) not null,           -- snapshot at time of sale
  discount_type_id uuid references discount_types,
  gross_amount numeric(12,2) not null,
  discount_amount numeric(12,2) not null default 0,
  net_amount numeric(12,2) not null,
  vatable_sales numeric(12,2) not null default 0,
  vat_amount numeric(12,2) not null default 0,
  vat_exempt_sales numeric(12,2) not null default 0,
  status text not null default 'active' check (status in ('active','voided')),
  voided_by uuid references profiles, void_reason text, voided_at timestamptz,
  override_by uuid references profiles,
  client_uuid uuid unique,
  created_by uuid references profiles,
  occurred_at timestamptz not null default app.now(),
  created_at timestamptz not null default app.now()
);

create table refill_rounds (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  session_id uuid not null references table_sessions,
  round_no integer not null,
  requested_by uuid references profiles,
  requested_at timestamptz not null,
  served_by uuid references profiles,
  served_at timestamptz,
  status text not null default 'queued' check (status in ('queued','served','voided')),
  override_by uuid references profiles,
  client_uuid uuid unique,
  created_at timestamptz not null default app.now(),
  unique (session_id, round_no)
);

create table refill_lines (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  round_id uuid not null references refill_rounds,
  item_id uuid not null references items,
  plates integer not null check (plates > 0),
  grams_per_plate_at_time numeric(14,3) not null
);

create table kitchen_tickets (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  session_id uuid not null references table_sessions,
  source text not null check (source in ('order','refill_round')),
  source_id uuid,
  title text not null,
  created_by uuid references profiles,
  created_at timestamptz not null default app.now(),
  served_at timestamptz,
  served_by uuid references profiles,
  status text not null default 'queued' check (status in ('queued','partially_served','served','voided'))
);

create table kitchen_ticket_lines (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  ticket_id uuid not null references kitchen_tickets,
  label text not null,
  qty numeric(10,3) not null,
  item_id uuid references items,
  is_meat boolean not null default false,
  ref_table text, ref_id uuid,
  served_at timestamptz, served_by uuid references profiles,
  voided boolean not null default false
);

create table bills (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  session_id uuid not null unique references table_sessions,
  subtotal numeric(12,2) not null,
  discount_total numeric(12,2) not null,
  vatable_sales numeric(12,2) not null,
  vat_amount numeric(12,2) not null,
  vat_exempt_sales numeric(12,2) not null,
  total numeric(12,2) not null,             -- no service charge in the MVP
  printed_count integer not null default 0,
  finalized_at timestamptz not null default app.now()
);

create table cash_shifts (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  terminal_id uuid not null references pos_terminals,
  cashier_id uuid not null references profiles,
  opened_at timestamptz not null default app.now(),
  opening_float numeric(12,2) not null default 0,
  cash_in numeric(12,2) not null default 0,
  cash_out numeric(12,2) not null default 0,
  closed_at timestamptz,
  counted_cash numeric(12,2),
  expected_cash numeric(12,2),
  over_short numeric(12,2)
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  bill_id uuid not null references bills,
  terminal_id uuid references pos_terminals,
  shift_id uuid references cash_shifts,
  method text not null check (method in ('cash','gcash','maya','card','bank')),
  amount numeric(12,2) not null check (amount > 0),
  reference_no text,
  tendered numeric(12,2),
  change numeric(12,2),
  received_by uuid references profiles,
  at timestamptz not null default app.now()
);

create table sc_pwd_records (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  bill_id uuid not null references bills,
  kind text not null check (kind in ('sc','pwd')),
  id_number text not null,
  full_name text not null
);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  terminal_id uuid references pos_terminals,
  bill_id uuid not null references bills,
  invoice_no bigint,                         -- null when a manual booklet invoice was used
  issued_at timestamptz not null default app.now(),
  business_date date not null,
  vatable_sales numeric(12,2) not null,
  vat_amount numeric(12,2) not null,
  vat_exempt_sales numeric(12,2) not null,
  zero_rated_sales numeric(12,2) not null default 0,
  discount_total numeric(12,2) not null,
  total numeric(12,2) not null,
  status text not null default 'issued' check (status in ('issued','voided')),
  void_reason text, voided_by uuid references profiles, voided_at timestamptz,
  reprint_count integer not null default 0,
  manual_booklet_no text,
  unique (terminal_id, invoice_no),
  check (invoice_no is not null or manual_booklet_no is not null)
);

create table x_readings (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  shift_id uuid not null references cash_shifts,
  terminal_id uuid not null references pos_terminals,
  generated_at timestamptz not null default app.now(),
  totals jsonb not null
);

create table z_readings (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  terminal_id uuid not null references pos_terminals,
  business_date date not null,
  generated_at timestamptz not null default app.now(),
  first_invoice_no bigint, last_invoice_no bigint,
  gross_sales numeric(14,2) not null, vat_amount numeric(14,2) not null,
  vat_exempt_sales numeric(14,2) not null, discounts jsonb not null,
  voids_total numeric(14,2) not null,
  accumulated_grand_total_start numeric(14,2) not null,
  accumulated_grand_total_end numeric(14,2) not null,
  reset_counter integer not null default 0,
  unique (terminal_id, business_date)
);

-- ───────────────────────── 12.4 Reservations and notifications ─────────────────────────
create table reservations (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  code text not null unique,
  customer_name text not null,
  phone text not null,
  email text,
  party_size integer not null check (party_size > 0),
  reserved_for timestamptz not null,
  package_interest text not null default 'not_sure' check (package_interest in ('unli_pork','unli_beef_pork','lunch','not_sure')),
  notes text,
  source text not null default 'web' check (source in ('web','phone','facebook','walk_in')),
  status text not null default 'pending' check (status in ('pending','confirmed','declined','seated','completed','cancelled','no_show')),
  table_id uuid references dining_tables,
  session_id uuid references table_sessions,
  confirmed_by uuid references profiles, confirmed_at timestamptz,
  decline_reason text,
  consent_privacy boolean not null,
  consent_marketing boolean not null default false,
  realerted_at timestamptz,
  created_at timestamptz not null default app.now()
);
alter table table_sessions add foreign key (reservation_id) references reservations;

create table reservation_slots_config (
  branch_id uuid not null references branches,
  weekday integer not null check (weekday between 0 and 6),   -- 0 = Sunday
  open_time time not null, close_time time not null,
  slot_minutes integer not null default 30,
  max_covers_per_slot integer not null,
  primary key (branch_id, weekday)
);

create table message_templates (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  channel text not null check (channel in ('sms','email')),
  event text not null check (event in ('confirmed','reminder','declined','cancelled','staff_new_booking')),
  subject text,
  body text not null,
  unique (branch_id, channel, event)
);

create table outbound_messages (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  reservation_id uuid references reservations,
  channel text not null check (channel in ('sms','email')),
  event text not null,
  to_address text not null,
  subject text,
  body text not null,
  send_after timestamptz not null default app.now(),
  status text not null default 'queued' check (status in ('queued','sent','failed','cancelled')),
  provider_id text, error text, sent_at timestamptz,
  created_at timestamptz not null default app.now()
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  target_roles text[] not null,
  target_user uuid references profiles,
  kind text not null,
  priority text not null default 'normal' check (priority in ('normal','high')),
  title text not null,
  body text,
  ref_table text, ref_id uuid,
  read_by uuid[] not null default '{}',
  pushed_at timestamptz,                       -- set by the push-fanout Edge Function
  created_at timestamptz not null default app.now()
);
create index on notifications (branch_id, created_at desc);

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  user_id uuid references profiles,
  device_id uuid references devices,
  endpoint text not null unique,
  keys jsonb not null,
  created_at timestamptz not null default app.now()
);
