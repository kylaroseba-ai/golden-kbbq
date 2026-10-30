-- Core helpers: settings, time, actors and roles, idempotency, audit, stock ledger, alerts.

-- ───────── Settings (§12.5) ─────────
create or replace function app.default_settings() returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'opening_time','11:00', 'closing_time','22:00',
    'lunch_from','11:00', 'lunch_to','15:00', 'unli_from','15:00', 'unli_to','22:00',
    'unli_timer_minutes',120, 'last_refill_cutoff_minutes_before_end',45,
    'max_meat_plates_per_round',3, 'require_prev_round_served',true,
    'enforce_package_items',false,
    'default_grams_per_plate',80, 'leftover_fee',200, 'leftover_fee_basis','per_session',
    'overtime_fee_enabled',false, 'last_unli_seating_time','20:00',
    'variance_threshold_pct',0.05, 'variance_abs_g',200, 'variance_abs_ml',200, 'variance_abs_pc',2,
    'reservation_slot_minutes',30, 'reservation_lead_minutes',120, 'max_online_party',16,
    'reservation_seating_minutes_unli',120, 'reservation_seating_minutes_lunch',60,
    'online_capacity_pct',0.70, 'reservation_reminder_minutes',180, 'no_show_grace_minutes',15,
    'vat_registered',true, 'kitchen_ticket_amber_min',5, 'kitchen_ticket_red_min',10,
    'stuck_round_minutes',10, 'max_unsynced_rounds_per_table',1, 'late_sync_flag_minutes',10,
    'invoice_requires_online',true, 'pin_max_attempts',5, 'pin_lockout_minutes',15,
    'monthly_sms_cap',null
  )
$$;

create or replace function app.settings(p_branch uuid) returns jsonb language sql stable as $$
  select app.default_settings() || coalesce((select settings from branches where id = p_branch), '{}')
$$;

create or replace function app.setting(p_branch uuid, p_key text) returns jsonb language sql stable as $$
  select app.settings(p_branch) -> p_key
$$;

-- ───────── Time (§4 business date, §10.1 clock rule) ─────────
create or replace function app.business_date(p_branch uuid, p_at timestamptz default app.now())
returns date language sql stable as $$
  select ((p_at at time zone b.timezone) - b.business_day_cutoff)::date
  from branches b where b.id = p_branch
$$;

create or replace function app.local_time(p_branch uuid, p_at timestamptz)
returns time language sql stable as $$
  select (p_at at time zone b.timezone)::time from branches b where b.id = p_branch
$$;

-- Corrected device time is trusted when it is within 12 hours of the server clock.
create or replace function app.effective_time(p_occurred_at timestamptz) returns timestamptz
language sql stable as $$
  select case when p_occurred_at is null then app.now()
              when abs(extract(epoch from app.now() - p_occurred_at)) > 12 * 3600 then app.now()
              else p_occurred_at end
$$;

-- ───────── Actors and roles (§11.1) ─────────
-- Resolves who is acting. Shared devices pass a staff token issued by verify_pin;
-- personal logins (owner/manager/admin) pass no token and are found by auth.uid().
create or replace function app.actor(p_token uuid) returns uuid
language plpgsql stable security definer set search_path = public, app as $$
declare v_user uuid;
begin
  if p_token is not null then
    select t.user_id into v_user
      from staff_tokens t join devices d on d.id = t.device_id
     where t.id = p_token and t.revoked_at is null and t.expires_at > app.now()
       and d.revoked_at is null and d.auth_user_id = auth.uid();
    if v_user is null then raise exception 'SESSION_EXPIRED: Staff sign-in expired. Enter your PIN again.'; end if;
    return v_user;
  end if;
  select id into v_user from profiles where auth_user_id = auth.uid() and is_active;
  if v_user is null then raise exception 'NOT_SIGNED_IN: Not signed in.'; end if;
  return v_user;
end $$;

