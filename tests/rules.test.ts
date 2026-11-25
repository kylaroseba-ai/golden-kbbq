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
