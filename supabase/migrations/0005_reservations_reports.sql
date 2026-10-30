-- Reservations (§7), notifications, reports and dashboard (§8).

-- ───────── Messages ─────────
create or replace function app.render(p_body text, r reservations) returns text language sql stable as $$
  select replace(replace(replace(replace(replace(replace(p_body,
    '{name}', r.customer_name), '{code}', r.code),
    '{date}', to_char(r.reserved_for at time zone b.timezone, 'Mon DD (Dy)')),
    '{time}', to_char(r.reserved_for at time zone b.timezone, 'FMHH12:MI AM')),
    '{party}', r.party_size::text), '{phone}', coalesce(b.contact_phone, ''))
  from branches b where b.id = r.branch_id
$$;

create or replace function app.queue_message(r reservations, p_event text, p_send_after timestamptz default app.now(), p_reason text default null)
returns void language plpgsql as $$
declare t message_templates; v_body text;
begin
  for t in select * from message_templates where branch_id = r.branch_id and event = p_event loop
    if t.channel = 'email' and r.email is null then continue; end if;
    v_body := replace(app.render(t.body, r), '{reason}', coalesce(p_reason, ''));
    insert into outbound_messages(branch_id, reservation_id, channel, event, to_address, subject, body, send_after)
    values (r.branch_id, r.id, t.channel, p_event, case when t.channel = 'sms' then r.phone else r.email end,
            app.render(coalesce(t.subject, ''), r), v_body, p_send_after);
  end loop;
end $$;

create or replace function app.new_code() returns text language sql volatile as $$
  select 'GKB-' || string_agg(substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', 1 + floor(random() * 31)::int, 1), '')
  from generate_series(1, 4)
$$;

create or replace function app.normalize_ph_mobile(p text) returns text language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(p,''), '[^0-9]', '', 'g');
begin
  if d ~ '^09[0-9]{9}$' then return '63' || substr(d, 2); end if;
  if d ~ '^639[0-9]{9}$' then return d; end if;
  if d ~ '^9[0-9]{9}$' then return '63' || d; end if;
  return null;
end $$;

-- ───────── Availability (§7.1): bookings hold seats across every slot they overlap ─────────
create or replace function app.seating_minutes(p_branch uuid, p_interest text) returns int language sql stable as $$
  select case when p_interest = 'lunch' then (app.setting(p_branch,'reservation_seating_minutes_lunch'))::int
              else (app.setting(p_branch,'reservation_seating_minutes_unli'))::int end
$$;

create or replace function app.slot_load(p_branch uuid, p_at timestamptz, p_exclude uuid default null) returns int
language sql stable as $$
  select coalesce(sum(party_size), 0)::int from reservations r
   where r.branch_id = p_branch and r.status in ('pending','confirmed','seated') and r.id is distinct from p_exclude
     and p_at >= r.reserved_for and p_at < r.reserved_for + make_interval(mins => app.seating_minutes(p_branch, r.package_interest))
$$;

create or replace function app.online_capacity(p_branch uuid, p_date date) returns int language sql stable as $$
  select floor(coalesce(
    (select max_covers_per_slot from reservation_slots_config where branch_id = p_branch and weekday = extract(dow from p_date)::int),
    (select coalesce(sum(seats),0) from dining_tables where branch_id = p_branch and is_active)) * (app.setting(p_branch,'online_capacity_pct'))::numeric)::int
$$;

create or replace function app.check_capacity(p_branch uuid, p_at timestamptz, p_party int, p_interest text, p_exclude uuid default null)
returns boolean language plpgsql stable as $$
declare v_cap int := app.online_capacity(p_branch, (p_at at time zone 'Asia/Manila')::date);
  v_step int := (app.setting(p_branch,'reservation_slot_minutes'))::int; v_t timestamptz := p_at;
begin
  while v_t < p_at + make_interval(mins => app.seating_minutes(p_branch, p_interest)) loop
    if app.slot_load(p_branch, v_t, p_exclude) + p_party > v_cap then return false; end if;
    v_t := v_t + make_interval(mins => v_step);
  end loop;
  return true;
end $$;

