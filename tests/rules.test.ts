// v0.6 confirmed rules: solo diner, birthday, reservation fee, closed days, kitchen/dispatch stations, internal receipts.
import { beforeEach, describe, expect, it } from 'vitest'
import { ids, makeDb, manila, uuid } from './harness'

let t: Awaited<ReturnType<typeof makeDb>>
beforeEach(async () => { t = await makeDb(); await t.clock(manila('2026-12-05 12:00')) })
const expectCode = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code })
const open = async (token: string, table: string, at: string, pkg: string, pax: object[], override?: string) => {
  await t.clock(manila(at))
  const tid = (await t.one<{ id: string }>(`select id from dining_tables where branch_id = $1 and label = $2`, [ids.candon, table])).id
  const sid = uuid()
  await t.rpc(ids.phone1.auth, 'open_session', { p_client_uuid: uuid(), p_token: token, p_branch: ids.candon, p_session_id: sid,
    p_table_ids: [tid], p_package_id: pkg, p_pax: pax, p_override: override ?? null })
  return sid
}
const birthday50 = '90000000-0000-0000-0000-000000000006'
const birthdayFree = '90000000-0000-0000-0000-000000000009'

describe('pricing rules', () => {
  it('one guest pays the solo-diner price; two or more pay the regular price', async () => {
    const ben = await t.pin(ids.phone1, ids.server1)
    const solo = await open(ben, '1', '2026-12-05 18:00', ids.unliBeef, [{ discount_type_id: ids.regular, pax_count: 1 }])
    expect(Number((await t.rpc(ids.phone1.auth, 'preview_bill', { p_session_id: solo })).total)).toBe(699)
    const two = await open(ben, '2', '2026-12-05 18:00', ids.unliBeef, [{ discount_type_id: ids.regular, pax_count: 2 }])
    expect(Number((await t.rpc(ids.phone1.auth, 'preview_bill', { p_session_id: two })).total)).toBe(1198)
  })

  it('birthday 50% needs 3 full-paying adults; free needs 7; one celebrant per table', async () => {
    const ben = await t.pin(ids.phone1, ids.server1)
    await expectCode(open(ben, '3', '2026-12-05 18:00', ids.unliPork,
      [{ discount_type_id: ids.regular, pax_count: 2 }, { discount_type_id: birthday50, pax_count: 1 }]), 'PAX_RULE')
    const ok = await open(ben, '4', '2026-12-05 18:00', ids.unliPork,
      [{ discount_type_id: ids.regular, pax_count: 3 }, { discount_type_id: birthday50, pax_count: 1 }])
    expect(Number((await t.rpc(ids.phone1.auth, 'preview_bill', { p_session_id: ok })).total)).toBe(3 * 499 + 249.5)
    await expectCode(open(ben, '5', '2026-12-05 18:00', ids.unliPork,
      [{ discount_type_id: ids.regular, pax_count: 6 }, { discount_type_id: birthdayFree, pax_count: 1 }]), 'PAX_RULE')
    const free = await open(ben, '10', '2026-12-05 18:00', ids.unliPork,
      [{ discount_type_id: ids.regular, pax_count: 7 }, { discount_type_id: birthdayFree, pax_count: 1 }])
    expect(Number((await t.rpc(ids.phone1.auth, 'preview_bill', { p_session_id: free })).total)).toBe(7 * 499)
    await expectCode(open(ben, '11', '2026-12-05 18:00', ids.unliPork,
      [{ discount_type_id: ids.regular, pax_count: 5 }, { discount_type_id: birthday50, pax_count: 2 }]), 'PAX_RULE')
    // a manager can override
    const mgr = await t.pin(ids.phone1, ids.manager, 'override')
    await open(ben, '12', '2026-12-05 18:00', ids.unliPork,
      [{ discount_type_id: ids.regular, pax_count: 2 }, { discount_type_id: birthday50, pax_count: 1 }], mgr)
  })
})

