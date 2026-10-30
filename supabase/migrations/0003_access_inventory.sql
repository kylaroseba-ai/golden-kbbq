-- Access RPCs (§11.1), bootstrap/master data, and inventory RPCs (§5).
-- Every RPC returns jsonb so clients (Supabase or the local demo backend) call them the same way.

create or replace function app.hash_pin(p_salt text, p_pin text) returns text language sql immutable as $$
  select encode(sha256(convert_to(p_salt || ':' || p_pin, 'UTF8')), 'hex')
$$;

create or replace function app.override_by(p_token uuid, p_override uuid, p_branch uuid) returns uuid
language plpgsql stable security definer set search_path = public, app as $$
declare v_actor uuid;
begin
  if p_override is not null then return app.require_override(p_override, p_branch); end if;
  v_actor := app.actor(p_token);
  if app.role_of(v_actor, p_branch) in ('manager','owner','admin') then return v_actor; end if;
  return null;
end $$;

-- ───────── Who am I / device sign-in ─────────
create or replace function public.whoami() returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare v_device devices; v_profile profiles;
begin
  select * into v_device from devices where auth_user_id = auth.uid() and revoked_at is null;
  if found then
    return jsonb_build_object('mode','device','device', jsonb_build_object('id',v_device.id,'label',v_device.label,'kind',v_device.kind,'branch_id',v_device.branch_id),
      'branches', (select jsonb_agg(jsonb_build_object('id',b.id,'code',b.code,'name',b.name)) from branches b where b.id = v_device.branch_id));
  end if;
  select * into v_profile from profiles where auth_user_id = auth.uid() and is_active;
  if found then
    return jsonb_build_object('mode','personal',
      'user', jsonb_build_object('id',v_profile.id,'full_name',v_profile.full_name,'language',v_profile.language),
      'branches', (select jsonb_agg(jsonb_build_object('id',b.id,'code',b.code,'name',b.name,'role',r.role) order by b.code)
                     from user_branch_roles r join branches b on b.id = r.branch_id where r.user_id = v_profile.id));
  end if;
  return jsonb_build_object('mode','none');
end $$;

create or replace function public.list_device_staff(p_device_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare v_branch uuid;
begin
  select branch_id into v_branch from devices where id = p_device_id and auth_user_id = auth.uid() and revoked_at is null;
  if v_branch is null then raise exception 'FORBIDDEN: Unknown device.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'full_name',p.full_name,'role',r.role,'language',p.language) order by p.full_name)
    from user_branch_roles r join profiles p on p.id = r.user_id
   where r.branch_id = v_branch and p.is_active and p.pin_hash is not null), '[]');
end $$;

-- PIN check happens only here, on the server. Hashes never leave the database.
create or replace function public.verify_pin(p_device_id uuid, p_user_id uuid, p_pin text, p_purpose text default 'session')
returns jsonb language plpgsql security definer set search_path = public, app as $$
declare d devices; p profiles; a pin_attempts; v_role text; v_tok uuid; v_exp timestamptz;
  v_max int; v_lock int;
begin
  select * into d from devices where id = p_device_id and auth_user_id = auth.uid() and revoked_at is null;
  if not found then raise exception 'FORBIDDEN: This device is not registered or was revoked.'; end if;
  select * into p from profiles where id = p_user_id and is_active;
  v_role := app.role_of(p_user_id, d.branch_id);
  if not found or v_role is null then raise exception 'FORBIDDEN: This person has no role on this branch.'; end if;
  v_max := (app.setting(d.branch_id,'pin_max_attempts'))::int;
  v_lock := (app.setting(d.branch_id,'pin_lockout_minutes'))::int;
  insert into pin_attempts(user_id, device_id) values (p_user_id, p_device_id) on conflict do nothing;
  select * into a from pin_attempts where user_id = p_user_id and device_id = p_device_id for update;
  if a.locked_until is not null and a.locked_until > app.now() then
    raise exception 'PIN_LOCKED: Too many wrong PINs. Try again after %.', to_char(a.locked_until at time zone 'Asia/Manila', 'FMHH12:MI AM');
  end if;
  if p.pin_hash is null or app.hash_pin(p.pin_salt, p_pin) <> p.pin_hash then
    update pin_attempts set failed_count = case when failed_count + 1 >= v_max then 0 else failed_count + 1 end,
      locked_until = case when failed_count + 1 >= v_max then app.now() + make_interval(mins => v_lock) else null end
    where user_id = p_user_id and device_id = p_device_id;
    if a.failed_count + 1 >= v_max then
      perform app.notify(d.branch_id, array['manager'], 'pin_lockout', 'PIN lockout: ' || p.full_name,
        'Locked on ' || d.label || ' after ' || v_max || ' wrong PINs.', 'profiles', p.id, 'high');
      return jsonb_build_object('ok', false, 'error', 'PIN_LOCKED', 'message', 'Too many wrong PINs. Locked for ' || v_lock || ' minutes.');
    end if;
    return jsonb_build_object('ok', false, 'error', 'PIN_WRONG', 'message', 'Wrong PIN.', 'attempts_left', v_max - a.failed_count - 1);
  end if;
  update pin_attempts set failed_count = 0, locked_until = null where user_id = p_user_id and device_id = p_device_id;
  if p_purpose = 'override' then
    if v_role not in ('manager','owner','admin') then
      return jsonb_build_object('ok', false, 'error', 'NOT_MANAGER', 'message', 'Override needs a manager PIN.');
    end if;
    v_exp := app.now() + interval '3 minutes';
  else
    -- valid until the end of the business day
    v_exp := ((app.business_date(d.branch_id) + 1 + (select business_day_cutoff from branches where id = d.branch_id))::timestamp
              at time zone (select timezone from branches where id = d.branch_id));
  end if;
  insert into staff_tokens(user_id, device_id, branch_id, purpose, expires_at)
  values (p_user_id, p_device_id, d.branch_id, p_purpose, v_exp) returning id into v_tok;
  update devices set last_seen_at = app.now() where id = p_device_id;
  return jsonb_build_object('ok', true, 'token', v_tok, 'expires_at', v_exp,
    'user', jsonb_build_object('id', p.id, 'full_name', p.full_name, 'role', v_role, 'language', p.language));
