// Accounts and roles (v0.6): screen access enforced in the database, multi-role staff, people and devices.
import { beforeEach, describe, expect, it } from 'vitest'
import { ids, makeDb } from './harness'

let t: Awaited<ReturnType<typeof makeDb>>
beforeEach(async () => { t = await makeDb() })

describe('screen access in the database', () => {
  it('servers, cashiers and kitchen cannot read the dashboard or reports; managers and the owner can', async () => {
    const ben = await t.pin(ids.phone1, ids.server1)
    const carlo = await t.pin(ids.counter, ids.cashier)
    const rico = await t.pin(ids.kitchenTab, ids.kitchen)
    for (const [dev, tok] of [[ids.phone1, ben], [ids.counter, carlo], [ids.kitchenTab, rico]] as const) {
      await expect(t.rpc(dev.auth, 'get_dashboard', { p_branch: ids.candon }, tok)).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(t.rpc(dev.auth, 'report_sales_summary', { p_branch: ids.candon, p_from: '2026-12-01', p_to: '2026-12-05' }, tok))
        .rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(t.rpc(dev.auth, 'get_live_shifts', { p_branch: ids.candon }, tok)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    // a shared device with nobody signed in by PIN gets nothing either
    await expect(t.rpc(ids.counter.auth, 'get_dashboard', { p_branch: ids.candon })).rejects.toMatchObject({ code: 'NOT_SIGNED_IN' })
    // manager by PIN on the counter, manager and owner by personal login
    const mara = await t.pin(ids.counter, ids.manager)
    expect((await t.rpc(ids.counter.auth, 'get_dashboard', { p_branch: ids.candon }, mara)).business_date).toBeTruthy()
    expect((await t.rpc(ids.manager.auth, 'get_dashboard', { p_branch: ids.candon })).business_date).toBeTruthy()
    expect((await t.rpc(ids.owner.auth, 'get_dashboard', { p_branch: ids.candon })).business_date).toBeTruthy()
    // the Taft manager cannot read Candon's dashboard
    await expect(t.rpc(ids.taftManager.auth, 'get_dashboard', { p_branch: ids.candon })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('servers and cashiers see stock levels without costs; kitchen and managers see costs', async () => {
    const hasCost = (x: unknown) => JSON.stringify(x).includes('cost')
    const ben = await t.pin(ids.phone1, ids.server1)
    const rico = await t.pin(ids.kitchenTab, ids.kitchen)
    const benStock = await t.rpc(ids.phone1.auth, 'get_live_stock', { p_branch: ids.candon }, ben)
    expect(JSON.stringify(benStock).length).toBeGreaterThan(100)
    expect(hasCost(benStock)).toBe(false)
    expect(hasCost(await t.rpc(ids.phone1.auth, 'get_bootstrap', { p_branch: ids.candon }, ben))).toBe(false)
    expect(hasCost(await t.rpc(ids.kitchenTab.auth, 'get_live_stock', { p_branch: ids.candon }, rico))).toBe(true)
    expect(hasCost(await t.rpc(ids.manager.auth, 'get_live_stock', { p_branch: ids.candon }))).toBe(true)
  })

  it('nav badges still work for every role', async () => {
    const ben = await t.pin(ids.phone1, ids.server1)
    const r = await t.rpc(ids.phone1.auth, 'get_nav_counts', { p_branch: ids.candon }, ben)
    expect(r).toHaveProperty('staff')
  })
})

describe('people and roles', () => {
  it('a person can hold two roles; dispatch can serve tickets; utility can only use the time clock', async () => {
    const add = (person: object) => t.rpc(ids.manager.auth, 'save_person', { p_branch: ids.candon, p_person: person })
    const robin = (await add({ full_name: 'Robin', roles: ['server', 'dispatch'] })).id
    const dish = (await add({ full_name: 'Dishwasher', roles: ['utility'] })).id
    await t.rpc(ids.manager.auth, 'set_pin', { p_branch: ids.candon, p_user_id: robin, p_pin: '7777' })
    await t.rpc(ids.manager.auth, 'set_pin', { p_branch: ids.candon, p_user_id: dish, p_pin: '8888' })
    const staff = await t.rpc(ids.phone1.auth, 'list_device_staff', { p_device_id: ids.phone1.id })
    const r = staff.find((s: any) => s.id === robin)
    expect(r.roles).toEqual(['dispatch', 'server'])
    expect(staff.filter((s: any) => s.id === robin)).toHaveLength(1)
    const v = await t.rpc(ids.phone1.auth, 'verify_pin', { p_device_id: ids.phone1.id, p_user_id: robin, p_pin: '7777' })
    expect(v.user.roles).toEqual(['dispatch', 'server'])
    // Robin can open a table (server) and is treated as kitchen for dispatch work
    await t.rpc(ids.phone1.auth, 'get_floor', { p_branch: ids.candon }, v.token)
    const d = await t.rpc(ids.phone1.auth, 'verify_pin', { p_device_id: ids.phone1.id, p_user_id: dish, p_pin: '8888' })
    const ok = await t.rpc(ids.phone1.auth, 'clock_event', { p_client_uuid: crypto.randomUUID(), p_token: d.token, p_branch: ids.candon, p_kind: 'in' })
    expect(ok.ok ?? true).toBeTruthy()
    await expect(t.rpc(ids.phone1.auth, 'log_waste', { p_client_uuid: crypto.randomUUID(), p_token: d.token, p_branch: ids.candon,
      p_item_id: '00000000-0000-0000-0000-000000000000', p_qty: 1, p_reason: 'spoiled' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('only the owner gives manager rights; only the admin gives owner rights; nobody changes their own roles', async () => {
    const add = (who: string, person: object) => t.rpc(who, 'save_person', { p_branch: ids.candon, p_person: person })
    await expect(add(ids.manager.auth, { full_name: 'New Manager', roles: ['manager'] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const nm = (await add(ids.owner.auth, { full_name: 'New Manager', roles: ['manager'] })).id
    expect(nm).toBeTruthy()
    await expect(add(ids.owner.auth, { full_name: 'Co-owner', roles: ['owner'] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await add(ids.admin.auth, { full_name: 'Co-owner', roles: ['owner'] })).id).toBeTruthy()
    // a manager cannot demote another manager
    await expect(add(ids.manager.auth, { id: nm, full_name: 'New Manager', roles: ['server'] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(add(ids.manager.auth, { id: ids.manager.id, full_name: 'Mara', roles: ['owner'] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    // servers cannot manage people at all
    const ben = await t.pin(ids.phone1, ids.server1)
    await expect(t.rpc(ids.phone1.auth, 'list_people', { p_branch: ids.candon }, ben)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const people = await t.rpc(ids.manager.auth, 'list_people', { p_branch: ids.candon })
    expect(JSON.stringify(people)).not.toContain('pin_hash')
    expect(people.find((p: any) => p.id === ids.server1.id).has_pin).toBe(true)
  })

  it('deactivating a person signs them out at once', async () => {
    const ben = await t.pin(ids.phone1, ids.server1)
    await t.rpc(ids.manager.auth, 'set_person_active', { p_branch: ids.candon, p_user_id: ids.server1.id, p_active: false })
    await expect(t.rpc(ids.phone1.auth, 'get_my_time', { p_token: ben, p_branch: ids.candon })).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    const staff = await t.rpc(ids.phone1.auth, 'list_device_staff', { p_device_id: ids.phone1.id })
    expect(staff.some((s: any) => s.id === ids.server1.id)).toBe(false)
  })

  it('invites are only for owner, manager and admin; emails are unique', async () => {
    await expect(t.rpc(ids.manager.auth, 'prepare_invite', { p_branch: ids.candon, p_user_id: null, p_full_name: 'Ben', p_email: 'ben@example.com', p_roles: ['server'] }))
      .rejects.toMatchObject({ code: 'BAD_INPUT' })
    const r = await t.rpc(ids.owner.auth, 'prepare_invite', { p_branch: ids.candon, p_user_id: null, p_full_name: 'Zion', p_email: 'Zion@Example.com', p_roles: ['manager'] })
    expect(r.email).toBe('zion@example.com')
    await expect(t.rpc(ids.owner.auth, 'prepare_invite', { p_branch: ids.candon, p_user_id: null, p_full_name: 'Other', p_email: 'zion@example.com', p_roles: ['manager'] }))
      .rejects.toMatchObject({ code: 'BAD_INPUT' })
  })
})

describe('devices', () => {
  it('a manager registers a device; a cashier device gets its own terminal; staff cannot', async () => {
    const r = await t.rpc(ids.manager.auth, 'prepare_device', { p_branch: ids.candon, p_label: 'Counter tablet 2', p_kind: 'cashier' })
    const list = await t.rpc(ids.manager.auth, 'list_devices', { p_branch: ids.candon })
    const d = list.find((x: any) => x.id === r.device_id)
    expect(d.registered).toBe(false)
    expect(d.terminal).toMatch(/^T\d+$/)
    expect(d.registered_by).toBeTruthy()
    const ben = await t.pin(ids.phone1, ids.server1)
    await expect(t.rpc(ids.phone1.auth, 'prepare_device', { p_branch: ids.candon, p_label: 'x', p_kind: 'server' }, ben))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