describe('reservations', () => {
  const book = (branch: string, date: string, time: string, party: number, extra: object = {}) =>
    t.rpc(null, 'create_public_reservation', { p_branch_code: branch, p_booking: { date, time, party_size: party,
      package_interest: 'unli_pork', customer_name: 'Group', phone: `0917${Math.floor(1e6 + Math.random() * 8e6)}`, consent_privacy: true, ...extra } })

  it('10+ pax pay a ₱1,000 GCash fee: required to book, checked before confirming, deducted from the bill, kept on no-show', async () => {
    await expectCode(book('CANDON', '2026-12-06', '18:00', 12), 'DEPOSIT_REQUIRED')
    const r = await book('CANDON', '2026-12-06', '18:00', 12, { deposit_ref: 'GC-777' })
    expect(r.deposit_status).toBe('pending')
    expect(Number(r.deposit_amount)).toBe(1000)
    const res = (await t.one<{ id: string }>('select id from reservations where code = $1', [r.code])).id
    const carlo = await t.pin(ids.counter, ids.cashier)
    await expectCode(t.rpc(ids.counter.auth, 'confirm_reservation', { p_token: carlo, p_reservation_id: res }), 'DEPOSIT_PENDING')
    await t.rpc(ids.counter.auth, 'verify_reservation_deposit', { p_reservation_id: res, p_received: true }, carlo)
    await t.rpc(ids.counter.auth, 'confirm_reservation', { p_token: carlo, p_reservation_id: res })
    // seated: the bill shows the fee already paid
    await t.clock(manila('2026-12-06 18:00'))
    const carlo2 = await t.pin(ids.counter, ids.cashier)
    const tid = (await t.one<{ id: string }>(`select id from dining_tables where branch_id = $1 and label = '15'`, [ids.candon])).id
    const sid = uuid()
    await t.rpc(ids.counter.auth, 'open_session', { p_client_uuid: uuid(), p_branch: ids.candon, p_session_id: sid,
      p_table_ids: [tid], p_package_id: ids.unliPork, p_pax: [{ discount_type_id: ids.regular, pax_count: 12 }], p_reservation_id: res, p_token: carlo2 })
    const sess = await t.rpc(ids.counter.auth, 'get_session', { p_session_id: sid })
    expect(Number(sess.reservation_fee.amount)).toBe(1000)
    expect(sess.reservation_fee.ref).toBe('GC-777')
    // no-show on another booking keeps the fee
    await t.clock(manila('2026-12-05 12:00'))
    const r2 = await book('CANDON', '2026-12-07', '18:00', 10, { deposit_ref: 'GC-888' })
    const res2 = (await t.one<{ id: string }>('select id from reservations where code = $1', [r2.code])).id
    await t.db.query(`update reservations set status = 'no_show' where id = $1`, [res2])
    expect((await t.one<{ s: string }>('select deposit_status s from reservations where id = $1', [res2])).s).toBe('forfeited')
  })

  it('Taft is closed on Sundays; Candon is open', async () => {
    const taft = await t.rpc(null, 'public_availability', { p_branch_code: 'TAFT', p_date: '2026-12-06', p_party: 2, p_interest: 'unli_pork' })
    expect(taft.closed).toBe(true)
    expect(taft.slots.some((x: any) => x.available)).toBe(false)
    await expectCode(book('TAFT', '2026-12-06', '18:00', 2), 'SLOT_UNAVAILABLE')
    const candon = await t.rpc(null, 'public_availability', { p_branch_code: 'CANDON', p_date: '2026-12-06', p_party: 2, p_interest: 'unli_pork' })
    expect(candon.closed).toBe(false)
    expect(candon.reservation_fee.amount).toBe(1000)
  })
})