create or replace function app.slot_allowed(p_branch uuid, p_at timestamptz, p_interest text) returns text
language plpgsql stable as $$
declare s jsonb := app.settings(p_branch); t time := app.local_time(p_branch, p_at);
begin
  if p_at < app.now() + make_interval(mins => (s->>'reservation_lead_minutes')::int) then
    return 'Please book at least ' || ((s->>'reservation_lead_minutes')::int / 60) || ' hours ahead, or call us.';
  end if;
  if t < (s->>'opening_time')::time or t >= (s->>'closing_time')::time then return 'We are open ' || (s->>'opening_time') || '–' || (s->>'closing_time') || '.'; end if;
  if p_interest = 'lunch' and not (t >= (s->>'lunch_from')::time and t < (s->>'lunch_to')::time) then
    return 'Lunch is ' || (s->>'lunch_from') || '–' || (s->>'lunch_to') || '.';
  end if;
  if p_interest in ('unli_pork','unli_beef_pork') and not (t >= (s->>'unli_from')::time and t <= (s->>'last_unli_seating_time' )::time) then
    return 'Unlimited grill bookings are ' || (s->>'unli_from') || '–' || (s->>'last_unli_seating_time') || '.';
  end if;
  return null;
end $$;

-- Public: available slots for a date (no login).
create or replace function public.public_availability(p_branch_code text, p_date date, p_party int, p_interest text) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare b branches; s jsonb; v_t time; v_at timestamptz; v_out jsonb := '[]';
begin
  select * into b from branches where code = p_branch_code;
  if not found then raise exception 'NOT_FOUND: Unknown branch.'; end if;
  s := app.settings(b.id);
  v_t := (s->>'opening_time')::time;
  while v_t < (s->>'closing_time')::time loop
    v_at := (p_date + v_t) at time zone b.timezone;
    v_out := v_out || jsonb_build_object('time', to_char(v_t, 'HH24:MI'), 'label', to_char(v_t, 'FMHH12:MI AM'),
      'available', app.slot_allowed(b.id, v_at, p_interest) is null and app.check_capacity(b.id, v_at, p_party, p_interest));
    v_t := v_t + make_interval(mins => (s->>'reservation_slot_minutes')::int);
  end loop;
  return jsonb_build_object('branch', jsonb_build_object('name', b.name, 'address', b.address, 'phone', b.contact_phone),
    'max_online_party', s->'max_online_party', 'slots', v_out);
end $$;

