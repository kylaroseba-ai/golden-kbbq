-- v0.6: accounts and roles.
--  • One person can hold several roles in a branch (Robin: server + dispatch).
--  • New roles: dispatch (prepares and plates; can do what kitchen does) and utility (time clock only).
--  • Staff token can travel in the x-staff-token request header, so read functions know which
--    staff member is using a shared device without changing every function's arguments.
--  • Dashboard, reports and staff schedules are manager-only in the database (§3.1).
--  • Unit costs are removed from stock data for roles that should not see them.
--  • People and device management for the Setup screens.

-- ───────── Roles ─────────
alter table user_branch_roles drop constraint user_branch_roles_role_check;
alter table user_branch_roles add constraint user_branch_roles_role_check
  check (role in ('owner','admin','manager','cashier','server','kitchen','dispatch','utility'));
alter table user_branch_roles drop constraint user_branch_roles_pkey;
alter table user_branch_roles add primary key (user_id, branch_id, role);

alter table devices drop constraint devices_kind_check;
alter table devices add constraint devices_kind_check check (kind in ('cashier','server','kitchen','dispatch','owner'));
alter table devices add column registered_by uuid references profiles;

alter table profiles add column email text;
alter table profiles add column invited_at timestamptz;
create unique index profiles_email_key on profiles (lower(email)) where email is not null;

-- Highest role first: this is the role shown on screen and used where one role is needed.
create or replace function app.role_rank(p_role text) returns int language sql immutable as $$
  select array_position(array['owner','admin','manager','cashier','dispatch','kitchen','server','utility'], p_role)
$$;

create or replace function app.roles_of(p_user uuid, p_branch uuid) returns text[]
language sql stable security definer set search_path = public, app as $$
  select coalesce(array_agg(role order by app.role_rank(role)), '{}') from user_branch_roles
   where user_id = p_user and branch_id = p_branch
$$;

create or replace function app.role_of(p_user uuid, p_branch uuid) returns text
language sql stable security definer set search_path = public, app as $$
  select (app.roles_of(p_user, p_branch))[1]
$$;

create or replace view app.primary_roles as
  select distinct on (user_id, branch_id) user_id, branch_id, role
    from user_branch_roles order by user_id, branch_id, app.role_rank(role);

-- Owner and admin can do everything; dispatch can do what kitchen can.
create or replace function app.has_any_role(p_user uuid, p_branch uuid, p_roles text[]) returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (select 1 from user_branch_roles r where r.user_id = p_user and r.branch_id = p_branch
    and (r.role = any(p_roles) or r.role in ('owner','admin') or (r.role = 'dispatch' and 'kitchen' = any(p_roles))))
$$;

-- ───────── Who is acting ─────────
create or replace function app.header_token() returns uuid language plpgsql stable as $$
declare h text := current_setting('request.headers', true); v text;
begin
  if h is null or h = '' then return null; end if;
  v := (h::json)->>'x-staff-token';
  if v is null or v !~ '^[0-9a-fA-F-]{36}$' then return null; end if;
  return v::uuid;
end $$;

-- Order: explicit token → header token → already checked earlier in this request → personal login.
create or replace function app.actor(p_token uuid) returns uuid
language plpgsql stable security definer set search_path = public, app as $$
declare v_user uuid; v_tok uuid := coalesce(p_token, app.header_token()); v_prev text;
begin
  if v_tok is not null then
    select t.user_id into v_user
      from staff_tokens t join devices d on d.id = t.device_id
     where t.id = v_tok and t.revoked_at is null and t.expires_at > app.now()
       and d.revoked_at is null and d.auth_user_id = auth.uid();
    if v_user is null then raise exception 'SESSION_EXPIRED: Staff sign-in expired. Enter your PIN again.'; end if;
    return v_user;
  end if;
  v_prev := nullif(current_setting('app.actor', true), '');
  if v_prev is not null then return v_prev::uuid; end if;
  select id into v_user from profiles where auth_user_id = auth.uid() and is_active;
  if v_user is null then raise exception 'NOT_SIGNED_IN: Not signed in.'; end if;
  return v_user;
end $$;

