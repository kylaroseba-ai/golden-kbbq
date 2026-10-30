-- POS (§6): sessions, time windows, order lines, refill rounds, kitchen tickets, billing, invoices, X/Z readings.

-- ───────── Pricing (§6.2 calculation order) ─────────
-- Prices are VAT-inclusive. Each line is rounded to the centavo when created.
create or replace function app.price_line(p_branch uuid, p_unit_price numeric, p_qty numeric, p_discount uuid, p_vat_exempt boolean,
  out gross numeric, out discount numeric, out net numeric, out vatable numeric, out vat numeric, out exempt numeric)
language plpgsql stable as $$
declare d discount_types; v_unit_net numeric; v_vat_reg boolean := (app.setting(p_branch, 'vat_registered'))::boolean;
begin
  gross := round(p_unit_price * p_qty, 2);
  if p_discount is not null then select * into d from discount_types where id = p_discount; end if;
  if d.kind = 'sc_pwd_vat_exempt' then
    v_unit_net := round(p_unit_price / 1.12 * (1 - d.value), 2);        -- ₱499 → ₱356.43
    net := round(v_unit_net * p_qty, 2);
    vatable := 0; vat := 0; exempt := net;
  else
    if d.kind = 'percent' then v_unit_net := round(p_unit_price * (1 - d.value), 2);
    elsif d.kind = 'fixed_price' then v_unit_net := d.value;
    else v_unit_net := p_unit_price; end if;
    net := round(v_unit_net * p_qty, 2);
    if v_vat_reg and not p_vat_exempt then
      vat := round(net / 1.12 * 0.12, 2); vatable := net - vat; exempt := 0;
    else
      vat := 0; vatable := 0; exempt := net;
    end if;
  end if;
  discount := gross - net;
end $$;

-- Lunch sets only in the lunch window, unli only in the unli window (§6.1), on the corrected device clock.
create or replace function app.check_time_window(p_branch uuid, p_item_type text, p_at timestamptz) returns text
language plpgsql stable as $$
declare s jsonb := app.settings(p_branch); t time := app.local_time(p_branch, p_at);
begin
  if p_item_type = 'set_meal' and not (t >= (s->>'lunch_from')::time and t < (s->>'lunch_to')::time) then
    return 'Lunch sets are only served ' || (s->>'lunch_from') || '–' || (s->>'lunch_to') || '.';
  end if;
  if p_item_type = 'unli_package' and not (t >= (s->>'unli_from')::time and t < (s->>'unli_to')::time) then
    return 'Unlimited grill starts at ' || (s->>'unli_from') || '.';
  end if;
  return null;
end $$;

create or replace function app.add_order_line(p_session table_sessions, p_menu_item uuid, p_qty numeric, p_discount uuid,
  p_actor uuid, p_at timestamptz, p_override uuid, p_client_uuid uuid, p_ticket uuid) returns uuid
language plpgsql as $$
declare m menu_items; pr record; v_id uuid := gen_random_uuid(); pr_rule record; v_mult numeric; v_err text; d discount_types;
begin
  select * into m from menu_items where id = p_menu_item and branch_id = p_session.branch_id;
  if not found or not m.is_active then raise exception 'BAD_INPUT: That menu item is not available.'; end if;
  v_err := app.check_time_window(p_session.branch_id, m.item_type, p_at);
  if v_err is not null and p_override is null then raise exception 'TIME_WINDOW: % Manager PIN can override.', v_err; end if;
  if p_discount is not null then
    select * into d from discount_types where id = p_discount and branch_id = p_session.branch_id;
    if d.requires_manager_pin and p_override is null then raise exception 'NEEDS_MANAGER: % needs a manager PIN.', d.name; end if;
  end if;
  pr := app.price_line(p_session.branch_id, m.price, p_qty, p_discount, m.vat_exempt);
  insert into order_lines(id, branch_id, session_id, menu_item_id, qty, unit_price, discount_type_id, gross_amount, discount_amount,
    net_amount, vatable_sales, vat_amount, vat_exempt_sales, override_by, client_uuid, created_by, occurred_at)
  values (v_id, p_session.branch_id, p_session.id, m.id, p_qty, m.price, p_discount, pr.gross, pr.discount, pr.net, pr.vatable,
    pr.vat, pr.exempt, case when v_err is not null or d.requires_manager_pin then p_override end, p_client_uuid, p_actor, p_at);
  -- portion-rule deductions
  for pr_rule in select item_id, qty, basis from portion_rules where menu_item_id = m.id loop
    v_mult := case pr_rule.basis when 'per_table' then 1 else p_qty end;
    if pr_rule.basis = 'per_table' and exists (select 1 from order_lines where session_id = p_session.id and menu_item_id = m.id and id <> v_id and status = 'active') then
      continue;
    end if;
    perform app.deduct_stock(p_session.branch_id, pr_rule.item_id, 'sale', pr_rule.qty * v_mult, 'order_lines', v_id, p_actor, p_at);
  end loop;
  if m.needs_kitchen and p_ticket is not null then
    insert into kitchen_ticket_lines(branch_id, ticket_id, label, qty, ref_table, ref_id)
    values (p_session.branch_id, p_ticket, m.name, p_qty, 'order_lines', v_id);
  end if;
  return v_id;
end $$;

create or replace function app.table_labels(p_ids uuid[]) returns text language sql stable as $$
  select string_agg(label, ' & ' order by sort_order, label) from dining_tables where id = any(p_ids)
$$;

