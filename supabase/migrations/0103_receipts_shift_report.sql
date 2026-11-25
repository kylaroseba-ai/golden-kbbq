-- v0.6: internal receipts and the shift report (SPEC §15.5).
--  • receipt_mode 'internal' (default): the POS is not BIR-registered. Each bill gets an internal number
--    (C-000123) and prints an "Order Summary — NOT AN OFFICIAL RECEIPT". The manual BIR receipt number is optional.
--  • receipt_mode 'bir': the earlier BIR invoice rules (booklet number required when not printing official invoices).
--  • Shift report in the layout Taft already uses: cash drawer + sales summary.

alter table invoices drop constraint invoices_check;
alter table invoices add column internal_no bigint;
alter table invoices add constraint invoices_internal_no_key unique (branch_id, internal_no);

-- Gap-free internal bill numbers per branch; the lock keeps two counters from taking the same number.
create or replace function app.assign_internal_no() returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtext('internal_no:' || new.branch_id::text));
  new.internal_no := coalesce((select max(internal_no) from invoices where branch_id = new.branch_id), 0) + 1;
  return new;
end $$;
create trigger assign_internal_no before insert on invoices for each row execute function app.assign_internal_no();

-- Internal mode: the manual official-receipt number is optional (kept for matching when the cashier writes one).
select app.patch_fn('public.settle_bill(uuid,uuid,uuid,jsonb,jsonb,uuid,text)',
  'if not v_official and coalesce(trim(p_manual_booklet_no),'''') = '''' and (app.setting(s.branch_id,''vat_registered''))::boolean then',
  'if not v_official and coalesce(trim(p_manual_booklet_no),'''') = '''' and (app.setting(s.branch_id,''vat_registered''))::boolean
     and coalesce(app.setting(s.branch_id,''receipt_mode'') #>> ''{}'', ''internal'') = ''bir'' then');

select app.patch_fn('public.get_invoice(uuid,boolean)',
  '''table_label'', app.table_labels(s.table_ids),',
  '''table_label'', app.table_labels(s.table_ids),
    ''receipt_mode'', coalesce(app.setting(inv.branch_id, ''receipt_mode'') #>> ''{}'', ''internal''),
    ''bill_no'', upper(left(br.code, 1)) || ''-'' || lpad(inv.internal_no::text, 6, ''0''),
    ''server'', (select full_name from profiles where id = s.opened_by),
    ''pax'', (select coalesce(sum(pax_count), 0) from session_pax where session_id = s.id),
    ''branch_code'', br.code, ''branch_phone'', br.contact_phone,');

-- Shift report (cashier shift close), matching the printout Taft uses today.
create or replace function public.get_shift_report(p_shift_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare cs cash_shifts; br branches; term pos_terminals; v_no int; v_cash numeric; v_refund_cash numeric;
  v_gross numeric; v_disc numeric; v_net numeric; v_refunds numeric; v_vat numeric;
begin
  select * into cs from cash_shifts where id = p_shift_id;
  if not found then raise exception 'NOT_FOUND: Shift not found.'; end if;
  perform app.require_role(null, cs.branch_id, array['cashier','manager']);
  select * into br from branches where id = cs.branch_id;
  select * into term from pos_terminals where id = cs.terminal_id;
  select count(*) into v_no from cash_shifts where terminal_id = cs.terminal_id and opened_at <= cs.opened_at;
  select coalesce(sum(p.amount), 0) into v_cash from payments p join invoices i on i.bill_id = p.bill_id
   where p.shift_id = cs.id and p.method = 'cash' and i.status = 'issued';
  select coalesce(sum(p.amount), 0) into v_refund_cash from payments p join invoices i on i.bill_id = p.bill_id
   where p.shift_id = cs.id and p.method = 'cash' and i.status = 'voided';
  with inv as (select distinct i.* from invoices i join payments p on p.bill_id = i.bill_id where p.shift_id = cs.id)
  select coalesce(sum(b.subtotal) filter (where inv.status = 'issued'), 0), coalesce(sum(inv.discount_total) filter (where inv.status = 'issued'), 0),
         coalesce(sum(inv.total) filter (where inv.status = 'issued'), 0), coalesce(sum(inv.total) filter (where inv.status = 'voided'), 0),
         coalesce(sum(inv.vat_amount) filter (where inv.status = 'issued'), 0)
    into v_gross, v_disc, v_net, v_refunds, v_vat
    from inv join bills b on b.id = inv.bill_id;
  return jsonb_build_object(
    'shift_number', v_no, 'store', br.name, 'pos', coalesce(term.terminal_code, '—'),
    'opened_by', (select full_name from profiles where id = cs.cashier_id), 'opened_at', cs.opened_at,
    'closed_by', case when cs.closed_at is not null then (select full_name from profiles where id = cs.cashier_id) end, 'closed_at', cs.closed_at,
    'cash_drawer', jsonb_build_object(
      'starting_cash', cs.opening_float, 'cash_payments', v_cash, 'cash_refunds', v_refund_cash,
      'paid_in', cs.cash_in, 'paid_out', cs.cash_out,
      'expected_cash', cs.opening_float + v_cash - v_refund_cash + cs.cash_in - cs.cash_out,
      'actual_cash', cs.counted_cash,
      'difference', case when cs.counted_cash is not null then cs.counted_cash - (cs.opening_float + v_cash - v_refund_cash + cs.cash_in - cs.cash_out) end),
    'sales_summary', jsonb_build_object('gross_sales', v_gross, 'refunds', v_refunds, 'discounts', v_disc, 'net_sales', v_net, 'vat_included', v_vat),
    'by_method', coalesce((select jsonb_object_agg(method, amt) from (
        select p.method, sum(p.amount) amt from payments p join invoices i on i.bill_id = p.bill_id
         where p.shift_id = cs.id and i.status = 'issued' group by p.method) q), '{}'),
    'bills', (select count(distinct i.id) from invoices i join payments p on p.bill_id = i.bill_id where p.shift_id = cs.id and i.status = 'issued'),
    'voided_bills', (select count(distinct i.id) from invoices i join payments p on p.bill_id = i.bill_id where p.shift_id = cs.id and i.status = 'voided'),
    'printed_at', app.now());
end $$;

select app.patch_fn('public.close_cash_shift(uuid,uuid,numeric)',
  'return jsonb_build_object(''x_reading_id'', v_id, ''totals'', v_totals);',
  'return jsonb_build_object(''x_reading_id'', v_id, ''totals'', v_totals, ''shift_id'', cs.id);');
