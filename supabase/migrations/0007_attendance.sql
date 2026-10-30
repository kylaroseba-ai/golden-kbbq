-- Staff time clock (time-in / break / time-out) and shift schedules, with a live shift view.
-- Staff clock themselves after PIN sign-in on a shared device, or from their own login.

create table shift_schedules (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  user_id uuid not null references profiles,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  break_minutes integer not null default 60,
  position text,                               -- e.g. Server, Cashier, Grill / kitchen
  notes text,
  created_by uuid references profiles,
  created_at timestamptz not null default app.now(),
  check (ends_at > starts_at)
);
create index on shift_schedules (branch_id, starts_at);

create table time_entries (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches,
  user_id uuid not null references profiles,
  kind text not null check (kind in ('in','break_start','break_end','out')),
  occurred_at timestamptz not null,
  device_id uuid references devices,
  schedule_id uuid references shift_schedules,
  late_minutes integer,
  note text,
  entered_by uuid references profiles,         -- set when a manager adds or corrects an entry
  client_uuid uuid unique,
  created_at timestamptz not null default app.now()
);
create index on time_entries (branch_id, user_id, occurred_at);

alter table shift_schedules enable row level security;
alter table time_entries enable row level security;
create policy branch_read on shift_schedules for select using (branch_id in (select app.my_branches()));
create policy branch_read on time_entries for select using (branch_id in (select app.my_branches()));
create trigger audit_shift_schedules after insert or update or delete on shift_schedules for each row execute function app.audit_trigger();
create trigger audit_time_entries after insert or update or delete on time_entries for each row execute function app.audit_trigger();
create trigger no_delete_time_entries before delete on time_entries for each row execute function app.forbid_change();

create or replace function app.attendance_defaults() returns jsonb language sql immutable as $$
  select jsonb_build_object('late_grace_minutes', 5, 'absent_after_minutes', 60)
$$;

-- off | working | on_break, from the person's last entry
create or replace function app.clock_status(p_user uuid, p_branch uuid) returns text language sql stable as $$
  select case (select kind from time_entries where user_id = p_user and branch_id = p_branch order by occurred_at desc, created_at desc limit 1)
    when 'in' then 'working' when 'break_end' then 'working' when 'break_start' then 'on_break' else 'off' end
$$;

-- Minutes worked between two times: time in minus breaks; an open shift counts up to now.
create or replace function app.worked_minutes(p_user uuid, p_branch uuid, p_from timestamptz, p_to timestamptz)
returns numeric language plpgsql stable as $$
declare e record; v_start timestamptz; v_total numeric := 0; v_end timestamptz := least(p_to, app.now());
begin
  -- carry state in from before the window
  if app.clock_status_at(p_user, p_branch, p_from) = 'working' then v_start := p_from; end if;
  for e in select kind, occurred_at from time_entries where user_id = p_user and branch_id = p_branch
             and occurred_at >= p_from and occurred_at < p_to order by occurred_at, created_at loop
    if e.kind in ('in','break_end') then v_start := coalesce(v_start, e.occurred_at);
    elsif v_start is not null then v_total := v_total + extract(epoch from e.occurred_at - v_start) / 60; v_start := null; end if;
  end loop;
  if v_start is not null and v_end > v_start then v_total := v_total + extract(epoch from v_end - v_start) / 60; end if;
  return round(v_total);
end $$;

create or replace function app.clock_status_at(p_user uuid, p_branch uuid, p_at timestamptz) returns text language sql stable as $$
  select case (select kind from time_entries where user_id = p_user and branch_id = p_branch and occurred_at < p_at
                order by occurred_at desc, created_at desc limit 1)
    when 'in' then 'working' when 'break_end' then 'working' when 'break_start' then 'on_break' else 'off' end
$$;

-- Bounds of a business date as timestamps (opening cutoff to next cutoff).
create or replace function app.day_bounds(p_branch uuid, p_date date, out day_from timestamptz, out day_to timestamptz)
language sql stable as $$
  select (p_date + b.business_day_cutoff)::timestamp at time zone b.timezone,
         (p_date + 1 + b.business_day_cutoff)::timestamp at time zone b.timezone
  from branches b where b.id = p_branch