-- ───────── 6.3 Open table ─────────
-- p_pax: [{discount_type_id, pax_count}] — one package per session; pax types may differ.
create or replace function public.open_session(p_client_uuid uuid, p_token uuid, p_branch uuid, p_session_id uuid,
  p_table_ids uuid[], p_package_id uuid, p_pax jsonb, p_reservation_id uuid default null,
  p_occurred_at timestamptz default null, p_override uuid default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_actor uuid; v_ovr uuid; s table_sessions; v_at timestamptz := app.effective_time(p_occurred_at); m menu_items;
  v_timer int; v_cut int; x jsonb; v_ticket uuid; v_last time; v_err text; r jsonb := app.idem_get(p_client_uuid);
  v_any_discount_ovr boolean := false;
begin
  if r is not null then return r; end if;
  v_actor := app.require_role(p_token, p_branch, array['server','cashier','manager']);
  v_ovr := case when p_override is not null then app.require_override(p_override, p_branch) end;
  if coalesce(array_length(p_table_ids, 1), 0) = 0 then raise exception 'BAD_INPUT: Pick at least one table.'; end if;
  if exists (select 1 from table_sessions where branch_id = p_branch and status in ('open','billing') and table_ids && p_table_ids) then
    raise exception 'TABLE_BUSY: That table already has an open bill.';
  end if;
  if p_package_id is not null then
    select * into m from menu_items where id = p_package_id and branch_id = p_branch and item_type = 'unli_package';
    if not found then raise exception 'BAD_INPUT: Unknown package.'; end if;
    v_err := app.check_time_window(p_branch, 'unli_package', v_at);
    v_last := (app.setting(p_branch, 'last_unli_seating_time') #>> '{}')::time;
    if v_err is null and app.local_time(p_branch, v_at) > v_last then
      v_err := 'Last unli seating is ' || to_char(v_last, 'FMHH12:MI AM') || '.';
    end if;
    if v_err is not null and v_ovr is null then raise exception 'TIME_WINDOW: % Manager PIN can override.', v_err; end if;
    v_timer := (app.setting(p_branch, 'unli_timer_minutes'))::int;
    v_cut := (app.setting(p_branch, 'last_refill_cutoff_minutes_before_end'))::int;
  end if;
  insert into table_sessions(id, branch_id, business_date, table_ids, package_id, reservation_id, opened_by, opened_at,
    timer_minutes, timer_ends_at, refill_cutoff_at, sales_channel, client_uuid)
  values (p_session_id, p_branch, app.business_date(p_branch, v_at), p_table_ids, p_package_id, p_reservation_id, v_actor, v_at,
    v_timer, v_at + make_interval(mins => v_timer), v_at + make_interval(mins => v_timer - v_cut),
    case when p_reservation_id is not null then 'reservation' else 'walk_in' end, p_client_uuid)
  returning * into s;
  for x in select * from jsonb_array_elements(coalesce(p_pax, '[]')) loop
    insert into session_pax(branch_id, session_id, discount_type_id, menu_item_id, pax_count)
    values (p_branch, s.id, (x->>'discount_type_id')::uuid, p_package_id, (x->>'pax_count')::int);
    if p_package_id is not null then
      perform app.add_order_line(s, p_package_id, (x->>'pax_count')::numeric, (x->>'discount_type_id')::uuid, v_actor, v_at,
        v_ovr, null, null);
    end if;
  end loop;
  update dining_tables set status = 'seated' where id = any(p_table_ids) and branch_id = p_branch;
  if p_reservation_id is not null then
    update reservations set status = 'seated', session_id = s.id, table_id = p_table_ids[1]
     where id = p_reservation_id and branch_id = p_branch;
  end if;
  return app.idem_put(p_client_uuid, p_branch, 'open_session', jsonb_build_object('id', s.id, 'timer_ends_at', s.timer_ends_at, 'refill_cutoff_at', s.refill_cutoff_at));
end $$;

-- ───────── 6.6 Orders for sets, add-ons, drinks, fees ─────────
-- p_lines: [{menu_item_id, qty, discount_type_id}]
create or replace function public.post_order_lines(p_client_uuid uuid, p_token uuid, p_session_id uuid, p_lines jsonb,
  p_occurred_at timestamptz default null, p_override uuid default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare s table_sessions; v_actor uuid; v_ovr uuid; v_at timestamptz := app.effective_time(p_occurred_at); x jsonb;
  v_ticket uuid := gen_random_uuid(); v_ids uuid[] := '{}'; r jsonb := app.idem_get(p_client_uuid);
begin
  if r is not null then return r; end if;
  select * into s from table_sessions where id = p_session_id for update;
  if not found then raise exception 'NOT_FOUND: Table session not found.'; end if;
  v_actor := app.require_role(p_token, s.branch_id, array['server','cashier','manager']);
  if s.status <> 'open' then raise exception 'SESSION_CLOSED: This table is already billing or closed.'; end if;
  v_ovr := case when p_override is not null then app.require_override(p_override, s.branch_id) end;
  insert into kitchen_tickets(id, branch_id, session_id, source, title, created_by)
  values (v_ticket, s.branch_id, s.id, 'order', 'New order', v_actor);
  for x in select * from jsonb_array_elements(p_lines) loop
    v_ids := v_ids || app.add_order_line(s, (x->>'menu_item_id')::uuid, coalesce((x->>'qty')::numeric, 1),
      (x->>'discount_type_id')::uuid, v_actor, v_at, v_ovr, null, v_ticket);
  end loop;
  update kitchen_tickets set source_id = v_ids[1] where id = v_ticket;
  if not exists (select 1 from kitchen_ticket_lines where ticket_id = v_ticket) then
    delete from kitchen_tickets where id = v_ticket;   -- nothing to prepare
    v_ticket := null;
  end if;
  return app.idem_put(p_client_uuid, s.branch_id, 'post_order_lines', jsonb_build_object('line_ids', to_jsonb(v_ids), 'ticket_id', v_ticket));
end $$;

-- ───────── 6.4 Refill rounds ─────────
-- p_lines: [{item_id, plates}]
create or replace function public.post_refill_round(p_client_uuid uuid, p_token uuid, p_session_id uuid, p_lines jsonb,
  p_occurred_at timestamptz default null, p_override uuid default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare s table_sessions; v_actor uuid; v_ovr uuid; v_at timestamptz := app.effective_time(p_occurred_at);
  v_limit int; v_meat int := 0; v_prev refill_rounds; v_round uuid := gen_random_uuid(); v_no int; v_ticket uuid := gen_random_uuid();
  x jsonb; i items; v_gpp numeric; v_line uuid; v_over boolean := false; v_late boolean;
  v_set jsonb; r jsonb := app.idem_get(p_client_uuid);
begin
  if r is not null then return r; end if;
  -- lock the session: two servers refilling the same table are serialized here (§14.1 concurrency)
  select * into s from table_sessions where id = p_session_id for update;
  if not found then raise exception 'NOT_FOUND: Table session not found.'; end if;
  v_actor := app.require_role(p_token, s.branch_id, array['server','cashier','manager']);
  v_set := app.settings(s.branch_id);
  if s.status <> 'open' then raise exception 'SESSION_CLOSED: This table is already billing or closed.'; end if;
  if s.package_id is null then raise exception 'NO_REFILLS: Refills are only for unlimited packages.'; end if;
  v_ovr := case when p_override is not null then app.require_override(p_override, s.branch_id) end;
  if jsonb_array_length(coalesce(p_lines,'[]')) = 0 then raise exception 'BAD_INPUT: Pick at least one plate.'; end if;

  -- refill cutoff (45 min before the 2-hour limit)
  if v_at >= s.refill_cutoff_at and v_ovr is null then
    raise exception 'REFILL_CUTOFF: Refill cutoff reached.';
  end if;
  -- previous round must be served (all meat lines)
  select * into v_prev from refill_rounds where session_id = s.id and status <> 'voided' order by round_no desc limit 1;
  if found and v_prev.status <> 'served' and (v_set->>'require_prev_round_served')::boolean then
    raise exception 'PREV_NOT_SERVED: Round % is not served yet.', v_prev.round_no;
  end if;
  -- plate limit: per table × number of merged tables (§6.4)
  v_limit := (v_set->>'max_meat_plates_per_round')::int * array_length(s.table_ids, 1);
  for x in select * from jsonb_array_elements(p_lines) loop
    select * into i from items where id = (x->>'item_id')::uuid and branch_id = s.branch_id and is_active;
    if not found or not i.is_refillable then raise exception 'BAD_INPUT: That item is not a refill item.'; end if;
    if (v_set->>'enforce_package_items')::boolean
       and not exists (select 1 from package_refill_items where package_id = s.package_id and item_id = i.id) then
      raise exception 'NOT_IN_PACKAGE: % is not included in this package.', i.name;
    end if;
    if i.is_meat then v_meat := v_meat + (x->>'plates')::int; end if;
  end loop;
  if v_meat > v_limit then
    if v_ovr is null then raise exception 'PLATE_LIMIT: Limit is % plates per round.', v_limit; end if;
    v_over := true;
  end if;

  v_no := coalesce((select max(round_no) from refill_rounds where session_id = s.id), 0) + 1;
  insert into refill_rounds(id, branch_id, session_id, round_no, requested_by, requested_at, override_by, client_uuid)
  values (v_round, s.branch_id, s.id, v_no, v_actor, v_at,
          case when v_over or v_at >= s.refill_cutoff_at then v_ovr end, p_client_uuid);
  insert into kitchen_tickets(id, branch_id, session_id, source, source_id, title, created_by)
  values (v_ticket, s.branch_id, s.id, 'refill_round', v_round, 'Refill round ' || v_no, v_actor);
  for x in select * from jsonb_array_elements(p_lines) loop
    select * into i from items where id = (x->>'item_id')::uuid;
    v_gpp := coalesce(i.grams_per_plate, (v_set->>'default_grams_per_plate')::numeric);
    insert into refill_lines(branch_id, round_id, item_id, plates, grams_per_plate_at_time)
    values (s.branch_id, v_round, i.id, (x->>'plates')::int, v_gpp) returning id into v_line;
    perform app.deduct_stock(s.branch_id, i.id, 'refill', (x->>'plates')::int * v_gpp, 'refill_lines', v_line, v_actor, v_at);
    insert into kitchen_ticket_lines(branch_id, ticket_id, label, qty, item_id, is_meat, ref_table, ref_id)
    values (s.branch_id, v_ticket, i.name, (x->>'plates')::int, i.id, i.is_meat, 'refill_lines', v_line);
  end loop;
  -- a late-synced round that would break the cutoff at receive time is flagged (§10.1)
  v_late := app.now() - v_at > make_interval(mins => (v_set->>'late_sync_flag_minutes')::int);
  if v_late and app.now() >= s.refill_cutoff_at then
    perform app.notify(s.branch_id, array['manager'], 'late_sync', 'Late-synced refill: ' || app.table_labels(s.table_ids),
      'Round ' || v_no || ' was tapped at ' || to_char(v_at at time zone 'Asia/Manila', 'FMHH12:MI AM') || ' and synced after the cutoff.',
      'refill_rounds', v_round, 'high');
  end if;
  return app.idem_put(p_client_uuid, s.branch_id, 'post_refill_round', jsonb_build_object('round_id', v_round, 'round_no', v_no, 'ticket_id', v_ticket));
end $$;

-- Round is served once all its meat lines are served; unserved side dishes don't block (§6.4).
create or replace function app.refresh_round(p_ticket uuid) returns void language plpgsql as $$
declare t kitchen_tickets; v_open int; v_meat_open int;
begin
  select * into t from kitchen_tickets where id = p_ticket;
  select count(*) filter (where served_at is null and not voided), count(*) filter (where served_at is null and not voided and is_meat)
    into v_open, v_meat_open from kitchen_ticket_lines where ticket_id = p_ticket;
  update kitchen_tickets set status = case when v_open = 0 then 'served' else 'partially_served' end,
    served_at = case when v_open = 0 then app.now() end
  where id = p_ticket and status <> 'voided';
  if t.source = 'refill_round' and v_meat_open = 0 then
    update refill_rounds set status = 'served', served_at = coalesce(served_at, app.now()),
      served_by = coalesce(served_by, (select served_by from kitchen_ticket_lines where ticket_id = p_ticket and served_by is not null limit 1))
     where id = t.source_id and status = 'queued';
  end if;
end $$;

create or replace function public.mark_ticket_served(p_token uuid, p_ticket_id uuid, p_line_ids uuid[] default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare t kitchen_tickets; v_actor uuid;
begin
  select * into t from kitchen_tickets where id = p_ticket_id for update;
  if not found then raise exception 'NOT_FOUND: Ticket not found.'; end if;
  v_actor := app.require_role(p_token, t.branch_id, array['kitchen','server','manager']);
  update kitchen_ticket_lines set served_at = app.now(), served_by = v_actor
   where ticket_id = t.id and served_at is null and not voided and (p_line_ids is null or id = any(p_line_ids));
  perform app.refresh_round(t.id);
  return jsonb_build_object('ok', true);
end $$;

-- Stuck round: a manager marks it served from the server's phone (audited via refill_rounds trigger).
create or replace function public.force_serve_round(p_token uuid, p_round_id uuid, p_override uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare rr refill_rounds; v_mgr uuid;
begin
  select * into rr from refill_rounds where id = p_round_id for update;
  perform app.require_role(p_token, rr.branch_id, array['server','cashier','kitchen','manager']);
  v_mgr := app.override_by(p_token, p_override, rr.branch_id);
  if v_mgr is null then raise exception 'NEEDS_MANAGER: Manager PIN needed.'; end if;
  perform set_config('app.actor', v_mgr::text, true);
  update kitchen_ticket_lines l set served_at = app.now(), served_by = v_mgr
    from kitchen_tickets t where t.id = l.ticket_id and t.source = 'refill_round' and t.source_id = rr.id and l.served_at is null;
  update refill_rounds set status = 'served', served_at = app.now(), served_by = v_mgr, override_by = v_mgr where id = rr.id;
  update kitchen_tickets set status = 'served', served_at = app.now(), served_by = v_mgr where source = 'refill_round' and source_id = rr.id;
  return jsonb_build_object('ok', true);
end $$;

-- ───────── Voids (§6.6) ─────────
create or replace function public.void_order_line(p_token uuid, p_line_id uuid, p_reason text, p_override uuid default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare ol order_lines; s table_sessions; v_actor uuid; v_mgr uuid; v_served boolean;
begin
  select * into ol from order_lines where id = p_line_id for update;
  if not found or ol.status = 'voided' then raise exception 'NOT_FOUND: Line not found or already voided.'; end if;
  select * into s from table_sessions where id = ol.session_id;
  v_actor := app.require_role(p_token, ol.branch_id, array['server','cashier','manager']);
  if s.status = 'closed' then raise exception 'INVOICED: The bill is settled. Void the invoice instead.'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'REASON_REQUIRED: Give a reason.'; end if;
  v_served := exists (select 1 from kitchen_ticket_lines where ref_table = 'order_lines' and ref_id = ol.id and served_at is not null);
  if v_served then
    v_mgr := app.override_by(p_token, p_override, ol.branch_id);
    if v_mgr is null then raise exception 'NEEDS_MANAGER: Already served — manager PIN needed.'; end if;
  else
    perform app.reverse_movements('order_lines', ol.id, v_actor);   -- only unserved items go back to stock
  end if;
  update order_lines set status = 'voided', voided_by = coalesce(v_mgr, v_actor), void_reason = p_reason, voided_at = app.now() where id = ol.id;
  update kitchen_ticket_lines set voided = true where ref_table = 'order_lines' and ref_id = ol.id and served_at is null;
  perform app.refresh_round(t.id) from kitchen_tickets t join kitchen_ticket_lines l on l.ticket_id = t.id where l.ref_id = ol.id;
  return jsonb_build_object('ok', true, 'stock_reversed', not v_served);
end $$;

create or replace function public.void_refill_round(p_token uuid, p_round_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare rr refill_rounds; v_actor uuid; l record;
begin
  select * into rr from refill_rounds where id = p_round_id for update;
  v_actor := app.require_role(p_token, rr.branch_id, array['server','cashier','manager']);
  if rr.status <> 'queued' then raise exception 'ALREADY_SERVED: Served rounds cannot be voided.'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'REASON_REQUIRED: Give a reason.'; end if;
  for l in select id from refill_lines where round_id = rr.id loop
    perform app.reverse_movements('refill_lines', l.id, v_actor);
  end loop;
  update refill_rounds set status = 'voided' where id = rr.id;
  update kitchen_tickets set status = 'voided' where source = 'refill_round' and source_id = rr.id;
  return jsonb_build_object('ok', true);
end $$;

-- ───────── Floor, session and kitchen views ─────────
create or replace function app.session_json(s table_sessions) returns jsonb language sql stable as $$
  select to_jsonb(s) || jsonb_build_object(
    'table_label', app.table_labels(s.table_ids),
    'package_name', (select name from menu_items where id = s.package_id),
    'pax_total', (select coalesce(sum(pax_count),0) from session_pax where session_id = s.id),
    'pax', coalesce((select jsonb_agg(jsonb_build_object('discount_type_id', p.discount_type_id, 'name', d.name, 'pax_count', p.pax_count) order by d.sort_order)
                       from session_pax p join discount_types d on d.id = p.discount_type_id where p.session_id = s.id), '[]'),
    'rounds', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'round_no', r.round_no, 'status', r.status,
        'requested_at', r.requested_at, 'served_at', r.served_at,
        'requested_by_name', (select full_name from profiles where id = r.requested_by),
        'lines', (select jsonb_agg(jsonb_build_object('item_id', l.item_id, 'name', i.name, 'plates', l.plates, 'is_meat', i.is_meat))
                    from refill_lines l join items i on i.id = l.item_id where l.round_id = r.id)) order by r.round_no)
      from refill_rounds r where r.session_id = s.id), '[]'),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'menu_item_id', o.menu_item_id, 'name', m.name, 'item_type', m.item_type,
        'qty', o.qty, 'unit_price', o.unit_price, 'discount_name', d.name, 'gross_amount', o.gross_amount,
        'discount_amount', o.discount_amount, 'net_amount', o.net_amount, 'status', o.status, 'void_reason', o.void_reason,
        'served', exists (select 1 from kitchen_ticket_lines k where k.ref_id = o.id and k.served_at is not null),
        'created_at', o.created_at) order by o.created_at)
      from order_lines o join menu_items m on m.id = o.menu_item_id left join discount_types d on d.id = o.discount_type_id
      where o.session_id = s.id), '[]'),
    'pending_tickets', (select count(*) from kitchen_tickets where session_id = s.id and status in ('queued','partially_served')));