-- Public booking (§7.1). Turnstile is verified by the Edge Function before this is called.
create or replace function public.create_public_reservation(p_branch_code text, p_booking jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare b branches; s jsonb; r reservations; v_at timestamptz; v_err text; v_phone text; v_party int; v_hour time;
begin
  select * into b from branches where code = p_branch_code;
  if not found then raise exception 'NOT_FOUND: Unknown branch.'; end if;
  s := app.settings(b.id);
  if not coalesce((p_booking->>'consent_privacy')::boolean, false) then raise exception 'CONSENT_REQUIRED: Please agree to the privacy notice.'; end if;
  v_phone := app.normalize_ph_mobile(p_booking->>'phone');
  if v_phone is null then raise exception 'BAD_PHONE: Enter a PH mobile number like 0917 123 4567.'; end if;
  if coalesce(trim(p_booking->>'customer_name'),'') = '' then raise exception 'BAD_INPUT: Enter your name.'; end if;
  v_party := (p_booking->>'party_size')::int;
  if v_party < 1 then raise exception 'BAD_INPUT: Party size must be at least 1.'; end if;
  if v_party > (s->>'max_online_party')::int then
    raise exception 'PARTY_TOO_LARGE: For groups over %, please call us at %.', s->>'max_online_party', coalesce(b.contact_phone, 'the restaurant');
  end if;
  -- simple rate limit: 3 bookings per phone per hour
  if (select count(*) from reservations where phone = v_phone and created_at > app.now() - interval '1 hour') >= 3 then
    raise exception 'RATE_LIMIT: Too many bookings from this number. Please call us.';
  end if;
  v_at := ((p_booking->>'date')::date + (p_booking->>'time')::time) at time zone b.timezone;
  v_err := app.slot_allowed(b.id, v_at, coalesce(p_booking->>'package_interest','not_sure'));
  if v_err is not null then raise exception 'SLOT_UNAVAILABLE: %', v_err; end if;
  if not app.check_capacity(b.id, v_at, v_party, coalesce(p_booking->>'package_interest','not_sure')) then
    raise exception 'FULLY_BOOKED: That time is fully booked. Please pick another time.';
  end if;
  insert into reservations(branch_id, code, customer_name, phone, email, party_size, reserved_for, package_interest, notes, source,
    consent_privacy, consent_marketing)
  values (b.id, app.new_code(), trim(p_booking->>'customer_name'), v_phone, nullif(trim(p_booking->>'email'),''), v_party, v_at,
    coalesce(p_booking->>'package_interest','not_sure'), p_booking->>'notes', 'web', true,
    coalesce((p_booking->>'consent_marketing')::boolean, false))
  returning * into r;
  perform app.on_new_reservation(r);
  return jsonb_build_object('code', r.code, 'reserved_for', r.reserved_for, 'status', r.status);
end $$;

-- Staff alert: in-app + push now; email backup to the branch inbox always goes at once.
-- After-hours bookings hold the in-app/push alert until 30 min before opening (§7.3).
create or replace function app.on_new_reservation(r reservations) returns void language plpgsql as $$
declare b branches; s jsonb; v_t time; v_open timestamptz;
begin
  select * into b from branches where id = r.branch_id;
  s := app.settings(b.id);
  v_t := app.local_time(b.id, app.now());
  perform app.notify(r.branch_id, array['cashier','manager'], 'reservation_new',
    'New booking ' || r.code || ': ' || r.party_size || ' pax',
    r.customer_name || ' · ' || to_char(r.reserved_for at time zone b.timezone, 'Mon DD HH12:MI AM'), 'reservations', r.id, 'high');
  if b.email is not null then
    insert into outbound_messages(branch_id, reservation_id, channel, event, to_address, subject, body)
    values (b.id, r.id, 'email', 'staff_new_booking', b.email, 'New booking ' || r.code,
      r.customer_name || ' (' || r.phone || ') booked ' || r.party_size || ' pax for ' ||
      to_char(r.reserved_for at time zone b.timezone, 'Mon DD HH12:MI AM') || '. Open the app to confirm.');
  end if;
end $$;

create or replace function public.create_staff_reservation(p_token uuid, p_branch uuid, p_booking jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_actor uuid; r reservations; v_at timestamptz; v_phone text;
begin
  v_actor := app.require_role(p_token, p_branch, array['cashier','manager']);
  v_phone := coalesce(app.normalize_ph_mobile(p_booking->>'phone'), p_booking->>'phone');
  v_at := ((p_booking->>'date')::date + (p_booking->>'time')::time) at time zone (select timezone from branches where id = p_branch);
  insert into reservations(branch_id, code, customer_name, phone, email, party_size, reserved_for, package_interest, notes, source,
    consent_privacy, status, confirmed_by, confirmed_at)
  values (p_branch, app.new_code(), p_booking->>'customer_name', v_phone, nullif(p_booking->>'email',''), (p_booking->>'party_size')::int,
    v_at, coalesce(p_booking->>'package_interest','not_sure'), p_booking->>'notes', coalesce(p_booking->>'source','phone'), true,
    'confirmed', v_actor, app.now())
  returning * into r;
  perform app.queue_confirmation(r);
  return to_jsonb(r);
end $$;

-- Confirmation now; reminder 3 h before unless confirmed less than 3 h 30 min before (§7.3).
create or replace function app.queue_confirmation(r reservations) returns void language plpgsql as $$
declare v_rem int := (app.setting(r.branch_id, 'reservation_reminder_minutes'))::int;
begin
  perform app.queue_message(r, 'confirmed');
  if r.reserved_for - app.now() >= make_interval(mins => v_rem + 30) then
    perform app.queue_message(r, 'reminder', r.reserved_for - make_interval(mins => v_rem));
  end if;
end $$;

create or replace function public.confirm_reservation(p_token uuid, p_reservation_id uuid, p_table_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare r reservations; v_actor uuid;
begin
  select * into r from reservations where id = p_reservation_id for update;
  v_actor := app.require_role(p_token, r.branch_id, array['cashier','manager']);
  if r.status <> 'pending' then raise exception 'BAD_STATE: Only pending bookings can be confirmed.'; end if;
  update reservations set status = 'confirmed', confirmed_by = v_actor, confirmed_at = app.now(), table_id = p_table_id
   where id = r.id returning * into r;
  perform app.queue_confirmation(r);
  return to_jsonb(r);
end $$;

create or replace function public.decline_reservation(p_token uuid, p_reservation_id uuid, p_reason text, p_status text default 'declined') returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare r reservations;
begin
  select * into r from reservations where id = p_reservation_id for update;
  perform app.require_role(p_token, r.branch_id, array['cashier','manager']);
  if p_status not in ('declined','cancelled') then raise exception 'BAD_INPUT: status must be declined or cancelled.'; end if;
  if r.status not in ('pending','confirmed') then raise exception 'BAD_STATE: This booking can no longer be changed.'; end if;
  update reservations set status = p_status, decline_reason = p_reason where id = r.id returning * into r;
  update outbound_messages set status = 'cancelled' where reservation_id = r.id and status = 'queued' and event = 'reminder';
  perform app.queue_message(r, p_status, app.now(), p_reason);
  return to_jsonb(r);
end $$;

create or replace function public.mark_no_show(p_token uuid, p_reservation_id uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare r reservations;
begin
  select * into r from reservations where id = p_reservation_id for update;
  perform app.require_role(p_token, r.branch_id, array['cashier','manager']);
  if r.status not in ('pending','confirmed') then raise exception 'BAD_STATE: Cannot mark as no-show.'; end if;
  update reservations set status = 'no_show' where id = r.id returning * into r;
  update outbound_messages set status = 'cancelled' where reservation_id = r.id and status = 'queued';
  return to_jsonb(r);
end $$;

create or replace function public.get_reservations(p_branch uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare v_grace int := (app.setting(p_branch,'no_show_grace_minutes'))::int; v_tz text := (select timezone from branches where id = p_branch);
begin
  perform app.assert_branch(p_branch);
  return coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object(
      'table_label', (select label from dining_tables where id = r.table_id),
      'suggest_no_show', r.status = 'confirmed' and app.now() > r.reserved_for + make_interval(mins => v_grace),
      'messages', (select coalesce(jsonb_agg(jsonb_build_object('channel', channel, 'event', event, 'status', status, 'send_after', send_after, 'error', error) order by created_at), '[]')
                     from outbound_messages m where m.reservation_id = r.id and m.event <> 'staff_new_booking'))
      order by r.reserved_for)
    from reservations r where r.branch_id = p_branch
      and (r.reserved_for at time zone v_tz)::date between p_from and p_to), '[]');
end $$;

-- Unconfirmed bookings older than 15 min re-alert the manager (§7.2). Run every minute (pg_cron).
create or replace function public.realert_unconfirmed() returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare r reservations; v_n int := 0;
begin
  for r in select * from reservations where status = 'pending' and realerted_at is null and created_at < app.now() - interval '15 minutes' loop
    perform app.notify(r.branch_id, array['manager'], 'reservation_unconfirmed', 'Booking ' || r.code || ' still unconfirmed',
      r.customer_name || ', ' || r.party_size || ' pax', 'reservations', r.id, 'high');
    update reservations set realerted_at = app.now() where id = r.id;
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('realerted', v_n);
end $$;

-- ───────── Notifications for the current user/device ─────────
create or replace function public.get_notifications(p_token uuid, p_branch uuid, p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare v_user uuid := app.actor(p_token); v_role text := app.role_of(v_user, p_branch);
begin
  perform app.assert_branch(p_branch);
  return coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'priority', n.priority, 'title', n.title, 'body', n.body,
      'ref_table', n.ref_table, 'ref_id', n.ref_id, 'created_at', n.created_at, 'read', v_user = any(n.read_by)) order by n.created_at desc)
    from (select * from notifications n where n.branch_id = p_branch
            and (v_role in ('owner','admin') or v_role = any(n.target_roles) or n.target_user = v_user)
          order by created_at desc limit p_limit) n), '[]');