end $$;

create or replace function public.set_pin(p_token uuid, p_branch uuid, p_user_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_salt text := encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex');
begin
  perform app.require_role(p_token, p_branch, array['manager']);
  if p_pin !~ '^[0-9]{4,6}$' then raise exception 'BAD_PIN: PIN must be 4 to 6 digits.'; end if;
  if app.role_of(p_user_id, p_branch) is null then raise exception 'FORBIDDEN: Not on this branch.'; end if;
  update profiles set pin_salt = v_salt, pin_hash = app.hash_pin(v_salt, p_pin) where id = p_user_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.revoke_device(p_token uuid, p_device_id uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_branch uuid := (select branch_id from devices where id = p_device_id);
begin
  perform app.require_role(p_token, v_branch, array['manager']);
  update devices set revoked_at = app.now() where id = p_device_id;
  update staff_tokens set revoked_at = app.now() where device_id = p_device_id and revoked_at is null;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.report_clock(p_offset_ms integer) returns jsonb
language sql security definer set search_path = public as $$
  update devices set clock_offset_ms = p_offset_ms, last_seen_at = app.now() where auth_user_id = auth.uid();
  select jsonb_build_object('server_time', app.now());
$$;

-- ───────── Bootstrap: everything a device caches for offline use ─────────
create or replace function public.get_bootstrap(p_branch uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
begin
  perform app.assert_branch(p_branch);
  return jsonb_build_object(
    'server_time', app.now(),
    'branch', (select to_jsonb(b) - 'settings' from branches b where id = p_branch),
    'settings', app.settings(p_branch),
    'business_date', app.business_date(p_branch),
    'categories', coalesce((select jsonb_agg(to_jsonb(c) order by sort_order) from item_categories c where branch_id = p_branch), '[]'),
    'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order, i.name) from items i where branch_id = p_branch), '[]'),
    'suppliers', coalesce((select jsonb_agg(to_jsonb(s) order by s.name) from suppliers s where branch_id = p_branch), '[]'),
    'menu_categories', coalesce((select jsonb_agg(to_jsonb(c) order by sort_order) from menu_categories c where branch_id = p_branch), '[]'),
    'menu_items', coalesce((select jsonb_agg(to_jsonb(m) order by m.sort_order, m.name) from menu_items m where branch_id = p_branch), '[]'),
    'discount_types', coalesce((select jsonb_agg(to_jsonb(d) order by sort_order) from discount_types d where branch_id = p_branch and is_active), '[]'),
    'tables', coalesce((select jsonb_agg(to_jsonb(t) order by sort_order, label) from dining_tables t where branch_id = p_branch and is_active), '[]'),
    'package_refill_items', coalesce((select jsonb_agg(to_jsonb(x)) from package_refill_items x where branch_id = p_branch), '[]'),
    'prep_recipes', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'output_item_id', r.output_item_id, 'standard_output_qty', r.standard_output_qty,
        'notes', r.notes, 'inputs', (select jsonb_agg(jsonb_build_object('item_id', x.item_id, 'qty', x.qty)) from prep_recipe_inputs x where x.recipe_id = r.id)))
        from prep_recipes r where branch_id = p_branch and is_active), '[]'),
    'terminals', coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'terminal_code',t.terminal_code,'device_id',t.device_id,
        'invoice_printing_enabled',t.invoice_printing_enabled,'bir_min',t.bir_min,'bir_serial_no',t.bir_serial_no,'bir_ptu_no',t.bir_ptu_no,'bir_ptu_date',t.bir_ptu_date))
        from pos_terminals t where branch_id = p_branch), '[]')
  );
end $$;

