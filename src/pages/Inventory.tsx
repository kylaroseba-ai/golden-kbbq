import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { isManager, useAuth } from '../lib/auth'
import { deviceNow, useRpc, useWakeLock } from '../lib/hooks'
import { cacheGet, cacheSet, mutate, uuid } from '../lib/outbox'
import { dateTime, peso, qty } from '../lib/format'
import { Button, Card, CardTitle, Empty, ErrorBox, Field, LevelBar, Modal, PageHeader, StatusChip, inputCls, useToast } from '../components/ui'
import { displayStatus } from './Manage'

const useBoot = () => {
  const auth = useAuth()
  return useRpc<any>('get_bootstrap', { p_branch: auth.branchId }, { cache: true, staleTime: 60_000 })
}

// ───── 5.4 Live stock + 5.6 expiry / FIFO ─────
export function StockPage() {
  const auth = useAuth()
  const toast = useToast()
  const boot = useBoot()
  const stock = useRpc<any[]>('get_live_stock', { p_branch: auth.branchId }, { cache: true, refetchInterval: 15_000 })
  const expiry = useRpc<any[]>('get_near_expiry', { p_branch: auth.branchId }, { cache: true })
  const [cat, setCat] = useState('')
  const [search, setSearch] = useState('')
  const [fifo, setFifo] = useState<any>(null)
  const refillOnly = auth.role === 'server'
  const rows = (stock.data ?? []).filter((r) => (!cat || r.category_id === cat) && r.name.toLowerCase().includes(search.toLowerCase()) && (!refillOnly || r.is_refillable))
  return (
    <div>
      <PageHeader eyebrow="Inventory" title="Live stock">
        <input className={`${inputCls} !w-48`} placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className={`${inputCls} !w-52`} value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">All categories</option>
          {(boot.data?.categories ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </PageHeader>
      {(expiry.data ?? []).length > 0 && (
        <Card className="mb-4">
          <CardTitle right={<span className="text-xs text-silver">Tracked by batch</span>}>Near expiry · use first (FIFO)</CardTitle>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {expiry.data!.map((b) => (
              <div key={b.batch_id} className="flex items-center justify-between gap-2 rounded-xl bg-charcoal-800 border border-charcoal-700 px-3.5 py-2.5">
                <div><div className="font-semibold">{b.name}</div>
                  <div className="text-xs text-silver">{qty(b.qty_remaining, b)} · {b.expired ? 'expired' : b.days_left === 0 ? 'expires today' : `${b.days_left} day(s) left`} ({b.expiry_date})</div></div>
                {b.expired ? <Button variant="danger" onClick={() => mutate('waste_expired_batch', { p_client_uuid: uuid(), p_token: auth.token, p_batch_id: b.batch_id })
                  .then(() => { toast('Logged as expired waste', 'ok'); expiry.refetch() }).catch((e) => toast(e.message, 'error'))}>Log waste</Button>
                  : <StatusChip status="expiring" />}
              </div>
            ))}
          </div>
        </Card>
      )}
      <ErrorBox error={stock.error} />
      <Card className="!p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left border-b border-charcoal-700">
              <th className="label font-semibold px-5 py-3">Item</th><th className="label font-semibold py-3 w-1/4 hidden sm:table-cell">Level vs par</th>
              <th className="label font-semibold py-3 px-3 text-right">On hand</th><th className="label font-semibold py-3 px-3">Status</th>
              <th className="label font-semibold py-3 px-3 hidden md:table-cell">Alert / Par</th><th className="label font-semibold py-3 pr-5 hidden lg:table-cell">Last movement</th></tr></thead>
            <tbody>
              {rows.map((r) => { const st = displayStatus(r); return (
                <tr key={r.item_id} className="border-t border-charcoal-800 hover:bg-charcoal-800/60 cursor-pointer" onClick={() => setFifo(r)}>
                  <td className="px-5 py-3 font-medium">{r.name}{r.grams_per_plate ? <span className="block text-xs text-silver font-normal">≈{Math.max(0, Math.floor(Number(r.qty) / Number(r.grams_per_plate)))} plates</span> : ''}</td>
                  <td className="py-3 pr-4 hidden sm:table-cell"><LevelBar value={Number(r.qty)} max={Number(r.par_level)} status={st} /></td>
                  <td className={`py-3 px-3 text-right whitespace-nowrap font-semibold ${Number(r.qty) < 0 ? 'text-bad' : ''}`}>{qty(r.qty, r)}</td>
                  <td className="py-3 px-3"><div className="flex flex-wrap gap-1"><StatusChip status={st} />{r.expired ? <StatusChip status="expired" /> : r.near_expiry ? <StatusChip status="expiring" /> : null}</div></td>
                  <td className="py-3 px-3 hidden md:table-cell text-silver whitespace-nowrap">{qty(r.reorder_level, r)} / {qty(r.par_level, r)}</td>
                  <td className="py-3 pr-5 hidden lg:table-cell text-silver whitespace-nowrap">{dateTime(r.last_movement_at)}</td>
                </tr>) })}
            </tbody>
          </table>
        </div>
      </Card>
      {fifo && <FifoDialog item={fifo} onClose={() => setFifo(null)} />}
    </div>
  )
}

function FifoDialog({ item, onClose }: { item: any; onClose: () => void }) {
  const auth = useAuth()
  const b = useRpc<any[]>('get_batches', { p_branch: auth.branchId, p_item_id: item.item_id })
  return (
    <Modal open onClose={onClose} title={`${item.name} — batches (oldest first)`}>
      <p className="text-silver text-sm mb-3">Average cost {peso(Number(item.avg_unit_cost) * Number(item.count_unit_factor))}/{item.count_unit}</p>
      {(b.data ?? []).length === 0 && <Empty>No batches with stock.</Empty>}
      {(b.data ?? []).map((x) => (
        <div key={x.id} className="flex justify-between border-b border-charcoal-700 py-2 text-sm">
          <span>{dateTime(x.received_at)} · {x.source_type}</span>
          <span>{qty(x.qty_remaining, item)} left{x.expiry_date ? ` · exp ${x.expiry_date}` : ''}</span>
        </div>
      ))}
    </Modal>
  )
}

// ───── 5.2 Deliveries ─────
export function DeliveryPage() {
  const auth = useAuth()
  const toast = useToast()
  const boot = useBoot()
  const items: any[] = (boot.data?.items ?? []).filter((i: any) => i.is_active)
  const suppliers: any[] = boot.data?.suppliers ?? []
  const [supplier, setSupplier] = useState('')
  const [ref, setRef] = useState('')
  const [payment, setPayment] = useState('cash')
  const [lines, setLines] = useState<{ item_id: string; qty: string; unit_price: string; expiry_date: string }[]>([{ item_id: '', qty: '', unit_price: '', expiry_date: '' }])
  const [err, setErr] = useState<unknown>(null)
  const total = lines.reduce((a, l) => a + Number(l.qty || 0) * Number(l.unit_price || 0), 0)
  const submit = async () => {
    setErr(null)
    try {
      const r = await mutate('receive_delivery', { p_client_uuid: uuid(), p_token: auth.token, p_branch: auth.branchId, p_delivery: {
        supplier_id: supplier || null, reference_no: ref, payment_method: payment, occurred_at: deviceNow().toISOString(),
        lines: lines.filter((l) => l.item_id && Number(l.qty) > 0).map((l) => ({ item_id: l.item_id, qty: Number(l.qty), unit_price: Number(l.unit_price), expiry_date: l.expiry_date || null })) } },
        { queueable: true, label: 'Delivery', branch_id: auth.branchId! })
      toast(r.queued ? 'Delivery saved offline — pending sync' : `Delivery saved · ${peso(r.result.total)}`, 'ok')
      setLines([{ item_id: '', qty: '', unit_price: '', expiry_date: '' }]); setRef('')
    } catch (e) { setErr(e) }
  }
  return (
    <div>
      <PageHeader eyebrow="Inventory" title="Receive delivery" />
      <Card>
        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="Supplier"><select className={inputCls} value={supplier} onChange={(e) => setSupplier(e.target.value)}>
            <option value="">—</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="Reference / invoice no."><input className={inputCls} value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
          <Field label="Payment"><select className={inputCls} value={payment} onChange={(e) => setPayment(e.target.value)}>
            {['cash', 'gcash', 'bank', 'terms'].map((m) => <option key={m}>{m}</option>)}</select></Field>
        </div>
        {lines.map((l, i) => {
          const it = items.find((x) => x.id === l.item_id)
          return (
            <div key={i} className="grid grid-cols-2 sm:grid-cols-[2fr_1fr_1fr_1fr_auto] gap-2 mb-2 items-end">
              <select className={`${inputCls} col-span-2 sm:col-span-1`} value={l.item_id} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, item_id: e.target.value } : x))}>
                <option value="">Item…</option>{items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
              <input className={inputCls} inputMode="decimal" placeholder={`Qty (${it?.count_unit ?? 'unit'})`} value={l.qty} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} />
              <input className={inputCls} inputMode="decimal" placeholder={`₱ per ${it?.count_unit ?? 'unit'}`} value={l.unit_price} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, unit_price: e.target.value } : x))} />
              <input className={inputCls} type="date" title={it?.tracks_expiry ? 'Expiry date (required)' : 'Expiry date'} required={it?.tracks_expiry}
                value={l.expiry_date} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, expiry_date: e.target.value } : x))} />
              <button className="min-h-12 px-3 text-red-300" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>
            </div>
          )
        })}
        <div className="flex flex-wrap items-center gap-3 mt-3">
          <Button variant="ghost" onClick={() => setLines([...lines, { item_id: '', qty: '', unit_price: '', expiry_date: '' }])}>+ Line</Button>
          <span className="ml-auto text-lg">Total <strong>{peso(total)}</strong></span>
          <Button variant="gold" onClick={submit}>Save delivery</Button>
        </div>
        <ErrorBox error={err} />
      </Card>
    </div>
  )
}