end $$;

create or replace function public.mark_notifications_read(p_token uuid, p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_user uuid := app.actor(p_token);
begin
  update notifications set read_by = array_append(read_by, v_user)
   where id = any(p_ids) and not (v_user = any(read_by)) and branch_id in (select app.my_branches());
  return jsonb_build_object('ok', true);
end $$;

-- ───────── Reports (§8.2) ─────────
create or replace function public.shift_summary(p_branch uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
begin
  perform app.assert_branch(p_branch);
  return jsonb_build_object('business_date', p_date,
    'sales', public.report_sales_summary(p_branch, p_date, p_date),
    'waste', coalesce((select jsonb_agg(jsonb_build_object('name', i.name, 'qty', w.qty, 'base_unit', i.base_unit, 'reason', w.reason,
        'value', round(w.qty * coalesce(w.unit_cost_at_time,0), 2)))
      from waste_logs w join items i on i.id = w.item_id where w.branch_id = p_branch and w.business_date = p_date), '[]'),
    'variances', coalesce((select jsonb_agg(jsonb_build_object('name', i.name, 'variance_qty', l.variance_qty, 'base_unit', i.base_unit,
        'variance_value', l.variance_value, 'reason', l.reason) order by abs(l.variance_value) desc)
      from stock_count_lines l join stock_counts c on c.id = l.count_id join items i on i.id = l.item_id
      where c.branch_id = p_branch and c.business_date = p_date and c.count_type = 'closing' and l.variance_qty <> 0), '[]'),
    'low_stock', coalesce((select jsonb_agg(jsonb_build_object('name', i.name, 'qty', l.qty_on_hand, 'base_unit', i.base_unit))
      from items i join item_stock_levels l on l.item_id = i.id where i.branch_id = p_branch and i.is_active and l.qty_on_hand <= i.reorder_level and i.stage <> 'supply'), '[]'),
    'notes', (select string_agg(notes, ' / ') from stock_counts where branch_id = p_branch and business_date = p_date and notes is not null));
end $$;

create or replace function public.report_sales_summary(p_branch uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
begin
  perform app.assert_branch(p_branch);
  return jsonb_build_object(
    'days', coalesce((select jsonb_agg(d order by d->>'business_date') from (
      select jsonb_build_object('business_date', s.business_date,
        'sessions', count(distinct s.id),
        'pax', (select coalesce(sum(pax_count),0) from session_pax p join table_sessions s2 on s2.id = p.session_id
                 where s2.branch_id = p_branch and s2.business_date = s.business_date and s2.status = 'closed'),
        'gross', coalesce(sum(i.total + i.discount_total),0), 'discounts', coalesce(sum(i.discount_total),0),
        'net', coalesce(sum(i.total),0), 'vat', coalesce(sum(i.vat_amount),0)) d
      from table_sessions s join bills b on b.session_id = s.id join invoices i on i.bill_id = b.id and i.status = 'issued'
      where s.branch_id = p_branch and s.business_date between p_from and p_to group by s.business_date) x), '[]'),
    'pax_by_type', coalesce((select jsonb_object_agg(name, n) from (
      select d.name, sum(p.pax_count) n from session_pax p join discount_types d on d.id = p.discount_type_id
        join table_sessions s on s.id = p.session_id where s.branch_id = p_branch and s.business_date between p_from and p_to and s.status = 'closed'
      group by d.name) x), '{}'),
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'item_type', item_type, 'qty', q, 'net', n) order by item_type, name) from (
      select m.name, m.item_type, sum(o.qty) q, sum(o.net_amount) n from order_lines o join menu_items m on m.id = o.menu_item_id
        join table_sessions s on s.id = o.session_id
       where s.branch_id = p_branch and s.business_date between p_from and p_to and o.status = 'active' and s.status = 'closed'
       group by m.name, m.item_type) x), '[]'),
    'payments', coalesce((select jsonb_object_agg(method, amt) from (
      select p.method, sum(p.amount) amt from payments p join bills b on b.id = p.bill_id join table_sessions s on s.id = b.session_id
        join invoices i on i.bill_id = b.id and i.status = 'issued'
       where s.branch_id = p_branch and s.business_date between p_from and p_to group by p.method) x), '{}'),
    'refills', jsonb_build_object(
      'rounds', (select count(*) from refill_rounds r join table_sessions s on s.id = r.session_id
                  where s.branch_id = p_branch and s.business_date between p_from and p_to and r.status <> 'voided'),
      'plates', (select coalesce(sum(l.plates),0) from refill_lines l join refill_rounds r on r.id = l.round_id join table_sessions s on s.id = r.session_id
                  where s.branch_id = p_branch and s.business_date between p_from and p_to and r.status <> 'voided')),
    'voids', (select count(*) from invoices where branch_id = p_branch and business_date between p_from and p_to and status = 'voided'),
    'invoice_range', (select jsonb_build_object('first', min(invoice_no), 'last', max(invoice_no), 'booklet', count(*) filter (where manual_booklet_no is not null))
                       from invoices where branch_id = p_branch and business_date between p_from and p_to));