create or replace function app.role_of(p_user uuid, p_branch uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from user_branch_roles where user_id = p_user and branch_id = p_branch
$$;

-- Owner and admin can do everything a manager can.
create or replace function app.require_role(p_token uuid, p_branch uuid, p_roles text[]) returns uuid
language plpgsql stable security definer set search_path = public, app as $$
declare v_user uuid := app.actor(p_token); v_role text;
begin
  v_role := app.role_of(v_user, p_branch);
  if v_role is null then raise exception 'FORBIDDEN: No access to this branch.'; end if;
  if not (v_role = any(p_roles) or v_role in ('owner','admin')) then
    raise exception 'FORBIDDEN: Your role (%) cannot do this.', v_role;
  end if;
  perform set_config('app.actor', v_user::text, true);
  return v_user;
end $$;

-- A manager override is a second, short-lived token from a manager's PIN entry.
create or replace function app.require_override(p_override uuid, p_branch uuid) returns uuid
language plpgsql stable security definer set search_path = public, app as $$
declare v_user uuid; v_role text;
begin
  if p_override is null then return null; end if;
  select t.user_id into v_user from staff_tokens t join devices d on d.id = t.device_id
   where t.id = p_override and t.revoked_at is null and t.expires_at > app.now() and d.auth_user_id = auth.uid();
  if v_user is null then
    -- personal login of a manager can also override with their own session token id = null case
    raise exception 'OVERRIDE_INVALID: Manager PIN expired. Enter it again.';
  end if;
  v_role := app.role_of(v_user, p_branch);
  if v_role not in ('manager','owner','admin') then raise exception 'OVERRIDE_INVALID: Override needs a manager.'; end if;
  return v_user;
end $$;

-- Branches the caller may see: personal login roles, or the device account's branch.
create or replace function app.my_branches() returns setof uuid
language sql stable security definer set search_path = public as $$
  select r.branch_id from user_branch_roles r join profiles p on p.id = r.user_id
   where p.auth_user_id = auth.uid() and p.is_active
  union
  select d.branch_id from devices d where d.auth_user_id = auth.uid() and d.revoked_at is null
$$;

create or replace function app.assert_branch(p_branch uuid) returns void
language plpgsql stable security definer set search_path = public, app as $$
begin
  if not exists (select 1 from app.my_branches() b where b = p_branch) then
    raise exception 'FORBIDDEN: No access to this branch.';
  end if;
end $$;

-- ───────── Idempotency (§9.3) ─────────
create or replace function app.idem_get(p_client_uuid uuid) returns jsonb
language sql stable as $$ select result from idempotency_keys where client_uuid = p_client_uuid $$;

create or replace function app.idem_put(p_client_uuid uuid, p_branch uuid, p_rpc text, p_result jsonb)
returns jsonb language plpgsql as $$
begin
  if p_client_uuid is not null then
    insert into idempotency_keys(client_uuid, branch_id, rpc_name, result) values (p_client_uuid, p_branch, p_rpc, p_result);
  end if;
  return p_result;
end $$;

-- ───────── Notifications ─────────
create or replace function app.notify(p_branch uuid, p_roles text[], p_kind text, p_title text,
  p_body text default null, p_ref_table text default null, p_ref_id uuid default null,
  p_priority text default 'normal', p_user uuid default null) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  insert into notifications(branch_id, target_roles, target_user, kind, priority, title, body, ref_table, ref_id)
  values (p_branch, p_roles, p_user, p_kind, p_priority, p_title, p_body, p_ref_table, p_ref_id)
  returning id into v_id;
  return v_id;
end $$;

-- ───────── Stock ledger (§4, §5) ─────────
create or replace function app.ensure_level(p_branch uuid, p_item uuid) returns void language sql as $$
  insert into item_stock_levels(branch_id, item_id) values (p_branch, p_item) on conflict (item_id) do nothing
$$;

-- Low / out alerts, de-duplicated per threshold crossing and re-armed after restock (§5.5).
create or replace function app.check_alerts(p_branch uuid, p_item uuid) returns void
language plpgsql as $$
declare l item_stock_levels; i items; v_roles text[] := array['manager','kitchen'];
begin
  select * into l from item_stock_levels where item_id = p_item;
  select * into i from items where id = p_item;
  if i.stage = 'supply' then return; end if;
  if l.qty_on_hand <= 0 and l.out_armed then
    perform app.notify(p_branch, v_roles, 'stock_out', 'OUT: ' || i.name, 'No stock left.', 'items', p_item, 'high');
    update item_stock_levels set out_armed = false, low_armed = false where item_id = p_item;
  elsif l.qty_on_hand <= i.reorder_level and l.low_armed and i.reorder_level > 0 then
    perform app.notify(p_branch, v_roles, 'stock_low', 'LOW: ' || i.name,
      'On hand ' || round(l.qty_on_hand) || ' ' || i.base_unit || ' (alert at ' || round(i.reorder_level) || ').', 'items', p_item, 'high');
    update item_stock_levels set low_armed = false where item_id = p_item;
  elsif l.qty_on_hand > i.reorder_level then
    update item_stock_levels set low_armed = true, out_armed = true where item_id = p_item;
  elsif l.qty_on_hand > 0 then
    update item_stock_levels set out_armed = true where item_id = p_item;
  end if;
end $$;

create or replace function app.write_movement(p_branch uuid, p_item uuid, p_type text, p_qty numeric,
  p_unit_cost numeric, p_batch uuid, p_ref_table text, p_ref_id uuid, p_actor uuid, p_at timestamptz)
returns void language plpgsql as $$
begin
  insert into stock_movements(branch_id, business_date, item_id, batch_id, movement_type, qty_delta, unit_cost,
                              ref_table, ref_id, created_by, occurred_at)
  values (p_branch, app.business_date(p_branch, p_at), p_item, p_batch, p_type, p_qty, coalesce(p_unit_cost,0),
          p_ref_table, p_ref_id, p_actor, p_at);
end $$;

-- Stock in: new batch + movement; updates the moving weighted-average cost.
create or replace function app.add_stock(p_branch uuid, p_item uuid, p_type text, p_qty numeric, p_unit_cost numeric,
  p_expiry date, p_source_type text, p_source_id uuid, p_ref_table text, p_ref_id uuid, p_actor uuid,
  p_at timestamptz default app.now()) returns uuid
language plpgsql as $$
declare v_batch uuid; v_on numeric; v_avg numeric;
begin
  if p_qty <= 0 then raise exception 'BAD_QTY: Quantity must be more than zero.'; end if;
  perform app.ensure_level(p_branch, p_item);
  select qty_on_hand, avg_unit_cost into v_on, v_avg from item_stock_levels where item_id = p_item for update;
  insert into stock_batches(branch_id, item_id, source_type, source_id, received_at, expiry_date, qty_initial, qty_remaining, unit_cost)
  values (p_branch, p_item, p_source_type, p_source_id, p_at, p_expiry, p_qty, p_qty, coalesce(p_unit_cost, v_avg))
  returning id into v_batch;
  perform app.write_movement(p_branch, p_item, p_type, p_qty, coalesce(p_unit_cost, v_avg), v_batch, p_ref_table, p_ref_id, p_actor, p_at);
  update item_stock_levels set
    avg_unit_cost = case when greatest(v_on,0) + p_qty = 0 then v_avg
                         else (greatest(v_on,0) * v_avg + p_qty * coalesce(p_unit_cost, v_avg)) / (greatest(v_on,0) + p_qty) end,
    qty_on_hand = qty_on_hand + p_qty,
    last_movement_at = app.now()
  where item_id = p_item;
  perform app.check_alerts(p_branch, p_item);
  return v_batch;
end $$;

-- Stock out: FIFO over non-expired batches (oldest received first), valued at moving average.
-- Any excess goes to a batch-less movement so stock may go negative (§5.6, §10).
create or replace function app.deduct_stock(p_branch uuid, p_item uuid, p_type text, p_qty numeric,
  p_ref_table text, p_ref_id uuid, p_actor uuid, p_at timestamptz default app.now(), p_batch uuid default null)
returns numeric  -- returns unit cost used
language plpgsql as $$
declare v_left numeric := p_qty; v_avg numeric; b record; v_take numeric;
begin
  if p_qty <= 0 then return 0; end if;
  perform app.ensure_level(p_branch, p_item);
  select avg_unit_cost into v_avg from item_stock_levels where item_id = p_item for update;
  for b in select id, qty_remaining from stock_batches
            where item_id = p_item and qty_remaining > 0
              and (p_batch is null or id = p_batch)
              and (p_batch is not null or expiry_date is null or expiry_date >= app.business_date(p_branch, p_at))
            order by received_at, id for update loop
    exit when v_left <= 0;
    v_take := least(v_left, b.qty_remaining);
    update stock_batches set qty_remaining = qty_remaining - v_take where id = b.id;
    perform app.write_movement(p_branch, p_item, p_type, -v_take, v_avg, b.id, p_ref_table, p_ref_id, p_actor, p_at);
    v_left := v_left - v_take;
  end loop;
  if v_left > 0 then
    perform app.write_movement(p_branch, p_item, p_type, -v_left, v_avg, null, p_ref_table, p_ref_id, p_actor, p_at);
  end if;
  update item_stock_levels set qty_on_hand = qty_on_hand - p_qty, last_movement_at = app.now() where item_id = p_item;
  perform app.check_alerts(p_branch, p_item);
  return v_avg;
end $$;

-- Reverse every movement written for a reference (used by voids before serving).
create or replace function app.reverse_movements(p_ref_table text, p_ref_id uuid, p_actor uuid) returns void
language plpgsql as $$
declare m record;
begin
  for m in select branch_id, item_id, batch_id, qty_delta, unit_cost from stock_movements
            where ref_table = p_ref_table and ref_id = p_ref_id and movement_type in ('sale','refill') loop
    if m.batch_id is not null then
      update stock_batches set qty_remaining = qty_remaining - m.qty_delta where id = m.batch_id;
    end if;
    perform app.write_movement(m.branch_id, m.item_id, 'void_reversal', -m.qty_delta, m.unit_cost, m.batch_id, p_ref_table, p_ref_id, p_actor, app.now());
    update item_stock_levels set qty_on_hand = qty_on_hand - m.qty_delta, last_movement_at = app.now() where item_id = m.item_id;
    perform app.check_alerts(m.branch_id, m.item_id);
  end loop;
end $$;

-- ───────── Audit (§11) ─────────
create or replace function app.audit_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  insert into audit_log(branch_id, user_id, table_name, record_id, action, before, after)
  values ((v_row->>'branch_id')::uuid, nullif(current_setting('app.actor', true), '')::uuid, tg_table_name,
          coalesce(v_row->>'id', v_row->>'session_id', v_row->>'list_id', v_row->>'item_id'),
          lower(tg_op),
          case when tg_op <> 'INSERT' then to_jsonb(old) - 'pin_hash' - 'pin_salt' end,
          case when tg_op <> 'DELETE' then to_jsonb(new) - 'pin_hash' - 'pin_salt' end);
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['branches','profiles','user_branch_roles','devices','pos_terminals','items','suppliers',
    'deliveries','prep_recipes','production_runs','waste_logs','stock_counts','stock_count_lines','reorder_lists','reorder_lines',
    'dining_tables','menu_items','discount_types','table_sessions','order_lines','refill_rounds','bills','payments',
    'invoices','cash_shifts','reservations','message_templates'] loop
    execute format('create trigger audit_%1$s after insert or update or delete on %1$I for each row execute function app.audit_trigger()', t);
  end loop;
end $$;

-- Append-only records: ledger, audit, BIR documents (§11).
create or replace function app.forbid_change() returns trigger language plpgsql as $$
begin raise exception 'IMMUTABLE: % rows cannot be %d.', tg_table_name, lower(tg_op); end $$;

create trigger no_change_movements before update or delete on stock_movements for each row execute function app.forbid_change();
create trigger no_change_audit before update or delete on audit_log for each row execute function app.forbid_change();
create trigger no_delete_invoices before delete on invoices for each row execute function app.forbid_change();
create trigger no_change_z before update or delete on z_readings for each row execute function app.forbid_change();
create trigger no_change_x before update or delete on x_readings for each row execute function app.forbid_change();

-- Finalized invoice amounts can never change; only void and reprint fields may.
create or replace function app.guard_invoice() returns trigger language plpgsql as $$
begin
  if (new.invoice_no, new.total, new.vatable_sales, new.vat_amount, new.vat_exempt_sales, new.discount_total, new.bill_id, new.terminal_id, new.issued_at)
     is distinct from (old.invoice_no, old.total, old.vatable_sales, old.vat_amount, old.vat_exempt_sales, old.discount_total, old.bill_id, old.terminal_id, old.issued_at) then
    raise exception 'IMMUTABLE: Invoice amounts cannot be edited. Void it instead.';
  end if;
  if old.status = 'voided' and new.status <> 'voided' then raise exception 'IMMUTABLE: A voided invoice stays void.'; end if;
  return new;
end $$;
create trigger guard_invoice before update on invoices for each row execute function app.guard_invoice();

create or replace function app.guard_grand_total() returns trigger language plpgsql as $$
begin
  if new.accumulated_grand_total < old.accumulated_grand_total then
    raise exception 'IMMUTABLE: The accumulated grand total never decreases.';
  end if;
  if new.next_invoice_no < old.next_invoice_no then raise exception 'IMMUTABLE: Invoice numbers never go back.'; end if;
  return new;
end $$;
create trigger guard_grand_total before update on pos_terminals for each row execute function app.guard_grand_total();