$$;

-- Time in / start break / end break / time out for the signed-in person.
create or replace function public.clock_event(p_client_uuid uuid, p_token uuid, p_branch uuid, p_kind text,
  p_occurred_at timestamptz default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_actor uuid; v_at timestamptz := app.effective_time(p_occurred_at); v_status text; sh shift_schedules; v_late int;
  v_grace int := (app.attendance_defaults()->>'late_grace_minutes')::int; v_name text; r jsonb := app.idem_get(p_client_uuid);
begin
  if r is not null then return r; end if;
  v_actor := app.require_role(p_token, p_branch, array['server','cashier','kitchen','manager']);
  v_status := app.clock_status(v_actor, p_branch);
  if p_kind = 'in' and v_status <> 'off' then raise exception 'ALREADY_IN: You are already timed in.'; end if;
  if p_kind = 'break_start' and v_status <> 'working' then raise exception 'NOT_WORKING: Time in first.'; end if;
  if p_kind = 'break_end' and v_status <> 'on_break' then raise exception 'NOT_ON_BREAK: You are not on a break.'; end if;
  if p_kind = 'out' and v_status = 'off' then raise exception 'NOT_IN: You are not timed in.'; end if;
  if p_kind not in ('in','break_start','break_end','out') then raise exception 'BAD_INPUT: Unknown clock action.'; end if;
  -- timing out from a break ends the break first
  if p_kind = 'out' and v_status = 'on_break' then
    insert into time_entries(branch_id, user_id, kind, occurred_at, device_id)
    values (p_branch, v_actor, 'break_end', v_at, (select id from devices where auth_user_id = auth.uid()));
  end if;
  if p_kind = 'in' then
    -- the scheduled shift this time-in belongs to (starts up to 3 h later, or already started and not ended)
    select * into sh from shift_schedules where user_id = v_actor and branch_id = p_branch
       and v_at between starts_at - interval '3 hours' and ends_at order by abs(extract(epoch from starts_at - v_at)) limit 1;
    if sh.id is not null then
      v_late := greatest(0, floor(extract(epoch from v_at - sh.starts_at) / 60))::int;
      if v_late <= v_grace then v_late := 0; end if;
    end if;
  end if;
  insert into time_entries(branch_id, user_id, kind, occurred_at, device_id, schedule_id, late_minutes, note, client_uuid)
  values (p_branch, v_actor, p_kind, v_at, (select id from devices where auth_user_id = auth.uid()), sh.id, v_late, p_note, p_client_uuid);
  if coalesce(v_late, 0) > 0 then
    select full_name into v_name from profiles where id = v_actor;
    perform app.notify(p_branch, array['manager'], 'staff_late', v_name || ' timed in ' || v_late || ' min late',
      'Shift started ' || to_char(sh.starts_at at time zone 'Asia/Manila', 'FMHH12:MI AM') || '.', 'profiles', v_actor);
  end if;
  return app.idem_put(p_client_uuid, p_branch, 'clock_event', jsonb_build_object('status', app.clock_status(v_actor, p_branch), 'late_minutes', v_late, 'at', v_at));
end $$;

-- Manager adds a missed entry (e.g. forgot to time out). Audited and marked with who entered it.
create or replace function public.manager_time_entry(p_token uuid, p_branch uuid, p_user_id uuid, p_kind text, p_at timestamptz, p_note text) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_mgr uuid;
begin
  v_mgr := app.require_role(p_token, p_branch, array['manager']);
  if coalesce(trim(p_note), '') = '' then raise exception 'REASON_REQUIRED: Add a note explaining the correction.'; end if;
  if app.role_of(p_user_id, p_branch) is null then raise exception 'FORBIDDEN: Not on this branch.'; end if;
  insert into time_entries(branch_id, user_id, kind, occurred_at, note, entered_by) values (p_branch, p_user_id, p_kind, p_at, p_note, v_mgr);
  return jsonb_build_object('ok', true);
end $$;

-- "My time" screen: status, today's entries and hours, and the week's schedule.
create or replace function public.get_my_time(p_token uuid, p_branch uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare v_user uuid := app.actor(p_token); v_today date := app.business_date(p_branch); b record; v_since timestamptz;
begin
  perform app.assert_branch(p_branch);
  select * into b from app.day_bounds(p_branch, v_today);
  select occurred_at into v_since from time_entries where user_id = v_user and branch_id = p_branch and kind = 'in'
   order by occurred_at desc limit 1;
  return jsonb_build_object('server_time', app.now(), 'business_date', v_today,
    'user', (select jsonb_build_object('id', id, 'full_name', full_name, 'role', app.role_of(id, p_branch)) from profiles where id = v_user),
    'status', app.clock_status(v_user, p_branch),
    'since', case when app.clock_status(v_user, p_branch) <> 'off' then v_since end,
    'worked_minutes_today', app.worked_minutes(v_user, p_branch, b.day_from, b.day_to),
    'entries_today', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'occurred_at', occurred_at, 'late_minutes', late_minutes) order by occurred_at)
        from time_entries where user_id = v_user and branch_id = p_branch and occurred_at >= b.day_from and occurred_at < b.day_to), '[]'),
    'schedule', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'starts_at', starts_at, 'ends_at', ends_at, 'break_minutes', break_minutes, 'position', position) order by starts_at)
        from shift_schedules where user_id = v_user and branch_id = p_branch and ends_at >= b.day_from and starts_at < b.day_from + interval '7 days'), '[]'));