// ───── 5.3 Production / prep ─────
export function PrepPage() {
  const auth = useAuth()
  const toast = useToast()
  const boot = useBoot()
  const items = new Map<string, any>((boot.data?.items ?? []).map((i: any) => [i.id, i]))
  const recipes: any[] = boot.data?.prep_recipes ?? []
  const [recipe, setRecipe] = useState<any>(null)
  const [output, setOutput] = useState('')
  const outItem = recipe ? items.get(recipe.output_item_id) : null
  const factor = outItem ? Number(outItem.count_unit_factor) : 1
  const scale = recipe && output ? (Number(output) * factor) / Number(recipe.standard_output_qty) : 0
  return (
    <div>
      <PageHeader eyebrow="Inventory" title="Prep & production" />
      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <h3 className="font-bold mb-3">Recipe</h3>
          <div className="grid sm:grid-cols-2 gap-2">
            {recipes.map((r) => (
              <button key={r.id} onClick={() => { setRecipe(r); setOutput(String(Number(r.standard_output_qty) / Number(items.get(r.output_item_id)?.count_unit_factor ?? 1))) }}
                className={`rounded-xl border p-3 text-left transition ${recipe?.id === r.id ? 'border-gold-400 bg-gold-400/10' : 'border-charcoal-700 bg-charcoal-800 hover:border-charcoal-600'}`}>
                <div className="font-semibold">{items.get(r.output_item_id)?.name}</div><div className="text-xs text-silver">{r.notes}</div>
              </button>
            ))}
          </div>
        </Card>
        {recipe && <Card>
          <h3 className="font-bold mb-3">{outItem?.name}</h3>
          <Field label={`Actual output weight (${outItem?.count_unit})`} hint="Weigh marinated meats with sauce."><input className={inputCls} inputMode="decimal" value={output} onChange={(e) => setOutput(e.target.value)} /></Field>
          <p className="text-sm text-silver mb-2">Inputs deducted (scaled to actual output):</p>
          {recipe.inputs.map((x: any) => {
            const it = items.get(x.item_id)
            return <div key={x.item_id} className="flex justify-between py-1 border-b border-charcoal-700"><span>{it?.name}</span><span>{qty(Number(x.qty) * scale, it)}</span></div>
          })}
          <Button variant="gold" className="w-full mt-4" disabled={!Number(output)} onClick={() =>
            mutate('run_production', { p_client_uuid: uuid(), p_token: auth.token, p_branch: auth.branchId, p_recipe_id: recipe.id,
              p_output_qty: Number(output) * factor, p_occurred_at: deviceNow().toISOString() }, { queueable: true, label: 'Prep run', branch_id: auth.branchId! })
              .then((r) => toast(r.queued ? 'Prep saved offline' : `Prep logged · cost ${peso(r.result.unit_cost * factor)}/${outItem?.count_unit}`, 'ok'))
              .catch((e) => toast(e.message, 'error'))}>Log prep run</Button>
        </Card>}
      </div>
    </div>
  )
}