create or replace function app.require_role(p_token uuid, p_branch uuid, p_roles text[]) returns uuid
language plpgsql stable security definer set search_path = public, app as $$
declare v_user uuid := app.actor(p_token); v_role text;
begin
  v_role := app.role_of(v_user, p_branch);
  if v_role is null then raise exception 'FORBIDDEN: No access to this branch.'; end if;
  if not app.has_any_role(v_user, p_branch, p_roles) then
    raise exception 'FORBIDDEN: Your role (%) cannot do this.', v_role;
  end if;
  perform set_config('app.actor', v_user::text, true);
  return v_user;
end $$;

-- True when the person using this device/login may see unit costs (manager, owner, admin, kitchen, dispatch).
create or replace function app.can_see_costs(p_branch uuid) returns boolean
language plpgsql stable security definer set search_path = public, app as $$
declare v_user uuid;
begin
  begin v_user := app.actor(null); exception when others then return false; end;
  return app.has_any_role(v_user, p_branch, array['manager','kitchen']);
end $$;

create or replace function app.strip_costs(p jsonb) returns jsonb language plpgsql immutable as $$
declare k text; v jsonb; r jsonb;
begin
  if jsonb_typeof(p) = 'object' then
    r := '{}';
    for k, v in select * from jsonb_each(p) loop
      if k not like '%cost%' and k not in ('value', 'stock_value') then r := r || jsonb_build_object(k, app.strip_costs(v)); end if;
    end loop;
    return r;
  elsif jsonb_typeof(p) = 'array' then
    return coalesce((select jsonb_agg(app.strip_costs(e) order by i) from jsonb_array_elements(p) with ordinality a(e, i)), '[]');
  end if;
  return p;
end $$;

