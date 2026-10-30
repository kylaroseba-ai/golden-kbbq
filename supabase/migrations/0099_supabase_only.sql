-- Supabase-only setup: grants, Realtime publication and scheduled jobs.
-- (The local demo backend skips this file; PGlite has no pg_cron, pg_net or Realtime.)

-- RPCs: staff functions need a signed-in user; public booking is only callable by the Edge Function.
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant usage on schema app to authenticated;
grant execute on all functions in schema app to authenticated;
grant execute on function public.public_availability(text, date, int, text) to anon;
revoke execute on function public.create_public_reservation(text, jsonb) from authenticated;
grant execute on function public.create_public_reservation(text, jsonb) to service_role;
revoke execute on function public.realert_unconfirmed() from authenticated;
grant select on all tables in schema public to authenticated;

-- Realtime: devices refresh when these change (RLS still applies to every event).
alter publication supabase_realtime add table item_stock_levels, kitchen_tickets, kitchen_ticket_lines, refill_rounds,
  notifications, reservations, table_sessions, dining_tables, order_lines, time_entries, shift_schedules;

-- Scheduled jobs. The two jobs that call Edge Functions (messages, push) are in supabase/setup/edge_function_cron.sql:
-- run that once the functions are deployed and their secrets are set.
create extension if not exists pg_cron;

select cron.schedule('realert-unconfirmed', '* * * * *', $$ select public.realert_unconfirmed() $$);

-- Daily expiry digest at 10:30 AM Manila (02:30 UTC), 30 minutes before opening.
select cron.schedule('expiry-digest', '30 2 * * *', $$ select public.daily_expiry_digest(id) from branches $$);

-- Production clock: never movable.
create or replace function app.now() returns timestamptz language sql stable as $$ select now() $$;