// ───── 5.7 Waste ─────
const REASONS = [['spoilage', 'Spoilage'], ['expired', 'Expired'], ['over_portioning', 'Over-portioning'], ['plate_waste', 'Plate waste'], ['dropped_damaged', 'Dropped / damaged'], ['other', 'Other (add note)']]
export function WastePage() {
  const auth = useAuth()
  const toast = useToast()
  const boot = useBoot()
  const items: any[] = (boot.data?.items ?? []).filter((i: any) => i.is_active)
  const [item, setItem] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('spoilage')
  const [note, setNote] = useState('')
  const it = items.find((x) => x.id === item)
  return (
    <div>
      <PageHeader eyebrow="Inventory" title="Waste log" />
      <Card className="max-w-xl">
        <Field label="Item"><select className={inputCls} value={item} onChange={(e) => setItem(e.target.value)}><option value="">—</option>{items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        <Field label={`Quantity (${it?.count_unit ?? ''})`}><input className={inputCls} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Reason"><div className="grid grid-cols-2 gap-2">{REASONS.map(([v, l]) => (
          <button key={v} onClick={() => setReason(v)} className={`min-h-12 rounded-xl border text-sm ${reason === v ? 'border-gold-400 bg-gold-400/10 text-gold-200' : 'border-charcoal-700 bg-charcoal-800'}`}>{l}</button>))}</div></Field>
        <Field label="Note"><input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <Button variant="gold" className="w-full" disabled={!item || !Number(amount)} onClick={() =>
          mutate('log_waste', { p_client_uuid: uuid(), p_token: auth.token, p_branch: auth.branchId, p_item_id: item, p_qty: Number(amount) * Number(it.count_unit_factor),
            p_reason: reason, p_note: note || null, p_occurred_at: deviceNow().toISOString() }, { queueable: true, label: 'Waste', branch_id: auth.branchId! })
            .then((r) => { toast(r.queued ? 'Saved offline' : `Waste logged · ${peso(r.result.value)}`, 'ok'); setAmount(''); setNote('') })
            .catch((e) => toast(e.message, 'error'))}>Log waste</Button>
      </Card>
    </div>
  )
}

