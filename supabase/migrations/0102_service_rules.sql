-- v0.6 service rules (SPEC §15.5, §15.7):
--  • Unli from opening (no more 3 PM start); lunch sets 11 AM – 3 PM; last unli seating per branch.
--  • Overtime fee ₱200 per table; leftover fee ₱200 per table.
--  • Online bookings: 50% of seats, up to 50 pax, 3 hours ahead, ₱1,000 GCash fee for 10+ pax; closed weekdays.
--  • Solo diner price when one guest takes an unli package.
--  • Birthday rules: needs N full-paying adults, one celebrant per table.
--  • Kitchen and Dispatch are separate stations with their own screens.
--  • Receipts are internal (not BIR invoices).

-- ───────── Settings ─────────
create or replace function app.default_settings() returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'opening_time','11:00', 'closing_time','22:00', 'closed_weekdays', '[]'::jsonb,
    'lunch_from','11:00', 'lunch_to','15:00', 'unli_from','11:00', 'unli_to','22:00',
    'unli_timer_minutes',120, 'last_refill_cutoff_minutes_before_end',45,
    'max_meat_plates_per_round',3, 'require_prev_round_served',true,
    'enforce_package_items',false,
    'default_grams_per_plate',80, 'leftover_fee',200, 'leftover_fee_basis','per_session',
    'overtime_fee_enabled',true, 'overtime_fee',200, 'overtime_fee_basis','per_session',
    'last_unli_seating_time','20:30',
    'variance_threshold_pct',0.05, 'variance_abs_g',200, 'variance_abs_ml',200, 'variance_abs_pc',2,
    'reservation_slot_minutes',30, 'reservation_lead_minutes',180, 'max_online_party',50,
    'reservation_seating_minutes_unli',120, 'reservation_seating_minutes_lunch',60,
    'online_capacity_pct',0.50, 'reservation_reminder_minutes',180, 'no_show_grace_minutes',15,
    'reservation_fee_min_party',10, 'reservation_fee_amount',1000, 'gcash_number',null, 'gcash_name',null,
    'vat_registered',true, 'receipt_mode','internal', 'kitchen_ticket_amber_min',5, 'kitchen_ticket_red_min',10,
    'stuck_round_minutes',10, 'max_unsynced_rounds_per_table',1, 'late_sync_flag_minutes',10,
    'invoice_requires_online',true, 'pin_max_attempts',5, 'pin_lockout_minutes',15,
    'monthly_sms_cap',null
  )
$$;

