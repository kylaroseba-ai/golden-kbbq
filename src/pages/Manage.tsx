import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { isManager, useAuth } from '../lib/auth'
import { DevicesAdmin, PeopleAdmin } from './SetupPeople'
import { deviceNow, useRpc } from '../lib/hooks'
import { flushOutbox, localDb, mutate } from '../lib/outbox'
import { dateTime, manilaDate, peso, qty, time } from '../lib/format'
import { Avatar, Button, Card, CardTitle, Empty, ErrorBox, Field, LevelBar, Modal, PageHeader, Pill, Stat, StatusChip, inputCls, useToast } from '../components/ui'

// ───── 8.1 Owner dashboard ─────
export function Dashboard() {
  const auth = useAuth()
  const nav = useNavigate()
  const d = useRpc<any>('get_dashboard', { p_branch: auth.branchId }, { refetchInterval: 30_000 })
  const stock = useRpc<any[]>('get_live_stock', { p_branch: auth.branchId }, { refetchInterval: 30_000 })
  const expiry = useRpc<any[]>('get_near_expiry', { p_branch: auth.branchId })
  const reorders = useRpc<any[]>('list_reorder_lists', { p_branch: auth.branchId })
  const counts = useRpc<any[]>('list_counts', { p_branch: auth.branchId, p_limit: 10 })
  const live = useRpc<any>('get_live_shifts', { p_branch: auth.branchId }, { refetchInterval: 60_000 })
  const today = manilaDate(deviceNow())
  const resv = useRpc<any[]>('get_reservations', { p_branch: auth.branchId, p_from: today, p_to: today }, { refetchInterval: 30_000 })
  const x = d.data
  if (!x) return <ErrorBox error={d.error ?? new Error('Loading…')} />
  const day = x.sales.days[0] ?? { gross: 0, discounts: 0, net: 0 }
  const pax = Object.values(x.sales.pax_by_type).reduce((a: number, n: any) => a + Number(n), 0)
  const hour = Number(new Date(deviceNow().getTime() + 8 * 3600_000).toISOString().slice(11, 13))
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const rv = resv.data ?? []
  const lc = live.data?.counts

  // Needs your attention
  type Item = { tone: 'bad' | 'warn' | 'info'; title: string; body: string; action: string; to: string }
  const items: Item[] = []
  for (const s of (stock.data ?? []).filter((s) => s.status === 'out' && s.stage !== 'supply').slice(0, 2))
    items.push({ tone: 'bad', title: `${s.name} is out`, body: 'No stock left. Prep more or reorder now.', action: 'View stock', to: '/stock' })
  for (const s of (stock.data ?? []).filter((s) => s.status === 'low' && s.stage !== 'supply').slice(0, 3))
    items.push({ tone: 'bad', title: `${s.name} running low`, body: `${qty(s.qty, s)} left · alert level is ${qty(s.reorder_level, s)}.`, action: s.stage === 'prepared' ? 'Prep' : 'Reorder', to: s.stage === 'prepared' ? '/prep' : '/reorder' })
  for (const b of (expiry.data ?? []).slice(0, 2))
    items.push({ tone: 'warn', title: `${b.expired ? 'Expired' : 'Near expiry'}: ${b.name}`, body: `${qty(b.qty_remaining, b)} · ${b.expired ? 'expired' : 'expires'} ${b.expiry_date}. Use first (FIFO).`, action: 'View batch', to: '/stock' })
  for (const c of (counts.data ?? []).filter((c) => c.status === 'submitted').slice(0, 1))
    items.push({ tone: 'warn', title: `${c.count_type[0].toUpperCase()}${c.count_type.slice(1)} count waiting for approval`, body: `${c.flagged} flagged variance(s) · ${peso(c.variance_value)} · ${c.counted_by_name}`, action: 'Review', to: `/counts/${c.id}` })
  for (const r of (reorders.data ?? []).filter((r) => r.status === (auth.role === 'owner' ? 'manager_approved' : 'draft')).slice(0, 1))
    items.push({ tone: 'info', title: 'Reorder list ready for approval', body: `${r.lines} items · ${peso(r.est_total)} estimated`, action: 'Approve', to: '/reorder' })
  const pend = rv.filter((r) => r.status === 'pending')
  if (pend.length) items.push({ tone: 'warn', title: `${pend.length} booking(s) waiting for confirmation`, body: pend.map((r) => `${r.customer_name} · ${r.party_size} pax · ${time(r.reserved_for)}`).join(' · '), action: 'Confirm', to: '/reservations' })
  for (const st of (live.data?.staff ?? []).filter((s: any) => s.status === 'absent' || (s.status === 'late' && !s.late_minutes)).slice(0, 2))
    items.push({ tone: 'warn', title: `${st.full_name} hasn't timed in`, body: `Shift started ${time(st.first_start)}.`, action: 'View shifts', to: '/shifts' })
  const watch = (stock.data ?? []).filter((s) => s.is_watch)

  return (
    <div>
      <PageHeader eyebrow={`${new Date(deviceNow()).toLocaleDateString('en-PH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Manila' })}`}
        title={`${greet}, ${(auth.userName ?? '').split(' ')[0].replace(/\(.*\)/, '')}`} />
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-4">
        <Stat label="Sales today" value={peso(day.net).replace('.00', '')} sub={`Gross ${peso(day.gross)} · Disc ${peso(day.discounts)}`} />
        <Stat label="Guests served" value={pax} sub={`${x.pax_seated_now} seated now`} />
        <Stat label="Reservations" value={rv.filter((r) => !['declined', 'cancelled'].includes(r.status)).length}
          sub={<>{rv.filter((r) => r.status === 'confirmed').length} confirmed · <span className="text-warn">{pend.length} pending</span></>} />
        <Stat label="Food cost today" value={x.food_cost.pct != null ? `${x.food_cost.pct}%` : '—'} sub={`${peso(x.food_cost.theoretical)} theoretical`} />
        <Stat label="Tables active" value={x.tables_active} sub={`${x.sales.refills.plates} refill plates today`} />
        <Stat label="Staff on shift" value={lc ? `${lc.working + lc.on_break} / ${lc.scheduled}` : '—'} sub={lc ? `${lc.on_break} on break · ${lc.late} late` : ''} />
      </div>
      <div className="grid xl:grid-cols-[1.15fr_1fr] gap-4 mb-4">
        <Card>
          <CardTitle right={<Link to="/stock" className="text-sm text-gold-300 hover:underline">Live stock</Link>}>Live stock · core items</CardTitle>
          <table className="w-full text-sm">
            <thead><tr className="text-left"><th className="label pb-2 font-semibold">Item</th><th className="label pb-2 font-semibold w-2/5">Level vs par</th><th className="label pb-2 font-semibold text-right">On hand</th><th className="label pb-2 font-semibold text-right">Status</th></tr></thead>
            <tbody>{watch.map((w) => { const st = displayStatus(w); return (
              <tr key={w.item_id} className="border-t border-charcoal-800"><td className="py-3 pr-2">{w.name}</td><td className="pr-4"><LevelBar value={Number(w.qty)} max={Number(w.par_level)} status={st} /></td>
                <td className="text-right whitespace-nowrap font-medium">{qty(w.qty, w)}</td><td className="text-right pl-2"><StatusChip status={st} /></td></tr>) })}</tbody>
          </table>
        </Card>
        <Card>
          <CardTitle right={<span className="text-xs text-silver">{items.length} item(s)</span>}>Needs your attention</CardTitle>
          {items.length === 0 && <Empty>All clear. Nothing needs you right now.</Empty>}
          <div className="space-y-2">{items.slice(0, 6).map((it, i) => (
            <div key={i} className="flex items-start gap-3 rounded-xl border border-charcoal-700 bg-charcoal-950/40 p-3.5">
              <span className={`mt-1.5 size-2.5 rounded-full shrink-0 ${it.tone === 'bad' ? 'bg-bad' : it.tone === 'warn' ? 'bg-warn' : 'bg-info'}`} />
              <div className="flex-1 min-w-0"><div className="font-semibold text-sm">{it.title}</div><div className="text-xs text-silver mt-0.5">{it.body}</div></div>
              <Button variant={it.action === 'Approve' ? 'gold' : 'dark'} className="!min-h-9 shrink-0" onClick={() => nav(it.to)}>{it.action}</Button>
            </div>))}</div>
        </Card>
      </div>
      <div className="grid md:grid-cols-3 gap-4">
        <Card>
          <CardTitle right={<Link to="/reservations" className="text-sm text-gold-300 hover:underline">All</Link>}>Today's reservations</CardTitle>
          {rv.length === 0 && <p className="text-sm text-silver">No bookings today.</p>}
          {rv.slice(0, 6).map((r) => (
            <div key={r.id} className="flex items-center gap-3 py-2 border-b border-charcoal-800 last:border-0 text-sm">
              <span className="font-display font-bold w-16">{time(r.reserved_for).replace(' PM', '').replace(' AM', '')}</span>
              <span className="flex-1 min-w-0 truncate">{r.customer_name} · {r.party_size} pax</span><Pill tone={r.status}>{r.status.replace('_', ' ')}</Pill>
            </div>))}
        </Card>
        <Card>
          <CardTitle right={<Link to="/shifts" className="text-sm text-gold-300 hover:underline">Live shifts</Link>}>Staff right now</CardTitle>
          {(live.data?.staff ?? []).length === 0 && <p className="text-sm text-silver">No one scheduled today.</p>}
          {(live.data?.staff ?? []).map((s: any) => (
            <div key={s.user_id} className="flex items-center gap-3 py-2 border-b border-charcoal-800 last:border-0 text-sm">
              <Avatar name={s.full_name} className="!size-8" /><span className="flex-1 min-w-0"><span className="block truncate font-medium">{s.full_name}</span><span className="block text-xs text-silver capitalize">{s.shifts[0]?.position ?? s.role}</span></span>
              <Pill tone={s.status}>{({ working: 'Working', on_break: 'On break', late: s.late_minutes ? `Late ${s.late_minutes}m` : 'Not in', absent: 'Absent', done: 'Done', scheduled: `From ${time(s.first_start)}`, off: 'Off' } as Record<string, string>)[s.status]}</Pill>
            </div>))}
        </Card>
        <Card>
          <CardTitle>Payments today</CardTitle>
          {Object.keys(x.sales.payments).length === 0 && <p className="text-sm text-silver">No payments yet.</p>}
          {Object.entries(x.sales.payments).map(([k, v]) => (
            <div key={k} className="flex justify-between py-2 border-b border-charcoal-800 last:border-0 text-sm"><span className="uppercase text-silver">{k}</span><span className="font-semibold">{peso(v as number)}</span></div>))}
          <div className="label mt-5 mb-2">Alerts</div>
          <div className="flex flex-wrap gap-2">
            <Pill tone={x.alerts.out ? 'out' : 'ok'}>{x.alerts.out} out</Pill><Pill tone={x.alerts.low ? 'low' : 'ok'}>{x.alerts.low} low</Pill>
            <Pill tone={x.alerts.near_expiry ? 'expiring' : 'ok'}>{x.alerts.near_expiry} expiring</Pill><Pill tone={x.alerts.large_variances ? 'late' : 'ok'}>{x.alerts.large_variances} variances</Pill>
          </div>
        </Card>
      </div>
    </div>
  )
}