describe('kitchen and dispatch', () => {
  it('meat and side-dish refills go to Dispatch; cooked items go to the Kitchen; each screen sees only its lines', async () => {
    const ben = await t.pin(ids.phone1, ids.server1)
    const sid = await open(ben, '7', '2026-12-05 18:00', ids.unliPork, [{ discount_type_id: ids.regular, pax_count: 2 }])
    const item = async (n: string) => (await t.one<{ id: string }>(`select id from items where branch_id = $1 and name = $2`, [ids.candon, n])).id
    await t.rpc(ids.phone1.auth, 'post_refill_round', { p_client_uuid: uuid(), p_token: ben, p_session_id: sid,
      p_lines: [{ item_id: await item('Samgyupsal'), plates: 2 }, { item_id: await item('Steam Egg'), plates: 1 }] })
    const rico = await t.pin(ids.kitchenTab, ids.kitchen)
    const disp = await t.rpc(ids.kitchenTab.auth, 'get_station_queue', { p_branch: ids.candon, p_station: 'dispatch' }, rico)
    const kit = await t.rpc(ids.kitchenTab.auth, 'get_station_queue', { p_branch: ids.candon, p_station: 'kitchen' }, rico)
    expect(disp.tickets[0].lines.map((l: any) => l.label)).toEqual(['Samgyupsal'])
    expect(kit.tickets[0].lines.map((l: any) => l.label)).toEqual(['Steam Egg'])
    // dispatch serves the meat: the next round unlocks even though the egg is still cooking
    await t.rpc(ids.kitchenTab.auth, 'mark_ticket_served', { p_token: rico, p_ticket_id: disp.tickets[0].id, p_line_ids: disp.tickets[0].lines.map((l: any) => l.id) })
    await t.clock(manila('2026-12-05 18:20'))
    const r = await t.rpc(ids.phone1.auth, 'post_refill_round', { p_client_uuid: uuid(), p_token: ben, p_session_id: sid,
      p_lines: [{ item_id: await item('Samgyupsal'), plates: 1 }] })
    expect(r.round_no).toBe(2)
  })
})