$$;

create or replace function public.get_floor(p_branch uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
begin
  perform app.assert_branch(p_branch);
  return jsonb_build_object('server_time', app.now(), 'tables', coalesce((select jsonb_agg(jsonb_build_object(
      'id', t.id, 'label', t.label, 'seats', t.seats, 'zone', t.zone, 'status', t.status,
      'session', (select jsonb_build_object('id', s.id, 'status', s.status, 'opened_at', s.opened_at, 'timer_ends_at', s.timer_ends_at,
          'refill_cutoff_at', s.refill_cutoff_at, 'package_name', (select name from menu_items where id = s.package_id),
          'table_label', app.table_labels(s.table_ids),
          'pax_total', (select coalesce(sum(pax_count),0) from session_pax where session_id = s.id),
          'last_round', (select jsonb_build_object('round_no', round_no, 'status', status) from refill_rounds
                          where session_id = s.id and status <> 'voided' order by round_no desc limit 1))
        from table_sessions s where s.branch_id = p_branch and s.status in ('open','billing') and t.id = any(s.table_ids) limit 1),
      'reservation', (select jsonb_build_object('id', r.id, 'customer_name', r.customer_name, 'party_size', r.party_size, 'reserved_for', r.reserved_for)
        from reservations r where r.table_id = t.id and r.status = 'confirmed'
          and r.reserved_for between app.now() - interval '30 minutes' and app.now() + interval '3 hours' order by r.reserved_for limit 1))
      order by t.sort_order, t.label)
    from dining_tables t where t.branch_id = p_branch and t.is_active), '[]'));
end $$;

create or replace function public.get_session(p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare s table_sessions;
begin
  select * into s from table_sessions where id = p_session_id;
  if not found then raise exception 'NOT_FOUND: Table session not found.'; end if;
  perform app.assert_branch(s.branch_id);
  return app.session_json(s) || jsonb_build_object('server_time', app.now(),
    'bill', (select to_jsonb(b) from bills b where b.session_id = s.id),
    'invoice', (select to_jsonb(i) from invoices i join bills b on b.id = i.bill_id where b.session_id = s.id order by issued_at desc limit 1));
end $$;

create or replace function public.get_kitchen_queue(p_branch uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
begin
  perform app.assert_branch(p_branch);
  return jsonb_build_object('server_time', app.now(), 'tickets', coalesce((select jsonb_agg(jsonb_build_object(
      'id', t.id, 'title', t.title, 'source', t.source, 'status', t.status, 'created_at', t.created_at,
      'table_label', app.table_labels(s.table_ids), 'server_name', (select full_name from profiles where id = t.created_by),
      'lines', (select jsonb_agg(jsonb_build_object('id', l.id, 'label', l.label, 'qty', l.qty, 'is_meat', l.is_meat,
          'served_at', l.served_at, 'voided', l.voided,
          'stock_status', case when l.item_id is null then null
              when coalesce(sl.qty_on_hand,0) <= 0 then 'out'
              when coalesce(sl.qty_on_hand,0) <= i.reorder_level then 'low' else 'ok' end) order by l.label)
        from kitchen_ticket_lines l left join items i on i.id = l.item_id left join item_stock_levels sl on sl.item_id = l.item_id
        where l.ticket_id = t.id)) order by t.created_at)
    from kitchen_tickets t join table_sessions s on s.id = t.session_id
    where t.branch_id = p_branch and t.status in ('queued','partially_served')), '[]'));
end $$;

create or replace function public.set_table_status(p_token uuid, p_table_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare t dining_tables;
begin
  select * into t from dining_tables where id = p_table_id;
  perform app.require_role(p_token, t.branch_id, array['server','cashier','manager']);
  if p_status = 'free' and exists (select 1 from table_sessions where status in ('open','billing') and p_table_id = any(table_ids)) then
    raise exception 'TABLE_BUSY: This table still has an open bill.';
  end if;
  update dining_tables set status = p_status where id = p_table_id;
  return jsonb_build_object('ok', true);
end $$;

-- ───────── 6.7 Billing, payment, invoice ─────────
create or replace function app.bill_totals(p_session uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'subtotal', coalesce(sum(gross_amount),0), 'discount_total', coalesce(sum(discount_amount),0),
    'vatable_sales', coalesce(sum(vatable_sales),0), 'vat_amount', coalesce(sum(vat_amount),0),
    'vat_exempt_sales', coalesce(sum(vat_exempt_sales),0), 'total', coalesce(sum(net_amount),0),
    'sc_pwd_pax', coalesce(sum(qty) filter (where discount_type_id in (select id from discount_types where kind = 'sc_pwd_vat_exempt')),0))
  from order_lines where session_id = p_session and status = 'active'
$$;

create or replace function public.preview_bill(p_session_id uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare s table_sessions;
begin
  select * into s from table_sessions where id = p_session_id;
  perform app.assert_branch(s.branch_id);
  if s.status = 'open' then update table_sessions set status = 'billing' where id = s.id;
    update dining_tables set status = 'billing' where id = any(s.table_ids); end if;
  return app.bill_totals(s.id);
end $$;

create or replace function public.reopen_session(p_token uuid, p_session_id uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare s table_sessions;
begin
  select * into s from table_sessions where id = p_session_id for update;
  perform app.require_role(p_token, s.branch_id, array['cashier','server','manager']);
  if s.status <> 'billing' then raise exception 'BAD_STATE: Only a table in billing can go back to open.'; end if;
  update table_sessions set status = 'open' where id = s.id;
  update dining_tables set status = 'seated' where id = any(s.table_ids);
  return jsonb_build_object('ok', true);
end $$;

-- p_payments: [{method, amount, reference_no, tendered}], p_sc_pwd: [{kind, id_number, full_name}]
-- Official invoice numbers come only from the server and only for the registered terminal device (§6.7).
-- Without a permitted terminal (offline, or before BIR approval) a manual booklet number is required.
create or replace function public.settle_bill(p_client_uuid uuid, p_token uuid, p_session_id uuid, p_payments jsonb,
  p_sc_pwd jsonb default '[]', p_terminal_id uuid default null, p_manual_booklet_no text default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare s table_sessions; v_actor uuid; v_tot jsonb; v_bill uuid := gen_random_uuid(); x jsonb; v_paid numeric := 0;
  v_cash numeric := 0; v_change numeric := 0; term pos_terminals; v_inv uuid; v_no bigint; v_shift uuid; v_official boolean := false;
  v_pax int; r jsonb := app.idem_get(p_client_uuid);
begin
  if r is not null then return r; end if;
  select * into s from table_sessions where id = p_session_id for update;
  if not found then raise exception 'NOT_FOUND: Table session not found.'; end if;
  v_actor := app.require_role(p_token, s.branch_id, array['cashier','manager']);
  if s.status = 'closed' then raise exception 'ALREADY_DONE: This bill is already settled.'; end if;
  v_tot := app.bill_totals(s.id);
  for x in select * from jsonb_array_elements(p_payments) loop
    v_paid := v_paid + (x->>'amount')::numeric;
    if x->>'method' = 'cash' then v_cash := v_cash + (x->>'amount')::numeric; end if;
    if x->>'method' <> 'cash' and coalesce(trim(x->>'reference_no'),'') = '' then
      raise exception 'REFERENCE_REQUIRED: Enter the reference no. for %.', upper(x->>'method');
    end if;
  end loop;
  if v_paid < (v_tot->>'total')::numeric then raise exception 'UNDERPAID: Payments are ₱% short.', (v_tot->>'total')::numeric - v_paid; end if;
  if v_paid - v_cash > (v_tot->>'total')::numeric then raise exception 'OVERPAID: Only cash can be more than the total.'; end if;
  v_pax := (v_tot->>'sc_pwd_pax')::numeric::int;
  if v_pax > 0 and jsonb_array_length(coalesce(p_sc_pwd,'[]')) < v_pax then
    raise exception 'SC_PWD_DETAILS: Enter name and ID no. for each SC/PWD guest (%).', v_pax;
  end if;
  if p_terminal_id is not null then
    select * into term from pos_terminals where id = p_terminal_id and branch_id = s.branch_id for update;
    v_official := term.invoice_printing_enabled
      and exists (select 1 from devices d where d.id = term.device_id and d.auth_user_id = auth.uid() and d.revoked_at is null);
    select id into v_shift from cash_shifts where terminal_id = term.id and closed_at is null order by opened_at desc limit 1;
  end if;
  if not v_official and coalesce(trim(p_manual_booklet_no),'') = '' and (app.setting(s.branch_id,'vat_registered'))::boolean then
    raise exception 'BOOKLET_REQUIRED: Official invoice printing is off for this device — enter the manual booklet invoice no.';
  end if;

  insert into bills(id, branch_id, session_id, subtotal, discount_total, vatable_sales, vat_amount, vat_exempt_sales, total)
  values (v_bill, s.branch_id, s.id, (v_tot->>'subtotal')::numeric, (v_tot->>'discount_total')::numeric, (v_tot->>'vatable_sales')::numeric,
          (v_tot->>'vat_amount')::numeric, (v_tot->>'vat_exempt_sales')::numeric, (v_tot->>'total')::numeric);
  v_change := v_paid - (v_tot->>'total')::numeric;
  for x in select * from jsonb_array_elements(p_payments) loop
    insert into payments(branch_id, bill_id, terminal_id, shift_id, method, amount, reference_no, tendered, change, received_by)
    values (s.branch_id, v_bill, p_terminal_id, v_shift, x->>'method',
      case when x->>'method' = 'cash' then (x->>'amount')::numeric - v_change else (x->>'amount')::numeric end,
      x->>'reference_no', case when x->>'method' = 'cash' then (x->>'amount')::numeric end,
      case when x->>'method' = 'cash' then v_change end, v_actor);
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p_sc_pwd,'[]')) loop
    insert into sc_pwd_records(branch_id, bill_id, kind, id_number, full_name)
    values (s.branch_id, v_bill, coalesce(x->>'kind','sc'), x->>'id_number', x->>'full_name');
  end loop;
  if v_official then
    v_no := term.next_invoice_no;
    update pos_terminals set next_invoice_no = next_invoice_no + 1,
      accumulated_grand_total = accumulated_grand_total + (v_tot->>'total')::numeric where id = term.id;
  end if;
  insert into invoices(branch_id, terminal_id, bill_id, invoice_no, business_date, vatable_sales, vat_amount, vat_exempt_sales,
    discount_total, total, manual_booklet_no)
  values (s.branch_id, case when v_official then term.id end, v_bill, v_no, app.business_date(s.branch_id),
    (v_tot->>'vatable_sales')::numeric, (v_tot->>'vat_amount')::numeric, (v_tot->>'vat_exempt_sales')::numeric,
    (v_tot->>'discount_total')::numeric, (v_tot->>'total')::numeric, case when not v_official then nullif(trim(p_manual_booklet_no),'') end)
  returning id into v_inv;
  update table_sessions set status = 'closed', closed_at = app.now() where id = s.id;
  update dining_tables set status = 'dirty' where id = any(s.table_ids);
  update reservations set status = 'completed' where session_id = s.id;
  return app.idem_put(p_client_uuid, s.branch_id, 'settle_bill',
    jsonb_build_object('bill_id', v_bill, 'invoice_id', v_inv, 'invoice_no', v_no, 'official', v_official, 'change', v_change));
end $$;

-- Everything the cashier prints. Reprints are marked and counted.
create or replace function public.get_invoice(p_invoice_id uuid, p_reprint boolean default false) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare inv invoices; b bills; s table_sessions; br branches; term pos_terminals;
begin
  select * into inv from invoices where id = p_invoice_id;
  if not found then raise exception 'NOT_FOUND: Invoice not found.'; end if;
  perform app.assert_branch(inv.branch_id);
  if p_reprint then
    update invoices set reprint_count = reprint_count + 1 where id = inv.id returning * into inv;
  end if;
  select * into b from bills where id = inv.bill_id;
  select * into s from table_sessions where id = b.session_id;
  select * into br from branches where id = inv.branch_id;
  select * into term from pos_terminals where id = inv.terminal_id;
  return jsonb_build_object('invoice', to_jsonb(inv), 'bill', to_jsonb(b), 'reprint', p_reprint,
    'branch', jsonb_build_object('name', br.name, 'registered_name', br.registered_name, 'address', br.address, 'vat_reg_tin', br.vat_reg_tin),
    'terminal', case when term.id is not null then jsonb_build_object('terminal_code', term.terminal_code, 'bir_min', term.bir_min,
       'bir_serial_no', term.bir_serial_no, 'bir_ptu_no', term.bir_ptu_no, 'bir_ptu_date', term.bir_ptu_date, 'prefix', term.invoice_prefix) end,
    'table_label', app.table_labels(s.table_ids), 'cashier', (select full_name from profiles p join payments pa on pa.received_by = p.id where pa.bill_id = b.id limit 1),
    'lines', (app.session_json(s))->'lines',
    'payments', coalesce((select jsonb_agg(to_jsonb(p) order by at) from payments p where p.bill_id = b.id), '[]'),
    'sc_pwd', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'id_number', id_number, 'full_name', full_name)) from sc_pwd_records where bill_id = b.id), '[]'));
end $$;

create or replace function public.void_invoice(p_token uuid, p_invoice_id uuid, p_reason text, p_override uuid default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare inv invoices; v_mgr uuid;
begin
  select * into inv from invoices where id = p_invoice_id for update;
  perform app.require_role(p_token, inv.branch_id, array['cashier','manager']);
  v_mgr := app.override_by(p_token, p_override, inv.branch_id);
  if v_mgr is null then raise exception 'NEEDS_MANAGER: Voiding an invoice needs a manager PIN.'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'REASON_REQUIRED: Give a reason.'; end if;
  if inv.status = 'voided' then raise exception 'ALREADY_DONE: Already voided.'; end if;
  perform set_config('app.actor', v_mgr::text, true);
  update invoices set status = 'voided', void_reason = p_reason, voided_by = v_mgr, voided_at = app.now() where id = inv.id;
  return jsonb_build_object('ok', true);
end $$;

-- ───────── 6.8 Cashier shift and day close ─────────
create or replace function public.open_cash_shift(p_token uuid, p_terminal_id uuid, p_opening_float numeric) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare term pos_terminals; v_actor uuid; v_id uuid;
begin
  select * into term from pos_terminals where id = p_terminal_id;
  v_actor := app.require_role(p_token, term.branch_id, array['cashier','manager']);
  if exists (select 1 from cash_shifts where terminal_id = term.id and closed_at is null) then
    raise exception 'SHIFT_OPEN: A shift is already open on this terminal.';
  end if;
  insert into cash_shifts(branch_id, terminal_id, cashier_id, opening_float) values (term.branch_id, term.id, v_actor, p_opening_float)
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.get_open_shift(p_terminal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare cs cash_shifts;
begin
  select * into cs from cash_shifts where terminal_id = p_terminal_id and closed_at is null order by opened_at desc limit 1;
  if not found then return null; end if;
  perform app.assert_branch(cs.branch_id);
  return to_jsonb(cs) || jsonb_build_object('cashier_name', (select full_name from profiles where id = cs.cashier_id),
    'cash_sales', (select coalesce(sum(amount),0) from payments where shift_id = cs.id and method = 'cash'));
end $$;

create or replace function public.cash_move(p_token uuid, p_shift_id uuid, p_amount numeric) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare cs cash_shifts;
begin
  select * into cs from cash_shifts where id = p_shift_id for update;
  perform app.require_role(p_token, cs.branch_id, array['cashier','manager']);
  if p_amount >= 0 then update cash_shifts set cash_in = cash_in + p_amount where id = cs.id;
  else update cash_shifts set cash_out = cash_out - p_amount where id = cs.id; end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function app.payment_totals(p_where_shift uuid, p_branch uuid, p_terminal uuid, p_date date) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'by_method', coalesce((select jsonb_object_agg(method, amt) from (
        select p.method, sum(p.amount) amt from payments p join invoices i on i.bill_id = p.bill_id
         where i.status = 'issued' and ((p_where_shift is not null and p.shift_id = p_where_shift)
            or (p_where_shift is null and p.terminal_id = p_terminal and i.business_date = p_date))
         group by p.method) x), '{}'))
$$;

-- X-reading closes the cashier shift (§6.8).
create or replace function public.close_cash_shift(p_token uuid, p_shift_id uuid, p_counted_cash numeric) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare cs cash_shifts; v_cash numeric; v_expected numeric; v_totals jsonb; v_id uuid;
begin
  select * into cs from cash_shifts where id = p_shift_id for update;
  perform app.require_role(p_token, cs.branch_id, array['cashier','manager']);
  if cs.closed_at is not null then raise exception 'ALREADY_DONE: Shift already closed.'; end if;
  select coalesce(sum(amount),0) into v_cash from payments where shift_id = cs.id and method = 'cash';
  v_expected := cs.opening_float + cs.cash_in - cs.cash_out + v_cash;
  update cash_shifts set closed_at = app.now(), counted_cash = p_counted_cash, expected_cash = v_expected,
    over_short = p_counted_cash - v_expected where id = cs.id;
  v_totals := app.payment_totals(cs.id, null, null, null) || jsonb_build_object(
    'opening_float', cs.opening_float, 'cash_in', cs.cash_in, 'cash_out', cs.cash_out,
    'expected_cash', v_expected, 'counted_cash', p_counted_cash, 'over_short', p_counted_cash - v_expected,
    'invoices', (select count(*) from invoices i join payments p on p.bill_id = i.bill_id where p.shift_id = cs.id),
    'gross', (select coalesce(sum(distinct_total),0) from (select distinct i.id, i.total distinct_total from invoices i join payments p on p.bill_id = i.bill_id where p.shift_id = cs.id and i.status='issued') q));
  insert into x_readings(branch_id, shift_id, terminal_id, totals) values (cs.branch_id, cs.id, cs.terminal_id, v_totals) returning id into v_id;
  return jsonb_build_object('x_reading_id', v_id, 'totals', v_totals);
end $$;

-- Z-reading for one terminal and business date. Totals equal the sum of issued invoices (§14.1).
create or replace function public.z_reading(p_token uuid, p_terminal_id uuid, p_business_date date) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare term pos_terminals; v_gross numeric; v_vat numeric; v_exempt numeric; v_voids numeric; v_first bigint; v_last bigint;
  v_disc jsonb; v_id uuid;
begin
  select * into term from pos_terminals where id = p_terminal_id;
  perform app.require_role(p_token, term.branch_id, array['cashier','manager']);
  if exists (select 1 from z_readings where terminal_id = term.id and business_date = p_business_date) then
    return (select to_jsonb(z) from z_readings z where terminal_id = term.id and business_date = p_business_date);
  end if;
  select coalesce(sum(total) filter (where status='issued'),0), coalesce(sum(vat_amount) filter (where status='issued'),0),
         coalesce(sum(vat_exempt_sales) filter (where status='issued'),0), coalesce(sum(total) filter (where status='voided'),0),
         min(invoice_no), max(invoice_no)
    into v_gross, v_vat, v_exempt, v_voids, v_first, v_last
    from invoices where terminal_id = term.id and business_date = p_business_date and invoice_no is not null;
  select coalesce(jsonb_object_agg(name, amt), '{}') into v_disc from (
    select d.name, sum(o.discount_amount) amt from order_lines o join discount_types d on d.id = o.discount_type_id
      join bills b on b.session_id = o.session_id join invoices i on i.bill_id = b.id
     where i.terminal_id = term.id and i.business_date = p_business_date and i.status = 'issued' and o.status = 'active' and o.discount_amount > 0
     group by d.name) x;
  insert into z_readings(branch_id, terminal_id, business_date, first_invoice_no, last_invoice_no, gross_sales, vat_amount, vat_exempt_sales,
    discounts, voids_total, accumulated_grand_total_start, accumulated_grand_total_end)
  values (term.branch_id, term.id, p_business_date, v_first, v_last, v_gross, v_vat, v_exempt, v_disc, v_voids,
    term.accumulated_grand_total - (select coalesce(sum(total),0) from invoices where terminal_id = term.id and invoice_no is not null
       and business_date > p_business_date) - v_gross - v_voids,
    term.accumulated_grand_total - (select coalesce(sum(total),0) from invoices where terminal_id = term.id and invoice_no is not null
       and business_date > p_business_date))
  returning id into v_id;
  return (select to_jsonb(z) from z_readings z where id = v_id) || jsonb_build_object('payments', app.payment_totals(null, term.branch_id, term.id, p_business_date));
end $$;