end $$;

-- Live shift board for a business date: who is scheduled, working, on break, late or absent.
create or replace function public.get_live_shifts(p_branch uuid, p_date date default null) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare v_date date := coalesce(p_date, app.business_date(p_branch)); b record;
  v_grace int := (app.attendance_defaults()->>'late_grace_minutes')::int; v_absent int := (app.attendance_defaults()->>'absent_after_minutes')::int;
  v_rows jsonb;
begin
  perform app.assert_branch(p_branch);
  select * into b from app.day_bounds(p_branch, v_date);
  select coalesce(jsonb_agg(x order by x->>'sort_start', x->>'full_name'), '[]') into v_rows from (
    select jsonb_build_object(
      'user_id', p.id, 'full_name', p.full_name, 'role', r.role,
      'shifts', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'starts_at', s.starts_at, 'ends_at', s.ends_at, 'position', s.position, 'break_minutes', s.break_minutes) order by s.starts_at)
          from shift_schedules s where s.user_id = p.id and s.branch_id = p_branch and s.starts_at < b.day_to and s.ends_at > b.day_from), '[]'),
      'entries', coalesce((select jsonb_agg(jsonb_build_object('kind', e.kind, 'occurred_at', e.occurred_at, 'late_minutes', e.late_minutes, 'manual', e.entered_by is not null) order by e.occurred_at)
          from time_entries e where e.user_id = p.id and e.branch_id = p_branch and e.occurred_at >= b.day_from and e.occurred_at < b.day_to), '[]'),
      'worked_minutes', app.worked_minutes(p.id, p_branch, b.day_from, b.day_to),
      'clock', app.clock_status(p.id, p_branch),
      'late_minutes', (select max(late_minutes) from time_entries e where e.user_id = p.id and e.branch_id = p_branch and e.kind = 'in' and e.occurred_at >= b.day_from and e.occurred_at < b.day_to),
      'first_start', (select min(starts_at) from shift_schedules s where s.user_id = p.id and s.branch_id = p_branch and s.starts_at < b.day_to and s.ends_at > b.day_from),
      'timed_in_today', exists (select 1 from time_entries e where e.user_id = p.id and e.branch_id = p_branch and e.kind = 'in' and e.occurred_at >= b.day_from and e.occurred_at < b.day_to),
      'sort_start', coalesce((select min(starts_at) from shift_schedules s where s.user_id = p.id and s.branch_id = p_branch and s.starts_at < b.day_to and s.ends_at > b.day_from)::text, 'z')) x
    from user_branch_roles r join profiles p on p.id = r.user_id
    where r.branch_id = p_branch and p.is_active and r.role in ('manager','cashier','server','kitchen')
      and (exists (select 1 from shift_schedules s where s.user_id = p.id and s.branch_id = p_branch and s.starts_at < b.day_to and s.ends_at > b.day_from)
        or exists (select 1 from time_entries e where e.user_id = p.id and e.branch_id = p_branch and e.occurred_at >= b.day_from and e.occurred_at < b.day_to))) q;
  -- status per person
  select coalesce(jsonb_agg(x || jsonb_build_object('status',
      case when x->>'clock' = 'on_break' then 'on_break'
           when x->>'clock' = 'working' then case when coalesce((x->>'late_minutes')::int, 0) > 0 then 'late' else 'working' end
           when (x->>'timed_in_today')::boolean then 'done'
           when x->>'first_start' is null then 'off'
           when app.now() > (x->>'first_start')::timestamptz + make_interval(mins => v_absent) then 'absent'
           when app.now() > (x->>'first_start')::timestamptz + make_interval(mins => v_grace) then 'late'
           else 'scheduled' end)), '[]')
    into v_rows from jsonb_array_elements(v_rows) x;
  return jsonb_build_object('server_time', app.now(), 'business_date', v_date, 'day_from', b.day_from, 'day_to', b.day_to, 'staff', v_rows,
    'counts', jsonb_build_object(
      'scheduled', (select count(*) from jsonb_array_elements(v_rows) x where jsonb_array_length(x->'shifts') > 0),
      'working', (select count(*) from jsonb_array_elements(v_rows) x where x->>'clock' = 'working'),
      'on_break', (select count(*) from jsonb_array_elements(v_rows) x where x->>'clock' = 'on_break'),
      'late', (select count(*) from jsonb_array_elements(v_rows) x where coalesce((x->>'late_minutes')::int, 0) > 0 or x->>'status' = 'late'),
      'absent', (select count(*) from jsonb_array_elements(v_rows) x where x->>'status' = 'absent')));