// ───── 5.8 Counts ─────
export function CountsPage() {
  const auth = useAuth()
  const nav = useNavigate()
  const list = useRpc<any[]>('list_counts', { p_branch: auth.branchId })
  return (
    <div>
      <PageHeader eyebrow="Inventory" title="Stock counts">
        <Button variant="gold" onClick={() => nav('/counts/new/opening')}>Opening count</Button>
        <Button variant="gold" onClick={() => nav('/counts/new/closing')}>Closing count</Button>
        <Button onClick={() => nav('/counts/new/spot')}>Spot count</Button>
      </PageHeader>
      <Card>
        {(list.data ?? []).length === 0 && <Empty>No counts yet.</Empty>}
        {(list.data ?? []).map((c) => (
          <Link key={c.id} to={`/counts/${c.id}`} className="flex flex-wrap justify-between gap-2 border-b border-charcoal-700 py-3 hover:bg-charcoal-800 px-2 rounded">
            <span><strong className="capitalize">{c.count_type}</strong> · {c.business_date} · {c.counted_by_name}</span>
            <span>{c.flagged > 0 && <span className="text-amber-300 mr-3">{c.flagged} flagged</span>}{peso(c.variance_value)} · <span className="capitalize">{c.status}</span></span>
          </Link>
        ))}
      </Card>
    </div>
  )
}