-- ───────── Closed days (Taft: Sundays) ─────────
select app.patch_fn('app.slot_allowed(uuid,timestamptz,text)',
  'begin
  if p_at < app.now()',
  'begin
  if extract(dow from p_at at time zone ''Asia/Manila'')::int in (select jsonb_array_elements_text(coalesce(s->''closed_weekdays'', ''[]''))::int) then
    return ''We are closed on '' || trim(to_char(p_at at time zone ''Asia/Manila'', ''Day'')) || ''s.'';
  end if;
  if p_at < app.now()');

-- ───────── Solo diner price ─────────
alter table menu_items add column solo_price numeric(12,2);

create or replace function app.unit_price(m menu_items, p_session uuid) returns numeric language sql stable as $$
  select case when m.item_type = 'unli_package' and m.solo_price is not null
               and (select coalesce(sum(pax_count), 0) from session_pax where session_id = p_session) = 1
              then m.solo_price else m.price end
$$;

select app.patch_fn('app.add_order_line(table_sessions,uuid,numeric,uuid,uuid,timestamptz,uuid,uuid,uuid)',
  'd discount_types;', 'd discount_types; v_price numeric;');
select app.patch_fn('app.add_order_line(table_sessions,uuid,numeric,uuid,uuid,timestamptz,uuid,uuid,uuid)',
  'pr := app.price_line(p_session.branch_id, m.price, p_qty,', 'v_price := app.unit_price(m, p_session.id);
  pr := app.price_line(p_session.branch_id, v_price, p_qty,');
select app.patch_fn('app.add_order_line(table_sessions,uuid,numeric,uuid,uuid,timestamptz,uuid,uuid,uuid)',
  'p_qty, m.price, p_discount, pr.gross', 'p_qty, v_price, p_discount, pr.gross');

-- ───────── Pax rules (birthday) ─────────
alter table discount_types add column min_full_paying integer;     -- e.g. Birthday 50%: 3 full-paying adults
alter table discount_types add column max_per_session integer;     -- e.g. one celebrant per table
alter table discount_types add column conditions text;             -- shown to staff, e.g. "Valid ID, once in birth month"

create or replace function app.check_pax_rules(p_branch uuid, p_session uuid, p_override uuid) returns void
language plpgsql stable as $$
declare r record; v_full int;
begin
  select coalesce(sum(p.pax_count), 0) into v_full from session_pax p join discount_types d on d.id = p.discount_type_id
   where p.session_id = p_session and d.kind = 'none';
  for r in select d.name, d.min_full_paying, d.max_per_session, p.pax_count from session_pax p
             join discount_types d on d.id = p.discount_type_id where p.session_id = p_session loop
    if r.max_per_session is not null and r.pax_count > r.max_per_session and p_override is null then
      raise exception 'PAX_RULE: Only % % per table. Manager PIN can override.', r.max_per_session, r.name;
    end if;
    if r.min_full_paying is not null and v_full < r.min_full_paying and p_override is null then
      raise exception 'PAX_RULE: % needs at least % full-paying adults at the table. Manager PIN can override.', r.name, r.min_full_paying;
    end if;
  end loop;
end $$;

-- Insert every pax row first, so the solo-diner price and the birthday rule see the whole table.
select app.patch_fn('public.open_session(uuid,uuid,uuid,uuid,uuid[],uuid,jsonb,uuid,timestamptz,uuid)',
  '    values (p_branch, s.id, (x->>''discount_type_id'')::uuid, p_package_id, (x->>''pax_count'')::int);
    if p_package_id is not null then',
  '    values (p_branch, s.id, (x->>''discount_type_id'')::uuid, p_package_id, (x->>''pax_count'')::int);
  end loop;
  perform app.check_pax_rules(p_branch, s.id, v_ovr);
  for x in select * from jsonb_array_elements(coalesce(p_pax, ''[]'')) loop
    if p_package_id is not null then');

-- ───────── Kitchen and Dispatch stations ─────────
alter table items add column station text not null default 'dispatch' check (station in ('kitchen','dispatch'));
alter table menu_items add column station text not null default 'kitchen' check (station in ('kitchen','dispatch'));
alter table kitchen_ticket_lines add column station text not null default 'kitchen' check (station in ('kitchen','dispatch'));

select app.patch_fn('public.post_refill_round(uuid,uuid,uuid,jsonb,timestamptz,uuid)',
  'insert into kitchen_ticket_lines(branch_id, ticket_id, label, qty, item_id, is_meat, ref_table, ref_id)
    values (s.branch_id, v_ticket, i.name, (x->>''plates'')::int, i.id, i.is_meat, ''refill_lines'', v_line);',
  'insert into kitchen_ticket_lines(branch_id, ticket_id, label, qty, item_id, is_meat, ref_table, ref_id, station)
    values (s.branch_id, v_ticket, i.name, (x->>''plates'')::int, i.id, i.is_meat, ''refill_lines'', v_line, i.station);');
select app.patch_fn('app.add_order_line(table_sessions,uuid,numeric,uuid,uuid,timestamptz,uuid,uuid,uuid)',
  'insert into kitchen_ticket_lines(branch_id, ticket_id, label, qty, ref_table, ref_id)
    values (p_session.branch_id, p_ticket, m.name, p_qty, ''order_lines'', v_id);',
  'insert into kitchen_ticket_lines(branch_id, ticket_id, label, qty, ref_table, ref_id, station)
    values (p_session.branch_id, p_ticket, m.name, p_qty, ''order_lines'', v_id, m.station);');
select app.patch_fn('public.get_kitchen_queue(uuid)',
  '''served_at'', l.served_at, ''voided'', l.voided,', '''served_at'', l.served_at, ''voided'', l.voided, ''station'', l.station,');

-- One station's screen: only its lines, and only tickets that still have something for it.
create or replace function public.get_station_queue(p_branch uuid, p_station text) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare q jsonb := public.get_kitchen_queue(p_branch);
begin
  if p_station not in ('kitchen','dispatch') then raise exception 'BAD_INPUT: Unknown station.'; end if;
  return jsonb_build_object('server_time', q->'server_time', 'station', p_station, 'tickets', coalesce((
    select jsonb_agg(t || jsonb_build_object('lines', (select jsonb_agg(l) from jsonb_array_elements(t->'lines') l where l->>'station' = p_station)))
      from jsonb_array_elements(q->'tickets') t
     where exists (select 1 from jsonb_array_elements(t->'lines') l
                    where l->>'station' = p_station and l->>'served_at' is null and not (l->>'voided')::boolean)), '[]'));
end $$;

-- ───────── Reservation fee (10+ pax, GCash) ─────────
alter table reservations add column deposit_amount numeric(12,2) not null default 0;
alter table reservations add column deposit_ref text;
alter table reservations add column deposit_status text not null default 'none'
  check (deposit_status in ('none','pending','verified','applied','forfeited'));

select app.patch_fn('public.create_public_reservation(text,jsonb)', 'v_hour time;', 'v_hour time; v_dep numeric := 0;');
select app.patch_fn('public.create_public_reservation(text,jsonb)',
  '  insert into reservations(branch_id, code, customer_name, phone, email, party_size, reserved_for, package_interest, notes, source,
    consent_privacy, consent_marketing)',
  '  if v_party >= (s->>''reservation_fee_min_party'')::int then
    v_dep := (s->>''reservation_fee_amount'')::numeric;
    if coalesce(trim(p_booking->>''deposit_ref''), '''') = '''' then
      raise exception ''DEPOSIT_REQUIRED: Groups of % or more pay a ₱% reservation fee by GCash first. Enter the GCash reference number.'',
        s->>''reservation_fee_min_party'', to_char(v_dep, ''FM999,999'');
    end if;
  end if;
  insert into reservations(branch_id, code, customer_name, phone, email, party_size, reserved_for, package_interest, notes, source,
    consent_privacy, consent_marketing, deposit_amount, deposit_ref, deposit_status)');
select app.patch_fn('public.create_public_reservation(text,jsonb)',
  '    coalesce((p_booking->>''consent_marketing'')::boolean, false))
  returning * into r;',
  '    coalesce((p_booking->>''consent_marketing'')::boolean, false), v_dep, nullif(trim(p_booking->>''deposit_ref''), ''''),
    case when v_dep > 0 then ''pending'' else ''none'' end)
  returning * into r;');
select app.patch_fn('public.create_public_reservation(text,jsonb)',
  'return jsonb_build_object(''code'', r.code, ''reserved_for'', r.reserved_for, ''status'', r.status);',
  'return jsonb_build_object(''code'', r.code, ''reserved_for'', r.reserved_for, ''status'', r.status,
    ''deposit_amount'', r.deposit_amount, ''deposit_status'', r.deposit_status);');

-- Booking page shows the fee rule and where to pay.
select app.patch_fn('public.public_availability(text,date,int,text)',
  '''max_online_party'', s->''max_online_party'', ''slots'', v_out);',
  '''max_online_party'', s->''max_online_party'', ''slots'', v_out,
    ''closed'', extract(dow from p_date)::int in (select jsonb_array_elements_text(coalesce(s->''closed_weekdays'', ''[]''))::int),
    ''reservation_fee'', jsonb_build_object(''min_party'', s->''reservation_fee_min_party'', ''amount'', s->''reservation_fee_amount'',
      ''gcash_number'', s->''gcash_number'', ''gcash_name'', s->''gcash_name''));');

-- A booking with a fee cannot be confirmed until staff have checked the GCash payment.
select app.patch_fn('public.confirm_reservation(uuid,uuid,uuid)',
  'if r.status <> ''pending'' then raise exception ''BAD_STATE: Only pending bookings can be confirmed.''; end if;',
  'if r.status <> ''pending'' then raise exception ''BAD_STATE: Only pending bookings can be confirmed.''; end if;
  if r.deposit_status = ''pending'' then
    raise exception ''DEPOSIT_PENDING: Check the ₱% GCash payment (ref %) first, then mark it received.'', to_char(r.deposit_amount, ''FM999,999''), r.deposit_ref;
  end if;');

create or replace function public.verify_reservation_deposit(p_reservation_id uuid, p_received boolean, p_ref text default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare r reservations;
begin
  select * into r from reservations where id = p_reservation_id for update;
  if not found then raise exception 'NOT_FOUND: Booking not found.'; end if;
  perform app.require_role(null, r.branch_id, array['cashier','manager']);
  if r.deposit_amount <= 0 then raise exception 'BAD_STATE: This booking has no reservation fee.'; end if;
  if r.deposit_status not in ('pending','verified') then raise exception 'BAD_STATE: The fee is already %.', r.deposit_status; end if;
  update reservations set deposit_status = case when p_received then 'verified' else 'pending' end,
    deposit_ref = coalesce(nullif(trim(p_ref), ''), deposit_ref)
   where id = r.id returning * into r;
  return to_jsonb(r);
end $$;

-- Fee is used up when the table is billed; kept by the restaurant on a no-show or cancellation (non-refundable).
create or replace function app.reservation_fee_status() returns trigger language plpgsql as $$
begin
  if new.status in ('no_show','cancelled') and old.status not in ('no_show','cancelled') and new.deposit_status in ('pending','verified') then
    new.deposit_status := 'forfeited';
  elsif new.status in ('seated','completed') and new.deposit_status = 'pending' then
    new.deposit_status := 'verified';
  end if;
  return new;
end $$;
create trigger reservation_fee_status before update on reservations for each row execute function app.reservation_fee_status();

create or replace function app.session_fee_applied() returns trigger language plpgsql as $$
begin
  if new.status = 'closed' and old.status <> 'closed' then
    update reservations set deposit_status = 'applied' where session_id = new.id and deposit_status = 'verified';
  end if;
  return new;
end $$;
create trigger session_fee_applied after update on table_sessions for each row execute function app.session_fee_applied();

-- The bill shows the fee already paid, so the cashier collects only the rest.
select app.patch_fn('public.get_session(uuid)',
  '''bill'', (select to_jsonb(b) from bills b where b.session_id = s.id),',
  '''bill'', (select to_jsonb(b) from bills b where b.session_id = s.id),
    ''reservation_fee'', (select jsonb_build_object(''amount'', r.deposit_amount, ''ref'', r.deposit_ref, ''status'', r.deposit_status, ''code'', r.code)
      from reservations r where r.session_id = s.id and r.deposit_amount > 0 and r.deposit_status in (''verified'',''applied'')),');