-- ───────── Master data (Admin / Manager) ─────────
create or replace function public.upsert_item(p_token uuid, p_branch uuid, p_item jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_id uuid := coalesce((p_item->>'id')::uuid, gen_random_uuid());
begin
  perform app.require_role(p_token, p_branch, array['manager']);
  insert into items(id, branch_id, category_id, name, stage, base_unit, count_unit, count_unit_factor, reorder_level, par_level,
    default_supplier_id, tracks_expiry, shelf_life_days, near_expiry_days, grams_per_plate, is_refillable, is_meat, is_watch, sort_order, is_active)
  values (v_id, p_branch, (p_item->>'category_id')::uuid, p_item->>'name', p_item->>'stage', p_item->>'base_unit',
    coalesce(p_item->>'count_unit', p_item->>'base_unit'), coalesce((p_item->>'count_unit_factor')::numeric, 1),
    coalesce((p_item->>'reorder_level')::numeric, 0), coalesce((p_item->>'par_level')::numeric, 0),
    (p_item->>'default_supplier_id')::uuid, coalesce((p_item->>'tracks_expiry')::boolean, false),
    (p_item->>'shelf_life_days')::int, coalesce((p_item->>'near_expiry_days')::int, 3),
    (p_item->>'grams_per_plate')::numeric, coalesce((p_item->>'is_refillable')::boolean, false),
    coalesce((p_item->>'is_meat')::boolean, false), coalesce((p_item->>'is_watch')::boolean, false),
    coalesce((p_item->>'sort_order')::int, 0), coalesce((p_item->>'is_active')::boolean, true))
  on conflict (id) do update set category_id = excluded.category_id, name = excluded.name, stage = excluded.stage,
    base_unit = excluded.base_unit, count_unit = excluded.count_unit, count_unit_factor = excluded.count_unit_factor,
    reorder_level = excluded.reorder_level, par_level = excluded.par_level, default_supplier_id = excluded.default_supplier_id,
    tracks_expiry = excluded.tracks_expiry, shelf_life_days = excluded.shelf_life_days, near_expiry_days = excluded.near_expiry_days,
    grams_per_plate = excluded.grams_per_plate, is_refillable = excluded.is_refillable, is_meat = excluded.is_meat,
    is_watch = excluded.is_watch, sort_order = excluded.sort_order, is_active = excluded.is_active
  where items.branch_id = p_branch;
  perform app.ensure_level(p_branch, v_id);
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.upsert_supplier(p_token uuid, p_branch uuid, p_row jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_id uuid := coalesce((p_row->>'id')::uuid, gen_random_uuid());
begin
  perform app.require_role(p_token, p_branch, array['manager']);
  insert into suppliers(id, branch_id, name, contact_person, phones, viber, messenger, whatsapp, email, address, payment_terms, notes, is_active)
  values (v_id, p_branch, p_row->>'name', p_row->>'contact_person',
    coalesce(array(select jsonb_array_elements_text(p_row->'phones')), '{}'), p_row->>'viber', p_row->>'messenger', p_row->>'whatsapp',
    p_row->>'email', p_row->>'address', p_row->>'payment_terms', p_row->>'notes', coalesce((p_row->>'is_active')::boolean, true))
  on conflict (id) do update set name = excluded.name, contact_person = excluded.contact_person, phones = excluded.phones,
    viber = excluded.viber, messenger = excluded.messenger, whatsapp = excluded.whatsapp, email = excluded.email,
    address = excluded.address, payment_terms = excluded.payment_terms, notes = excluded.notes, is_active = excluded.is_active
  where suppliers.branch_id = p_branch;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.upsert_dining_table(p_token uuid, p_branch uuid, p_row jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_id uuid := coalesce((p_row->>'id')::uuid, gen_random_uuid());
begin
  perform app.require_role(p_token, p_branch, array['manager']);
  insert into dining_tables(id, branch_id, label, seats, zone, sort_order, is_active)
  values (v_id, p_branch, p_row->>'label', coalesce((p_row->>'seats')::int, 4), p_row->>'zone',
          coalesce((p_row->>'sort_order')::int, 0), coalesce((p_row->>'is_active')::boolean, true))
  on conflict (id) do update set label = excluded.label, seats = excluded.seats, zone = excluded.zone,
    sort_order = excluded.sort_order, is_active = excluded.is_active
  where dining_tables.branch_id = p_branch;
  return jsonb_build_object('id', v_id);
end $$;

-- Price changes keep history so past sales keep their own price (§1.2).
create or replace function public.upsert_menu_item(p_token uuid, p_branch uuid, p_row jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_id uuid := coalesce((p_row->>'id')::uuid, gen_random_uuid()); v_old numeric;
begin
  perform app.require_role(p_token, p_branch, array['manager']);
  select price into v_old from menu_items where id = v_id;
  insert into menu_items(id, branch_id, category_id, name, item_type, price, priced_per_person, needs_kitchen, vat_exempt, sort_order, is_active)
  values (v_id, p_branch, (p_row->>'category_id')::uuid, p_row->>'name', p_row->>'item_type', (p_row->>'price')::numeric,
    coalesce((p_row->>'priced_per_person')::boolean, false), coalesce((p_row->>'needs_kitchen')::boolean, false),
    coalesce((p_row->>'vat_exempt')::boolean, false), coalesce((p_row->>'sort_order')::int, 0), coalesce((p_row->>'is_active')::boolean, true))
  on conflict (id) do update set category_id = excluded.category_id, name = excluded.name, item_type = excluded.item_type,
    price = excluded.price, priced_per_person = excluded.priced_per_person, needs_kitchen = excluded.needs_kitchen,
    vat_exempt = excluded.vat_exempt, sort_order = excluded.sort_order, is_active = excluded.is_active
  where menu_items.branch_id = p_branch;
  if v_old is distinct from (p_row->>'price')::numeric then
    insert into menu_item_price_history(branch_id, menu_item_id, price) values (p_branch, v_id, (p_row->>'price')::numeric);
  end if;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.set_branch_settings(p_token uuid, p_branch uuid, p_settings jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.require_role(p_token, p_branch, array['admin']);
  update branches set settings = settings || p_settings where id = p_branch;
  return app.settings(p_branch);
end $$;

-- ───────── Opening balance (§13.4 step 6) ─────────
create or replace function public.post_opening_balance(p_client_uuid uuid, p_token uuid, p_branch uuid, p_lines jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_actor uuid; l jsonb; r jsonb := app.idem_get(p_client_uuid);
begin
  if r is not null then return r; end if;
  v_actor := app.require_role(p_token, p_branch, array['manager']);
  for l in select * from jsonb_array_elements(p_lines) loop
    perform app.add_stock(p_branch, (l->>'item_id')::uuid, 'opening_balance', (l->>'qty')::numeric, (l->>'unit_cost')::numeric,
      (l->>'expiry_date')::date, 'opening', null, 'opening', null, v_actor);
  end loop;
  return app.idem_put(p_client_uuid, p_branch, 'post_opening_balance', jsonb_build_object('ok', true, 'lines', jsonb_array_length(p_lines)));
end $$;

-- ───────── 5.2 Deliveries ─────────
-- p_delivery: {supplier_id, received_at, reference_no, payment_method, notes, photo_path,
--              lines: [{item_id, qty (count unit), unit_price (per count unit) | line_total, expiry_date}]}
create or replace function public.receive_delivery(p_client_uuid uuid, p_token uuid, p_branch uuid, p_delivery jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_actor uuid; v_id uuid := gen_random_uuid(); l jsonb; i items; v_qty numeric; v_total numeric; v_unit numeric;
  v_batch uuid; v_sum numeric := 0; v_at timestamptz; r jsonb := app.idem_get(p_client_uuid);
begin
  if r is not null then return r; end if;
  v_actor := app.require_role(p_token, p_branch, array['kitchen','manager']);
  v_at := app.effective_time(coalesce((p_delivery->>'received_at')::timestamptz, (p_delivery->>'occurred_at')::timestamptz));
  if jsonb_array_length(coalesce(p_delivery->'lines','[]')) = 0 then raise exception 'BAD_INPUT: Add at least one line.'; end if;
  insert into deliveries(id, branch_id, supplier_id, received_at, business_date, reference_no, payment_method, received_by, photo_path, notes, client_uuid, occurred_at)
  values (v_id, p_branch, (p_delivery->>'supplier_id')::uuid, v_at, app.business_date(p_branch, v_at), p_delivery->>'reference_no',
          p_delivery->>'payment_method', v_actor, p_delivery->>'photo_path', p_delivery->>'notes', p_client_uuid, v_at);
  for l in select * from jsonb_array_elements(p_delivery->'lines') loop
    select * into i from items where id = (l->>'item_id')::uuid and branch_id = p_branch;
    if not found then raise exception 'BAD_INPUT: Unknown item.'; end if;
    v_qty := round((l->>'qty')::numeric * i.count_unit_factor, 3);
    v_total := coalesce((l->>'line_total')::numeric, round((l->>'qty')::numeric * (l->>'unit_price')::numeric, 2));
    v_unit := v_total / v_qty;
    if i.tracks_expiry and (l->>'expiry_date') is null then
      raise exception 'EXPIRY_REQUIRED: % needs an expiry date.', i.name;
    end if;
    v_batch := app.add_stock(p_branch, i.id, 'delivery_in', v_qty, v_unit, (l->>'expiry_date')::date, 'delivery', v_id, 'deliveries', v_id, v_actor, v_at);
    insert into delivery_lines(branch_id, delivery_id, item_id, qty_base, unit_cost, line_total, expiry_date, batch_id)
    values (p_branch, v_id, i.id, v_qty, v_unit, v_total, (l->>'expiry_date')::date, v_batch);
    v_sum := v_sum + v_total;
    if (p_delivery->>'supplier_id') is not null then
      insert into supplier_items(branch_id, supplier_id, item_id, last_unit_price, last_purchase_at)
      values (p_branch, (p_delivery->>'supplier_id')::uuid, i.id, v_unit, v_at)
      on conflict (supplier_id, item_id) do update set last_unit_price = excluded.last_unit_price, last_purchase_at = excluded.last_purchase_at;
    end if;
  end loop;
  update deliveries set total_amount = v_sum where id = v_id;
  -- link to an owner-approved, ordered reorder list if given
  if (p_delivery->>'reorder_list_id') is not null then
    update reorder_lists set status = 'received', delivery_id = v_id
     where id = (p_delivery->>'reorder_list_id')::uuid and branch_id = p_branch and status = 'ordered';
  end if;
  return app.idem_put(p_client_uuid, p_branch, 'receive_delivery', jsonb_build_object('id', v_id, 'total', v_sum));
end $$;

-- ───────── 5.3 Production ─────────
create or replace function public.run_production(p_client_uuid uuid, p_token uuid, p_branch uuid, p_recipe_id uuid,
  p_output_qty numeric, p_actual_inputs jsonb default null, p_occurred_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_actor uuid; rec prep_recipes; v_out items; v_run uuid := gen_random_uuid(); x record; v_qty numeric;
  v_cost numeric := 0; v_avg numeric; v_batch uuid; v_at timestamptz := app.effective_time(p_occurred_at);
  r jsonb := app.idem_get(p_client_uuid);
begin
  if r is not null then return r; end if;
  v_actor := app.require_role(p_token, p_branch, array['kitchen','manager']);
  select * into rec from prep_recipes where id = p_recipe_id and branch_id = p_branch and is_active;
  if not found then raise exception 'BAD_INPUT: Unknown prep recipe.'; end if;
  if p_output_qty <= 0 then raise exception 'BAD_QTY: Output must be more than zero.'; end if;
  select * into v_out from items where id = rec.output_item_id;
  insert into production_runs(id, branch_id, recipe_id, business_date, output_qty_actual, made_by, client_uuid, occurred_at)
  values (v_run, p_branch, rec.id, app.business_date(p_branch, v_at), p_output_qty, v_actor, p_client_uuid, v_at);
  for x in select item_id, qty from prep_recipe_inputs where recipe_id = rec.id loop
    -- actual inputs if entered, otherwise scale the recipe to the actual output
    v_qty := coalesce((select (e->>'qty')::numeric from jsonb_array_elements(coalesce(p_actual_inputs,'[]')) e where (e->>'item_id')::uuid = x.item_id),
                      round(x.qty * p_output_qty / rec.standard_output_qty, 3));
    v_avg := app.deduct_stock(p_branch, x.item_id, 'production_out', v_qty, 'production_runs', v_run, v_actor, v_at);
    v_cost := v_cost + v_qty * v_avg;
    insert into production_run_inputs(branch_id, run_id, item_id, qty_used) values (p_branch, v_run, x.item_id, v_qty);
  end loop;
  v_batch := app.add_stock(p_branch, rec.output_item_id, 'production_in', p_output_qty, v_cost / p_output_qty,
    case when v_out.shelf_life_days is not null then app.business_date(p_branch, v_at) + v_out.shelf_life_days end,
    'production', v_run, 'production_runs', v_run, v_actor, v_at);
  update production_runs set output_batch_id = v_batch where id = v_run;
  return app.idem_put(p_client_uuid, p_branch, 'run_production',
    jsonb_build_object('id', v_run, 'output_qty', p_output_qty, 'unit_cost', round(v_cost / p_output_qty, 6)));
end $$;

-- ───────── 5.7 Waste ─────────
create or replace function public.log_waste(p_client_uuid uuid, p_token uuid, p_branch uuid, p_item_id uuid, p_qty numeric,
  p_reason text, p_note text default null, p_batch_id uuid default null, p_session_id uuid default null,
  p_occurred_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_actor uuid; v_id uuid := gen_random_uuid(); v_avg numeric; v_at timestamptz := app.effective_time(p_occurred_at);
  r jsonb := app.idem_get(p_client_uuid);
begin
  if r is not null then return r; end if;
  v_actor := app.require_role(p_token, p_branch, array['kitchen','manager','server','cashier']);
  if p_reason = 'other' and coalesce(trim(p_note), '') = '' then raise exception 'NOTE_REQUIRED: Add a note for "other".'; end if;
  if not exists (select 1 from items where id = p_item_id and branch_id = p_branch) then raise exception 'BAD_INPUT: Unknown item.'; end if;
  insert into waste_logs(id, branch_id, business_date, item_id, batch_id, qty, reason, note, session_id, logged_by, client_uuid, occurred_at)
  values (v_id, p_branch, app.business_date(p_branch, v_at), p_item_id, p_batch_id, p_qty, p_reason, p_note, p_session_id, v_actor, p_client_uuid, v_at);
  v_avg := app.deduct_stock(p_branch, p_item_id, 'waste', p_qty, 'waste_logs', v_id, v_actor, v_at, p_batch_id);
  update waste_logs set unit_cost_at_time = v_avg where id = v_id;
  return app.idem_put(p_client_uuid, p_branch, 'log_waste', jsonb_build_object('id', v_id, 'value', round(p_qty * v_avg, 2)));
end $$;

-- One tap: log an expired batch as waste (§5.6).
create or replace function public.waste_expired_batch(p_client_uuid uuid, p_token uuid, p_batch_id uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare b stock_batches;
begin
  select * into b from stock_batches where id = p_batch_id;
  if not found or b.qty_remaining <= 0 then raise exception 'BAD_INPUT: Batch is empty.'; end if;
  return public.log_waste(p_client_uuid, p_token, b.branch_id, b.item_id, b.qty_remaining, 'expired', null, b.id);
end $$;

-- ───────── 5.4 Live stock, 5.6 expiry ─────────
create or replace function public.get_live_stock(p_branch uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare v_today date := app.business_date(p_branch);
begin
  perform app.assert_branch(p_branch);
  return coalesce((select jsonb_agg(jsonb_build_object(
      'item_id', i.id, 'name', i.name, 'category_id', i.category_id, 'stage', i.stage, 'base_unit', i.base_unit,
      'count_unit', i.count_unit, 'count_unit_factor', i.count_unit_factor,
      'qty', coalesce(l.qty_on_hand, 0), 'avg_unit_cost', coalesce(l.avg_unit_cost, 0),
      'reorder_level', i.reorder_level, 'par_level', i.par_level, 'is_watch', i.is_watch,
      'is_refillable', i.is_refillable, 'grams_per_plate', i.grams_per_plate,
      'last_movement_at', l.last_movement_at,
      'near_expiry', exists (select 1 from stock_batches b where b.item_id = i.id and b.qty_remaining > 0
                              and b.expiry_date is not null and b.expiry_date <= v_today + i.near_expiry_days),
      'expired', exists (select 1 from stock_batches b where b.item_id = i.id and b.qty_remaining > 0 and b.expiry_date < v_today),
      'status', case when coalesce(l.qty_on_hand,0) <= 0 then 'out' when coalesce(l.qty_on_hand,0) <= i.reorder_level then 'low' else 'ok' end
    ) order by i.sort_order, i.name)
    from items i left join item_stock_levels l on l.item_id = i.id
    where i.branch_id = p_branch and i.is_active), '[]');
end $$;

create or replace function public.get_near_expiry(p_branch uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare v_today date := app.business_date(p_branch);
begin
  perform app.assert_branch(p_branch);
  return coalesce((select jsonb_agg(jsonb_build_object('batch_id', b.id, 'item_id', i.id, 'name', i.name, 'base_unit', i.base_unit,
      'count_unit', i.count_unit, 'count_unit_factor', i.count_unit_factor,
      'qty_remaining', b.qty_remaining, 'expiry_date', b.expiry_date, 'days_left', b.expiry_date - v_today,
      'expired', b.expiry_date < v_today, 'received_at', b.received_at) order by b.expiry_date, i.name)
    from stock_batches b join items i on i.id = b.item_id
    where b.branch_id = p_branch and b.qty_remaining > 0 and b.expiry_date is not null
      and b.expiry_date <= v_today + i.near_expiry_days), '[]');
end $$;

create or replace function public.get_batches(p_branch uuid, p_item_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
begin
  perform app.assert_branch(p_branch);
  return coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'source_type', b.source_type, 'received_at', b.received_at,
      'expiry_date', b.expiry_date, 'qty_initial', b.qty_initial, 'qty_remaining', b.qty_remaining, 'unit_cost', b.unit_cost)
      order by b.received_at, b.id)
    from stock_batches b where b.branch_id = p_branch and b.item_id = p_item_id and b.qty_remaining > 0), '[]');
end $$;

create or replace function public.daily_expiry_digest(p_branch uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_n int; v_exp int; v_today date := app.business_date(p_branch);
begin
  select count(distinct b.item_id), count(distinct b.item_id) filter (where b.expiry_date < v_today) into v_n, v_exp
    from stock_batches b join items i on i.id = b.item_id
   where b.branch_id = p_branch and b.qty_remaining > 0 and b.expiry_date <= v_today + i.near_expiry_days;
  if v_n > 0 then
    perform app.notify(p_branch, array['manager','kitchen'], 'expiry_digest',
      v_n || ' items are near expiry', case when v_exp > 0 then v_exp || ' already expired — log them as waste.' end, null, null, 'high');
  end if;
  return jsonb_build_object('near_expiry_items', v_n, 'expired_items', v_exp);
end $$;

-- ───────── 5.8 Counts ─────────
-- p_lines: [{item_id, counted (in count unit), reason}]
create or replace function public.submit_count(p_client_uuid uuid, p_token uuid, p_branch uuid, p_count_type text,
  p_lines jsonb, p_notes text default null, p_occurred_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_actor uuid; v_id uuid := gen_random_uuid(); l jsonb; i items; v_counted numeric; v_expected numeric; v_var numeric;
  v_avg numeric; v_need boolean; v_abs numeric; v_pct numeric; v_missing text[] := '{}'; v_at timestamptz := app.effective_time(p_occurred_at);
  r jsonb := app.idem_get(p_client_uuid);
begin
  if r is not null then return r; end if;
  v_actor := app.require_role(p_token, p_branch, array['kitchen','manager']);
  v_pct := (app.setting(p_branch, 'variance_threshold_pct'))::numeric;
  insert into stock_counts(id, branch_id, business_date, count_type, status, counted_by, notes, client_uuid, occurred_at)
  values (v_id, p_branch, app.business_date(p_branch, v_at), p_count_type, 'submitted', v_actor, p_notes, p_client_uuid, v_at);
  for l in select * from jsonb_array_elements(p_lines) loop
    select * into i from items where id = (l->>'item_id')::uuid and branch_id = p_branch;
    v_counted := round((l->>'counted')::numeric * i.count_unit_factor, 3);
    select coalesce(qty_on_hand, 0), coalesce(avg_unit_cost, 0) into v_expected, v_avg from item_stock_levels where item_id = i.id;
    v_expected := coalesce(v_expected, 0); v_avg := coalesce(v_avg, 0);
    v_var := v_counted - v_expected;
    v_abs := (app.setting(p_branch, 'variance_abs_' || i.base_unit))::numeric;
    -- reason needed when BOTH the % and the absolute minimum are exceeded (§5.8)
    v_need := abs(v_var) > v_abs and (v_expected = 0 or abs(v_var) / abs(v_expected) > v_pct);
    if v_need and p_count_type = 'closing' and coalesce(trim(l->>'reason'), '') = '' then
      v_missing := v_missing || i.name;
    end if;
    insert into stock_count_lines(branch_id, count_id, item_id, counted_qty, expected_qty, variance_qty, variance_value, needs_reason, reason, approve_adjustment)
    values (p_branch, v_id, i.id, v_counted, v_expected, v_var, round(v_var * v_avg, 2), v_need, nullif(trim(l->>'reason'), ''),
            p_count_type <> 'opening');
  end loop;
  if array_length(v_missing, 1) > 0 then
    raise exception 'REASON_REQUIRED: Add a reason for: %', array_to_string(v_missing, ', ');
  end if;
  perform app.notify(p_branch, array['manager'], 'count_submitted', initcap(p_count_type) || ' count waiting for approval', null, 'stock_counts', v_id);
  return app.idem_put(p_client_uuid, p_branch, 'submit_count', public.get_count(v_id));
end $$;

create or replace function public.get_count(p_count_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare c stock_counts;
begin
  select * into c from stock_counts where id = p_count_id;
  if not found then raise exception 'NOT_FOUND: Count not found.'; end if;
  return to_jsonb(c) || jsonb_build_object(
    'counted_by_name', (select full_name from profiles where id = c.counted_by),
    'lines', coalesce((select jsonb_agg(to_jsonb(x) || jsonb_build_object('name', i.name, 'base_unit', i.base_unit,
        'count_unit', i.count_unit, 'count_unit_factor', i.count_unit_factor,
        'variance_pct', case when x.expected_qty <> 0 then round(x.variance_qty / abs(x.expected_qty) * 100, 1) end)
        order by i.sort_order, i.name)
      from stock_count_lines x join items i on i.id = x.item_id where x.count_id = c.id), '[]'));
end $$;

create or replace function public.list_counts(p_branch uuid, p_limit int default 30) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
begin
  perform app.assert_branch(p_branch);
  return coalesce((select jsonb_agg(x order by x->>'created_at' desc) from (
    select jsonb_build_object('id', c.id, 'business_date', c.business_date, 'count_type', c.count_type, 'status', c.status,
      'counted_by_name', (select full_name from profiles where id = c.counted_by), 'created_at', c.created_at,
      'lines', (select count(*) from stock_count_lines where count_id = c.id),
      'flagged', (select count(*) from stock_count_lines where count_id = c.id and needs_reason),
      'variance_value', (select coalesce(sum(variance_value),0) from stock_count_lines where count_id = c.id)) x
    from stock_counts c where c.branch_id = p_branch order by c.created_at desc limit p_limit) s), '[]');
end $$;

-- Approval posts count_adjustment movements against the expected snapshot and builds the shift summary.
-- p_approve_items: for opening counts, the item ids whose differences the manager accepts.
create or replace function public.approve_count(p_token uuid, p_count_id uuid, p_approve_items uuid[] default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare c stock_counts; v_actor uuid; x record; v_now numeric; v_delta numeric;
begin
  select * into c from stock_counts where id = p_count_id for update;
  if not found then raise exception 'NOT_FOUND: Count not found.'; end if;
  v_actor := app.require_role(p_token, c.branch_id, array['manager']);
  if c.status = 'approved' then raise exception 'ALREADY_DONE: This count is already approved.'; end if;
  for x in select * from stock_count_lines where count_id = c.id loop
    if c.count_type = 'opening' and not (x.item_id = any(coalesce(p_approve_items, '{}'))) then
      update stock_count_lines set approve_adjustment = false where count_id = c.id and item_id = x.item_id;
      continue;
    end if;
    -- adjust by the variance against the snapshot, so sales posted after the count are kept
    v_delta := x.variance_qty;
    if v_delta > 0 then
      perform app.add_stock(c.branch_id, x.item_id, 'count_adjustment', v_delta, null, null, 'count', c.id, 'stock_counts', c.id, v_actor);
    elsif v_delta < 0 then
      perform app.deduct_stock(c.branch_id, x.item_id, 'count_adjustment', -v_delta, 'stock_counts', c.id, v_actor);
    end if;
    update stock_count_lines set approve_adjustment = true where count_id = c.id and item_id = x.item_id;
  end loop;
  update stock_counts set status = 'approved', approved_by = v_actor, approved_at = app.now() where id = c.id;
  return public.get_count(c.id) || jsonb_build_object('shift_summary',
    case when c.count_type = 'closing' then public.shift_summary(c.branch_id, c.business_date) end);
end $$;

-- ───────── 5.9 Suppliers ─────────
create or replace function public.get_suppliers(p_branch uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
begin
  perform app.assert_branch(p_branch);
  return coalesce((select jsonb_agg(to_jsonb(s) || jsonb_build_object('items', coalesce((
      select jsonb_agg(jsonb_build_object('item_id', i.id, 'name', i.name, 'base_unit', i.base_unit, 'count_unit', i.count_unit,
        'count_unit_factor', i.count_unit_factor, 'last_unit_price', si.last_unit_price, 'last_purchase_at', si.last_purchase_at,
        'simple_avg', (select avg(dl.unit_cost) from delivery_lines dl join deliveries d on d.id = dl.delivery_id where d.supplier_id = s.id and dl.item_id = i.id),
        'weighted_avg', (select sum(dl.line_total) / nullif(sum(dl.qty_base),0) from delivery_lines dl join deliveries d on d.id = dl.delivery_id where d.supplier_id = s.id and dl.item_id = i.id))
        order by i.name)
      from supplier_items si join items i on i.id = si.item_id where si.supplier_id = s.id), '[]')) order by s.name)
    from suppliers s where s.branch_id = p_branch and s.is_active), '[]');
end $$;

-- ───────── 5.10 Reorder list with dual approval ─────────
create or replace function public.generate_reorder_list(p_token uuid, p_branch uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_actor uuid; v_id uuid := gen_random_uuid(); v_n int;
begin
  v_actor := app.require_role(p_token, p_branch, array['manager']);
  insert into reorder_lists(id, branch_id, created_by) values (v_id, p_branch, v_actor);
  insert into reorder_lines(branch_id, list_id, item_id, supplier_id, suggested_qty, final_qty, est_unit_price)
  select p_branch, v_id, i.id, i.default_supplier_id, greatest(i.par_level - coalesce(l.qty_on_hand,0), 0),
         greatest(i.par_level - coalesce(l.qty_on_hand,0), 0),
         coalesce((select last_unit_price from supplier_items si where si.supplier_id = i.default_supplier_id and si.item_id = i.id), l.avg_unit_cost)
    from items i left join item_stock_levels l on l.item_id = i.id
   where i.branch_id = p_branch and i.is_active and i.stage in ('raw','resale','supply')
     and coalesce(l.qty_on_hand,0) <= i.reorder_level and i.par_level > coalesce(l.qty_on_hand,0);
  get diagnostics v_n = row_count;
  return public.get_reorder_list(v_id);
end $$;

create or replace function public.get_reorder_list(p_list_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare rl reorder_lists;
begin
  select * into rl from reorder_lists where id = p_list_id;
  perform app.assert_branch(rl.branch_id);
  return to_jsonb(rl) || jsonb_build_object(
    'manager_name', (select full_name from profiles where id = rl.manager_approved_by),
    'owner_name', (select full_name from profiles where id = rl.owner_approved_by),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('item_id', i.id, 'name', i.name, 'base_unit', i.base_unit,
        'count_unit', i.count_unit, 'count_unit_factor', i.count_unit_factor, 'supplier_id', x.supplier_id,
        'supplier_name', s.name, 'supplier_phone', s.phones[1], 'suggested_qty', x.suggested_qty, 'final_qty', x.final_qty,
        'est_unit_price', x.est_unit_price, 'est_cost', round(x.final_qty * coalesce(x.est_unit_price,0), 2)) order by s.name nulls last, i.name)
      from reorder_lines x join items i on i.id = x.item_id left join suppliers s on s.id = x.supplier_id where x.list_id = rl.id), '[]'));
end $$;

create or replace function public.list_reorder_lists(p_branch uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
begin
  perform app.assert_branch(p_branch);
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'status', status, 'created_at', created_at,
      'lines', (select count(*) from reorder_lines where list_id = r.id),
      'est_total', (select round(coalesce(sum(final_qty * coalesce(est_unit_price,0)),0),2) from reorder_lines where list_id = r.id))
      order by created_at desc)
    from reorder_lists r where branch_id = p_branch), '[]');
end $$;

-- Quantities in count units; editing before approval. Owner edits are audited (audit trigger on reorder_lines).
create or replace function public.update_reorder_line(p_token uuid, p_list_id uuid, p_item_id uuid, p_final_qty_count numeric) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare rl reorder_lists; v_actor uuid; v_role text;
begin
  select * into rl from reorder_lists where id = p_list_id;
  v_actor := app.require_role(p_token, rl.branch_id, array['manager']);
  v_role := app.role_of(v_actor, rl.branch_id);
  if rl.status = 'draft' or (rl.status = 'manager_approved' and v_role in ('owner','admin')) then
    update reorder_lines x set final_qty = round(p_final_qty_count * i.count_unit_factor, 3)
      from items i where i.id = x.item_id and x.list_id = p_list_id and x.item_id = p_item_id;
  else
    raise exception 'LOCKED: This list can no longer be edited.';
  end if;
  return public.get_reorder_list(p_list_id);
end $$;

-- level = 'manager' first, then 'owner'. A manager's approval alone never releases an order (§5.10).
create or replace function public.approve_reorder(p_token uuid, p_list_id uuid, p_level text) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare rl reorder_lists; v_actor uuid; v_role text;
begin
  select * into rl from reorder_lists where id = p_list_id for update;
  if p_level = 'manager' then
    v_actor := app.require_role(p_token, rl.branch_id, array['manager']);
    if rl.status <> 'draft' then raise exception 'BAD_STATE: Only a draft can get manager approval.'; end if;
    update reorder_lists set status = 'manager_approved', manager_approved_by = v_actor, manager_approved_at = app.now() where id = rl.id;
    perform app.notify(rl.branch_id, array['owner'], 'reorder_waiting', 'Reorder list waiting for your approval', null, 'reorder_lists', rl.id, 'high');
  elsif p_level = 'owner' then
    v_actor := app.actor(p_token);
    v_role := app.role_of(v_actor, rl.branch_id);
    if v_role <> 'owner' then raise exception 'FORBIDDEN: Only the owner gives final approval.'; end if;
    perform set_config('app.actor', v_actor::text, true);
    if rl.status <> 'manager_approved' then raise exception 'BAD_STATE: The branch manager must approve first.'; end if;
    update reorder_lists set status = 'owner_approved', owner_approved_by = v_actor, owner_approved_at = app.now() where id = rl.id;
  else
    raise exception 'BAD_INPUT: level must be manager or owner.';
  end if;
  return public.get_reorder_list(rl.id);
end $$;

create or replace function public.reject_reorder(p_token uuid, p_list_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare rl reorder_lists; v_actor uuid;
begin
  select * into rl from reorder_lists where id = p_list_id for update;
  v_actor := app.require_role(p_token, rl.branch_id, array['manager']);
  if rl.status not in ('draft','manager_approved') then raise exception 'BAD_STATE: Cannot reject now.'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'REASON_REQUIRED: Give a reason.'; end if;
  update reorder_lists set status = 'rejected', rejected_by = v_actor, reject_reason = p_reason where id = rl.id;
  return public.get_reorder_list(rl.id);
end $$;

create or replace function public.mark_reorder_ordered(p_token uuid, p_list_id uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare rl reorder_lists;
begin
  select * into rl from reorder_lists where id = p_list_id for update;
  perform app.require_role(p_token, rl.branch_id, array['manager']);
  if rl.status <> 'owner_approved' then raise exception 'NEEDS_OWNER: JD must approve before ordering.'; end if;
  update reorder_lists set status = 'ordered', ordered_at = app.now() where id = rl.id;
  return public.get_reorder_list(rl.id);
end $$;