export function CountSheet() {
  const { type } = useParams()
  const auth = useAuth()
  const toast = useToast()
  const nav = useNavigate()
  useWakeLock()
  const boot = useBoot()
  const stock = useRpc<any[]>('get_live_stock', { p_branch: auth.branchId }, { cache: true })
  const list = useRpc<any[]>('list_counts', { p_branch: auth.branchId })
  const lastClosing = (list.data ?? []).find((c) => c.count_type === 'closing')
  const prev = useRpc<any>('get_count', { p_count_id: lastClosing?.id }, { enabled: type === 'opening' && !!lastClosing })
  const draftKey = `count-draft-${auth.branchId}-${type}`
  const [values, setValues] = useState<Record<string, string>>({})
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [err, setErr] = useState<unknown>(null)
  useEffect(() => { cacheGet<any>(draftKey).then((d) => { if (d) { setValues(d.values ?? {}); setReasons(d.reasons ?? {}) } }) }, [draftKey])
  const cats: any[] = boot.data?.categories ?? []
  const items: any[] = (boot.data?.items ?? []).filter((i: any) => i.is_active)
  const expected = new Map((stock.data ?? []).map((s) => [s.item_id, Number(s.qty)]))
  const prevCounted = new Map<string, number>((prev.data?.lines ?? []).map((l: any) => [l.item_id, Number(l.counted_qty)]))
  const saveDraft = (v = values, r = reasons) => cacheSet(draftKey, { values: v, reasons: r })

  const submit = async () => {
    setErr(null)
    const lines = items.filter((i) => values[i.id] !== undefined && values[i.id] !== '')
      .map((i) => ({ item_id: i.id, counted: Number(values[i.id]), reason: reasons[i.id] || null }))
    try {
      const r = await mutate('submit_count', { p_client_uuid: uuid(), p_token: auth.token, p_branch: auth.branchId, p_count_type: type, p_lines: lines,
        p_occurred_at: deviceNow().toISOString() }, { queueable: true, label: `${type} count`, branch_id: auth.branchId! })
      await cacheSet(draftKey, null)
      toast(r.queued ? 'Count saved offline — will submit when online' : 'Count submitted for approval', 'ok')
      nav(r.queued ? '/counts' : `/counts/${r.result.id}`)
    } catch (e) { setErr(e) }
  }

  return (
    <div>
      <PageHeader title={`${type?.[0].toUpperCase()}${type?.slice(1)} count`}>
        <span className="text-sm text-silver self-center">Enter in count units. Weigh marinated meats with sauce. Draft saves on this device.</span>
      </PageHeader>
      {cats.map((c) => {
        const list = items.filter((i) => i.category_id === c.id)
        if (!list.length) return null
        return (
          <Card key={c.id} className="mb-3">
            <h3 className="font-bold mb-2">{c.name}</h3>
            {list.map((i) => {
              const exp = (expected.get(i.id) ?? 0) / Number(i.count_unit_factor)
              const pre = prevCounted.has(i.id) ? prevCounted.get(i.id)! / Number(i.count_unit_factor) : null
              const v = values[i.id]
              const diff = v !== undefined && v !== '' ? Number(v) - exp : null
              return (
                <div key={i.id} className="grid grid-cols-[1fr_120px] sm:grid-cols-[1fr_140px_160px_1fr] gap-2 items-center py-2 border-b border-charcoal-800">
                  <span>{i.name}</span>
                  <input className={inputCls} inputMode="decimal" placeholder={pre !== null ? String(pre) : i.count_unit} value={v ?? ''}
                    onChange={(e) => { const nv = { ...values, [i.id]: e.target.value }; setValues(nv); saveDraft(nv) }} />
                  <span className="text-xs text-silver hidden sm:block">{type === 'opening' && pre !== null ? `last close ${pre} ${i.count_unit}` : `expected ${exp.toFixed(2)} ${i.count_unit}`}
                    {diff !== null && Math.abs(diff) > 0.0005 && <span className={`block ${diff < 0 ? 'text-red-300' : 'text-emerald-300'}`}>{diff > 0 ? '+' : ''}{diff.toFixed(3)}</span>}</span>
                  <input className={`${inputCls} col-span-2 sm:col-span-1`} placeholder="Reason (if different)" value={reasons[i.id] ?? ''}
                    onChange={(e) => { const nr = { ...reasons, [i.id]: e.target.value }; setReasons(nr); saveDraft(values, nr) }} />
                </div>
              )
            })}
          </Card>
        )
      })}
      <ErrorBox error={err} />
      <div className="flex gap-2">
        {type === 'opening' && prev.data && <Button onClick={() => { const v: Record<string, string> = {}; prevCounted.forEach((q, id) => { const it = items.find((x) => x.id === id); if (it) v[id] = String(q / Number(it.count_unit_factor)) }); setValues(v); saveDraft(v) }}>Pre-fill from last closing</Button>}
        <Button variant="gold" big onClick={submit}>Submit count</Button>
      </div>
    </div>
  )
}