end $$;

-- Weekly usage tracker: actual (from counts) vs theoretical (POS deductions) (§8.2).
create or replace function public.report_usage(p_branch uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
begin
  perform app.assert_branch(p_branch);
  return coalesce((select jsonb_agg(row_to_json(x)::jsonb order by x.week, x.sort_order, x.name) from (
    select date_trunc('week', m.business_date)::date as week, i.name, i.base_unit, i.sort_order,
      sum(m.qty_delta) filter (where m.movement_type in ('delivery_in','opening_balance')) as stock_in,
      sum(m.qty_delta) filter (where m.movement_type = 'production_in') as production_in,
      -sum(m.qty_delta) filter (where m.movement_type = 'production_out') as production_out,
      -sum(m.qty_delta) filter (where m.movement_type = 'waste') as waste,
      -sum(m.qty_delta) filter (where m.movement_type in ('sale','refill','void_reversal')) as theoretical,
      -sum(m.qty_delta) filter (where m.movement_type in ('sale','refill','void_reversal','count_adjustment','usage_import')) as actual,
      -sum(m.qty_delta) filter (where m.movement_type = 'count_adjustment') as gap,
      round(-sum(m.qty_delta * m.unit_cost) filter (where m.movement_type = 'count_adjustment'), 2) as gap_value
    from stock_movements m join items i on i.id = m.item_id
    where m.branch_id = p_branch and m.business_date between p_from and p_to
    group by 1, i.name, i.base_unit, i.sort_order) x), '[]');
end $$;

create or replace function public.report_waste(p_branch uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
begin
  perform app.assert_branch(p_branch);
  return jsonb_build_object(
    'logged', coalesce((select jsonb_agg(jsonb_build_object('business_date', w.business_date, 'name', i.name, 'qty', w.qty, 'base_unit', i.base_unit,
        'reason', w.reason, 'note', w.note, 'by', p.full_name, 'value', round(w.qty * coalesce(w.unit_cost_at_time,0), 2)) order by w.business_date desc, i.name)
      from waste_logs w join items i on i.id = w.item_id left join profiles p on p.id = w.logged_by
      where w.branch_id = p_branch and w.business_date between p_from and p_to), '[]'),
    -- prep trim is computed from production runs, not logged as waste (§5.3)
    'prep_trim', coalesce((select jsonb_agg(jsonb_build_object('business_date', r.business_date, 'name', i.name,
        'input', (select sum(qty_used) from production_run_inputs where run_id = r.id), 'output', r.output_qty_actual,
        'trim', (select sum(qty_used) from production_run_inputs where run_id = r.id) - r.output_qty_actual))
      from production_runs r join prep_recipes pr on pr.id = r.recipe_id join items i on i.id = pr.output_item_id
      where r.branch_id = p_branch and r.business_date between p_from and p_to
        and (select sum(qty_used) from production_run_inputs where run_id = r.id) > r.output_qty_actual), '[]'));
end $$;

create or replace function public.report_variance(p_branch uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
begin
  perform app.assert_branch(p_branch);
  return jsonb_build_object(
    'lines', coalesce((select jsonb_agg(jsonb_build_object('business_date', c.business_date, 'count_type', c.count_type, 'name', i.name,
        'base_unit', i.base_unit, 'expected', l.expected_qty, 'counted', l.counted_qty, 'variance', l.variance_qty,
        'variance_pct', case when l.expected_qty <> 0 then round(l.variance_qty / abs(l.expected_qty) * 100, 1) end,
        'value', l.variance_value, 'reason', l.reason, 'flagged', l.needs_reason) order by c.business_date desc, abs(l.variance_value) desc)
      from stock_count_lines l join stock_counts c on c.id = l.count_id join items i on i.id = l.item_id
      where c.branch_id = p_branch and c.business_date between p_from and p_to and l.variance_qty <> 0), '[]'),
    'repeat_offenders', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'times', n, 'value', v) order by n desc, v) from (
      select i.name, count(*) n, sum(l.variance_value) v from stock_count_lines l join stock_counts c on c.id = l.count_id join items i on i.id = l.item_id
       where c.branch_id = p_branch and c.business_date between p_from and p_to and l.needs_reason group by i.name having count(*) >= 2) x), '[]'));