-- ───────── Function patching helpers ─────────
-- Rewrites part of an existing function body; fails loudly if the text is not found.
create or replace function app.patch_fn(p_sig text, p_old text, p_new text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(p_sig::regprocedure); n text;
begin
  n := replace(d, p_old, p_new);
  if n = d then raise exception 'patch_fn: % does not contain %', p_sig, left(p_old, 60); end if;
  execute n;
end $$;

-- Moves public.<name> to app.<name>__impl and puts a checking wrapper in its place.
-- p_mode 'manager': caller must be manager/owner/admin of the branch.
-- p_mode 'costs'  : unit costs are removed unless the caller may see them.
create or replace function app.wrap_rpc(p_name text, p_branch_expr text, p_mode text) returns void language plpgsql as $f$
declare o oid; v_args text; v_ident text; v_names text[]; v_vol text; v_call text; v_pre text := ''; v_post text := '';
begin
  select p.oid, pg_get_function_arguments(p.oid), pg_get_function_identity_arguments(p.oid), p.proargnames,
         case p.provolatile when 's' then 'stable' else 'volatile' end
    into o, v_args, v_ident, v_names, v_vol
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = p_name;
  if o is null then raise exception 'wrap_rpc: public.% not found', p_name; end if;
  execute format('alter function public.%I(%s) set schema app', p_name, v_ident);
  execute format('alter function app.%I(%s) rename to %I', p_name, v_ident, p_name || '__impl');
  select string_agg(format('%1$I => %1$I', a), ', ') into v_call from unnest(v_names) a;
  if p_mode = 'manager' then
    v_pre := 'perform app.require_role(null, v_branch, array[''manager'']);';
  elsif p_mode = 'costs' then
    v_post := 'if not app.can_see_costs(v_branch) then r := app.strip_costs(r); end if;';
  else raise exception 'wrap_rpc: unknown mode %', p_mode; end if;
  execute format($w$
    create function public.%1$I(%2$s) returns jsonb language plpgsql %3$s security definer set search_path = public, app as $b$
    declare v_branch uuid := %4$s; r jsonb;
    begin
      %5$s
      r := app.%6$I(%7$s);
      %8$s
      return r;
    end $b$$w$, p_name, v_args, v_vol, p_branch_expr, v_pre, p_name || '__impl', v_call, v_post);
end $f$;

-- ───────── Manager-only reads (§3.1) ─────────
select app.wrap_rpc('get_dashboard', 'p_branch', 'manager');
select app.wrap_rpc('report_sales_summary', 'p_branch', 'manager');
select app.wrap_rpc('report_usage', 'p_branch', 'manager');
select app.wrap_rpc('report_waste', 'p_branch', 'manager');
select app.wrap_rpc('report_variance', 'p_branch', 'manager');
select app.wrap_rpc('report_avg_cost', 'p_branch', 'manager');
select app.wrap_rpc('report_refills', 'p_branch', 'manager');
select app.wrap_rpc('report_attendance', 'p_branch', 'manager');
select app.wrap_rpc('shift_summary', 'p_branch', 'manager');
select app.wrap_rpc('get_message_log', 'p_branch', 'manager');
select app.wrap_rpc('get_live_shifts', 'p_branch', 'manager');
select app.wrap_rpc('get_schedule', 'p_branch', 'manager');
select app.wrap_rpc('get_branch_staff', 'p_branch', 'manager');
select app.wrap_rpc('list_reorder_lists', 'p_branch', 'manager');
select app.wrap_rpc('get_reorder_list', '(select branch_id from reorder_lists where id = p_list_id)', 'manager');

-- ───────── Costs hidden from servers, cashiers and utility ─────────
select app.wrap_rpc('get_live_stock', 'p_branch', 'costs');
select app.wrap_rpc('get_bootstrap', 'p_branch', 'costs');
select app.wrap_rpc('get_batches', 'p_branch', 'costs');
select app.wrap_rpc('get_near_expiry', 'p_branch', 'costs');
select app.wrap_rpc('list_counts', 'p_branch', 'costs');
select app.wrap_rpc('get_count', '(select branch_id from stock_counts where id = p_count_id)', 'costs');

-- Nav badges are for everyone: count from the unchecked staff board.
select app.patch_fn('public.get_nav_counts(uuid)', 'public.get_live_shifts(p_branch)', 'app.get_live_shifts__impl(p_branch)');

-- ───────── New roles in existing functions ─────────
select app.patch_fn('public.clock_event(uuid,uuid,uuid,text,timestamptz,text)',
  'array[''server'',''cashier'',''kitchen'',''manager'']', 'array[''server'',''cashier'',''kitchen'',''utility'',''manager'']');
-- Staff boards list each person once, with their highest role; dispatch and utility included.
select app.patch_fn('app.get_live_shifts__impl(uuid,date)', 'from user_branch_roles r join profiles p', 'from app.primary_roles r join profiles p');
select app.patch_fn('app.get_live_shifts__impl(uuid,date)', 'r.role in (''manager'',''cashier'',''server'',''kitchen'')',
  'r.role in (''manager'',''cashier'',''server'',''kitchen'',''dispatch'',''utility'')');
select app.patch_fn('app.get_branch_staff__impl(uuid)', 'from user_branch_roles r join profiles p', 'from app.primary_roles r join profiles p');
select app.patch_fn('app.get_branch_staff__impl(uuid)', 'r.role in (''manager'',''cashier'',''server'',''kitchen'')',
  'r.role in (''manager'',''cashier'',''server'',''kitchen'',''dispatch'',''utility'')');
select app.patch_fn('app.report_attendance__impl(uuid,date,date)', 'from user_branch_roles r join profiles p', 'from app.primary_roles r join profiles p');
select app.patch_fn('app.report_attendance__impl(uuid,date,date)', 'r.role in (''manager'',''cashier'',''server'',''kitchen'')',
  'r.role in (''manager'',''cashier'',''server'',''kitchen'',''dispatch'',''utility'')');
select app.patch_fn('public.verify_pin(uuid,uuid,text,text)', '''role'', v_role, ''language''',
  '''role'', v_role, ''roles'', to_jsonb(app.roles_of(p.id, d.branch_id)), ''language''');

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
      'user', jsonb_build_object('id',v_profile.id,'full_name',v_profile.full_name,'language',v_profile.language,'email',v_profile.email),
      'branches', (select jsonb_agg(jsonb_build_object('id',b.id,'code',b.code,'name',b.name,
                     'role', app.role_of(v_profile.id, b.id), 'roles', to_jsonb(app.roles_of(v_profile.id, b.id))) order by b.code)
                     from branches b where b.id in (select branch_id from user_branch_roles where user_id = v_profile.id)));
  end if;
  return jsonb_build_object('mode','none');
end $$;

create or replace function public.list_device_staff(p_device_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare v_branch uuid;
begin
  select branch_id into v_branch from devices where id = p_device_id and auth_user_id = auth.uid() and revoked_at is null;
  if v_branch is null then raise exception 'FORBIDDEN: Unknown device.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'full_name',p.full_name,'role',r.role,
      'roles', to_jsonb(app.roles_of(p.id, v_branch)),'language',p.language) order by p.full_name)
    from app.primary_roles r join profiles p on p.id = r.user_id
   where r.branch_id = v_branch and p.is_active and p.pin_hash is not null and r.role not in ('owner','admin')), '[]');