export function CountDetail() {
  const { id } = useParams()
  const auth = useAuth()
  const toast = useToast()
  const c = useRpc<any>('get_count', { p_count_id: id })
  const [accept, setAccept] = useState<Set<string>>(new Set())
  const [summary, setSummary] = useState<any>(null)
  const d = c.data
  if (!d) return <ErrorBox error={c.error ?? new Error('Loading…')} />
  return (
    <div>
      <PageHeader title={`${d.count_type} count · ${d.business_date}`}>
        <span className="self-center capitalize">{d.status}</span>
        {d.status === 'submitted' && isManager(auth.role) && <Button variant="gold" onClick={() =>
          mutate('approve_count', { p_token: auth.token, p_count_id: d.id, p_approve_items: [...accept] })
            .then((r) => { toast('Approved — ledger adjusted', 'ok'); setSummary(r.result.shift_summary); c.refetch() }).catch((e) => toast(e.message, 'error'))}>
          Approve{d.count_type === 'opening' ? ` (${accept.size} adjustments)` : ''}</Button>}
      </PageHeader>
      <div className="overflow-x-auto rounded-2xl border border-charcoal-700">
        <table className="w-full text-sm">
          <thead className="bg-charcoal-900 text-silver text-left"><tr><th className="p-2">Item</th><th className="p-2">Expected</th><th className="p-2">Counted</th><th className="p-2">Variance</th><th className="p-2">%</th><th className="p-2">₱</th><th className="p-2">Reason</th>{d.count_type === 'opening' && <th className="p-2">Post?</th>}</tr></thead>
          <tbody>{d.lines.map((l: any) => (
            <tr key={l.item_id} className={`border-t border-charcoal-800 ${l.needs_reason ? 'bg-amber-950/30' : ''}`}>
              <td className="p-2">{l.name}</td><td className="p-2">{qty(l.expected_qty, l)}</td><td className="p-2">{qty(l.counted_qty, l)}</td>
              <td className={`p-2 ${Number(l.variance_qty) < 0 ? 'text-red-300' : Number(l.variance_qty) > 0 ? 'text-emerald-300' : ''}`}>{qty(l.variance_qty, l)}</td>
              <td className="p-2">{l.variance_pct ?? '—'}</td><td className="p-2">{peso(l.variance_value)}</td><td className="p-2">{l.reason ?? (l.needs_reason ? '⚠ needed' : '')}</td>
              {d.count_type === 'opening' && <td className="p-2">{Number(l.variance_qty) !== 0 && d.status === 'submitted' &&
                <input type="checkbox" className="size-5" checked={accept.has(l.item_id)} onChange={(e) => { const n = new Set(accept); e.target.checked ? n.add(l.item_id) : n.delete(l.item_id); setAccept(n) }} />}</td>}
            </tr>))}</tbody>
        </table>
      </div>
      {summary && <ShiftSummary s={summary} />}
    </div>
  )
}

export function ShiftSummary({ s }: { s: any }) {
  return (
    <Card className="mt-4">
      <h3 className="font-bold mb-2">Shift summary · {s.business_date}</h3>
      <div className="grid sm:grid-cols-3 gap-3 text-sm">
        <div><div className="text-silver">Net sales</div><div className="text-xl font-bold">{peso((s.sales?.days ?? []).reduce((a: number, d: any) => a + Number(d.net), 0))}</div></div>
        <div><div className="text-silver">Waste items</div><div className="text-xl font-bold">{s.waste.length}</div></div>
        <div><div className="text-silver">Low stock</div><div className="text-xl font-bold">{s.low_stock.length}</div></div>
      </div>
      {s.variances.length > 0 && <p className="mt-2 text-sm">Largest variances: {s.variances.slice(0, 5).map((v: any) => `${v.name} ${peso(v.variance_value)}`).join(', ')}</p>}
    </Card>
  )
}

