-- Demo / staging seed. Ilocos Sur (Candon) set up from SPEC v0.3 + a tiny Taft branch for branch-isolation tests.
-- NOT production data: menu prices for add-ons/drinks, suppliers, staff names and portion rules are placeholders.
--
-- Demo sign-ins (local demo backend) — test values only, never use in production:
--   Personal logins: JD (owner), Kyla (admin), Mara Santos (manager)
--   Staff PINs on shared devices: Mara 1111 (manager) · Carlo 2222 (cashier) · Ben 3333 (server)
--                                 Liza 4444 (server) · Rico 5555 (kitchen) · Taft manager 9999
-- Fixed auth user ids below stand in for Supabase auth.users; on a real project create the users in
-- Supabase Auth and update profiles.auth_user_id / devices.auth_user_id.

insert into organizations(id, name) values ('00000000-0000-0000-0000-000000000001', 'Golden Baboy / Golden Korean BBQ');

insert into branches(id, organization_id, code, name, address, registered_name, vat_reg_tin, contact_phone, email, settings) values
 ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'CANDON', 'Golden Korean BBQ — Candon',
  'Candon City, Ilocos Sur', '(Registered business name — set with accountant)', 'VAT REG TIN 000-000-000-00000', '0917 000 0000',
  'candon@example.com', '{}'),
 ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'TAFT', 'Golden Baboy — Taft (test copy)',
  'Taft Ave, Manila', 'Golden Baboy (test)', 'VAT REG TIN 000-000-000-00001', '0917 000 0001', null, '{}');

