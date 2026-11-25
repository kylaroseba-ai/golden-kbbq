-- PROD starting data (SPEC v0.6 §15.5, §15.7). Real structure only: no demo staff, no PINs, no stock, no sales.
-- Taft goes live first; Candon is set up now and its staff are added in Setup → People when hired.
-- Run once on PROD. Safe to re-run: a branch that already exists is skipped.
-- Placeholders to finish in the app: addresses, registered business name/TIN, GCash number, add-on/drink list for Candon,
-- reorder and par levels, suppliers, set-meal recipes.

create or replace function pg_temp.setup_branch(p jsonb) returns uuid language plpgsql as $$
declare v_org uuid; v_branch uuid; v_cat jsonb; v_icat uuid; v_mcat uuid; v_item uuid; v_menu uuid; x jsonb; v_pkg uuid;
  v_items jsonb := '{}';   -- item name → id
begin
  if exists (select 1 from branches where code = p->>'code') then
    raise notice 'Branch % already exists — skipped', p->>'code';
    return (select id from branches where code = p->>'code');
  end if;
  select id into v_org from organizations limit 1;
  if v_org is null then insert into organizations(name) values ('Golden Baboy / Golden Korean BBQ') returning id into v_org; end if;

  insert into branches(organization_id, code, name, address, contact_phone, settings)
  values (v_org, p->>'code', p->>'name', p->>'address', p->>'phone', coalesce(p->'settings', '{}'))
  returning id into v_branch;

  -- booking capacity: every seat, on open days only (online share is a setting)
  insert into reservation_slots_config(branch_id, weekday, open_time, close_time, slot_minutes, max_covers_per_slot)
  select v_branch, d, (p->>'open')::time, (p->>'close')::time, 30,
         (select sum((t->>'seats')::int * (t->>'count')::int) from jsonb_array_elements(p->'tables') t)
    from generate_series(0, 6) d where d not in (select jsonb_array_elements_text(coalesce(p->'settings'->'closed_weekdays', '[]'))::int);

  -- tables, numbered 1, 2, 3 … in the order given
  insert into dining_tables(branch_id, label, seats, sort_order)
  select v_branch, (row_number() over ())::text, seats, row_number() over ()
    from (select (t->>'seats')::int seats from jsonb_array_elements(p->'tables') with ordinality a(t, o), generate_series(1, (t->>'count')::int) order by o) q;

  -- inventory categories and refill items (meat and side dishes are what the POS deducts during service)
  for v_cat in select * from jsonb_array_elements(p->'item_categories') loop
    insert into item_categories(branch_id, name, sort_order) values (v_branch, v_cat->>'name', (v_cat->>'sort')::int) returning id into v_icat;
    for x in select * from jsonb_array_elements(v_cat->'items') loop
      insert into items(branch_id, category_id, name, stage, base_unit, count_unit, count_unit_factor, grams_per_plate,
        is_refillable, is_meat, is_watch, tracks_expiry, shelf_life_days, near_expiry_days, station, sort_order)
      values (v_branch, v_icat, x->>'name', coalesce(x->>'stage', 'prepared'), coalesce(x->>'base', 'g'), coalesce(x->>'unit', 'kg'),
        coalesce((x->>'factor')::numeric, 1000), (x->>'gpp')::numeric, coalesce((x->>'refill')::boolean, false),
        coalesce((x->>'meat')::boolean, false), coalesce((x->>'watch')::boolean, false), coalesce((x->>'expiry')::boolean, false),
        (x->>'shelf')::int, coalesce((x->>'near')::int, 1), coalesce(x->>'station', 'dispatch'), coalesce((x->>'sort')::int, 0))
      returning id into v_item;
      insert into item_stock_levels(branch_id, item_id) values (v_branch, v_item);
      v_items := v_items || jsonb_build_object(x->>'name', v_item);
    end loop;
  end loop;

  -- menu
  for v_cat in select * from jsonb_array_elements(p->'menu') loop
    insert into menu_categories(branch_id, name, sort_order) values (v_branch, v_cat->>'name', (v_cat->>'sort')::int) returning id into v_mcat;
    for x in select * from jsonb_array_elements(v_cat->'items') loop
      insert into menu_items(branch_id, category_id, name, item_type, price, solo_price, priced_per_person, needs_kitchen, station, sort_order)
      values (v_branch, v_mcat, x->>'name', x->>'type', (x->>'price')::numeric, (x->>'solo')::numeric, x->>'type' = 'unli_package',
        coalesce((x->>'kitchen')::boolean, false), coalesce(x->>'station', 'kitchen'), coalesce((x->>'sort')::int, 0))
      returning id into v_menu;
      insert into menu_item_price_history(branch_id, menu_item_id, price) values (v_branch, v_menu, (x->>'price')::numeric);
      -- which refill items a package includes (enforcement is a setting, off by default)
      if x->>'type' = 'unli_package' then
        insert into package_refill_items(branch_id, package_id, item_id)
        select v_branch, v_menu, (v_items->>n)::uuid from jsonb_object_keys(v_items) n
         join items i on i.id = (v_items->>n)::uuid
         where i.is_refillable and (not i.is_meat or n in (select jsonb_array_elements_text(x->'meats')));
      end if;
      -- simple stock deductions for add-ons sold by count/weight
      if x ? 'deducts' then
        insert into portion_rules(branch_id, menu_item_id, item_id, qty, basis)
        values (v_branch, v_menu, (v_items->>(x->'deducts'->>0))::uuid, (x->'deducts'->>1)::numeric, 'per_unit');
      end if;
    end loop;
  end loop;

  -- discounts (same rules at every branch, at that branch's prices)
  insert into discount_types(branch_id, name, kind, value, requires_manager_pin, requires_id_record, sort_order, min_full_paying, max_per_session, conditions) values
   (v_branch, 'Regular', 'none', 0, false, false, 1, null, null, null),
   (v_branch, 'Senior Citizen', 'sc_pwd_vat_exempt', 0.20, false, true, 2, null, null, 'Valid SC ID; name and ID number recorded'),
   (v_branch, 'PWD', 'sc_pwd_vat_exempt', 0.20, false, true, 3, null, null, 'Valid PWD ID; name and ID number recorded'),
   (v_branch, 'Kids under 3 ft', 'percent', 1.00, false, false, 4, null, null, 'Free'),
   (v_branch, 'Kids 3 ft to under 4 ft', 'percent', 0.50, false, false, 5, null, null, 'Half price; 4 ft and above pay regular'),
   (v_branch, 'Athlete', 'percent', 0.20, false, false, 6, null, null, 'Valid athlete ID'),
   (v_branch, 'Birthday 50% (3+ full-paying adults)', 'percent', 0.50, false, false, 7, 3, 1, 'Valid ID; once during birth month; not combinable'),
   (v_branch, 'Birthday free (7+ full-paying adults)', 'percent', 1.00, false, false, 8, 7, 1, 'Valid ID; once during birth month; not combinable');

  -- customer messages
  insert into message_templates(branch_id, channel, event, subject, body) values
   (v_branch,'sms','confirmed',null, p->>'brand' || ': Hi {name}, your table for {party} on {date} at {time} is confirmed. Ref {code}. See you!'),
   (v_branch,'sms','reminder',null, p->>'brand' || ': Reminder — your table for {party} is today at {time}. Ref {code}. Call {phone} to change.'),
   (v_branch,'sms','declined',null, p->>'brand' || ': Sorry {name}, we can''t take your booking for {date} {time}: {reason}. Call {phone} for other times.'),
   (v_branch,'sms','cancelled',null, p->>'brand' || ': Your booking {code} for {date} {time} was cancelled. {reason} Call {phone} with questions.'),
   (v_branch,'email','confirmed','Booking confirmed — {code}','Hi {name},\n\nYour table for {party} on {date} at {time} is confirmed.\nReference: {code}\n\n' || (p->>'name')),
   (v_branch,'email','reminder','See you today — {code}','Hi {name},\n\nReminder: your table for {party} is today at {time}.\nReference: {code}\n\n' || (p->>'name')),
   (v_branch,'email','declined','About your booking — {code}','Hi {name},\n\nSorry, we can''t take your booking for {date} {time}: {reason}\nPlease call {phone} for other times.'),
   (v_branch,'email','cancelled','Booking cancelled — {code}','Hi {name},\n\nYour booking {code} for {date} {time} was cancelled. {reason}');
  return v_branch;
end $$;

-- Refill items shared by both branches (Taft list; Candon uses the same cuts and side dishes).
-- Portions per plate: meat with sauce 120 g, meat without sauce 80 g, side dishes 50 g.
drop table if exists _cats;
create temporary table _cats as select $j$[
 {"name":"Ready-to-Serve Meats","sort":1,"items":[
   {"name":"Samgyupsal","gpp":80,"refill":true,"meat":true,"watch":true,"expiry":true,"shelf":3,"sort":1},
   {"name":"Yangyum Samgyupsal","gpp":120,"refill":true,"meat":true,"watch":true,"expiry":true,"shelf":3,"sort":2},
   {"name":"Woo Samgyupsal (beef)","gpp":80,"refill":true,"meat":true,"watch":true,"expiry":true,"shelf":3,"sort":3},
   {"name":"Yangyum Woo Samgyupsal (beef)","gpp":120,"refill":true,"meat":true,"watch":true,"expiry":true,"shelf":3,"sort":4}]},
 {"name":"Side Dishes","sort":2,"items":[
   {"name":"Kimchi","gpp":50,"refill":true,"watch":true,"sort":10},
   {"name":"Potato Marble","gpp":50,"refill":true,"sort":11},
   {"name":"Chicken Poppers","gpp":50,"refill":true,"sort":12},
   {"name":"Japchae","gpp":50,"refill":true,"sort":13},
   {"name":"Korean Salad","gpp":50,"refill":true,"sort":14},
   {"name":"Salad","gpp":50,"refill":true,"sort":15},
   {"name":"Meatballs","gpp":50,"refill":true,"sort":16},
   {"name":"Kimchi Soup","gpp":50,"refill":true,"station":"kitchen","sort":17},
   {"name":"Radish","gpp":50,"refill":true,"sort":18},
   {"name":"Fishcake","gpp":50,"refill":true,"sort":19},
   {"name":"Lettuce","gpp":50,"refill":true,"expiry":true,"shelf":3,"sort":20},
   {"name":"Cheese","gpp":50,"refill":true,"sort":21},
   {"name":"Steamed Egg","gpp":50,"refill":true,"station":"kitchen","sort":22},
   {"name":"Rice (cooked)","watch":true,"sort":23}]},
 {"name":"Beverages & Desserts","sort":3,"items":[
   {"name":"Soft drinks","stage":"resale","base":"pc","unit":"pc","factor":1,"sort":30},
   {"name":"Ice cream","stage":"resale","base":"pc","unit":"pc","factor":1,"expiry":true,"shelf":30,"near":7,"sort":31}]}
]$j$::jsonb j;

select pg_temp.setup_branch(jsonb_build_object(
  'code', 'TAFT', 'name', 'Golden Baboy — Taft', 'brand', 'Golden Baboy', 'address', 'Taft Avenue, Manila (to confirm)', 'phone', null,
  'open', '11:00', 'close', '23:00',
  'settings', '{"closing_time":"23:00","unli_to":"23:00","last_unli_seating_time":"21:30","closed_weekdays":[0]}'::jsonb,
  'tables', '[{"seats":4,"count":16},{"seats":6,"count":4}]'::jsonb,
  'item_categories', (select j from _cats),
  'menu', $j$[
    {"name":"Unlimited Korean Grill","sort":1,"items":[
      {"name":"Unlimited Korean Grill","type":"unli_package","price":649,"solo":749,"sort":1,
       "meats":["Samgyupsal","Yangyum Samgyupsal","Woo Samgyupsal (beef)","Yangyum Woo Samgyupsal (beef)"]}]},
    {"name":"Sets","sort":2,"items":[
      {"name":"Solo Set (150 g meat)","type":"set_meal","price":350,"kitchen":true,"sort":1},
      {"name":"Bento Set (150 g meat)","type":"set_meal","price":270,"kitchen":true,"sort":2}]},
    {"name":"Additional Orders","sort":3,"items":[
      {"name":"1 kg Kimchi","type":"add_on","price":200,"kitchen":true,"station":"dispatch","deducts":["Kimchi",1000],"sort":1},
      {"name":"500 g Meat","type":"add_on","price":300,"kitchen":true,"station":"dispatch","sort":2},
      {"name":"Steamed Egg","type":"add_on","price":60,"kitchen":true,"station":"kitchen","deducts":["Steamed Egg",50],"sort":3},
      {"name":"Free ice cream (on billing out)","type":"add_on","price":0,"kitchen":true,"station":"dispatch","deducts":["Ice cream",1],"sort":4}]},
    {"name":"Drinks","sort":4,"items":[
      {"name":"Soft drinks","type":"drink","price":60,"station":"dispatch","deducts":["Soft drinks",1],"sort":1}]},
    {"name":"Fees","sort":5,"items":[
      {"name":"Leftover fee","type":"fee","price":200,"sort":1},
      {"name":"Overtime fee (past 2 hours)","type":"fee","price":200,"sort":2}]}
  ]$j$::jsonb));

select pg_temp.setup_branch(jsonb_build_object(
  'code', 'CANDON', 'name', 'Golden Korean BBQ — Candon', 'brand', 'Golden Korean BBQ', 'address', 'Candon City, Ilocos Sur', 'phone', null,
  'open', '11:00', 'close', '22:00',
  'settings', '{"closing_time":"22:00","unli_to":"22:00","last_unli_seating_time":"20:30"}'::jsonb,
  'tables', '[{"seats":4,"count":9},{"seats":6,"count":12}]'::jsonb,
  'item_categories', (select j from _cats),
  'menu', $j$[
    {"name":"Unlimited Grill","sort":1,"items":[
      {"name":"Unli Pork","type":"unli_package","price":499,"solo":599,"sort":1,"meats":["Samgyupsal","Yangyum Samgyupsal"]},
      {"name":"Unli Pork + Beef","type":"unli_package","price":599,"solo":699,"sort":2,
       "meats":["Samgyupsal","Yangyum Samgyupsal","Woo Samgyupsal (beef)","Yangyum Woo Samgyupsal (beef)"]}]},
    {"name":"Lunch (11 AM – 3 PM)","sort":2,"items":[
      {"name":"Bowl","type":"set_meal","price":149,"kitchen":true,"sort":1},
      {"name":"Bento","type":"set_meal","price":270,"kitchen":true,"sort":2},
      {"name":"Solo Set","type":"set_meal","price":350,"kitchen":true,"sort":3}]},
    {"name":"Fees","sort":5,"items":[
      {"name":"Leftover fee","type":"fee","price":200,"sort":1},
      {"name":"Overtime fee (past 2 hours)","type":"fee","price":200,"sort":2}]}
  ]$j$::jsonb));

-- People. Logins (email) and PINs are set later in the app; nobody can sign in yet.
create or replace function pg_temp.person(p_name text, p_branch text, p_roles text[], p_email text default null) returns void language plpgsql as $$
declare v_id uuid; v_branch uuid := (select id from branches where code = p_branch);
begin
  select id into v_id from profiles where full_name = p_name and (p_email is null or lower(email) = lower(p_email)) limit 1;
  if v_id is null then
    insert into profiles(full_name, email) values (p_name, lower(p_email)) returning id into v_id;
  end if;
  insert into user_branch_roles(user_id, branch_id, role) select v_id, v_branch, r from unnest(p_roles) r on conflict do nothing;
end $$;

-- JD: owner of both branches (owner can do everything a manager can).
select pg_temp.person('JD (Jose Wilfredo John Dizon)', 'TAFT', array['owner'], 'johndizonbusiness@gmail.com');
select pg_temp.person('JD (Jose Wilfredo John Dizon)', 'CANDON', array['owner'], 'johndizonbusiness@gmail.com');
-- Taft team (SPEC §15.5)
select pg_temp.person('Jessie Dayawon', 'TAFT', array['kitchen']);          -- Head Chef / Kitchen Head
select pg_temp.person('Robin', 'TAFT', array['server','dispatch']);
select pg_temp.person('Norjay Magboo', 'TAFT', array['kitchen']);
select pg_temp.person('Mary Rose Guevarra', 'TAFT', array['dispatch']);
select pg_temp.person('Annalyn Roxas', 'TAFT', array['cashier']);           -- Assistant Restaurant Manager; cashier rights only (§15.7)
select pg_temp.person('Jenny', 'TAFT', array['server']);
select pg_temp.person('Elbe', 'TAFT', array['server']);