end $$;

-- Simple vs weighted purchase averages; weighted is the costing basis (§8.2).
create or replace function public.report_avg_cost(p_branch uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
begin
  perform app.assert_branch(p_branch);
  return coalesce((select jsonb_agg(row_to_json(x)::jsonb order by x.name, x.supplier) from (
    select i.name, i.count_unit, i.count_unit_factor, coalesce(s.name, '—') supplier, count(*) deliveries,
      sum(dl.qty_base) qty, sum(dl.line_total) spent,
      round(avg(dl.unit_cost) * i.count_unit_factor, 2) simple_avg_per_count_unit,
      round(sum(dl.line_total) / sum(dl.qty_base) * i.count_unit_factor, 2) weighted_avg_per_count_unit,
      round(min(dl.unit_cost) * i.count_unit_factor, 2) min_price, round(max(dl.unit_cost) * i.count_unit_factor, 2) max_price,
      jsonb_agg(jsonb_build_object('date', d.business_date, 'price', round(dl.unit_cost * i.count_unit_factor, 2)) order by d.received_at) trend
    from delivery_lines dl join deliveries d on d.id = dl.delivery_id join items i on i.id = dl.item_id left join suppliers s on s.id = d.supplier_id
    where d.branch_id = p_branch and d.business_date between p_from and p_to
    group by i.name, i.count_unit, i.count_unit_factor, s.name) x), '[]');
end $$;

create or replace function public.report_refills(p_branch uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
begin
  perform app.assert_branch(p_branch);
  return jsonb_build_object(
    'by_cut', coalesce((select jsonb_agg(jsonb_build_object('name', i.name, 'plates', sum_p) order by sum_p desc) from (
       select l.item_id, sum(l.plates) sum_p from refill_lines l join refill_rounds r on r.id = l.round_id join table_sessions s on s.id = r.session_id
        where s.branch_id = p_branch and s.business_date between p_from and p_to and r.status <> 'voided' group by l.item_id) x join items i on i.id = x.item_id), '[]'),
    'by_hour', coalesce((select jsonb_agg(jsonb_build_object('hour', h, 'plates', p) order by h) from (
       select extract(hour from r.requested_at at time zone 'Asia/Manila')::int h, sum(l.plates) p from refill_lines l join refill_rounds r on r.id = l.round_id
         join table_sessions s on s.id = r.session_id where s.branch_id = p_branch and s.business_date between p_from and p_to and r.status <> 'voided' group by 1) x), '[]'),
    'plates_per_pax', (select round(sum(l.plates)::numeric / nullif((select sum(pax_count) from session_pax p join table_sessions s2 on s2.id = p.session_id
         where s2.branch_id = p_branch and s2.business_date between p_from and p_to and s2.package_id is not null), 0), 2)
       from refill_lines l join refill_rounds r on r.id = l.round_id join table_sessions s on s.id = r.session_id
       where s.branch_id = p_branch and s.business_date between p_from and p_to and r.status <> 'voided'));
end $$;

-- ───────── 8.1 Owner dashboard ─────────
create or replace function public.get_dashboard(p_branch uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare v_today date := app.business_date(p_branch); v_tz text := (select timezone from branches where id = p_branch);
  v_net numeric; v_cost numeric;
begin
  perform app.assert_branch(p_branch);
  select coalesce(sum(i.total),0) into v_net from invoices i where i.branch_id = p_branch and i.business_date = v_today and i.status = 'issued';
  select coalesce(-sum(qty_delta * unit_cost),0) into v_cost from stock_movements
   where branch_id = p_branch and business_date = v_today and movement_type in ('sale','refill','void_reversal');
  return jsonb_build_object('business_date', v_today,
    'sales', public.report_sales_summary(p_branch, v_today, v_today),
    'tables_active', (select count(*) from table_sessions where branch_id = p_branch and status in ('open','billing')),
    'pax_seated_now', (select coalesce(sum(p.pax_count),0) from session_pax p join table_sessions s on s.id = p.session_id where s.branch_id = p_branch and s.status in ('open','billing')),
    'watch', coalesce((select jsonb_agg(x) from jsonb_array_elements(public.get_live_stock(p_branch)) x where (x->>'is_watch')::boolean), '[]'),
    'alerts', jsonb_build_object(
      'low', (select count(*) from items i join item_stock_levels l on l.item_id = i.id where i.branch_id = p_branch and i.is_active and i.stage <> 'supply' and l.qty_on_hand <= i.reorder_level and l.qty_on_hand > 0),
      'out', (select count(*) from items i join item_stock_levels l on l.item_id = i.id where i.branch_id = p_branch and i.is_active and i.stage <> 'supply' and l.qty_on_hand <= 0),
      'near_expiry', jsonb_array_length(public.get_near_expiry(p_branch)),
      'large_variances', (select count(*) from stock_count_lines l join stock_counts c on c.id = l.count_id where c.branch_id = p_branch and c.business_date >= v_today - 7 and l.needs_reason),
      'unconfirmed_reservations', (select count(*) from reservations where branch_id = p_branch and status = 'pending'),
      'reorders_waiting', (select count(*) from reorder_lists where branch_id = p_branch and status = 'manager_approved')),
    'reservations', jsonb_build_object(
      'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from reservations
          where branch_id = p_branch and (reserved_for at time zone v_tz)::date = v_today group by status) x), '{}'),
      'next', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'name', customer_name, 'party_size', party_size, 'reserved_for', reserved_for, 'status', status) order by reserved_for)
          from (select * from reservations where branch_id = p_branch and status in ('pending','confirmed') and reserved_for >= app.now() - interval '30 minutes' order by reserved_for limit 5) r), '[]')),
    'food_cost', jsonb_build_object('theoretical', round(v_cost, 2), 'pct', case when v_net > 0 then round(v_cost / v_net * 100, 1) end));