end $$;

-- ───────── People (Setup → People) ─────────
-- Managers add and edit staff; only owner/admin can give manager rights; only admin can give owner/admin.
create or replace function app.assert_can_grant(p_actor uuid, p_branch uuid, p_roles text[]) returns void
language plpgsql stable security definer set search_path = public, app as $$
declare v_top text := app.role_of(p_actor, p_branch);
begin
  if p_roles && array['owner','admin'] and v_top <> 'admin' then
    raise exception 'FORBIDDEN: Only the system admin can give owner or admin access.';
  end if;
  if 'manager' = any(p_roles) and v_top not in ('owner','admin') then
    raise exception 'FORBIDDEN: Only the owner can give manager access.';
  end if;
end $$;

create or replace function public.list_people(p_branch uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
begin
  perform app.require_role(null, p_branch, array['manager']);
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', p.id, 'full_name', p.full_name, 'phone', p.phone, 'email', p.email, 'language', p.language,
      'roles', to_jsonb(app.roles_of(p.id, p_branch)), 'role', app.role_of(p.id, p_branch),
      'is_active', p.is_active, 'has_pin', p.pin_hash is not null,
      'has_login', p.auth_user_id is not null, 'invited_at', p.invited_at,
      'locked', exists (select 1 from pin_attempts a where a.user_id = p.id and a.locked_until > app.now()))
      order by p.is_active desc, app.role_rank(app.role_of(p.id, p_branch)), p.full_name)
    from profiles p where p.id in (select user_id from user_branch_roles where branch_id = p_branch)), '[]');
end $$;