-- ───── People ─────
insert into profiles(id, auth_user_id, full_name) values
 ('20000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'JD (Owner)'),
 ('20000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', 'Kyla (Admin)'),
 ('20000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000003', 'Mara Santos'),
 ('20000000-0000-0000-0000-000000000004', null, 'Carlo Cruz'),
 ('20000000-0000-0000-0000-000000000005', null, 'Ben Ramos'),
 ('20000000-0000-0000-0000-000000000006', null, 'Liza Dela Cruz'),
 ('20000000-0000-0000-0000-000000000007', null, 'Rico Valdez'),
 ('20000000-0000-0000-0000-000000000008', 'a0000000-0000-0000-0000-000000000008', 'Taft Manager (test)');

update profiles set pin_salt = id::text, pin_hash = app.hash_pin(id::text, pin)
from (values ('20000000-0000-0000-0000-000000000003'::uuid, '1111'), ('20000000-0000-0000-0000-000000000004'::uuid, '2222'),
             ('20000000-0000-0000-0000-000000000005'::uuid, '3333'), ('20000000-0000-0000-0000-000000000006'::uuid, '4444'),
             ('20000000-0000-0000-0000-000000000007'::uuid, '5555'), ('20000000-0000-0000-0000-000000000008'::uuid, '9999')) v(uid, pin)
where profiles.id = v.uid;

insert into user_branch_roles(user_id, branch_id, role) values
 ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'owner'),
 ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'owner'),
 ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'admin'),
 ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'manager'),
 ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'cashier'),
 ('20000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 'server'),
 ('20000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', 'server'),
 ('20000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000001', 'kitchen'),
 ('20000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000002', 'manager');

insert into devices(id, branch_id, label, kind, auth_user_id) values
 ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Counter tablet', 'cashier', 'd0000000-0000-0000-0000-000000000001'),
 ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Server phone 1', 'server', 'd0000000-0000-0000-0000-000000000002'),
 ('30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'Server phone 2', 'server', 'd0000000-0000-0000-0000-000000000003'),
 ('30000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'Kitchen tablet', 'kitchen', 'd0000000-0000-0000-0000-000000000004'),
 ('30000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000002', 'Taft counter', 'cashier', 'd0000000-0000-0000-0000-000000000005');

-- Invoice printing stays OFF until the BIR permit arrives (§6.7); the cashier uses the manual booklet until then.
insert into pos_terminals(id, branch_id, device_id, terminal_code, invoice_prefix, bir_min, bir_serial_no, bir_ptu_no) values
 ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'T1', '',
  '(MIN pending)', '(serial pending)', '(PTU pending)');

-- ───── Item categories (seeded from the Taft sheet) ─────
insert into item_categories(id, branch_id, name, sort_order)
select ('50000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid, '10000000-0000-0000-0000-000000000001', name, n
from (values (1,'Frozen Meats'),(2,'Ready-to-Serve Meats'),(3,'Vegetables'),(4,'Side Dishes'),(5,'Sauces'),(6,'Local Ingredients'),
             (7,'Korean Ingredients'),(8,'Beverages'),(9,'Janitorial'),(10,'Charcoal & Fuel'),(11,'Delivery / Packaging')) v(n, name);

insert into suppliers(id, branch_id, name, contact_person, phones, viber, payment_terms, notes) values
 ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Ilocos Meat Supplier (demo)', 'To be set', '{09170000001}', '09170000001', 'COD', 'Placeholder — Ilocos will have its own suppliers'),
 ('60000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Candon Market Vegetables (demo)', 'To be set', '{09170000002}', null, 'Cash', 'Placeholder'),
 ('60000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'Beverage Distributor (demo)', 'To be set', '{09170000003}', null, '7 days', 'Placeholder'),
 ('60000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'Korean Grocery (demo)', 'To be set', '{09170000004}', null, 'GCash', 'Placeholder');

-- ───── Items. Levels from Appendix A (Candon volume factor 1.0 until JD sets it) ─────
-- columns: name, cat, stage, base, count_unit, factor, reorder, par, supplier, expiry, shelf, near, gpp, refill, meat, watch, sort
insert into items(branch_id, category_id, name, stage, base_unit, count_unit, count_unit_factor, reorder_level, par_level,
  default_supplier_id, tracks_expiry, shelf_life_days, near_expiry_days, grams_per_plate, is_refillable, is_meat, is_watch, sort_order)
select '10000000-0000-0000-0000-000000000001', ('50000000-0000-0000-0000-0000000000' || lpad(cat::text,2,'0'))::uuid, name, stage, base, cu, f,
  reorder, par, case when sup is null then null else ('60000000-0000-0000-0000-00000000000' || sup)::uuid end, exp, shelf, near, gpp, refill, meat, watch, sort
from (values
 -- Frozen meats (raw)
 ('Pork Belly (frozen)',1,'raw','g','kg',1000,15000,35000,1,true,90,7,null::numeric,false,false,false,10),
 ('Pork Shoulder (frozen)',1,'raw','g','kg',1000,11500,27000,1,true,90,7,null,false,false,false,11),
 ('Beef Shortplate (frozen)',1,'raw','g','kg',1000,16000,36500,1,true,90,7,null,false,false,false,12),
 ('Chicken (frozen)',1,'raw','g','kg',1000,2500,6000,1,true,90,7,null,false,false,false,13),
 -- Ready-to-serve meats (prepared) — reorder_level = service low alert, par = prep target (A.2)
 ('Samgyupsal',2,'prepared','g','kg',1000,500,2000,null,true,2,1,80,true,true,true,20),
 ('Daepae',2,'prepared','g','kg',1000,1100,4500,null,true,2,1,80,true,true,false,21),
 ('Moksal',2,'prepared','g','kg',1000,500,2000,null,true,2,1,80,true,true,false,22),
 ('Y-Sam w/ sauce',2,'prepared','g','kg',1000,600,2500,null,true,2,1,80,true,true,true,23),
 ('Gochujang w/ sauce',2,'prepared','g','kg',1000,600,2500,null,true,2,1,80,true,true,false,24),
 ('Plain Beef',2,'prepared','g','kg',1000,1000,4000,null,true,2,1,80,true,true,true,25),
 ('Y-Woo Beef w/ sauce',2,'prepared','g','kg',1000,1300,5000,null,true,2,1,80,true,true,true,26),
 ('Enoki',2,'prepared','g','kg',1000,600,2500,4,true,5,1,80,true,false,false,27),
 -- Vegetables (raw)
 ('Lettuce',3,'raw','g','kg',1000,3000,7000,2,true,3,1,null,false,false,false,30),
 ('Onion Leeks',3,'raw','g','kg',1000,2000,4500,2,true,4,1,null,false,false,false,31),
 ('White Onion',3,'raw','g','kg',1000,1500,3000,2,true,14,1,null,false,false,false,32),
 ('Carrots',3,'raw','g','kg',1000,1000,2500,2,true,7,1,null,false,false,false,33),
 ('Cabbage',3,'raw','g','kg',1000,1000,1500,2,true,5,1,null,false,false,false,34),
 ('Potato Marble (raw)',3,'raw','g','kg',1000,6000,13500,2,true,14,1,null,false,false,false,35),
 -- Side dishes (prepared, served)
 ('Kimchi (served side dish)',4,'prepared','g','kg',1000,600,2500,null,true,3,1,80,true,false,true,40),
 ('Potato Marbles',4,'prepared','g','kg',1000,800,3000,null,true,1,1,80,true,false,false,41),
 ('Japchae',4,'prepared','g','kg',1000,400,1500,null,true,1,1,80,true,false,false,42),
 ('Meat Balls',4,'prepared','g','kg',1000,400,1500,null,true,1,1,80,true,false,false,43),
 ('Fishcake',4,'prepared','g','kg',1000,400,1500,null,true,1,1,80,true,false,false,44),
 ('Chicken (side)',4,'prepared','g','kg',1000,300,1000,null,true,1,1,80,true,false,false,45),
 ('Radish (side)',4,'prepared','g','kg',1000,400,1500,null,true,3,1,80,true,false,false,46),
 ('Korean Salad',4,'prepared','g','kg',1000,100,500,null,true,1,1,80,true,false,false,47),
 ('Sliced Cheese',4,'prepared','g','kg',1000,500,2000,4,true,7,1,80,true,false,false,48),
 ('Steam Egg',4,'prepared','g','kg',1000,1400,5500,null,true,1,1,80,true,false,false,49),
 ('Rice (cooked)',4,'prepared','g','kg',1000,2000,8000,null,false,1,1,null,false,false,true,50),
 -- Sauces
 ('Samjang Dip Sauce',5,'prepared','g','kg',1000,100,500,null,true,7,2,null,false,false,false,60),
 ('Bulgogi Dip Sauce',5,'prepared','g','kg',1000,300,1000,null,true,7,2,null,false,false,false,61),
 ('Hot Dip Sauce',5,'prepared','g','kg',1000,300,1000,null,true,7,2,null,false,false,false,62),
 ('Yangnyeom Meat Sauce',5,'prepared','g','kg',1000,2000,6000,null,true,7,2,null,false,false,true,63),
 -- Local / Korean ingredients
 ('Rice (uncooked)',6,'raw','g','kg',1000,15500,36000,4,false,null,14,null,false,false,false,70),
 ('Eggs',6,'raw','pc','pc',1,190,430,2,true,14,7,null,false,false,false,71),
 ('Kimchi (raw, 1 kg pack)',7,'raw','g','pack',1000,6000,14000,4,true,30,14,null,false,false,false,72),
 ('Gochujang paste',7,'raw','g','kg',1000,1000,3000,4,true,180,14,null,false,false,false,73),
 -- Beverages (resale)
 ('Coke (can)',8,'resale','pc','pc',1,24,72,3,true,180,14,null,false,false,false,80),
 ('Bottled Water',8,'resale','pc','pc',1,24,72,3,false,null,14,null,false,false,false,81),
 -- Supplies
 ('Charcoal',10,'supply','g','kg',1000,20000,60000,null,false,null,14,null,false,false,false,90),
 ('LPG (11 kg tank)',10,'supply','pc','tank',1,1,3,null,false,null,14,null,false,false,false,91)
) v(name, cat, stage, base, cu, f, reorder, par, sup, exp, shelf, near, gpp, refill, meat, watch, sort);

insert into item_stock_levels(branch_id, item_id) select branch_id, id from items;

create temporary table _i as select name, id from items where branch_id = '10000000-0000-0000-0000-000000000001';

-- ───── Prep recipes (Taft standards; yields are placeholders tuned during testing §5.3) ─────
create temporary table _r(name text, output text, std numeric, inputs jsonb, notes text);
insert into _r values
 ('ysam', 'Y-Sam w/ sauce', 5500, '[["Pork Belly (frozen)",4000],["Yangnyeom Meat Sauce",1500]]', 'Taft standard: 4 kg meat + 1.5 kg sauce = 5.5 kg'),
 ('ywoo', 'Y-Woo Beef w/ sauce', 12000, '[["Beef Shortplate (frozen)",8000],["Yangnyeom Meat Sauce",4000]]', 'Taft standard: 8 kg + 4 kg = 12 kg'),
 ('gochu', 'Gochujang w/ sauce', 8000, '[["Pork Shoulder (frozen)",6000],["Gochujang paste",2000]]', 'Taft standard: 6 kg + 2 kg = 8 kg'),
 ('samg', 'Samgyupsal', 950, '[["Pork Belly (frozen)",1000]]', 'Slicing, 95% yield (placeholder)'),
 ('daep', 'Daepae', 950, '[["Pork Belly (frozen)",1000]]', 'Thin slicing, 95% yield (placeholder)'),
 ('moks', 'Moksal', 950, '[["Pork Shoulder (frozen)",1000]]', 'Slicing, 95% yield (placeholder)'),
 ('beef', 'Plain Beef', 950, '[["Beef Shortplate (frozen)",1000]]', 'Slicing, 95% yield (placeholder)'),
 ('rice', 'Rice (cooked)', 2200, '[["Rice (uncooked)",1000]]', '1 kg raw → 2.2 kg cooked (placeholder)'),
 ('kimc', 'Kimchi (served side dish)', 1000, '[["Kimchi (raw, 1 kg pack)",1000]]', 'Portioned from packs'),
 ('pota', 'Potato Marbles', 900, '[["Potato Marble (raw)",1000]]', 'Cooked, 90% yield (placeholder)'),
 ('egg', 'Steam Egg', 1000, '[["Eggs",16]]', '16 eggs → 1 kg steam egg (placeholder)');

insert into prep_recipes(id, branch_id, output_item_id, standard_output_qty, notes)
select md5(r.name)::uuid, '10000000-0000-0000-0000-000000000001', (select id from _i where _i.name = r.output), r.std, r.notes from _r r;
insert into prep_recipe_inputs(branch_id, recipe_id, item_id, qty)
select '10000000-0000-0000-0000-000000000001', md5(r.name)::uuid, (select id from _i where _i.name = e->>0), (e->>1)::numeric
from _r r, jsonb_array_elements(r.inputs) e;

-- ───── Menu (proposed Ilocos prices §6.1; add-on/drink prices are placeholders) ─────
insert into menu_categories(id, branch_id, name, sort_order) values
 ('70000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','Unlimited Grill',1),
 ('70000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','Lunch',2),
 ('70000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','Add-ons',3),
 ('70000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000001','Drinks',4),
 ('70000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000001','Fees',5);

insert into menu_items(id, branch_id, category_id, name, item_type, price, priced_per_person, needs_kitchen, sort_order) values
 ('80000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000001','Unli Pork','unli_package',499,true,false,1),
 ('80000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000001','Unli Beef + Pork','unli_package',599,true,false,2),
 ('80000000-0000-0000-0000-000000000011','10000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000002','Bulgogi Bowl','set_meal',149,false,true,1),
 ('80000000-0000-0000-0000-000000000012','10000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000002','Gochujang Bowl','set_meal',149,false,true,2),
 ('80000000-0000-0000-0000-000000000013','10000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000002','Chicken Bowl','set_meal',149,false,true,3),
 ('80000000-0000-0000-0000-000000000014','10000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000002','Bento','set_meal',270,false,true,4),
 ('80000000-0000-0000-0000-000000000015','10000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000002','Solo Set','set_meal',350,false,true,5),
 ('80000000-0000-0000-0000-000000000021','10000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000003','Extra Cheese (demo price)','add_on',60,false,true,1),
 ('80000000-0000-0000-0000-000000000022','10000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000003','Extra Steam Egg (demo price)','add_on',80,false,true,2),
 ('80000000-0000-0000-0000-000000000031','10000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000004','Coke (can) (demo price)','drink',60,false,false,1),
 ('80000000-0000-0000-0000-000000000032','10000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000004','Bottled Water (demo price)','drink',30,false,false,2),
 ('80000000-0000-0000-0000-000000000041','10000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000005','Leftover fee','fee',200,false,false,1);

insert into menu_item_price_history(branch_id, menu_item_id, price) select branch_id, id, price from menu_items;

insert into portion_rules(branch_id, menu_item_id, item_id, qty, basis)
select '10000000-0000-0000-0000-000000000001', m::uuid, (select id from _i where name = i), q, 'per_unit' from (values
 ('80000000-0000-0000-0000-000000000011','Rice (cooked)',150),('80000000-0000-0000-0000-000000000011','Y-Woo Beef w/ sauce',100),('80000000-0000-0000-0000-000000000011','Kimchi (served side dish)',30),
 ('80000000-0000-0000-0000-000000000012','Rice (cooked)',150),('80000000-0000-0000-0000-000000000012','Gochujang w/ sauce',100),('80000000-0000-0000-0000-000000000012','Kimchi (served side dish)',30),
 ('80000000-0000-0000-0000-000000000013','Rice (cooked)',150),('80000000-0000-0000-0000-000000000013','Chicken (side)',100),('80000000-0000-0000-0000-000000000013','Kimchi (served side dish)',30),
 ('80000000-0000-0000-0000-000000000014','Rice (cooked)',150),('80000000-0000-0000-0000-000000000014','Y-Sam w/ sauce',120),('80000000-0000-0000-0000-000000000014','Japchae',60),
 ('80000000-0000-0000-0000-000000000015','Rice (cooked)',200),('80000000-0000-0000-0000-000000000015','Samgyupsal',160),('80000000-0000-0000-0000-000000000015','Steam Egg',80),
 ('80000000-0000-0000-0000-000000000021','Sliced Cheese',80),('80000000-0000-0000-0000-000000000022','Steam Egg',80),
 ('80000000-0000-0000-0000-000000000031','Coke (can)',1),('80000000-0000-0000-0000-000000000032','Bottled Water',1)
) v(m, i, q);

-- Package → allowed refill items (enforcement stays off until JD confirms the cuts, §6.1)
insert into package_refill_items(branch_id, package_id, item_id)
select '10000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000002', id from items
 where branch_id = '10000000-0000-0000-0000-000000000001' and is_refillable;
insert into package_refill_items(branch_id, package_id, item_id)
select '10000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', id from items
 where branch_id = '10000000-0000-0000-0000-000000000001' and is_refillable and name not in ('Plain Beef','Y-Woo Beef w/ sauce');

-- ───── Discounts (§6.2; all Taft types except Solo Diner) ─────
insert into discount_types(id, branch_id, name, kind, value, requires_manager_pin, requires_id_record, sort_order) values
 ('90000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','Regular','none',0,false,false,1),
 ('90000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','Senior Citizen','sc_pwd_vat_exempt',0.20,false,true,2),
 ('90000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','PWD','sc_pwd_vat_exempt',0.20,false,true,3),
 ('90000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000001','Kids','percent',0.50,false,false,4),
 ('90000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000001','Athlete','percent',0.20,false,false,5),
 ('90000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000001','Employee / Birthday','percent',0.30,false,false,6),
 ('90000000-0000-0000-0000-000000000007','10000000-0000-0000-0000-000000000001','Manager discount','percent',0.10,true,false,7);

-- ───── Tables: Candon has 21 tables, 108 seats (9 × 4-seaters, 12 × 6-seaters) — table 21 and seat counts set below ─────
insert into dining_tables(branch_id, label, seats, zone, sort_order)
select '10000000-0000-0000-0000-000000000001', n::text, 4, case when n <= 10 then 'Main' else 'Side' end, n from generate_series(1, 20) n;

insert into reservation_slots_config(branch_id, weekday, open_time, close_time, slot_minutes, max_covers_per_slot)
select '10000000-0000-0000-0000-000000000001', d, '11:00', '22:00', 30, 108 from generate_series(0, 6) d;

insert into message_templates(branch_id, channel, event, subject, body) values
 ('10000000-0000-0000-0000-000000000001','sms','confirmed',null,'Golden Korean BBQ: Hi {name}, your table for {party} on {date} at {time} is confirmed. Ref {code}. See you!'),
 ('10000000-0000-0000-0000-000000000001','sms','reminder',null,'Golden Korean BBQ: Reminder — your table for {party} is today at {time}. Ref {code}. Call {phone} to change.'),
 ('10000000-0000-0000-0000-000000000001','sms','declined',null,'Golden Korean BBQ: Sorry {name}, we can''t take your booking for {date} {time}: {reason}. Call {phone} for other times.'),
 ('10000000-0000-0000-0000-000000000001','sms','cancelled',null,'Golden Korean BBQ: Your booking {code} for {date} {time} was cancelled. {reason} Call {phone} with questions.'),
 ('10000000-0000-0000-0000-000000000001','email','confirmed','Booking confirmed — {code}','Hi {name},\n\nYour table for {party} on {date} at {time} is confirmed.\nReference: {code}\n\nGolden Korean BBQ, Candon City'),
 ('10000000-0000-0000-0000-000000000001','email','reminder','See you today — {code}','Hi {name},\n\nReminder: your table for {party} is today at {time}.\nReference: {code}'),
 ('10000000-0000-0000-0000-000000000001','email','declined','About your booking — {code}','Hi {name},\n\nSorry, we can''t take your booking for {date} {time}: {reason}\nPlease call {phone} for other times.'),
 ('10000000-0000-0000-0000-000000000001','email','cancelled','Booking cancelled — {code}','Hi {name},\n\nYour booking {code} for {date} {time} was cancelled. {reason}');

-- ───── Opening stock (demo quantities; real opening count happens on opening day §13.4) ─────
select app.add_stock('10000000-0000-0000-0000-000000000001', id, 'opening_balance', qty, cost, current_date + shelf, 'opening', null, 'opening', null,
                     '20000000-0000-0000-0000-000000000003')
from (select i.id, v.qty, v.cost, coalesce(i.shelf_life_days, 30) shelf from (values
  ('Pork Belly (frozen)', 30000, 0.325), ('Pork Shoulder (frozen)', 20000, 0.290), ('Beef Shortplate (frozen)', 30000, 0.380),
  ('Chicken (frozen)', 6000, 0.190), ('Samgyupsal', 2000, 0.345), ('Daepae', 4500, 0.345), ('Moksal', 2000, 0.305),
  ('Y-Sam w/ sauce', 2500, 0.300), ('Gochujang w/ sauce', 2500, 0.270), ('Plain Beef', 4000, 0.400), ('Y-Woo Beef w/ sauce', 5000, 0.300),
  ('Enoki', 2500, 0.180), ('Lettuce', 5000, 0.120), ('Onion Leeks', 3000, 0.100), ('White Onion', 2500, 0.110), ('Carrots', 2000, 0.080),
  ('Cabbage', 1500, 0.060), ('Potato Marble (raw)', 10000, 0.090), ('Kimchi (served side dish)', 2500, 0.150), ('Potato Marbles', 3000, 0.100),
  ('Japchae', 1500, 0.120), ('Meat Balls', 1500, 0.200), ('Fishcake', 1500, 0.180), ('Chicken (side)', 1000, 0.210),
  ('Radish (side)', 1500, 0.060), ('Korean Salad', 500, 0.080), ('Sliced Cheese', 2000, 0.450), ('Steam Egg', 5500, 0.090),
  ('Rice (cooked)', 8000, 0.025), ('Samjang Dip Sauce', 500, 0.150), ('Bulgogi Dip Sauce', 1000, 0.140), ('Hot Dip Sauce', 1000, 0.140),
  ('Yangnyeom Meat Sauce', 6000, 0.120), ('Rice (uncooked)', 30000, 0.055), ('Eggs', 300, 8.0), ('Kimchi (raw, 1 kg pack)', 10000, 0.140),
  ('Gochujang paste', 3000, 0.200), ('Coke (can)', 60, 38), ('Bottled Water', 60, 12), ('Charcoal', 40000, 0.030), ('LPG (11 kg tank)', 2, 1100)
) v(name, qty, cost) join items i on i.name = v.name and i.branch_id = '10000000-0000-0000-0000-000000000001') s;

-- One batch close to expiry so the near-expiry list has something to show in the demo
update stock_batches set expiry_date = current_date + 1
 where item_id = (select id from _i where name = 'Lettuce');

-- ───── Taft (test copy): a few rows so branch isolation can be tested ─────
insert into item_categories(id, branch_id, name) values ('50000000-0000-0000-0000-000000000099', '10000000-0000-0000-0000-000000000002', 'Frozen Meats');
insert into items(branch_id, category_id, name, stage, base_unit, count_unit, count_unit_factor, reorder_level, par_level)
values ('10000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000099', 'Pork Belly (Taft)', 'raw', 'g', 'kg', 1000, 15000, 35000);
insert into item_stock_levels(branch_id, item_id) select branch_id, id from items where branch_id = '10000000-0000-0000-0000-000000000002';
insert into dining_tables(branch_id, label, seats, sort_order) values ('10000000-0000-0000-0000-000000000002', 'Taft 1', 4, 1);

-- ───── Demo shift schedule: this week (times are Manila) ─────
insert into shift_schedules(branch_id, user_id, starts_at, ends_at, break_minutes, position)
select '10000000-0000-0000-0000-000000000001', v.uid::uuid,
       ((app.business_date('10000000-0000-0000-0000-000000000001') + d) + v.s::time) at time zone 'Asia/Manila',
       ((app.business_date('10000000-0000-0000-0000-000000000001') + d) + v.e::time) at time zone 'Asia/Manila', 60, v.pos
from generate_series(0, 6) d,
     (values ('20000000-0000-0000-0000-000000000003', '10:00', '19:00', 'Manager'),
             ('20000000-0000-0000-0000-000000000007', '10:00', '19:00', 'Grill / kitchen'),
             ('20000000-0000-0000-0000-000000000004', '13:00', '22:00', 'Cashier'),
             ('20000000-0000-0000-0000-000000000005', '14:00', '23:00', 'Server'),
             ('20000000-0000-0000-0000-000000000006', '15:00', '23:00', 'Server')) v(uid, s, e, pos)
where not (v.uid = '20000000-0000-0000-0000-000000000006' and d = 3);   -- Liza's rest day

-- ───── v0.6 confirmed rules (SPEC §15.5, §15.7) ─────
-- Tables: 1–9 four-seaters, 10–21 six-seaters (108 seats)
insert into dining_tables(branch_id, label, seats, zone, sort_order) values ('10000000-0000-0000-0000-000000000001', '21', 6, 'Side', 21);
update dining_tables set seats = case when label::int <= 9 then 4 else 6 end where branch_id = '10000000-0000-0000-0000-000000000001';
-- Portions per plate: meat with sauce 120 g, meat without sauce 80 g, side dishes 50 g
update items set grams_per_plate = case when is_meat and name ilike '%w/ sauce%' then 120 when is_meat then 80 else 50 end
 where branch_id = '10000000-0000-0000-0000-000000000001' and is_refillable;
-- Stations: dispatch prepares and plates meat and side dishes; the kitchen cooks
update items set station = case when name in ('Steam Egg') then 'kitchen' else 'dispatch' end where is_refillable;
update menu_items set station = case when item_type in ('drink') or name ilike '%cheese%' then 'dispatch' else 'kitchen' end;
-- Solo diner (one guest at an unli table)
update menu_items set solo_price = 599 where id = '80000000-0000-0000-0000-000000000001';
update menu_items set solo_price = 699 where id = '80000000-0000-0000-0000-000000000002';
insert into menu_items(id, branch_id, category_id, name, item_type, price, priced_per_person, needs_kitchen, sort_order) values
 ('80000000-0000-0000-0000-000000000042','10000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000005','Overtime fee (past 2 hours)','fee',200,false,false,2);
insert into menu_item_price_history(branch_id, menu_item_id, price) values ('10000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000042',200);
-- Discounts: Kids by height, Athlete 20 %, Birthday 50 % (3 full-paying adults) or free (7), one celebrant per table
update discount_types set name = 'Kids 3 ft to under 4 ft', conditions = 'Half price' where id = '90000000-0000-0000-0000-000000000004';
update discount_types set conditions = 'Valid athlete ID' where id = '90000000-0000-0000-0000-000000000005';
update discount_types set name = 'Birthday 50% (3+ full-paying adults)', value = 0.50, min_full_paying = 3, max_per_session = 1,
  conditions = 'Valid ID; once during birth month; not combinable' where id = '90000000-0000-0000-0000-000000000006';
insert into discount_types(id, branch_id, name, kind, value, requires_manager_pin, requires_id_record, sort_order, min_full_paying, max_per_session, conditions) values
 ('90000000-0000-0000-0000-000000000008','10000000-0000-0000-0000-000000000001','Kids under 3 ft','percent',1.00,false,false,4,null,null,'Free'),
 ('90000000-0000-0000-0000-000000000009','10000000-0000-0000-0000-000000000001','Birthday free (7+ full-paying adults)','percent',1.00,false,false,6,7,1,'Valid ID; once during birth month; not combinable');
-- Taft test branch: 11 AM – 11 PM, closed Sundays, last seating 9:30 PM
update branches set settings = settings || '{"closing_time":"23:00","unli_to":"23:00","last_unli_seating_time":"21:30","closed_weekdays":[0]}'
 where id = '10000000-0000-0000-0000-000000000002';
-- GCash for reservation fees (TEST placeholder; JD enters the real number in Setup)
update branches set settings = settings || '{"gcash_number":"0917 000 0000","gcash_name":"TEST ONLY"}' where id = '10000000-0000-0000-0000-000000000001';

drop table _i; drop table _r;