end $$;

-- Owner/manager list of branches with today's headline numbers (branch switcher).
create or replace function public.get_message_log(p_branch uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
begin
  perform app.assert_branch(p_branch);
  return coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at desc) from (
    select * from outbound_messages where branch_id = p_branch order by created_at desc limit 100) m), '[]');
end $$;

-- ───────── Sync conflicts and push subscriptions ─────────
-- An offline action the server rejected on sync is flagged to the manager, never silently dropped (§10).
create or replace function public.report_sync_conflict(p_token uuid, p_branch uuid, p_action text, p_error text) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_user uuid := app.actor(p_token);
begin
  perform app.assert_branch(p_branch);
  perform app.notify(p_branch, array['manager'], 'sync_conflict', 'Offline action rejected: ' || p_action,
    (select full_name from profiles where id = v_user) || ' — ' || p_error, null, null, 'high');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.save_push_subscription(p_token uuid, p_branch uuid, p_endpoint text, p_keys jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_user uuid := app.actor(p_token);
begin
  perform app.assert_branch(p_branch);
  insert into push_subscriptions(branch_id, user_id, device_id, endpoint, keys)
  values (p_branch, v_user, (select id from devices where auth_user_id = auth.uid()), p_endpoint, p_keys)
  on conflict (endpoint) do update set user_id = excluded.user_id, keys = excluded.keys;
  return jsonb_build_object('ok', true);
end $$;
