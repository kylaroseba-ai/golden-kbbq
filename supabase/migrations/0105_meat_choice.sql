-- v0.6: sets and add-ons with "chosen meat" (Solo Set 150 g, Bento 150 g, 500 g Meat).
-- The server picks the meat when ordering; that meat is taken off stock and shown on the kitchen ticket.

alter table menu_items add column choice_grams numeric(14,3);          -- grams of the chosen meat per unit; null = no choice
alter table order_lines add column choice_item_id uuid references items;

create or replace function app.apply_choice(p_line uuid, p_choice uuid, p_actor uuid, p_at timestamptz) returns void
language plpgsql as $$
declare ol order_lines; m menu_items; i items;
begin
  select * into ol from order_lines where id = p_line;
  select * into m from menu_items where id = ol.menu_item_id;
  if m.choice_grams is null then
    if p_choice is not null then raise exception 'BAD_INPUT: % has no meat choice.', m.name; end if;
    return;
  end if;
  if p_choice is null then raise exception 'CHOICE_REQUIRED: Pick the meat for %.', m.name; end if;
  select * into i from items where id = p_choice and branch_id = ol.branch_id and is_meat and is_active;
  if not found then raise exception 'BAD_INPUT: Pick one of the meat cuts for %.', m.name; end if;
  update order_lines set choice_item_id = i.id where id = ol.id;
  perform app.deduct_stock(ol.branch_id, i.id, 'sale', m.choice_grams * ol.qty, 'order_lines', ol.id, p_actor, p_at);
  update kitchen_ticket_lines set label = m.name || ' — ' || i.name where ref_table = 'order_lines' and ref_id = ol.id;
end $$;

select app.patch_fn('public.post_order_lines(uuid,uuid,uuid,jsonb,timestamptz,uuid)',
  'v_ticket uuid := gen_random_uuid();', 'v_ticket uuid := gen_random_uuid(); v_line uuid;');
select app.patch_fn('public.post_order_lines(uuid,uuid,uuid,jsonb,timestamptz,uuid)',
  '    v_ids := v_ids || app.add_order_line(s, (x->>''menu_item_id'')::uuid, coalesce((x->>''qty'')::numeric, 1),
      (x->>''discount_type_id'')::uuid, v_actor, v_at, v_ovr, null, v_ticket);',
  '    v_line := app.add_order_line(s, (x->>''menu_item_id'')::uuid, coalesce((x->>''qty'')::numeric, 1),
      (x->>''discount_type_id'')::uuid, v_actor, v_at, v_ovr, null, v_ticket);
    perform app.apply_choice(v_line, nullif(x->>''choice_item_id'', '''')::uuid, v_actor, v_at);
    v_ids := v_ids || v_line;');

-- Bill and receipt show the chosen meat in the line name.
select app.patch_fn('app.session_json(table_sessions)', '''unit_price''', '''choice_name'', (select name from items where id = o.choice_item_id), ''unit_price''');