describe('internal receipts and shift report', () => {
  it('bills get internal numbers C-000001…, need no BIR booklet number, and the shift report adds up', async () => {
    const ben = await t.pin(ids.phone1, ids.server1)
    const carlo = await t.pin(ids.counter, ids.cashier)
    const shift = await t.rpc(ids.counter.auth, 'open_cash_shift', { p_token: carlo, p_terminal_id: ids.terminal, p_opening_float: 2000 })
    const a = await open(ben, '1', '2026-12-05 18:00', ids.unliPork, [{ discount_type_id: ids.regular, pax_count: 2 }, { discount_type_id: ids.senior, pax_count: 1 }])
    const b = await open(ben, '2', '2026-12-05 18:00', ids.unliPork, [{ discount_type_id: ids.regular, pax_count: 2 }])
    const settle = (sid: string, payments: object[]) => t.rpc(ids.counter.auth, 'settle_bill', { p_client_uuid: uuid(), p_token: carlo, p_session_id: sid,
      p_terminal_id: ids.terminal, p_payments: payments, p_sc_pwd: [{ kind: 'sc', id_number: 'SC-1', full_name: 'Lola' }] })
    const r1 = await settle(a, [{ method: 'cash', amount: 1500 }])                      // 998 + 356.43 = 1,354.43
    const r2 = await settle(b, [{ method: 'gcash', amount: 998, reference_no: 'GC-1' }])
    const inv1 = await t.rpc(ids.counter.auth, 'get_invoice', { p_invoice_id: r1.invoice_id }, carlo)
    const inv2 = await t.rpc(ids.counter.auth, 'get_invoice', { p_invoice_id: r2.invoice_id }, carlo)
    expect(inv1.receipt_mode).toBe('internal')
    expect(inv1.bill_no).toBe('C-000001')
    expect(inv2.bill_no).toBe('C-000002')
    expect(inv1.server).toBe('Ben Ramos')
    expect(Number(inv1.pax)).toBe(3)
    await t.rpc(ids.counter.auth, 'cash_move', { p_token: carlo, p_shift_id: shift.id, p_amount: 500 })
    await t.rpc(ids.counter.auth, 'close_cash_shift', { p_token: carlo, p_shift_id: shift.id, p_counted_cash: 3854.53 })
    const rep = await t.rpc(ids.counter.auth, 'get_shift_report', { p_shift_id: shift.id }, carlo)
    expect(rep.shift_number).toBe(1)
    expect(Number(rep.cash_drawer.cash_payments)).toBe(1354.43)
    expect(Number(rep.cash_drawer.expected_cash)).toBe(3854.43)
    expect(Number(rep.cash_drawer.difference)).toBe(0.1)
    expect(Number(rep.sales_summary.gross_sales)).toBe(499 * 5)
    expect(Number(rep.sales_summary.net_sales)).toBe(2352.43)
    expect(Number(rep.sales_summary.discounts)).toBe(Number((499 - 356.43).toFixed(2)))
    expect(Number(rep.by_method.gcash)).toBe(998)
    // servers cannot print the shift report
    await expect(t.rpc(ids.phone1.auth, 'get_shift_report', { p_shift_id: shift.id }, ben)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('meat choice', () => {
  it('a Solo Set takes 150 g of the chosen meat off stock and names it on the kitchen ticket; no choice is refused', async () => {
    const ben = await t.pin(ids.phone1, ids.server1)
    await t.clock(manila('2026-12-05 12:00'))
    const tid = (await t.one<{ id: string }>(`select id from dining_tables where branch_id = $1 and label = '6'`, [ids.candon])).id
    const sid = uuid()
    await t.rpc(ids.phone1.auth, 'open_session', { p_client_uuid: uuid(), p_token: ben, p_branch: ids.candon, p_session_id: sid,
      p_table_ids: [tid], p_package_id: null, p_pax: [] })
    const soloSet = '80000000-0000-0000-0000-000000000015'
    const ysam = (await t.one<{ id: string }>(`select id from items where branch_id = $1 and name = 'Y-Sam w/ sauce'`, [ids.candon])).id
    const before = Number((await t.one<{ q: string }>('select qty_on_hand q from item_stock_levels where item_id = $1', [ysam])).q)
    await expect(t.rpc(ids.phone1.auth, 'post_order_lines', { p_client_uuid: uuid(), p_token: ben, p_session_id: sid,
      p_lines: [{ menu_item_id: soloSet, qty: 1 }] })).rejects.toMatchObject({ code: 'CHOICE_REQUIRED' })
    await t.rpc(ids.phone1.auth, 'post_order_lines', { p_client_uuid: uuid(), p_token: ben, p_session_id: sid,
      p_lines: [{ menu_item_id: soloSet, qty: 2, choice_item_id: ysam }] })
    const after = Number((await t.one<{ q: string }>('select qty_on_hand q from item_stock_levels where item_id = $1', [ysam])).q)
    expect(before - after).toBe(300)
    const label = (await t.one<{ label: string }>(`select label from kitchen_ticket_lines where label like 'Solo Set%'`)).label
    expect(label).toBe('Solo Set — Y-Sam w/ sauce')
    const s = await t.rpc(ids.phone1.auth, 'get_session', { p_session_id: sid })
    expect(s.lines.find((l: any) => l.name === 'Solo Set').choice_name).toBe('Y-Sam w/ sauce')
    // voiding before it is served puts the meat back
    const line = s.lines.find((l: any) => l.name === 'Solo Set').id
    await t.rpc(ids.phone1.auth, 'void_order_line', { p_token: ben, p_line_id: line, p_reason: 'wrong order' })
    expect(Number((await t.one<{ q: string }>('select qty_on_hand q from item_stock_levels where item_id = $1', [ysam])).q)).toBe(before)
  })
})