// ───── 5.9 Suppliers ─────
export function SuppliersPage() {
  const auth = useAuth()
  const toast = useToast()
  const list = useRpc<any[]>('get_suppliers', { p_branch: auth.branchId })
  const [edit, setEdit] = useState<any>(null)
  return (
    <div>
      <PageHeader eyebrow="Inventory" title="Suppliers">{isManager(auth.role) && <Button variant="gold" onClick={() => setEdit({ name: '', phones: [] })}>+ Supplier</Button>}</PageHeader>
      <div className="grid md:grid-cols-2 gap-3">
        {(list.data ?? []).map((s) => (
          <Card key={s.id}>
            <div className="flex justify-between"><h3 className="font-bold">{s.name}</h3>{isManager(auth.role) && <button className="text-sm underline" onClick={() => setEdit(s)}>Edit</button>}</div>
            <p className="text-sm text-silver">{s.contact_person} · {s.payment_terms}</p>
            <div className="flex flex-wrap gap-2 my-2">
              {(s.phones ?? []).map((p: string) => <a key={p} className="rounded-lg bg-charcoal-700 px-3 py-2" href={`tel:${p}`}>📞 {p}</a>)}
              {s.viber && <a className="rounded-lg bg-purple-800 px-3 py-2" href={`viber://chat?number=${encodeURIComponent(s.viber)}`}>Viber</a>}
              {s.messenger && <a className="rounded-lg bg-blue-800 px-3 py-2" href={`https://m.me/${s.messenger}`} target="_blank" rel="noreferrer">Messenger</a>}
            </div>
            {s.items.length > 0 && <table className="w-full text-xs mt-2"><thead className="text-silver"><tr><th className="text-left">Item</th><th>Last</th><th>Simple avg</th><th>Weighted avg</th></tr></thead>
              <tbody>{s.items.map((i: any) => { const f = Number(i.count_unit_factor); return (
                <tr key={i.item_id}><td>{i.name}</td><td className="text-center">{peso(i.last_unit_price * f)}/{i.count_unit}</td>
                  <td className="text-center">{i.simple_avg ? peso(i.simple_avg * f) : '—'}</td><td className="text-center">{i.weighted_avg ? peso(i.weighted_avg * f) : '—'}</td></tr>) })}</tbody></table>}
          </Card>
        ))}
      </div>
      {edit && <Modal open onClose={() => setEdit(null)} title={edit.id ? 'Edit supplier' : 'New supplier'}>
        {['name', 'contact_person', 'viber', 'messenger', 'email', 'address', 'payment_terms', 'notes'].map((k) => (
          <Field key={k} label={k.replace('_', ' ')}><input className={inputCls} value={edit[k] ?? ''} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></Field>))}
        <Field label="Phones (comma separated)"><input className={inputCls} value={(edit.phones ?? []).join(', ')} onChange={(e) => setEdit({ ...edit, phones: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></Field>
        <Button variant="gold" className="w-full" onClick={() => mutate('upsert_supplier', { p_token: auth.token, p_branch: auth.branchId, p_row: edit })
          .then(() => { setEdit(null); list.refetch() }).catch((e) => toast(e.message, 'error'))}>Save</Button>
      </Modal>}
    </div>
  )
}

// ───── 5.10 Reorder with dual approval ─────
export function ReorderPage() {
  const auth = useAuth()
  const toast = useToast()
  const lists = useRpc<any[]>('list_reorder_lists', { p_branch: auth.branchId })
  const [openId, setOpenId] = useState<string | null>(null)
  return (
    <div>
      <PageHeader eyebrow="Inventory" title="Reorder lists">
        {isManager(auth.role) && auth.role !== 'owner' && <Button variant="gold" onClick={() => mutate('generate_reorder_list', { p_token: auth.token, p_branch: auth.branchId })
          .then((r) => { setOpenId(r.result.id); lists.refetch() }).catch((e) => toast(e.message, 'error'))}>Generate from low stock</Button>}
      </PageHeader>
      <p className="text-sm text-silver mb-3">draft → manager approves → JD approves → ordered → received. A manager's approval alone never releases an order.</p>
      <Card>
        {(lists.data ?? []).length === 0 && <Empty>No reorder lists.</Empty>}
        {(lists.data ?? []).map((l) => (
          <button key={l.id} className="w-full flex justify-between border-b border-charcoal-700 py-3 px-2 hover:bg-charcoal-800 rounded" onClick={() => setOpenId(l.id)}>
            <span>{dateTime(l.created_at)} · {l.lines} items</span><span>{peso(l.est_total)} · <strong className="capitalize">{l.status.replace('_', ' ')}</strong></span>
          </button>
        ))}
      </Card>
      {openId && <ReorderDetail id={openId} onClose={() => { setOpenId(null); lists.refetch() }} />}
    </div>
  )
}

function ReorderDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const auth = useAuth()
  const toast = useToast()
  const l = useRpc<any>('get_reorder_list', { p_list_id: id })
  const d = l.data
  const act = (name: string, args: Record<string, unknown>) => mutate(name, { p_token: auth.token, p_list_id: id, ...args }).then(() => l.refetch()).catch((e) => toast(e.message, 'error'))
  const editable = d && (d.status === 'draft' || (d.status === 'manager_approved' && auth.role === 'owner'))
  const bySupplier = useMemo(() => {
    const m = new Map<string, any[]>()
    for (const x of d?.lines ?? []) m.set(x.supplier_name ?? 'No supplier', [...(m.get(x.supplier_name ?? 'No supplier') ?? []), x])
    return [...m.entries()]
  }, [d])
  if (!d) return null
  return (
    <Modal open onClose={onClose} title={`Reorder · ${d.status.replace('_', ' ')}`} wide>
      {bySupplier.map(([sup, lines]) => (
        <div key={sup} className="mb-4">
          <div className="flex justify-between items-center mb-1"><h3 className="font-bold">{sup}</h3>
            {['owner_approved', 'ordered'].includes(d.status) && <Button variant="ghost" onClick={() => {
              const text = `Hi! Order from Golden Korean BBQ Candon:\n${lines.map((x) => `• ${x.name}: ${(x.final_qty / x.count_unit_factor).toFixed(2)} ${x.count_unit}`).join('\n')}\nThank you!`
              if (navigator.share) navigator.share({ text }).catch(() => {}); else navigator.clipboard.writeText(text).then(() => toast('Message copied', 'ok'))
            }}>Copy / share message</Button>}</div>
          {lines.map((x) => (
            <div key={x.item_id} className="grid grid-cols-[1fr_110px_100px] gap-2 items-center py-1 border-b border-charcoal-800 text-sm">
              <span>{x.name} <span className="text-silver">(suggested {(x.suggested_qty / x.count_unit_factor).toFixed(2)})</span></span>
              {editable ? <input className={`${inputCls} !min-h-10`} inputMode="decimal" defaultValue={(x.final_qty / x.count_unit_factor).toFixed(2)}
                onBlur={(e) => act('update_reorder_line', { p_item_id: x.item_id, p_final_qty_count: Number(e.target.value) })} />
                : <span>{(x.final_qty / x.count_unit_factor).toFixed(2)} {x.count_unit}</span>}
              <span className="text-right">{peso(x.est_cost)}</span>
            </div>
          ))}
        </div>
      ))}
      <p className="text-sm text-silver mb-3">{d.manager_name && `Manager: ${d.manager_name} ✓ `}{d.owner_name && `· Owner: ${d.owner_name} ✓`}{d.reject_reason && `Rejected: ${d.reject_reason}`}</p>
      <div className="flex flex-wrap gap-2">
        {d.status === 'draft' && isManager(auth.role) && <Button variant="gold" onClick={() => act('approve_reorder', { p_level: 'manager' })}>Approve (manager)</Button>}
        {d.status === 'manager_approved' && auth.role === 'owner' && <Button variant="gold" onClick={() => act('approve_reorder', { p_level: 'owner' })}>Final approval (JD)</Button>}
        {d.status === 'owner_approved' && isManager(auth.role) && <Button variant="gold" onClick={() => act('mark_reorder_ordered', {})}>Mark ordered</Button>}
        {['draft', 'manager_approved'].includes(d.status) && isManager(auth.role) && <Button variant="danger" onClick={() => { const r = prompt('Reason for rejecting?'); if (r) act('reject_reorder', { p_reason: r }) }}>Reject</Button>}
      </div>
    </Modal>
  )
}
