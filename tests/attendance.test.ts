// Time clock and shift schedule.
import { beforeEach, describe, expect, it } from 'vitest'
import { ids, makeDb, manila, uuid } from './harness'

let t: Awaited<ReturnType<typeof makeDb>>
beforeEach(async () => {
  t = await makeDb()
  await t.db.query('delete from shift_schedules')   // seed has a schedule relative to the real date
  await t.clock(manila('2026-12-05 09:00'))
})
const clock = (token: string, kind: string) =>
  t.rpc(ids.phone1.auth, 'clock_event', { p_client_uuid: uuid(), p_token: token, p_branch: ids.candon, p_kind: kind })

describe('time clock', () => {
  it('records late time-in, breaks and worked hours; live board shows status', async () => {
    const mgr = await t.pin(ids.phone1, ids.manager)
    for (const [u, s, e] of [[ids.server1.id, '14:00', '23:00'], [ids.server2.id, '15:00', '23:00'], [ids.cashier.id, '13:00', '22:00']]) {
      await t.rpc(ids.phone1.auth, 'upsert_shift', { p_token: mgr, p_branch: ids.candon,
        p_row: { user_id: u, starts_at: manila(`2026-12-05 ${s}`), ends_at: manila(`2026-12-05 ${e}`), position: 'Server' } })
    }
    const ben = await t.pin(ids.phone1, ids.server1)
    await t.clock(manila('2026-12-05 14:22'))
    const r = await clock(ben, 'in')
    expect(r.late_minutes).toBe(22)
    await expect(clock(ben, 'in')).rejects.toMatchObject({ code: 'ALREADY_IN' })
    await t.clock(manila('2026-12-05 17:30')); await clock(ben, 'break_start')
    await t.clock(manila('2026-12-05 18:00')); await clock(ben, 'break_end')
    await t.clock(manila('2026-12-05 20:22'))
    const live = await t.rpc(ids.manager.auth, 'get_live_shifts', { p_branch: ids.candon, p_date: '2026-12-05' })
    const b = live.staff.find((s: any) => s.user_id === ids.server1.id)
    expect(b.status).toBe('late')
    expect(Number(b.worked_minutes)).toBe(6 * 60 - 30)
    // Liza scheduled 15:00, never timed in → absent; Carlo too
    expect(live.staff.find((s: any) => s.user_id === ids.server2.id).status).toBe('absent')
    expect(live.counts.working).toBe(1)
    expect(live.counts.absent).toBe(2)
    expect(Number((await t.one<{ n: string }>(`select count(*) n from notifications where kind = 'staff_late'`)).n)).toBe(1)
    // time out from a break closes the break first
    await clock(ben, 'break_start')
    await t.clock(manila('2026-12-05 20:52')); await clock(ben, 'out')
    const me = await t.rpc(ids.phone1.auth, 'get_my_time', { p_token: ben, p_branch: ids.candon })
    expect(me.status).toBe('off')
    expect(me.entries_today.map((e: any) => e.kind)).toEqual(['in', 'break_start', 'break_end', 'break_start', 'break_end', 'out'])
    const rep = await t.rpc(ids.manager.auth, 'report_attendance', { p_branch: ids.candon, p_from: '2026-12-05', p_to: '2026-12-05' })
    const row = rep.find((x: any) => x.staff === 'Ben Ramos')
    expect(Number(row.worked_hours)).toBe(5.5)
    expect(Number(row.scheduled_hours)).toBe(8)
    expect(row.times_late).toBe(1)
  })

  it('only managers edit schedules; overlapping shifts are refused', async () => {
    const ben = await t.pin(ids.phone1, ids.server1)
    const row = { user_id: ids.server1.id, starts_at: manila('2026-12-06 14:00'), ends_at: manila('2026-12-06 23:00') }
    await expect(t.rpc(ids.phone1.auth, 'upsert_shift', { p_token: ben, p_branch: ids.candon, p_row: row })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await t.rpc(ids.manager.auth, 'upsert_shift', { p_branch: ids.candon, p_row: row })
    await expect(t.rpc(ids.manager.auth, 'upsert_shift', { p_branch: ids.candon,
      p_row: { ...row, starts_at: manila('2026-12-06 20:00'), ends_at: manila('2026-12-07 01:00') } })).rejects.toMatchObject({ code: 'OVERLAP' })
  })

  it('a missed time-out is corrected by a manager with a note', async () => {
    const ben = await t.pin(ids.phone1, ids.server1)
    await clock(ben, 'in')
    await expect(t.rpc(ids.manager.auth, 'manager_time_entry', { p_branch: ids.candon, p_user_id: ids.server1.id, p_kind: 'out',
      p_at: manila('2026-12-05 17:00'), p_note: '' })).rejects.toMatchObject({ code: 'REASON_REQUIRED' })
    await t.rpc(ids.manager.auth, 'manager_time_entry', { p_branch: ids.candon, p_user_id: ids.server1.id, p_kind: 'out',
      p_at: manila('2026-12-05 17:00'), p_note: 'Forgot to time out' })
    expect((await t.rpc(ids.phone1.auth, 'get_my_time', { p_token: ben, p_branch: ids.candon })).status).toBe('off')
  })
})
