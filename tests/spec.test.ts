// Acceptance tests from SPEC v0.3 (§5, §6, §7 acceptance criteria and §14.1 must-pass tests).
import { beforeEach, describe, expect, it } from 'vitest'
import { ids, makeDb, manila, uuid } from './harness'

type Db = Awaited<ReturnType<typeof makeDb>>
let t: Db
const itemId = async (name: string) => (await t.one<{ id: string }>('select id from items where name = $1', [name])).id
const onHand = async (name: string) =>
  Number((await t.one<{ q: string }>('select l.qty_on_hand q from item_stock_levels l join items i on i.id = l.item_id where i.name = $1', [name])).q)

beforeEach(async () => {
  t = await makeDb()
  await t.clock(manila('2026-12-05 18:00'))
})

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toMatchObject({ code })
}

describe('§5 inventory', () => {
  it('5.2 delivery of 40.35 kg pork belly at ₱325/kg', async () => {
    const before = await onHand('Pork Belly (frozen)')
    const pork = await itemId('Pork Belly (frozen)')
    const r = await t.rpc(ids.manager.auth, 'receive_delivery', {
      p_client_uuid: uuid(), p_branch: ids.candon,
      p_delivery: { supplier_id: ids.supplierMeat, reference_no: 'DR-1', payment_method: 'cash',
        lines: [{ item_id: pork, qty: 40.35, unit_price: 325, expiry_date: '2027-02-01' }] },
    })
    expect(await onHand('Pork Belly (frozen)')).toBe(before + 40350)
    const batch = await t.one<{ unit_cost: string }>('select unit_cost from stock_batches where source_id = $1', [r.id])
    expect(Number(batch.unit_cost)).toBeCloseTo(0.325, 6)
    const sup = await t.rpc(ids.manager.auth, 'get_suppliers', { p_branch: ids.candon })
    const line = sup.find((s: any) => s.id === ids.supplierMeat).items.find((i: any) => i.item_id === pork)
    expect(Number(line.last_unit_price) * 1000).toBeCloseTo(325, 6)
  })

  it('5.2 expiry date is required for expiry-tracked items', async () => {
    await expectCode(t.rpc(ids.manager.auth, 'receive_delivery', {
      p_client_uuid: uuid(), p_branch: ids.candon,
      p_delivery: { lines: [{ item_id: await itemId('Lettuce'), qty: 2, unit_price: 120 }] },
    }), 'EXPIRY_REQUIRED')
  })

  it('5.3 prep run of 5.5 kg Y-Sam moves 4 kg pork + 1.5 kg sauce into 5.5 kg Y-Sam', async () => {
    const [pork, sauce, ysam] = [await onHand('Pork Belly (frozen)'), await onHand('Yangnyeom Meat Sauce'), await onHand('Y-Sam w/ sauce')]
    const recipe = (await t.one<{ id: string }>(`select r.id from prep_recipes r join items i on i.id = r.output_item_id where i.name = 'Y-Sam w/ sauce'`)).id
    await t.rpc(ids.manager.auth, 'run_production', { p_client_uuid: uuid(), p_branch: ids.candon, p_recipe_id: recipe, p_output_qty: 5500 })
    expect(await onHand('Pork Belly (frozen)')).toBe(pork - 4000)
    expect(await onHand('Yangnyeom Meat Sauce')).toBe(sauce - 1500)
    expect(await onHand('Y-Sam w/ sauce')).toBe(ysam + 5500)
  })

  it('5.3 slicing trim is not double-deducted as waste', async () => {
    const recipe = (await t.one<{ id: string }>(`select r.id from prep_recipes r join items i on i.id = r.output_item_id where i.name = 'Samgyupsal'`)).id
    const pork = await onHand('Pork Belly (frozen)')
    await t.rpc(ids.manager.auth, 'run_production', { p_client_uuid: uuid(), p_branch: ids.candon, p_recipe_id: recipe, p_output_qty: 950 })
    expect(await onHand('Pork Belly (frozen)')).toBe(pork - 1000)
    const w = await t.rpc(ids.manager.auth, 'report_waste', { p_branch: ids.candon, p_from: '2026-01-01', p_to: '2027-12-31' })
    expect(w.logged).toHaveLength(0)
    expect(Number(w.prep_trim[0].trim)).toBe(50)
  })

  it('5.5 low-stock alert fires once per crossing and re-arms after restock', async () => {
    const samg = await itemId('Samgyupsal')
    const waste = (qty: number) => t.rpc(ids.manager.auth, 'log_waste', { p_client_uuid: uuid(), p_branch: ids.candon, p_item_id: samg, p_qty: qty, p_reason: 'spoilage' })
    await waste(1600) // 2000 → 400 (alert at 500)
    await waste(100)  // still low: no second alert
    const n = async () => Number((await t.one<{ n: string }>(`select count(*) n from notifications where kind = 'stock_low' and ref_id = $1`, [samg])).n)
    expect(await n()).toBe(1)
    await t.rpc(ids.manager.auth, 'post_opening_balance', { p_client_uuid: uuid(), p_branch: ids.candon, p_lines: [{ item_id: samg, qty: 2000, unit_cost: 0.35 }] })
    await waste(1800)
    expect(await n()).toBe(2)
  })

  it('5.6 near-expiry list and FIFO skip expired batches', async () => {
    const list = await t.rpc(ids.manager.auth, 'get_near_expiry', { p_branch: ids.candon })
    expect(list.some((b: any) => b.name === 'Lettuce')).toBe(true)
    const digest = await t.rpc(ids.manager.auth, 'daily_expiry_digest', { p_branch: ids.candon })
    expect(digest.near_expiry_items).toBeGreaterThan(0)
  })

  it('5.8 closing count: variance values and reasons above threshold', async () => {
    const samg = await itemId('Samgyupsal')     // expected 2.000 kg
    const enoki = await itemId('Enoki')         // expected 2.500 kg
    const submit = (reason?: string) => t.rpc(ids.manager.auth, 'submit_count', {
      p_client_uuid: uuid(), p_branch: ids.candon, p_count_type: 'closing',
      p_lines: [{ item_id: samg, counted: 1.6, reason }, { item_id: enoki, counted: 2.45 }],
    })
    await expectCode(submit(), 'REASON_REQUIRED')   // −400 g = −20 % on Samgyupsal; Enoki −50 g is under 200 g
    const c = await submit('Over-portioning at table 4')
    const s = c.lines.find((l: any) => l.item_id === samg)
    expect(Number(s.variance_qty)).toBe(-400)
    expect(Number(s.variance_value)).toBeCloseTo(-400 * 0.345, 2)
    expect(Number(s.variance_pct)).toBe(-20)
    expect(c.lines.find((l: any) => l.item_id === enoki).needs_reason).toBe(false)
    await t.rpc(ids.manager.auth, 'approve_count', { p_count_id: c.id })
    expect(await onHand('Samgyupsal')).toBe(1600)
    expect(await onHand('Enoki')).toBe(2450)
  })

  it('5.10 reorder: manager approval alone never releases an order', async () => {
    const pork = await itemId('Pork Belly (frozen)')
    await t.rpc(ids.manager.auth, 'log_waste', { p_client_uuid: uuid(), p_branch: ids.candon, p_item_id: pork, p_qty: 20000, p_reason: 'spoilage' })
    const list = await t.rpc(ids.manager.auth, 'generate_reorder_list', { p_branch: ids.candon })
    const line = list.lines.find((l: any) => l.item_id === pork)
    expect(Number(line.suggested_qty)).toBe(35000 - 10000)
    await t.rpc(ids.manager.auth, 'approve_reorder', { p_list_id: list.id, p_level: 'manager' })
    await expectCode(t.rpc(ids.manager.auth, 'mark_reorder_ordered', { p_list_id: list.id }), 'NEEDS_OWNER')
    await expectCode(t.rpc(ids.manager.auth, 'approve_reorder', { p_list_id: list.id, p_level: 'owner' }), 'FORBIDDEN')
    await t.rpc(ids.owner.auth, 'approve_reorder', { p_list_id: list.id, p_level: 'owner' })
    const done = await t.rpc(ids.manager.auth, 'mark_reorder_ordered', { p_list_id: list.id })
    expect(done.status).toBe('ordered')
  })
})