end $$;

-- Schedule editing (manager). Staff list for the editor comes from get_branch_staff.
create or replace function public.get_branch_staff(p_branch uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
begin
  perform app.assert_branch(p_branch);
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'full_name', p.full_name, 'role', r.role) order by r.role, p.full_name)
    from user_branch_roles r join profiles p on p.id = r.user_id
    where r.branch_id = p_branch and p.is_active and r.role in ('manager','cashier','server','kitchen')), '[]');
end $$;

create or replace function public.get_schedule(p_branch uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare a record; z record;
begin
  perform app.assert_branch(p_branch);
  select * into a from app.day_bounds(p_branch, p_from);
  select * into z from app.day_bounds(p_branch, p_to);
  return coalesce((select jsonb_agg(to_jsonb(s) || jsonb_build_object('full_name', p.full_name,
      'business_date', app.business_date(p_branch, s.starts_at)) order by s.starts_at)
    from shift_schedules s join profiles p on p.id = s.user_id
    where s.branch_id = p_branch and s.starts_at >= a.day_from and s.starts_at < z.day_to), '[]');
end $$;

create or replace function public.upsert_shift(p_token uuid, p_branch uuid, p_row jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_mgr uuid; v_id uuid := coalesce((p_row->>'id')::uuid, gen_random_uuid()); v_user uuid := (p_row->>'user_id')::uuid;
  v_from timestamptz := (p_row->>'starts_at')::timestamptz; v_to timestamptz := (p_row->>'ends_at')::timestamptz;
begin
  v_mgr := app.require_role(p_token, p_branch, array['manager']);
  if app.role_of(v_user, p_branch) is null then raise exception 'FORBIDDEN: Not on this branch.'; end if;
  if v_to <= v_from then raise exception 'BAD_INPUT: The shift must end after it starts.'; end if;
  if exists (select 1 from shift_schedules where user_id = v_user and branch_id = p_branch and id <> v_id and starts_at < v_to and ends_at > v_from) then
    raise exception 'OVERLAP: This person already has a shift at that time.';
  end if;
  insert into shift_schedules(id, branch_id, user_id, starts_at, ends_at, break_minutes, position, notes, created_by)
  values (v_id, p_branch, v_user, v_from, v_to, coalesce((p_row->>'break_minutes')::int, 60), p_row->>'position', p_row->>'notes', v_mgr)
  on conflict (id) do update set user_id = excluded.user_id, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
    break_minutes = excluded.break_minutes, position = excluded.position, notes = excluded.notes
  where shift_schedules.branch_id = p_branch;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.delete_shift(p_token uuid, p_shift_id uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare s shift_schedules;
begin
  select * into s from shift_schedules where id = p_shift_id;
  if not found then raise exception 'NOT_FOUND: Shift not found.'; end if;
  perform app.require_role(p_token, s.branch_id, array['manager']);
  if exists (select 1 from time_entries where schedule_id = s.id) then raise exception 'IN_USE: Someone already timed in for this shift.'; end if;
  delete from shift_schedules where id = s.id;
  return jsonb_build_object('ok', true);
end $$;

-- Attendance summary for payroll: scheduled vs worked hours and lateness per person.
create or replace function public.report_attendance(p_branch uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare a record; z record;
begin
  perform app.assert_branch(p_branch);
  select * into a from app.day_bounds(p_branch, p_from);
  select * into z from app.day_bounds(p_branch, p_to);
  return coalesce((select jsonb_agg(row_to_json(x)::jsonb order by x.staff) from (
    select p.full_name staff, r.role,
      (select count(*) from shift_schedules s where s.user_id = p.id and s.branch_id = p_branch and s.starts_at >= a.day_from and s.starts_at < z.day_to) shifts,
      round((select coalesce(sum(extract(epoch from s.ends_at - s.starts_at) / 60 - s.break_minutes), 0) from shift_schedules s
              where s.user_id = p.id and s.branch_id = p_branch and s.starts_at >= a.day_from and s.starts_at < z.day_to) / 60, 2) scheduled_hours,
      round(app.worked_minutes(p.id, p_branch, a.day_from, z.day_to) / 60, 2) worked_hours,
      (select count(*) from time_entries e where e.user_id = p.id and e.branch_id = p_branch and e.kind = 'in' and e.late_minutes > 0 and e.occurred_at >= a.day_from and e.occurred_at < z.day_to) times_late,
      (select coalesce(sum(late_minutes), 0) from time_entries e where e.user_id = p.id and e.branch_id = p_branch and e.kind = 'in' and e.occurred_at >= a.day_from and e.occurred_at < z.day_to) late_minutes,
      (select count(*) from time_entries e where e.user_id = p.id and e.branch_id = p_branch and e.entered_by is not null and e.occurred_at >= a.day_from and e.occurred_at < z.day_to) manager_corrections
    from user_branch_roles r join profiles p on p.id = r.user_id
    where r.branch_id = p_branch and r.role in ('manager','cashier','server','kitchen')) x), '[]');
end $$;

-- Badge counts for the navigation (stock alerts, pending bookings, open tickets, staff issues).
create or replace function public.get_nav_counts(p_branch uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare v_live jsonb := public.get_live_shifts(p_branch);
begin
  perform app.assert_branch(p_branch);
  return jsonb_build_object(
    'stock', (select count(*) from items i join item_stock_levels l on l.item_id = i.id
               where i.branch_id = p_branch and i.is_active and i.stage <> 'supply' and l.qty_on_hand <= i.reorder_level),
    'expiry', jsonb_array_length(public.get_near_expiry(p_branch)),
    'reservations', (select count(*) from reservations where branch_id = p_branch and status = 'pending'),
    'kitchen', (select count(*) from kitchen_tickets where branch_id = p_branch and status in ('queued','partially_served')),
    'reorder', (select count(*) from reorder_lists where branch_id = p_branch and status in ('draft','manager_approved')),
    'counts', (select count(*) from stock_counts where branch_id = p_branch and status = 'submitted'),
    'staff', (v_live->'counts'->>'late')::int + (v_live->'counts'->>'absent')::int);
end $$;
