-- Branch isolation (§11): RLS on every table. Reads are allowed only for branches the caller has a role on
-- (or the device account's branch). There are no write policies: every write goes through a SECURITY DEFINER RPC.

do $$
declare t text;
  -- tables people may read directly (REST / Realtime) for their own branches
  readable text[] := array['branches','item_categories','suppliers','items','supplier_items','deliveries','stock_batches','delivery_lines',
    'prep_recipes','prep_recipe_inputs','production_runs','production_run_inputs','table_sessions','waste_logs','stock_counts',
    'stock_count_lines','stock_movements','item_stock_levels','reorder_lists','reorder_lines','dining_tables','menu_categories',
    'menu_items','menu_item_price_history','package_refill_items','portion_rules','discount_types','session_pax','order_lines',
    'refill_rounds','refill_lines','kitchen_tickets','kitchen_ticket_lines','bills','cash_shifts','payments','invoices','x_readings',
    'z_readings','reservations','reservation_slots_config','message_templates','outbound_messages','notifications','devices','pos_terminals',
    'user_branch_roles'];
  -- never readable directly; only through RPCs (PIN hashes, SC/PWD IDs, tokens, audit)
  hidden text[] := array['organizations','profiles','staff_tokens','pin_attempts','idempotency_keys','audit_log','sc_pwd_records','push_subscriptions'];
begin
  foreach t in array readable || hidden loop
    -- not FORCE: the RPCs run as the table owner and must bypass these read policies
    execute format('alter table %I enable row level security', t);
  end loop;
  foreach t in array readable loop
    if t = 'branches' then
      execute 'create policy branch_read on branches for select using (id in (select app.my_branches()))';
    else
      execute format('create policy branch_read on %I for select using (branch_id in (select app.my_branches()))', t);
    end if;
  end loop;
end $$;