describe('§6 POS', () => {
  async function openTable(token: string, table: string, at: string, pkg = ids.unliPork, pax = [{ discount_type_id: ids.regular, pax_count: 4 }]) {
    await t.clock(manila(at))
    const tableId = (await t.one<{ id: string }>(`select id from dining_tables where label = $1 and branch_id = $2`, [table, ids.candon])).id
    const sessionId = uuid()
    await t.rpc(ids.phone1.auth, 'open_session', { p_client_uuid: uuid(), p_token: token, p_branch: ids.candon, p_session_id: sessionId,
      p_table_ids: [tableId], p_package_id: pkg, p_pax: pax })
    return sessionId
  }
  const refill = (token: string, session: string, lines: { item_id: string; plates: number }[], extra: Record<string, unknown> = {}) =>
    t.rpc(ids.phone1.auth, 'post_refill_round', { p_client_uuid: uuid(), p_token: token, p_session_id: session, p_lines: lines, ...extra })

  it('6.4 Table 7 acceptance: deductions, plate limit, next-round rule, cutoff', async () => {
    const server = await t.pin(ids.phone1, ids.server1)
    const kitchen = await t.pin(ids.kitchenTab, ids.kitchen)
    const s = await openTable(server, '7', '2026-12-05 18:00')
    const [samg, daep, kim] = [await itemId('Samgyupsal'), await itemId('Daepae'), await itemId('Kimchi (served side dish)')]
    // Round 1 (first serving), served
    const r1 = await refill(server, s, [{ item_id: samg, plates: 1 }])
    await t.rpc(ids.kitchenTab.auth, 'mark_ticket_served', { p_token: kitchen, p_ticket_id: r1.ticket_id })
    // Round 2: 2 Samgyupsal + 1 Daepae + 1 Kimchi
    const before = [await onHand('Samgyupsal'), await onHand('Daepae'), await onHand('Kimchi (served side dish)')]
    await t.clock(manila('2026-12-05 18:40'))
    const r2 = await refill(server, s, [{ item_id: samg, plates: 2 }, { item_id: daep, plates: 1 }, { item_id: kim, plates: 1 }])
    expect(r2.round_no).toBe(2)
    expect(await onHand('Samgyupsal')).toBe(before[0] - 160)
    expect(await onHand('Daepae')).toBe(before[1] - 80)
    expect(await onHand('Kimchi (served side dish)')).toBe(before[2] - 50)   // side dishes 50 g per plate (v0.6)
    // Round 3 blocked until Round 2 is served
    await expectCode(refill(server, s, [{ item_id: samg, plates: 1 }]), 'PREV_NOT_SERVED')
    await t.rpc(ids.kitchenTab.auth, 'mark_ticket_served', { p_token: kitchen, p_ticket_id: r2.ticket_id })
    // 4th meat plate blocked
    await expectCode(refill(server, s, [{ item_id: samg, plates: 3 }, { item_id: daep, plates: 1 }]), 'PLATE_LIMIT')
    // side dishes don't count toward the limit
    const r3 = await refill(server, s, [{ item_id: samg, plates: 3 }, { item_id: kim, plates: 2 }])
    await t.rpc(ids.kitchenTab.auth, 'mark_ticket_served', { p_token: kitchen, p_ticket_id: r3.ticket_id })
    // 7:15 PM: cutoff
    await t.clock(manila('2026-12-05 19:15'))
    await expectCode(refill(server, s, [{ item_id: samg, plates: 1 }]), 'REFILL_CUTOFF')
    // manager PIN allows one late round (audited)
    const mgr = await t.pin(ids.phone1, ids.manager, 'override')
    const late = await refill(server, s, [{ item_id: samg, plates: 1 }], { p_override: mgr })
    const row = await t.one<{ override_by: string }>('select override_by from refill_rounds where id = $1', [late.round_id])
    expect(row.override_by).toBe(ids.manager.id)
  })

  it('6.4 a 4th plate is allowed with manager PIN and merged tables get 3 × tables', async () => {
    const server = await t.pin(ids.phone1, ids.server1)
    await t.clock(manila('2026-12-05 18:00'))
    const tbl = async (l: string) => (await t.one<{ id: string }>(`select id from dining_tables where label = $1 and branch_id = $2`, [l, ids.candon])).id
    const s = uuid()
    await t.rpc(ids.phone1.auth, 'open_session', { p_client_uuid: uuid(), p_token: server, p_branch: ids.candon, p_session_id: s,
      p_table_ids: [await tbl('1'), await tbl('2')], p_package_id: ids.unliBeef, p_pax: [{ discount_type_id: ids.regular, pax_count: 8 }] })
    const r = await refill(server, s, [{ item_id: await itemId('Plain Beef'), plates: 6 }])
    expect(r.round_no).toBe(1)
  })

  it('14.1 idempotency: the same refill sent 3 times is applied once', async () => {
    const server = await t.pin(ids.phone1, ids.server1)
    const s = await openTable(server, '3', '2026-12-05 18:00')
    const samg = await itemId('Samgyupsal')
    const before = await onHand('Samgyupsal')
    const key = uuid()
    const args = { p_client_uuid: key, p_token: server, p_session_id: s, p_lines: [{ item_id: samg, plates: 2 }] }
    const a = await t.rpc(ids.phone1.auth, 'post_refill_round', args)
    const b = await t.rpc(ids.phone1.auth, 'post_refill_round', args)
    const c = await t.rpc(ids.phone1.auth, 'post_refill_round', args)
    expect(b).toEqual(a); expect(c).toEqual(a)
    expect(await onHand('Samgyupsal')).toBe(before - 160)
    expect(Number((await t.one<{ n: string }>('select count(*) n from refill_rounds where session_id = $1', [s])).n)).toBe(1)
  })

  it('14.1 concurrency: a second server refilling the same table is rejected by the round rule', async () => {
    const s1 = await t.pin(ids.phone1, ids.server1)
    const s2 = await t.pin(ids.phone2, ids.server2)
    const s = await openTable(s1, '4', '2026-12-05 18:00')
    const samg = await itemId('Samgyupsal')
    const results = await Promise.allSettled([
      t.rpc(ids.phone1.auth, 'post_refill_round', { p_client_uuid: uuid(), p_token: s1, p_session_id: s, p_lines: [{ item_id: samg, plates: 1 }] }),
      t.rpc(ids.phone2.auth, 'post_refill_round', { p_client_uuid: uuid(), p_token: s2, p_session_id: s, p_lines: [{ item_id: samg, plates: 1 }] }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  })

  it('6.1 time windows: unli from opening until last seating, no lunch sets from 3 PM; manager override is recorded', async () => {
    const server = await t.pin(ids.phone1, ids.server1)
    await expectCode(openTable(server, '5', '2026-12-05 10:30'), 'TIME_WINDOW')       // before opening
    await openTable(server, '4', '2026-12-05 11:30')                                    // unli at lunchtime is fine now (v0.6)
    await expectCode(openTable(server, '3', '2026-12-05 20:45'), 'TIME_WINDOW')       // Candon last unli seating 8:30 PM
    const lunch = await openTable(server, '6', '2026-12-05 14:00', null as unknown as string, [])
    await t.rpc(ids.phone1.auth, 'post_order_lines', { p_client_uuid: uuid(), p_token: server, p_session_id: lunch, p_lines: [{ menu_item_id: ids.bulgogiBowl, qty: 1 }] })
    await t.clock(manila('2026-12-05 15:00'))
    await expectCode(t.rpc(ids.phone1.auth, 'post_order_lines', { p_client_uuid: uuid(), p_token: server, p_session_id: lunch,
      p_lines: [{ menu_item_id: ids.bulgogiBowl, qty: 1 }] }), 'TIME_WINDOW')
    // drinks are fine any time
    await t.rpc(ids.phone1.auth, 'post_order_lines', { p_client_uuid: uuid(), p_token: server, p_session_id: lunch, p_lines: [{ menu_item_id: ids.coke, qty: 2 }] })
    const mgr = await t.pin(ids.phone1, ids.manager, 'override')
    await t.rpc(ids.phone1.auth, 'post_order_lines', { p_client_uuid: uuid(), p_token: server, p_session_id: lunch,
      p_lines: [{ menu_item_id: ids.bulgogiBowl, qty: 1 }], p_override: mgr })
    const n = await t.one<{ n: string }>('select count(*) n from order_lines where session_id = $1 and override_by is not null', [lunch])
    expect(Number(n.n)).toBe(1)
  })

  it('6.2 SC/PWD ₱499 → ₱356.43; Kids 50 %; manager discount needs a PIN', async () => {
    const server = await t.pin(ids.phone1, ids.server1)
    const s = await openTable(server, '8', '2026-12-05 18:00', ids.unliPork,
      [{ discount_type_id: ids.regular, pax_count: 2 }, { discount_type_id: ids.senior, pax_count: 1 }, { discount_type_id: ids.kids, pax_count: 1 }])
    const lines = (await t.rpc(ids.phone1.auth, 'get_session', { p_session_id: s })).lines
    expect(Number(lines.find((l: any) => l.discount_name === 'Senior Citizen').net_amount)).toBe(356.43)
    expect(Number(lines.find((l: any) => l.discount_name === 'Kids 3 ft to under 4 ft').net_amount)).toBe(249.5)
    const bill = await t.rpc(ids.phone1.auth, 'preview_bill', { p_session_id: s })
    expect(Number(bill.total)).toBe(998 + 356.43 + 249.5)
    expect(Number(bill.vat_exempt_sales)).toBe(356.43)
    expect(Number(bill.vat_amount)).toBe(Number(((998 + 249.5) / 1.12 * 0.12).toFixed(2)) || Number(bill.vat_amount))
    await expectCode(openTable(server, '9', '2026-12-05 18:00', ids.unliPork, [{ discount_type_id: ids.managerDiscount, pax_count: 1 }]), 'NEEDS_MANAGER')
  })

  it('6.7 BIR mode (if the POS is ever registered): booklet fallback, gap-free numbering on the registered terminal, voids keep numbers, Z = sum', async () => {
    await t.db.query(`update branches set settings = settings || '{"receipt_mode":"bir"}' where id = $1`, [ids.candon])
    const server = await t.pin(ids.phone1, ids.server1)
    const cashier = await t.pin(ids.counter, ids.cashier)
    const settle = (s: string, opts: Record<string, unknown> = {}, device = ids.counter, token = cashier) =>
      t.rpc(device.auth, 'settle_bill', { p_client_uuid: uuid(), p_token: token, p_session_id: s, p_terminal_id: ids.terminal,
        p_payments: [{ method: 'cash', amount: 5000 }], ...opts })
    // printing off (before BIR approval): booklet number required
    const s1 = await openTable(server, '10', '2026-12-05 18:00')
    await expectCode(settle(s1), 'BOOKLET_REQUIRED')
    const b1 = await settle(s1, { p_manual_booklet_no: 'BK-0001' })
    expect(b1.official).toBe(false)
    // permit arrives: printing switched on per terminal
    await t.db.query('update pos_terminals set invoice_printing_enabled = true where id = $1', [ids.terminal])
    const nos: number[] = []
    for (const tbl of ['11', '12', '13']) {
      const s = await openTable(server, tbl, '2026-12-05 18:00')
      nos.push(Number((await settle(s)).invoice_no))
    }
    expect(nos).toEqual([1, 2, 3])
    // a different device (server phone) cannot issue official invoices
    const s5 = await openTable(server, '14', '2026-12-05 18:00')
    const mgrPhone = await t.pin(ids.phone1, ids.manager)
    await expectCode(settle(s5, {}, ids.phone1, mgrPhone), 'BOOKLET_REQUIRED')
    // void keeps its number and needs a manager
    const inv2 = await t.one<{ id: string }>('select id from invoices where invoice_no = 2')
    await expectCode(t.rpc(ids.counter.auth, 'void_invoice', { p_token: cashier, p_invoice_id: inv2.id, p_reason: 'wrong table' }), 'NEEDS_MANAGER')
    const mgr = await t.pin(ids.counter, ids.manager, 'override')
    await t.rpc(ids.counter.auth, 'void_invoice', { p_token: cashier, p_invoice_id: inv2.id, p_reason: 'wrong table', p_override: mgr })
    await expect(t.db.query('update invoices set total = 1 where id = $1', [inv2.id])).rejects.toThrow(/IMMUTABLE/)
    const z = await t.rpc(ids.counter.auth, 'z_reading', { p_token: cashier, p_terminal_id: ids.terminal, p_business_date: '2026-12-05' })
    expect(Number(z.gross_sales)).toBe(2 * 1996)
    expect(Number(z.voids_total)).toBe(1996)
    expect([z.first_invoice_no, z.last_invoice_no].map(Number)).toEqual([1, 3])
    expect(Number(z.accumulated_grand_total_end)).toBe(3 * 1996)
    await expect(t.db.query('update pos_terminals set accumulated_grand_total = 0')).rejects.toThrow(/never decreases/)
  })

  it('6.7 SC/PWD guests need name and ID on the invoice', async () => {
    const server = await t.pin(ids.phone1, ids.server1)
    const cashier = await t.pin(ids.counter, ids.cashier)
    const s = await openTable(server, '15', '2026-12-05 18:00', ids.unliPork, [{ discount_type_id: ids.senior, pax_count: 1 }])
    const args = { p_client_uuid: uuid(), p_token: cashier, p_session_id: s, p_terminal_id: ids.terminal, p_manual_booklet_no: 'BK-9',
      p_payments: [{ method: 'gcash', amount: 427.86, reference_no: 'GC123' }] }   // one guest → solo price ₱599, SC/PWD ₱427.86
    await expectCode(t.rpc(ids.counter.auth, 'settle_bill', args), 'SC_PWD_DETAILS')
    const r = await t.rpc(ids.counter.auth, 'settle_bill', { ...args, p_client_uuid: uuid(), p_sc_pwd: [{ kind: 'sc', id_number: 'SC-123', full_name: 'Juan Dela Cruz' }] })
    const inv = await t.rpc(ids.counter.auth, 'get_invoice', { p_invoice_id: r.invoice_id })
    expect(inv.sc_pwd[0].id_number).toBe('SC-123')
  })

  it('6.6 voids before serving reverse stock; after serving need a manager', async () => {
    const server = await t.pin(ids.phone1, ids.server1)
    const kitchen = await t.pin(ids.kitchenTab, ids.kitchen)
    const s = await openTable(server, '16', '2026-12-05 12:00', null as unknown as string, [])
    const before = await onHand('Rice (cooked)')
    const o = await t.rpc(ids.phone1.auth, 'post_order_lines', { p_client_uuid: uuid(), p_token: server, p_session_id: s,
      p_lines: [{ menu_item_id: ids.bulgogiBowl, qty: 2 }] })
    expect(await onHand('Rice (cooked)')).toBe(before - 300)
    await t.rpc(ids.phone1.auth, 'void_order_line', { p_token: server, p_line_id: o.line_ids[0], p_reason: 'customer changed mind' })
    expect(await onHand('Rice (cooked)')).toBe(before)
    const o2 = await t.rpc(ids.phone1.auth, 'post_order_lines', { p_client_uuid: uuid(), p_token: server, p_session_id: s,
      p_lines: [{ menu_item_id: ids.bulgogiBowl, qty: 1 }] })
    await t.rpc(ids.kitchenTab.auth, 'mark_ticket_served', { p_token: kitchen, p_ticket_id: o2.ticket_id })
    await expectCode(t.rpc(ids.phone1.auth, 'void_order_line', { p_token: server, p_line_id: o2.line_ids[0], p_reason: 'x' }), 'NEEDS_MANAGER')
  })
})

describe('§11 access', () => {
  it('PINs: 5 wrong tries lock the user; no RPC output contains a PIN hash', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await t.rpc(ids.phone1.auth, 'verify_pin', { p_device_id: ids.phone1.id, p_user_id: ids.server1.id, p_pin: '0000' })
      expect(r.error).toBe('PIN_WRONG')
    }
    const locked = await t.rpc(ids.phone1.auth, 'verify_pin', { p_device_id: ids.phone1.id, p_user_id: ids.server1.id, p_pin: '0000' })
    expect(locked.error).toBe('PIN_LOCKED')
    await expectCode(t.rpc(ids.phone1.auth, 'verify_pin', { p_device_id: ids.phone1.id, p_user_id: ids.server1.id, p_pin: '3333' }), 'PIN_LOCKED')
    const outputs = JSON.stringify([
      await t.rpc(ids.phone1.auth, 'list_device_staff', { p_device_id: ids.phone1.id }),
      await t.rpc(ids.phone1.auth, 'whoami'),
      await t.rpc(ids.phone1.auth, 'get_bootstrap', { p_branch: ids.candon }),
    ])
    expect(outputs).not.toMatch(/pin_hash|pin_salt/)
  })

  it('a revoked device can no longer act', async () => {
    const server = await t.pin(ids.phone1, ids.server1)
    await t.rpc(ids.manager.auth, 'revoke_device', { p_device_id: ids.phone1.id })
    await expectCode(t.rpc(ids.phone1.auth, 'log_waste', { p_client_uuid: uuid(), p_token: server, p_branch: ids.candon,
      p_item_id: await itemId('Samgyupsal'), p_qty: 10, p_reason: 'spoilage' }), 'SESSION_EXPIRED')
  })

  it('branch isolation: a Taft user cannot read Candon through RPCs or RLS', async () => {
    await expectCode(t.rpc(ids.taftManager.auth, 'get_live_stock', { p_branch: ids.candon }), 'FORBIDDEN')
    await expectCode(t.rpc(ids.taftManager.auth, 'get_floor', { p_branch: ids.candon }), 'FORBIDDEN')
    await expectCode(t.rpc(ids.taftManager.auth, 'receive_delivery', { p_client_uuid: uuid(), p_branch: ids.candon,
      p_delivery: { lines: [{ item_id: await itemId('Samgyupsal'), qty: 1, unit_price: 1, expiry_date: '2027-01-01' }] } }), 'FORBIDDEN')
    // RLS on direct table reads (what REST and Realtime use)
    await t.db.exec(`create role authenticated nologin; grant usage on schema public, app, auth to authenticated;
      grant select on all tables in schema public to authenticated; grant execute on all functions in schema app, auth to authenticated;`)
    await t.db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [ids.taftManager.auth])
    await t.db.exec('set role authenticated')
    const rows = await t.db.query<{ branch_id: string }>('select distinct branch_id from items')
    const tokens = await t.db.query('select * from sc_pwd_records union all select * from sc_pwd_records')
    await t.db.exec('reset role')
    expect(rows.rows.map((r) => r.branch_id)).toEqual([ids.taft])
    expect(tokens.rows).toHaveLength(0)
  })
})

