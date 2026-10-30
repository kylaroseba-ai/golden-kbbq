import { useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { deviceNow, useNow, useRpc } from '../lib/hooks'
import { mutate, uuid } from '../lib/outbox'
import { manilaDate, mmss, time } from '../lib/format'
import { Avatar, Button, Card, CardTitle, Empty, ErrorBox, Field, Modal, PageHeader, Pill, Stat, Tabs, inputCls, useToast } from '../components/ui'

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'Asia/Manila' })
const KIND: Record<string, string> = { in: 'Timed in', break_start: 'Break started', break_end: 'Back from break', out: 'Timed out' }

// ───── Time clock: every staff member times in and out here (after PIN sign-in on a shared device) ─────
export function TimeClock() {
  const auth = useAuth()
  const toast = useToast()
  const now = useNow()
  const me = useRpc<any>('get_my_time', { p_token: auth.token, p_branch: auth.branchId }, { refetchInterval: 30_000, cache: true })
  const [busy, setBusy] = useState(false)
  const d = me.data
  if (!d) return <ErrorBox error={me.error ?? new Error('Loading…')} />
  const first = (d.user?.full_name ?? '').split(' ')[0]
  const since = d.since ? new Date(d.since) : null
  const today = d.schedule.find((s: any) => manilaDate(new Date(s.starts_at)) === d.business_date)
  const lastBreak = [...d.entries_today].reverse().find((e: any) => e.kind === 'break_start')

  const act = async (kind: string, label: string) => {
    setBusy(true)
    try {
      const r = await mutate('clock_event', { p_client_uuid: uuid(), p_token: auth.token, p_branch: auth.branchId, p_kind: kind, p_occurred_at: deviceNow().toISOString() },
        { queueable: true, label, branch_id: auth.branchId! })
      if (r.queued) toast(`${label} saved offline — will sync`, 'info')
      else toast(r.result.late_minutes ? `${label} · ${r.result.late_minutes} min late` : label, r.result.late_minutes ? 'info' : 'ok')
      me.refetch()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
  }

  return (
    <div className="max-w-xl mx-auto">
      <div className="label mb-1">{now.toLocaleDateString('en-PH', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'Asia/Manila' })}</div>
      <h1 className="font-display text-3xl font-bold mb-6">Hi, {first}</h1>
      <Card className="text-center !p-7 mb-4">
        {d.status === 'off' ? (
          <>
            <Pill tone="off">Not timed in</Pill>
            <div className="font-display text-6xl font-bold my-5">{now.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' })}</div>
            <p className="text-silver text-sm mb-5">{today ? `Today's shift ${time(today.starts_at)} – ${time(today.ends_at)} · ${today.position ?? ''}` : 'No shift scheduled today.'}</p>
            <Button variant="gold" big className="w-full text-lg" disabled={busy} onClick={() => act('in', 'Timed in')}>Time in</Button>
          </>
        ) : (
          <>
            <Pill tone={d.status === 'on_break' ? 'on_break' : 'working'}>{d.status === 'on_break' ? `On break · since ${time(lastBreak?.occurred_at)}` : `Timed in · ${time(d.since)}`}</Pill>
            <div className="font-display text-6xl font-bold my-5 tabular-nums">{since ? mmss(now.getTime() - since.getTime()) : '—'}</div>
            <p className="text-silver text-sm mb-5">{today ? `Shift ${time(today.starts_at)} – ${time(today.ends_at)} · ` : ''}{Math.floor(d.worked_minutes_today / 60)} h {d.worked_minutes_today % 60} min worked today</p>
            <div className="grid grid-cols-2 gap-3">
              {d.status === 'on_break'
                ? <Button big className="!bg-info-bg !text-info !border-info/30" disabled={busy} onClick={() => act('break_end', 'Back from break')}>End break</Button>
                : <Button big className="!bg-info-bg !text-info !border-info/30" disabled={busy} onClick={() => act('break_start', 'Break started')}>Start break</Button>}
              <Button variant="gold" big disabled={busy} onClick={() => { if (confirm('Time out now?')) act('out', 'Timed out') }}>Time out</Button>
            </div>
          </>
        )}
      </Card>
      {d.entries_today.length > 0 && (
        <Card className="mb-4">
          <CardTitle>Today</CardTitle>
          {d.entries_today.map((e: any, i: number) => (
            <div key={i} className="flex justify-between py-2 border-b border-charcoal-800 last:border-0 text-sm">
              <span>{KIND[e.kind]}{e.late_minutes ? <span className="text-warn"> · {e.late_minutes} min late</span> : ''}</span><span className="text-silver">{time(e.occurred_at)}</span>
            </div>
          ))}
        </Card>
      )}
      <Card>
        <CardTitle right={<span className="text-xs text-silver">Next 7 days</span>}>My schedule</CardTitle>
        {d.schedule.length === 0 && <p className="text-sm text-silver">No shifts scheduled. Ask your manager.</p>}
        {d.schedule.map((s: any) => (
          <div key={s.id} className="flex flex-wrap items-baseline gap-x-4 py-2.5 border-b border-charcoal-800 last:border-0 text-sm">
            <span className="font-semibold w-24">{dayLabel(s.starts_at)}</span><span className="flex-1 whitespace-nowrap">{time(s.starts_at)} – {time(s.ends_at)}</span>
            <span className="text-silver text-xs">{s.position ?? ''} · break {s.break_minutes} min</span>
          </div>
        ))}
      </Card>
    </div>
  )
}

// ───── Staff & live shifts (manager / owner) ─────
export function ShiftsPage() {
  const [tab, setTab] = useState<'live' | 'schedule'>('live')
  return (
    <div>
      <PageHeader eyebrow="Team" title="Staff & live shifts"><Tabs value={tab} onChange={setTab} items={[['live', 'Live today'], ['schedule', 'Weekly schedule']]} /></PageHeader>
      {tab === 'live' ? <LiveShifts /> : <WeeklySchedule />}
    </div>
  )
}

const STATUS_LABEL: Record<string, string> = { working: 'Working', on_break: 'On break', late: 'Late', absent: 'Absent', done: 'Timed out', scheduled: 'Scheduled', off: 'Off' }

function LiveShifts() {
  const auth = useAuth()
  const toast = useToast()
  const now = useNow(30_000)
  const live = useRpc<any>('get_live_shifts', { p_branch: auth.branchId }, { refetchInterval: 30_000 })
  const [fix, setFix] = useState<any>(null)
  const d = live.data
  // timeline from 9 AM (or the earliest shift) to 11 PM (or the latest)
  const range = useMemo(() => {
    if (!d) return null
    const day = d.business_date
    let from = new Date(`${day}T09:00:00+08:00`).getTime(), to = new Date(`${day}T23:00:00+08:00`).getTime()
    for (const s of d.staff) for (const sh of s.shifts) { from = Math.min(from, new Date(sh.starts_at).getTime()); to = Math.max(to, new Date(sh.ends_at).getTime()) }
    return { from, to }
  }, [d])
  if (!d || !range) return <ErrorBox error={live.error ?? new Error('Loading…')} />
  const pct = (t: number) => Math.max(0, Math.min(100, ((t - range.from) / (range.to - range.from)) * 100))
  const hours: number[] = []
  for (let t = Math.ceil(range.from / 7200_000) * 7200_000; t <= range.to; t += 7200_000) hours.push(t)
  const nowT = now && deviceNow().getTime()   // re-read the corrected clock on every render (useNow only triggers it)
  const nowPct = pct(nowT)

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
        <Stat label="Scheduled today" value={d.counts.scheduled} />
        <Stat label="Working now" value={d.counts.working} tone="ok" />
        <Stat label="On break" value={d.counts.on_break} tone="info" />
        <Stat label="Late today" value={d.counts.late} tone="warn" />
        <Stat label="Absent" value={d.counts.absent} tone="bad" />
      </div>
      <Card>
        <CardTitle right={<div className="flex flex-wrap gap-3 text-xs text-silver">
          <span><i className="inline-block size-2.5 rounded-sm bg-gold-400 mr-1" />Worked</span><span><i className="inline-block size-2.5 rounded-sm bg-gold-700 mr-1" />Scheduled</span>
          <span><i className="inline-block size-2.5 rounded-sm bg-info mr-1" />Break</span><span><i className="inline-block size-2.5 rounded-sm bg-warn mr-1" />Late</span></div>}>Live shift schedule</CardTitle>
        {d.staff.length === 0 && <Empty>No one is scheduled today. Add shifts in the weekly schedule.</Empty>}
        <div className="overflow-x-auto">
          <div className="min-w-[720px]">
            <div className="grid grid-cols-[180px_1fr] text-[11px] text-silver mb-2">
              <span />
              <div className="relative h-4">{hours.map((h) => <span key={h} className="absolute -translate-x-1/2" style={{ left: `${pct(h)}%` }}>{new Date(h).toLocaleTimeString('en-PH', { hour: 'numeric', timeZone: 'Asia/Manila' })}</span>)}</div>
            </div>
            {d.staff.map((s: any) => {
              // worked / break segments from the entries
              const segs: { a: number; b: number; kind: 'work' | 'break' }[] = []
              let cur: { t: number; kind: 'work' | 'break' } | null = null
              for (const e of s.entries) {
                const t = new Date(e.occurred_at).getTime()
                if (cur) segs.push({ a: cur.t, b: t, kind: cur.kind })
                cur = e.kind === 'in' || e.kind === 'break_end' ? { t, kind: 'work' } : e.kind === 'break_start' ? { t, kind: 'break' } : null
              }
              if (cur) segs.push({ a: cur.t, b: nowT, kind: cur.kind })
              const firstIn = s.entries.find((e: any) => e.kind === 'in')
              return (
                <div key={s.user_id} className="grid grid-cols-[180px_1fr] items-center py-2 border-t border-charcoal-800">
                  <button className="text-left pr-3" onClick={() => setFix(s)}>
                    <div className="font-semibold text-sm">{s.full_name}</div>
                    <div className="text-xs"><span className="text-silver capitalize">{s.shifts[0]?.position ?? s.role}</span>
                      {s.status !== 'working' && s.status !== 'scheduled' && <span className={s.status === 'absent' ? 'text-bad' : s.status === 'late' ? 'text-warn' : s.status === 'on_break' ? 'text-info' : 'text-silver'}> · {STATUS_LABEL[s.status]}{s.late_minutes ? ` ${s.late_minutes} min` : ''}</span>}</div>
                  </button>
                  <div className={`relative h-7 rounded-lg ${s.status === 'absent' ? 'bg-bad-bg/40 border border-dashed border-bad/40' : 'bg-charcoal-800'}`}>
                    {s.shifts.map((sh: any) => <div key={sh.id} className="absolute inset-y-1 rounded-md bg-gold-700/70" style={{ left: `${pct(+new Date(sh.starts_at))}%`, width: `${pct(+new Date(sh.ends_at)) - pct(+new Date(sh.starts_at))}%` }} />)}
                    {firstIn?.late_minutes > 0 && s.shifts[0] && <div className="absolute inset-y-1 rounded-md bg-warn" style={{ left: `${pct(+new Date(s.shifts[0].starts_at))}%`, width: `${pct(+new Date(firstIn.occurred_at)) - pct(+new Date(s.shifts[0].starts_at))}%` }} />}
                    {segs.map((g, i) => <div key={i} className={`absolute inset-y-1 rounded-md ${g.kind === 'work' ? 'bg-gold-400' : 'bg-info'}`} style={{ left: `${pct(g.a)}%`, width: `${Math.max(0.4, pct(g.b) - pct(g.a))}%` }} />)}
                    {nowPct > 0 && nowPct < 100 && <div className="absolute -inset-y-1 w-0.5 bg-[#f3ecdd]" style={{ left: `${nowPct}%` }} />}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        <p className="text-xs text-silver mt-3">Tap a name to add a missed time-in or time-out (saved with your name and a note).</p>
      </Card>
      {fix && <FixEntry staff={fix} onClose={() => { setFix(null); live.refetch() }} onError={(m) => toast(m, 'error')} />}
    </>
  )
}

function FixEntry({ staff, onClose, onError }: { staff: any; onClose: () => void; onError: (m: string) => void }) {
  const auth = useAuth()
  const [kind, setKind] = useState('out')
  const [at, setAt] = useState(new Date(deviceNow().getTime() + 8 * 3600_000).toISOString().slice(0, 16))
  const [note, setNote] = useState('')
  return (
    <Modal open onClose={onClose} title={`Correct time · ${staff.full_name}`}>
      {staff.entries.length > 0 && <div className="mb-4 text-sm text-silver">{staff.entries.map((e: any) => `${KIND[e.kind]} ${time(e.occurred_at)}`).join(' · ')}</div>}
      <Field label="Entry"><select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      <Field label="Time"><input type="datetime-local" className={inputCls} value={at} onChange={(e) => setAt(e.target.value)} /></Field>
      <Field label="Note (required)"><input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. forgot to time out" /></Field>
      <Button variant="gold" className="w-full" disabled={!note} onClick={() => mutate('manager_time_entry', { p_token: auth.token, p_branch: auth.branchId, p_user_id: staff.user_id,
        p_kind: kind, p_at: new Date(`${at}:00+08:00`).toISOString(), p_note: note }).then(onClose).catch((e) => onError(e.message))}>Save correction</Button>
    </Modal>
  )
}

function WeeklySchedule() {
  const auth = useAuth()
  const toast = useToast()
  const [start, setStart] = useState(() => {
    const d = new Date(deviceNow().getTime() + 8 * 3600_000); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10)
  })
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(`${start}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10) })
  const staff = useRpc<any[]>('get_branch_staff', { p_branch: auth.branchId })
  const sched = useRpc<any[]>('get_schedule', { p_branch: auth.branchId, p_from: days[0], p_to: days[6] })
  const [edit, setEdit] = useState<any>(null)
  const shift = (n: number) => { const d = new Date(`${start}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); setStart(d.toISOString().slice(0, 10)) }
  return (
    <Card>
      <CardTitle right={<div className="flex gap-2"><Button onClick={() => shift(-7)}>← Prev</Button><Button onClick={() => shift(7)}>Next →</Button></div>}>
        Week of {dayLabel(`${days[0]}T12:00:00+08:00`)}
      </CardTitle>
      <ErrorBox error={staff.error ?? sched.error} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm border-separate border-spacing-1">
          <thead><tr><th className="text-left label p-2">Staff</th>{days.map((d) => <th key={d} className="label p-2 text-left">{dayLabel(`${d}T12:00:00+08:00`)}</th>)}</tr></thead>
          <tbody>{(staff.data ?? []).map((p) => (
            <tr key={p.id}>
              <td className="p-2"><div className="flex items-center gap-2"><Avatar name={p.full_name} className="!size-8" /><div><div className="font-semibold">{p.full_name}</div><div className="text-xs text-silver capitalize">{p.role}</div></div></div></td>
              {days.map((d) => {
                const list = (sched.data ?? []).filter((s) => s.user_id === p.id && s.business_date === d)
                return (
                  <td key={d} className="align-top">
                    {list.map((s) => (
                      <button key={s.id} onClick={() => setEdit({ ...s, date: d, start: time(s.starts_at), startT: toHHMM(s.starts_at), endT: toHHMM(s.ends_at) })}
                        className="w-full mb-1 rounded-lg bg-gold-700/40 border border-gold-600/40 px-2 py-1.5 text-left hover:border-gold-400">
                        <div className="font-semibold text-gold-200 text-xs">{time(s.starts_at)} – {time(s.ends_at)}</div><div className="text-[11px] text-silver">{s.position ?? ''}</div>
                      </button>
                    ))}
                    <button onClick={() => setEdit({ user_id: p.id, date: d, startT: '15:00', endT: '23:00', break_minutes: 60, position: p.role === 'kitchen' ? 'Grill / kitchen' : p.role[0].toUpperCase() + p.role.slice(1) })}
                      className="w-full rounded-lg border border-dashed border-charcoal-700 text-silver/60 hover:text-gold-300 hover:border-gold-600 text-xs py-1.5">+</button>
                  </td>
                )
              })}
            </tr>
          ))}</tbody>
        </table>
      </div>
      {edit && <Modal open onClose={() => setEdit(null)} title={edit.id ? 'Edit shift' : 'Add shift'}>
        <Field label="Staff"><select className={inputCls} value={edit.user_id} onChange={(e) => setEdit({ ...edit, user_id: e.target.value })}>{(staff.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Date"><input type="date" className={inputCls} value={edit.date} onChange={(e) => setEdit({ ...edit, date: e.target.value })} /></Field>
          <Field label="Start"><input type="time" className={inputCls} value={edit.startT} onChange={(e) => setEdit({ ...edit, startT: e.target.value })} /></Field>
          <Field label="End"><input type="time" className={inputCls} value={edit.endT} onChange={(e) => setEdit({ ...edit, endT: e.target.value })} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Position"><input className={inputCls} value={edit.position ?? ''} onChange={(e) => setEdit({ ...edit, position: e.target.value })} /></Field>
          <Field label="Break (minutes)"><input type="number" className={inputCls} value={edit.break_minutes ?? 60} onChange={(e) => setEdit({ ...edit, break_minutes: Number(e.target.value) })} /></Field>
        </div>
        <div className="flex gap-2">
          <Button variant="gold" className="flex-1" onClick={() => {
            const startsAt = new Date(`${edit.date}T${edit.startT}:00+08:00`)
            const endsAt = new Date(`${edit.date}T${edit.endT}:00+08:00`)
            if (endsAt <= startsAt) endsAt.setUTCDate(endsAt.getUTCDate() + 1)   // ends after midnight
            mutate('upsert_shift', { p_token: auth.token, p_branch: auth.branchId, p_row: { id: edit.id, user_id: edit.user_id, starts_at: startsAt.toISOString(),
              ends_at: endsAt.toISOString(), break_minutes: edit.break_minutes, position: edit.position } })
              .then(() => { setEdit(null); sched.refetch() }).catch((e) => toast(e.message, 'error'))
          }}>Save shift</Button>
          {edit.id && <Button variant="danger" onClick={() => mutate('delete_shift', { p_token: auth.token, p_shift_id: edit.id }).then(() => { setEdit(null); sched.refetch() }).catch((e) => toast(e.message, 'error'))}>Delete</Button>}
        </div>
      </Modal>}
    </Card>
  )
}

const toHHMM = (iso: string) => new Date(new Date(iso).getTime() + 8 * 3600_000).toISOString().slice(11, 16)