/** ok / near (within 25% above the alert level) / low / out */
export function displayStatus(s: { status: string; qty: number | string; reorder_level: number | string }) {
  if (s.status !== 'ok') return s.status
  return Number(s.qty) <= Number(s.reorder_level) * 1.25 ? 'near' : 'ok'
}

// ───── 8.2 Reports (CSV export) ─────
const REPORTS = [
  ['report_sales_summary', 'Sales summary'], ['report_usage', 'Weekly usage tracker'], ['report_avg_cost', 'Average ingredient cost'],
  ['report_waste', 'Waste summary'], ['report_variance', 'Variance report'], ['report_refills', 'Refill analytics'],
  ['report_attendance', 'Attendance (for payroll)'],
] as const

function toCsv(rows: any[]): string {
  if (!rows.length) return ''
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))]
  const esc = (v: unknown) => { const s = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n')
}

export function Reports() {
  const auth = useAuth()
  const [rep, setRep] = useState<string>('report_sales_summary')
  const [from, setFrom] = useState(manilaDate(new Date(deviceNow().getTime() - 6 * 86400_000)))
  const [to, setTo] = useState(manilaDate(deviceNow()))
  const r = useRpc<any>(rep, { p_branch: auth.branchId, p_from: from, p_to: to })
  const tables: [string, any[]][] = !r.data ? [] : Array.isArray(r.data) ? [['rows', r.data]]
    : Object.entries(r.data).map(([k, v]) => [k, Array.isArray(v) ? v : v && typeof v === 'object' ? Object.entries(v).map(([kk, vv]) => ({ key: kk, value: vv })) : [{ value: v }]])
  const download = (name: string, rows: any[]) => {
    const blob = new Blob([toCsv(rows)], { type: 'text/csv' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${rep}-${name}-${from}-${to}.csv`; a.click()
  }
  return (
    <div>
      <PageHeader title="Reports">
        <select className={`${inputCls} !w-60`} value={rep} onChange={(e) => setRep(e.target.value)}>{REPORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <input type="date" className={`${inputCls} !w-40`} value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" className={`${inputCls} !w-40`} value={to} onChange={(e) => setTo(e.target.value)} />
      </PageHeader>
      <ErrorBox error={r.error} />
      {tables.map(([name, rows]) => (
        <Card key={name} className="mb-4">
          <div className="flex justify-between items-center mb-2"><h3 className="font-bold capitalize">{name.replace(/_/g, ' ')}</h3>
            {rows.length > 0 && <Button variant="ghost" onClick={() => download(name, rows)}>Export CSV</Button>}</div>
          {rows.length === 0 ? <p className="text-silver text-sm">No data.</p> : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead className="text-silver text-left"><tr>{Object.keys(rows[0]).filter((k) => k !== 'trend').map((k) => <th key={k} className="p-1.5 whitespace-nowrap">{k.replace(/_/g, ' ')}</th>)}</tr></thead>
              <tbody>{rows.slice(0, 300).map((row, i) => <tr key={i} className="border-t border-charcoal-800">{Object.entries(row).filter(([k]) => k !== 'trend').map(([k, v]) =>
                <td key={k} className="p-1.5 whitespace-nowrap">{typeof v === 'number' || (typeof v === 'string' && /^-?\d+\.\d+$/.test(v)) ? Number(v).toLocaleString('en-PH', { maximumFractionDigits: 2 }) : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '—')}</td>)}</tr>)}</tbody>
            </table></div>
          )}
        </Card>
      ))}
    </div>
  )
}

// ───── Alerts / notifications ─────
export function AlertsPage() {
  const auth = useAuth()
  const n = useRpc<any[]>('get_notifications', { p_token: auth.token, p_branch: auth.branchId, p_limit: 100 })
  const unread = (n.data ?? []).filter((x) => !x.read).map((x) => x.id)
  return (
    <div>
      <PageHeader title="Alerts">{unread.length > 0 && <Button onClick={() => mutate('mark_notifications_read', { p_token: auth.token, p_ids: unread }).then(() => n.refetch())}>Mark all read</Button>}</PageHeader>
      {(n.data ?? []).length === 0 && <Empty>No alerts.</Empty>}
      {(n.data ?? []).map((x) => (
        <Card key={x.id} className={`mb-2 ${!x.read ? (x.priority === 'high' ? '!border-amber-500' : '!border-gold-600') : 'opacity-70'}`}>
          <div className="flex justify-between gap-2"><strong>{x.title}</strong><span className="text-xs text-silver">{dateTime(x.created_at)}</span></div>
          {x.body && <p className="text-sm text-silver">{x.body}</p>}
        </Card>
      ))}
    </div>
  )
}

// ───── Sync / outbox (§10) ─────
export function SyncPage() {
  const auth = useAuth()
  const items = useLiveQuery(() => localDb.outbox.toArray(), [], [])
  return (
    <div>
      <PageHeader title="Sync"><Button variant="gold" onClick={() => flushOutbox()}>Sync now</Button></PageHeader>
      <p className="text-silver mb-3">Actions saved while offline are posted in order when the device reconnects. Rejected ones are flagged to the manager and kept here.</p>
      {items.length === 0 && <Empty>Everything is synced.</Empty>}
      {items.map((i) => (
        <Card key={i.id} className={`mb-2 ${i.status === 'failed' ? '!border-red-600' : ''}`}>
          <div className="flex justify-between"><strong>{i.label}</strong><span className="text-xs text-silver">{dateTime(i.created_at)}</span></div>
          <div className="text-sm">{i.status === 'failed' ? <span className="text-red-300">Rejected: {i.error}</span> : 'Pending sync'}</div>
          {i.status === 'failed' && isManager(auth.role) && <button className="text-sm underline mt-1" onClick={() => localDb.outbox.delete(i.id!)}>Dismiss (reviewed)</button>}
        </Card>
      ))}
    </div>
  )
}

// ───── Admin: items, menu, tables, staff PINs, devices, settings ─────
export function AdminPage() {
  const auth = useAuth()
  const [tab, setTab] = useState<'people' | 'devices' | 'items' | 'menu' | 'tables' | 'settings'>('people')
  return (
    <div>
      <PageHeader eyebrow="Back office" title="Setup" />
      <div className="flex flex-wrap gap-2 mb-4">
        {(['people', 'devices', 'items', 'menu', 'tables', 'settings'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`min-h-11 px-4 rounded-xl capitalize ${tab === t ? 'bg-gold-400 text-charcoal-950 font-semibold' : 'bg-charcoal-800'}`}>{t}</button>
        ))}
      </div>
      {!auth.can('manager') ? <p>Managers and the owner only.</p> : tab === 'people' ? <PeopleAdmin /> : tab === 'devices' ? <DevicesAdmin />
        : tab === 'items' ? <ItemsAdmin /> : tab === 'menu' ? <MenuAdmin /> : tab === 'tables' ? <TablesAdmin /> : <SettingsAdmin />}
    </div>
  )
}

function useBootAdmin() {
  const auth = useAuth()
  return useRpc<any>('get_bootstrap', { p_branch: auth.branchId })
}

function ItemsAdmin() {
  const auth = useAuth()
  const toast = useToast()
  const boot = useBootAdmin()
  const [edit, setEdit] = useState<any>(null)
  const cats = new Map((boot.data?.categories ?? []).map((c: any) => [c.id, c.name]))
  return (
    <>
      <Button variant="gold" className="mb-3" onClick={() => setEdit({ stage: 'raw', base_unit: 'g', count_unit: 'kg', count_unit_factor: 1000, is_active: true })}>+ Item</Button>
      <div className="overflow-x-auto rounded-2xl border border-charcoal-700"><table className="w-full text-sm">
        <thead className="bg-charcoal-900 text-silver text-left"><tr><th className="p-2">Item</th><th className="p-2">Category</th><th className="p-2">Stage</th><th className="p-2">Unit</th><th className="p-2">Alert / Par</th><th className="p-2">g/plate</th><th className="p-2">Expiry</th><th className="p-2">Active</th></tr></thead>
        <tbody>{(boot.data?.items ?? []).map((i: any) => (
          <tr key={i.id} className="border-t border-charcoal-800 hover:bg-charcoal-900 cursor-pointer" onClick={() => setEdit(i)}>
            <td className="p-2">{i.name}</td><td className="p-2">{String(cats.get(i.category_id) ?? '')}</td><td className="p-2">{i.stage}</td><td className="p-2">{i.count_unit} ({i.count_unit_factor} {i.base_unit})</td>
            <td className="p-2">{qty(i.reorder_level, i)} / {qty(i.par_level, i)}</td><td className="p-2">{i.grams_per_plate ?? ''}</td><td className="p-2">{i.tracks_expiry ? `${i.shelf_life_days ?? '?'}d · warn ${i.near_expiry_days}d` : '—'}</td><td className="p-2">{i.is_active ? '✓' : '✕'}</td>
          </tr>))}</tbody></table></div>
      {edit && <Modal open wide onClose={() => setEdit(null)} title={edit.id ? edit.name : 'New item'}>
        <div className="grid sm:grid-cols-2 gap-x-3">
          <Field label="Name"><input className={inputCls} value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Category"><select className={inputCls} value={edit.category_id ?? ''} onChange={(e) => setEdit({ ...edit, category_id: e.target.value })}>
            <option value="">—</option>{(boot.data?.categories ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Stage"><select className={inputCls} value={edit.stage} onChange={(e) => setEdit({ ...edit, stage: e.target.value })}>{['raw', 'prepared', 'resale', 'supply'].map((s) => <option key={s}>{s}</option>)}</select></Field>
          <Field label="Base unit"><select className={inputCls} value={edit.base_unit} onChange={(e) => setEdit({ ...edit, base_unit: e.target.value })}>{['g', 'ml', 'pc'].map((s) => <option key={s}>{s}</option>)}</select></Field>
          <Field label="Count unit (e.g. kg, pack)"><input className={inputCls} value={edit.count_unit ?? ''} onChange={(e) => setEdit({ ...edit, count_unit: e.target.value })} /></Field>
          <Field label="Base units per count unit"><input className={inputCls} inputMode="decimal" value={edit.count_unit_factor ?? 1} onChange={(e) => setEdit({ ...edit, count_unit_factor: e.target.value })} /></Field>
          <Field label="Reorder / low alert (base units)"><input className={inputCls} inputMode="decimal" value={edit.reorder_level ?? 0} onChange={(e) => setEdit({ ...edit, reorder_level: e.target.value })} /></Field>
          <Field label="Par level (base units)"><input className={inputCls} inputMode="decimal" value={edit.par_level ?? 0} onChange={(e) => setEdit({ ...edit, par_level: e.target.value })} /></Field>
          <Field label="Grams per plate (refill items)"><input className={inputCls} inputMode="decimal" value={edit.grams_per_plate ?? ''} onChange={(e) => setEdit({ ...edit, grams_per_plate: e.target.value || null })} /></Field>
          <Field label="Shelf life (days)"><input className={inputCls} inputMode="numeric" value={edit.shelf_life_days ?? ''} onChange={(e) => setEdit({ ...edit, shelf_life_days: e.target.value || null })} /></Field>
          <Field label="Near-expiry warning (days)"><input className={inputCls} inputMode="numeric" value={edit.near_expiry_days ?? 3} onChange={(e) => setEdit({ ...edit, near_expiry_days: e.target.value })} /></Field>
          <Field label="Default supplier"><select className={inputCls} value={edit.default_supplier_id ?? ''} onChange={(e) => setEdit({ ...edit, default_supplier_id: e.target.value || null })}>
            <option value="">—</option>{(boot.data?.suppliers ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        </div>
        <div className="flex flex-wrap gap-4 mb-4">{[['tracks_expiry', 'Tracks expiry'], ['is_refillable', 'Refill item'], ['is_meat', 'Counts toward meat plate limit'], ['is_watch', 'Owner watch list'], ['is_active', 'Active']].map(([k, l]) => (
          <label key={k} className="flex items-center gap-2"><input type="checkbox" className="size-5" checked={!!edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.checked })} />{l}</label>))}</div>
        <Button variant="gold" className="w-full" onClick={() => mutate('upsert_item', { p_token: auth.token, p_branch: auth.branchId, p_item: edit })
          .then(() => { setEdit(null); boot.refetch(); toast('Saved', 'ok') }).catch((e) => toast(e.message, 'error'))}>Save item</Button>
      </Modal>}
    </>
  )
}

function MenuAdmin() {
  const auth = useAuth()
  const toast = useToast()
  const boot = useBootAdmin()
  return (
    <Card>
      <p className="text-sm text-silver mb-3">Prices are per branch and snapshotted on each order line, so changing a price never changes past sales.</p>
      {(boot.data?.menu_items ?? []).map((m: any) => (
        <div key={m.id} className="grid grid-cols-[1fr_120px_110px_auto] gap-2 items-center py-1.5 border-b border-charcoal-800">
          <span>{m.name} <span className="text-xs text-silver">{m.item_type}</span></span>
          <input className={`${inputCls} !min-h-10`} inputMode="decimal" defaultValue={m.price} onBlur={(e) => Number(e.target.value) !== Number(m.price) &&
            mutate('upsert_menu_item', { p_token: auth.token, p_branch: auth.branchId, p_row: { ...m, price: Number(e.target.value) } }).then(() => { toast('Price updated', 'ok'); boot.refetch() }).catch((x) => toast(x.message, 'error'))} />
          <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={m.is_active} onChange={(e) =>
            mutate('upsert_menu_item', { p_token: auth.token, p_branch: auth.branchId, p_row: { ...m, is_active: e.target.checked } }).then(() => boot.refetch())} /> active</label>
          <span />
        </div>
      ))}
    </Card>
  )
}

function TablesAdmin() {
  const auth = useAuth()
  const toast = useToast()
  const boot = useBootAdmin()
  const [label, setLabel] = useState('')
  return (
    <Card>
      <div className="flex gap-2 mb-3"><input className={inputCls} placeholder="New table label" value={label} onChange={(e) => setLabel(e.target.value)} />
        <Button variant="gold" disabled={!label} onClick={() => mutate('upsert_dining_table', { p_token: auth.token, p_branch: auth.branchId, p_row: { label, seats: 4, sort_order: 100 } })
          .then(() => { setLabel(''); boot.refetch() }).catch((e) => toast(e.message, 'error'))}>Add</Button></div>
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">{(boot.data?.tables ?? []).map((t: any) => (
        <div key={t.id} className="rounded-xl bg-charcoal-800 p-2 text-center"><div className="font-bold">{t.label}</div><div className="text-xs text-silver">{t.seats} seats · {t.zone ?? ''}</div>
          <button className="text-xs text-red-300 underline" onClick={() => mutate('upsert_dining_table', { p_token: auth.token, p_branch: auth.branchId, p_row: { ...t, is_active: false } }).then(() => boot.refetch())}>remove</button></div>))}</div>
    </Card>
  )
}

function SettingsAdmin() {
  const auth = useAuth()
  const toast = useToast()
  const boot = useBootAdmin()
  const [text, setText] = useState<string | null>(null)
  const settings = boot.data?.settings
  if (!settings) return null
  return (
    <Card>
      <p className="text-sm text-silver mb-2">Branch settings (§12.5). Changes apply without a new release. Admin only.</p>
      <textarea className={`${inputCls} font-mono text-xs min-h-96`} value={text ?? JSON.stringify(settings, null, 2)} onChange={(e) => setText(e.target.value)} />
      <Button variant="gold" className="mt-3" onClick={() => {
        try { const v = JSON.parse(text ?? '{}'); mutate('set_branch_settings', { p_token: auth.token, p_branch: auth.branchId, p_settings: v }).then(() => { toast('Settings saved', 'ok'); boot.refetch() }).catch((e) => toast(e.message, 'error')) }
        catch { toast('Not valid JSON', 'error') }
      }}>Save settings</Button>
      <div className="mt-4 text-sm"><h4 className="font-semibold">POS terminals</h4>
        {(boot.data?.terminals ?? []).map((t: any) => <div key={t.id}>{t.terminal_code}: invoice printing {t.invoice_printing_enabled ? 'ON' : 'OFF (manual booklet until BIR approval)'}</div>)}</div>
    </Card>
  )
}

export function NotFound() { return <Empty>Page not found. <Link className="underline" to="/">Home</Link></Empty> }
export { time }