create or replace function public.save_person(p_branch uuid, p_person jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_actor uuid := app.require_role(null, p_branch, array['manager']);
  v_id uuid := nullif(p_person->>'id', '')::uuid;
  v_name text := btrim(coalesce(p_person->>'full_name', ''));
  v_roles text[] := array(select distinct jsonb_array_elements_text(coalesce(p_person->'roles', '[]')));
  v_old text[];
begin
  if v_name = '' then raise exception 'BAD_INPUT: Name is required.'; end if;
  if cardinality(v_roles) = 0 then raise exception 'BAD_INPUT: Pick at least one role.'; end if;
  if exists (select 1 from unnest(v_roles) r where r not in ('owner','admin','manager','cashier','server','kitchen','dispatch','utility')) then
    raise exception 'BAD_INPUT: Unknown role.';
  end if;
  if v_id = v_actor then raise exception 'FORBIDDEN: You cannot change your own roles.'; end if;
  if v_id is not null then
    if not exists (select 1 from user_branch_roles where user_id = v_id and branch_id = p_branch) then
      raise exception 'FORBIDDEN: Not on this branch.';
    end if;
    v_old := app.roles_of(v_id, p_branch);
    -- changing someone who already has manager/owner/admin rights needs the same level
    perform app.assert_can_grant(v_actor, p_branch, v_old);
  end if;
  perform app.assert_can_grant(v_actor, p_branch, v_roles);
  if v_id is null then
    insert into profiles(full_name, phone, language) values (v_name, nullif(p_person->>'phone', ''), coalesce(nullif(p_person->>'language', ''), 'en'))
    returning id into v_id;
  else
    update profiles set full_name = v_name, phone = nullif(p_person->>'phone', ''),
      language = coalesce(nullif(p_person->>'language', ''), language)
     where id = v_id;
  end if;
  delete from user_branch_roles where user_id = v_id and branch_id = p_branch and role <> all(v_roles);
  insert into user_branch_roles(user_id, branch_id, role) select v_id, p_branch, r from unnest(v_roles) r on conflict do nothing;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- Deactivating signs the person out everywhere; their history stays.
create or replace function public.set_person_active(p_branch uuid, p_user_id uuid, p_active boolean) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_actor uuid := app.require_role(null, p_branch, array['manager']);
begin
  if p_user_id = v_actor then raise exception 'FORBIDDEN: You cannot deactivate yourself.'; end if;
  if not exists (select 1 from user_branch_roles where user_id = p_user_id and branch_id = p_branch) then
    raise exception 'FORBIDDEN: Not on this branch.';
  end if;
  perform app.assert_can_grant(v_actor, p_branch, app.roles_of(p_user_id, p_branch));
  update profiles set is_active = p_active where id = p_user_id;
  if not p_active then
    update staff_tokens set revoked_at = app.now() where user_id = p_user_id and revoked_at is null;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.unlock_pin(p_branch uuid, p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.require_role(null, p_branch, array['manager']);
  update pin_attempts set failed_count = 0, locked_until = null
   where user_id = p_user_id and device_id in (select id from devices where branch_id = p_branch);
  return jsonb_build_object('ok', true);
end $$;

-- Called by the invite-user Edge Function with the caller's own login, before it sends the email.
create or replace function public.prepare_invite(p_branch uuid, p_user_id uuid, p_full_name text, p_email text, p_roles text[]) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_actor uuid := app.require_role(null, p_branch, array['manager']);
  v_email text := lower(btrim(p_email)); v_id uuid := p_user_id; v_other uuid;
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'BAD_INPUT: Enter a valid email address.'; end if;
  if not (p_roles && array['owner','admin','manager']) then
    raise exception 'BAD_INPUT: Email logins are for owner, manager and admin. Staff use a PIN on a shared device.';
  end if;
  select id into v_other from profiles where lower(email) = v_email;
  if v_other is not null and v_other is distinct from v_id then
    raise exception 'BAD_INPUT: Someone else already uses this email.';
  end if;
  if v_id is null then
    v_id := (public.save_person(p_branch, jsonb_build_object('full_name', p_full_name, 'roles', to_jsonb(p_roles))))->>'id';
  else
    perform app.assert_can_grant(v_actor, p_branch, app.roles_of(v_id, p_branch) || p_roles);
    perform public.save_person(p_branch, jsonb_build_object('id', v_id, 'full_name', coalesce(nullif(p_full_name, ''), (select full_name from profiles where id = v_id)),
      'roles', to_jsonb(array(select distinct unnest(app.roles_of(v_id, p_branch) || p_roles)))));
  end if;
  update profiles set email = v_email, invited_at = app.now() where id = v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'email', v_email,
    'auth_user_id', (select auth_user_id from profiles where id = v_id));
end $$;

-- ───────── Devices (Setup → Devices) ─────────
create or replace function public.list_devices(p_branch uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
begin
  perform app.require_role(null, p_branch, array['manager']);
  return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'label', d.label, 'kind', d.kind,
      'registered', d.auth_user_id is not null, 'revoked_at', d.revoked_at, 'last_seen_at', d.last_seen_at,
      'created_at', d.created_at, 'registered_by', (select full_name from profiles where id = d.registered_by),
      'terminal', (select terminal_code from pos_terminals t where t.device_id = d.id))
      order by d.revoked_at nulls first, d.label)
    from devices d where d.branch_id = p_branch), '[]');
end $$;

-- Called by the register-device Edge Function with the manager's own login; the function then creates
-- the device's sign-in and stores its id with the service role.
create or replace function public.prepare_device(p_branch uuid, p_label text, p_kind text) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_actor uuid := app.require_role(null, p_branch, array['manager']); v_id uuid;
begin
  if btrim(coalesce(p_label, '')) = '' then raise exception 'BAD_INPUT: Give the device a name, e.g. "Server phone 1".'; end if;
  if p_kind not in ('cashier','server','kitchen','dispatch','owner') then raise exception 'BAD_INPUT: Unknown device type.'; end if;
  insert into devices(branch_id, label, kind, registered_by) values (p_branch, btrim(p_label), p_kind, v_actor) returning id into v_id;
  -- one cashier terminal record per cashier device (internal numbering only; BIR printing stays off)
  if p_kind = 'cashier' then
    insert into pos_terminals(branch_id, device_id, terminal_code)
    values (p_branch, v_id, 'T' || (select count(*) + 1 from pos_terminals where branch_id = p_branch));
  end if;
  return jsonb_build_object('ok', true, 'device_id', v_id);
end $$;

create or replace function public.rename_device(p_branch uuid, p_device_id uuid, p_label text) returns jsonb
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.require_role(null, p_branch, array['manager']);
  update devices set label = btrim(p_label) where id = p_device_id and branch_id = p_branch;
  return jsonb_build_object('ok', true);
end $$;