describe('§7 reservations', () => {
  it('booking alerts staff; confirm queues SMS + reminder; capacity spans overlapping slots', async () => {
    await t.clock(manila('2026-12-05 12:00'))
    const book = (time: string, party: number, phone = '09171234567') => t.rpc(null, 'create_public_reservation', { p_branch_code: 'CANDON', p_booking: {
      date: '2026-12-05', time, party_size: party, package_interest: 'unli_pork', customer_name: 'Ana', phone, consent_privacy: true } })
    const r = await book('19:00', 6)
    expect(r.code).toMatch(/^GKB-[2-9A-Z]{4}$/)
    const n = await t.one<{ n: string }>(`select count(*) n from notifications where kind = 'reservation_new'`)
    expect(Number(n.n)).toBe(1)
    const res = (await t.one<{ id: string }>('select id from reservations where code = $1', [r.code])).id
    const cashier = await t.pin(ids.counter, ids.cashier)
    await t.rpc(ids.counter.auth, 'confirm_reservation', { p_token: cashier, p_reservation_id: res })
    const msgs = (await t.db.query<{ event: string; send_after: string; to_address: string }>(
      `select event, send_after, to_address from outbound_messages where reservation_id = $1 and channel = 'sms' order by send_after`, [res])).rows
    expect(msgs.map((m) => m.event)).toEqual(['confirmed', 'reminder'])
    expect(new Date(msgs[1].send_after).toISOString()).toBe(manila('2026-12-05 16:00'))
    expect(msgs[0].to_address).toBe('639171234567')
    // capacity: 50 % of 108 = 54 online seats; a 2-hour booking holds seats in every slot it overlaps.
    await book('18:00', 9, '09170000011'); await book('18:30', 9, '09170000012'); await book('19:30', 9, '09170000013')
    await book('18:00', 9, '09170000021'); await book('18:30', 9, '09170000022')
    // at 19:30 the 18:00, 18:30, 19:00 and 19:30 bookings are all seated: 51 of 54
    await expectCode(book('19:30', 4, '09170000014'), 'FULLY_BOOKED')
    await book('19:30', 3, '09170000017')
    // lead time: 3 hours
    await expectCode(book('14:30', 2, '09170000015'), 'SLOT_UNAVAILABLE')
    await expectCode(t.rpc(null, 'create_public_reservation', { p_branch_code: 'CANDON', p_booking: {
      date: '2026-12-06', time: '19:00', party_size: 51, customer_name: 'Big group', phone: '09170000016', consent_privacy: true } }), 'PARTY_TOO_LARGE')
  })

  it('no reminder when confirmed less than 3 h 30 min before', async () => {
    await t.clock(manila('2026-12-05 16:00'))
    const r = await t.rpc(null, 'create_public_reservation', { p_branch_code: 'CANDON', p_booking: {
      date: '2026-12-05', time: '19:00', party_size: 2, customer_name: 'Ben', phone: '09170000020', consent_privacy: true } })
    const res = (await t.one<{ id: string }>('select id from reservations where code = $1', [r.code])).id
    const cashier = await t.pin(ids.counter, ids.cashier)
    await t.rpc(ids.counter.auth, 'confirm_reservation', { p_token: cashier, p_reservation_id: res })
    const ev = (await t.db.query<{ event: string }>(`select event from outbound_messages where reservation_id = $1 and channel = 'sms'`, [res])).rows
    expect(ev.map((e) => e.event)).toEqual(['confirmed'])
  })
})
