import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { isManager, useAuth } from '../lib/auth'
import { deviceNow, useNow, useOnline, useRpc, useWakeLock } from '../lib/hooks'
import { localDb, mutate, uuid } from '../lib/outbox'
import { mmss, peso, qty, time } from '../lib/format'
import { displayStatus } from './Manage'
import { Billing } from './Billing'
import { Button, Card, ErrorBox, Field, Modal, Pill, Tabs, inputCls, useManagerPin, useToast } from '../components/ui'

export function SessionPage() {
  const { id } = useParams()
  const nav = useNavigate()
  return <div className="max-w-3xl"><SessionView id={id!} onClose={() => nav('/floor')} /></div>
}

/** One table: header with timer, then Refill / Order / Bill. Used full-screen on phones and as the floor's side panel on tablets. */
export function SessionView({ id, embedded, onClose }: { id: string; embedded?: boolean; onClose: () => void }) {
  const auth = useAuth()
  const { t } = useTranslation()
  const now = useNow()
  useWakeLock()
  const session = useRpc<any>('get_session', { p_session_id: id }, { cache: true, refetchInterval: 10_000, retry: false })
  const pendingOpen = useLiveQuery(() => localDb.outbox.where('session_id').equals(id).toArray(), [id], [])
  const [tab, setTab] = useState<'refill' | 'order' | 'bill'>('refill')
  const s = session.data

  if (!s && pendingOpen.length) {
    return <div><h2 className="font-display text-xl font-bold mb-2">Table opened offline</h2>
      <p className="text-silver text-sm">It will appear here once this device is back online. Tell dispatch verbally in the meantime.</p></div>
  }
  if (!s) return <ErrorBox error={session.error ?? new Error('Loading…')} />

  const total = s.timer_minutes ? s.timer_minutes * 60_000 : null
  const left = s.timer_ends_at ? new Date(s.timer_ends_at).getTime() - now.getTime() : null
  const canBill = ['cashier', 'manager', 'owner', 'admin'].includes(auth.role ?? '')
  const hasRefills = !!s.package_id
  const lastRound = (s.rounds ?? []).filter((r: any) => r.status !== 'voided').at(-1)
  const price = (s.lines ?? []).find((l: any) => l.item_type === 'unli_package')?.unit_price
  const current = tab === 'refill' && !hasRefills ? 'order' : tab

  return (
    <div>
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="min-w-0">
          <button className="text-sm text-silver hover:text-gold-300 mb-1" onClick={onClose}>{embedded ? '✕ Close' : `← ${t('floor')}`}</button>
          <h1 className="font-display text-2xl font-bold">Table {s.table_label}</h1>
          <p className="text-sm text-silver">{s.pax_total} pax · {s.package_name ?? 'Sets / à la carte'}{price ? ` · ₱${Number(price).toFixed(0)} / head` : ''}{lastRound ? ` · Round ${lastRound.round_no}` : ''}</p>
        </div>
        {left !== null && <div className="text-right shrink-0">
          <div className={`font-display text-3xl font-bold tabular-nums ${left < 0 ? 'text-bad' : left < 15 * 60_000 ? 'text-warn' : 'text-gold-300'}`}>{left < 0 ? `+${mmss(left).slice(1)}` : mmss(left)}</div>
          <div className="text-xs text-silver">{left < 0 ? 'overtime' : `of ${Math.round((total ?? 0) / 3600_000)}:00 timer`}</div>
        </div>}
      </div>
      {total && left !== null && <div className="h-1.5 rounded-full bg-charcoal-700 overflow-hidden mt-3 mb-4"><div className={`h-full ${left < 15 * 60_000 ? 'bg-warn' : 'bg-gold-400'}`} style={{ width: `${Math.max(0, Math.min(100, (1 - left / total) * 100))}%` }} /></div>}
      {s.status !== 'open' && <div className="rounded-xl bg-info-bg text-info p-3 mb-4 text-sm">This table is {s.status}.</div>}
      <div className="mb-4 mt-3"><Tabs value={current} onChange={setTab} items={[...(hasRefills ? [['refill', t('refill')]] : []), ['order', t('order')], ...(canBill ? [['bill', t('bill')]] : [])] as any} /></div>
      {current === 'refill' ? <RefillPanel s={s} now={now} compact={embedded} /> : current === 'bill' ? <Billing s={s} compact={embedded} /> : <OrderPanel s={s} compact={embedded} />}
    </div>
  )
}

// ───── Refill rounds (§6.4) ─────
function RefillPanel({ s, now, compact }: { s: any; now: Date; compact?: boolean }) {
  const auth = useAuth()
  const { t } = useTranslation()
  const toast = useToast()
  const askPin = useManagerPin()
  const online = useOnline()
  const boot = useRpc<any>('get_bootstrap', { p_branch: auth.branchId }, { cache: true, staleTime: 60_000 })
  const stock = useRpc<any[]>('get_live_stock', { p_branch: auth.branchId }, { cache: true, refetchInterval: 20_000 })
  const pendingRounds = useLiveQuery(() => localDb.outbox.where('session_id').equals(s.id).filter((x) => x.name === 'post_refill_round').count(), [s.id], 0)
  const [plates, setPlates] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const settings = boot.data?.settings ?? {}
  const allowed = new Set((boot.data?.package_refill_items ?? []).filter((x: any) => x.package_id === s.package_id).map((x: any) => x.item_id))
  const items = (boot.data?.items ?? []).filter((i: any) => i.is_refillable && i.is_active && (!settings.enforce_package_items || allowed.has(i.id)))
  const level = new Map((stock.data ?? []).map((x) => [x.item_id, x]))
  const limit = Number(settings.max_meat_plates_per_round ?? 3) * (s.table_ids?.length ?? 1)
  const meatItems = items.filter((i: any) => i.is_meat)
  const sideItems = items.filter((i: any) => !i.is_meat)
  const meat = meatItems.reduce((a: number, i: any) => a + (plates[i.id] ?? 0), 0)
  const cutoffMs = new Date(s.refill_cutoff_at).getTime() - now.getTime()
  const last = (s.rounds ?? []).filter((r: any) => r.status !== 'voided').at(-1)
  const nextNo = (last?.round_no ?? 0) + 1
  const waiting = last && last.status !== 'served'
  const waitingMin = waiting ? (now.getTime() - new Date(last.requested_at).getTime()) / 60000 : 0
  const stuck = waiting && waitingMin >= Number(settings.stuck_round_minutes ?? 10)
  const gpp = Number(settings.default_grams_per_plate ?? 80)
  const chosen = Object.entries(plates).filter(([, n]) => n > 0)

  const submit = async (override?: string | null) => {
    const lines = chosen.map(([item_id, n]) => ({ item_id, plates: n }))
    setBusy(true)
    try {
      const r = await mutate('post_refill_round', { p_client_uuid: uuid(), p_token: auth.token, p_session_id: s.id, p_lines: lines,
        p_occurred_at: deviceNow().toISOString(), p_override: override ?? null },
        { queueable: true, label: `Refill · table ${s.table_label}`, session_id: s.id, branch_id: auth.branchId! })
      setPlates({})
      toast(r.queued ? 'Saved offline — tell dispatch verbally' : `${t('round')} ${r.result.round_no} sent to kitchen`, r.queued ? 'info' : 'ok')
    } catch (e: any) {
      if (['PLATE_LIMIT', 'REFILL_CUTOFF'].includes(e.code)) {
        const tok = await askPin(`${e.message} Manager PIN allows it (audited).`)
        if (tok) return submit(tok)
      } else toast(e.message, 'error')
    } finally { setBusy(false) }
  }

  // Offline rule (§6.4): at most one unsynced round per table, and only if the last synced round was served.
  const offlineBlocked = !online && (pendingRounds >= Number(settings.max_unsynced_rounds_per_table ?? 1) || waiting)
  const cutoffPassed = cutoffMs <= 0
  const lastCall = cutoffMs > 0 && cutoffMs < 10 * 60_000
  const stockText = (i: any) => { const l = level.get(i.id); if (!l) return ''; const st = displayStatus(l); return { txt: `${st === 'low' || st === 'out' ? (st === 'out' ? 'Out: ' : 'Low: ') : ''}${qty(l.qty, l)} in stock`, bad: st === 'low' || st === 'out' } }

  return (
    <div className={compact ? '' : 'grid lg:grid-cols-[1fr_300px] gap-4 items-start'}>
      <div>
        <div className={`rounded-xl px-4 py-3 mb-3 flex items-center justify-between gap-3 ${cutoffPassed ? 'bg-bad-bg text-bad' : lastCall ? 'bg-warn-bg text-warn' : 'bg-gold-700/25 text-gold-200'}`}>
          <span className="font-semibold text-sm">{cutoffPassed ? t('refill_cutoff_reached') : lastCall ? `${t('last_call')} · ${mmss(cutoffMs)}` : `Round ${nextNo} · meat plates`}</span>
          <span className="flex gap-1.5" aria-label={`${meat} of ${limit} plates`}>{Array.from({ length: Math.max(limit, meat) }, (_, i) => (
            <span key={i} className={`size-5 rounded-md ${i < meat ? (i < limit ? 'bg-gold-400' : 'bg-bad') : 'border border-dashed border-gold-500/60'}`} />))}</span>
        </div>
        {!cutoffPassed && !lastCall && <p className="text-xs text-silver mb-3">{t('refill_closes_in')} {mmss(cutoffMs)} · {gpp} g per plate, deducted live · {t('limit_per_round', { n: limit })}</p>}
        {waiting && (
          <div className={`rounded-xl p-3 mb-3 text-sm flex flex-wrap items-center gap-3 ${stuck ? 'bg-bad-bg text-bad' : 'bg-warn-bg text-warn'}`}>
            <span className="flex-1">{t('round')} {last.round_no} {stuck ? `— ${t('waiting_on_dispatch')}` : `is not served yet (${Math.floor(waitingMin)} min).`}</span>
            {stuck && <Button className="!min-h-9" onClick={async () => {
              const tok = isManager(auth.role) ? null : await askPin('Mark this stuck round as served?')
              if (!tok && !isManager(auth.role)) return
              await mutate('force_serve_round', { p_token: auth.token, p_round_id: last.id, p_override: tok }).catch((e) => toast(e.message, 'error'))
            }}>Manager: mark served</Button>}
          </div>
        )}
        {offlineBlocked && <div className="rounded-xl p-3 mb-3 bg-bad-bg text-bad text-sm">Offline: one round is already waiting to sync, or the last round isn’t confirmed served.</div>}
        <div className="label mb-2">Tap to add a plate</div>
        <div className={`grid gap-2 mb-5 ${compact ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'}`}>
          {meatItems.map((i: any) => {
            const n = plates[i.id] ?? 0
            const st = stockText(i)
            return (
              <div key={i.id} className={`rounded-2xl border p-3 flex items-center gap-3 transition ${n ? 'border-gold-500/70 bg-gold-700/15' : 'border-charcoal-700 bg-charcoal-800'}`}>
                <div className="flex-1 min-w-0"><div className="font-semibold leading-tight">{i.name}</div>
                  {st && <div className={`text-xs mt-0.5 ${st.bad ? 'text-bad font-semibold' : 'text-silver'}`}>{st.txt}</div>}</div>
                <button className="size-11 rounded-xl bg-charcoal-700 text-xl disabled:opacity-30" disabled={!n} onClick={() => setPlates({ ...plates, [i.id]: Math.max(0, n - 1) })} aria-label={`Remove ${i.name}`}>−</button>
                <span className="w-6 text-center text-xl font-bold">{n}</span>
                <button className="size-11 rounded-xl bg-gold-400 text-charcoal-950 text-xl font-bold" aria-label={`Add ${i.name}`}
                  onClick={() => { if (meat >= limit) toast(t('limit_per_round', { n: limit }), 'error'); setPlates({ ...plates, [i.id]: n + 1 }) }}>+</button>
              </div>
            )
          })}
        </div>
        <div className="label mb-2">Side refills · no limit</div>
        <div className="flex flex-wrap gap-2 mb-5">
          {sideItems.map((i: any) => {
            const n = plates[i.id] ?? 0
            const st = stockText(i)
            return (
              <span key={i.id} className={`inline-flex items-center rounded-full border transition ${n ? 'border-gold-500 bg-gold-700/25' : st && st.bad ? 'border-bad/50' : 'border-charcoal-600'}`}>
                <button className="min-h-11 pl-4 pr-3 text-sm font-medium" onClick={() => setPlates({ ...plates, [i.id]: n + 1 })}>{i.name}{n ? <b className="ml-1.5 text-gold-200">×{n}</b> : ''}</button>
                {n > 0 && <button className="min-h-11 pr-3 text-silver" onClick={() => setPlates({ ...plates, [i.id]: n - 1 })} aria-label={`Remove ${i.name}`}>−</button>}
              </span>
            )
          })}
        </div>
        {chosen.length > 0 && <div className="rounded-xl bg-charcoal-800 border border-charcoal-700 px-4 py-3 mb-3 text-sm">
          <span className="font-semibold">This round:</span> {chosen.map(([id, n]) => `${n} ${items.find((i: any) => i.id === id)?.name}`).join(', ')}</div>}
        <div className="grid grid-cols-[auto_1fr] gap-2">
          <Button big onClick={() => setPlates({})} disabled={!chosen.length}>Undo</Button>
          <Button variant="gold" big disabled={busy || s.status !== 'open' || !chosen.length || (waiting && online) || offlineBlocked} onClick={() => submit()}>
            {waiting ? `Waiting for round ${last.round_no}` : `Send round ${nextNo} to kitchen`}
          </Button>
        </div>
      </div>
      <div className={compact ? 'mt-6' : ''}>
        <div className="label mb-2">Rounds</div>
        {(s.rounds ?? []).length === 0 && <p className="text-silver text-sm">Round 1 is the first serving.</p>}
        {(s.rounds ?? []).slice().reverse().map((r: any) => (
          <div key={r.id} className="rounded-xl border border-charcoal-700 bg-charcoal-900 p-3 mb-2 text-sm">
            <div className="flex justify-between items-center"><strong>{t('round')} {r.round_no}</strong>
              {r.status === 'served' ? <Pill tone="confirmed">✓ {time(r.served_at)}</Pill> : r.status === 'voided' ? <Pill tone="off">voided</Pill> : <Pill tone="pending">⏳ since {time(r.requested_at)}</Pill>}</div>
            <div className="text-silver mt-1">{(r.lines ?? []).map((l: any) => `${l.plates}× ${l.name}`).join(', ')}</div>
            {r.status === 'queued' && <button className="text-xs text-bad mt-1 hover:underline" onClick={async () => {
              const reason = prompt('Why void this round?')
              if (reason) await mutate('void_refill_round', { p_token: auth.token, p_round_id: r.id, p_reason: reason }).catch((e) => toast(e.message, 'error'))
            }}>Void (not served)</button>}
          </div>
        ))}
        <RunningBill s={s} />
      </div>
    </div>
  )
}

function RunningBill({ s }: { s: any }) {
  const lines = (s.lines ?? []).filter((l: any) => l.status === 'active')
  if (!lines.length) return null
  return (
    <div className="mt-4 pt-4 border-t border-charcoal-700 text-sm">
      {lines.map((l: any) => <div key={l.id} className="flex justify-between py-0.5 text-silver"><span>{Number(l.qty)} × {l.name}</span><span>{peso(l.net_amount)}</span></div>)}
      <div className="flex justify-between mt-2 text-base font-bold"><span>Total</span><span className="font-display">{peso(lines.reduce((a: number, l: any) => a + Number(l.net_amount), 0))}</span></div>
    </div>
  )
}

// ───── Sets, add-ons, drinks, fees (§6.6) ─────
function OrderPanel({ s, compact }: { s: any; compact?: boolean }) {
  const auth = useAuth()
  const toast = useToast()
  const askPin = useManagerPin()
  const boot = useRpc<any>('get_bootstrap', { p_branch: auth.branchId }, { cache: true, staleTime: 60_000 })
  const [cart, setCart] = useState<{ menu_item_id: string; qty: number; discount_type_id: string | null }[]>([])
  const [wasteFor, setWasteFor] = useState(false)
  const menu = (boot.data?.menu_items ?? []).filter((m: any) => m.is_active && m.item_type !== 'unli_package')
  const cats: any[] = boot.data?.menu_categories ?? []
  const discounts: any[] = boot.data?.discount_types ?? []
  const settings = boot.data?.settings ?? {}
  const hour = new Date(deviceNow().getTime() + 8 * 3600_000).toISOString().slice(11, 16)
  const lunchOpen = hour >= settings.lunch_from && hour < settings.lunch_to

  const submit = async (override?: string | null) => {
    try {
      const hasLeftover = cart.some((c) => menu.find((m: any) => m.id === c.menu_item_id)?.item_type === 'fee' && /leftover/i.test(menu.find((m: any) => m.id === c.menu_item_id)?.name))
      const r = await mutate('post_order_lines', { p_client_uuid: uuid(), p_token: auth.token, p_session_id: s.id, p_lines: cart,
        p_occurred_at: deviceNow().toISOString(), p_override: override ?? null },
        { queueable: true, label: `Order · table ${s.table_label}`, session_id: s.id, branch_id: auth.branchId! })
      setCart([])
      toast(r.queued ? 'Saved offline — pending sync' : 'Order sent', r.queued ? 'info' : 'ok')
      if (hasLeftover) setWasteFor(true)   // leftover fee → log estimated plate waste (§5.7)
    } catch (e: any) {
      if (['TIME_WINDOW', 'NEEDS_MANAGER'].includes(e.code)) {
        const tok = await askPin(e.message)
        if (tok) return submit(tok)
      } else toast(e.message, 'error')
    }
  }

  return (
    <div className={`grid gap-4 ${compact ? '' : 'lg:grid-cols-[1fr_360px]'}`}>
      <Card>
        {cats.map((c) => {
          const list = menu.filter((m: any) => m.category_id === c.id)
          if (!list.length) return null
          return (
            <div key={c.id} className="mb-4">
              <h3 className="text-sm uppercase tracking-wide text-silver mb-2">{c.name}</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {list.map((m: any) => {
                  const blocked = m.item_type === 'set_meal' && !lunchOpen
                  return (
                    <button key={m.id} onClick={() => setCart([...cart, { menu_item_id: m.id, qty: 1, discount_type_id: null }])}
                      className={`rounded-xl border p-3 text-left min-h-16 ${blocked ? 'border-charcoal-700 opacity-40' : 'border-charcoal-600 bg-charcoal-800 hover:border-gold-400'}`}>
                      <div className="font-semibold leading-tight">{m.name}</div>
                      <div className="text-sm text-silver">{peso(m.price)}{blocked ? ` · ${settings.lunch_from}–${settings.lunch_to} only` : ''}</div>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </Card>
      <div className="space-y-4">
        <Card>
          <h3 className="font-bold mb-2">New order</h3>
          {cart.length === 0 && <p className="text-silver text-sm">Tap items to add.</p>}
          {cart.map((c, i) => {
            const m = menu.find((x: any) => x.id === c.menu_item_id)
            return (
              <div key={i} className="flex flex-wrap items-center gap-2 py-2 border-b border-charcoal-700">
                <span className="flex-1">{m?.name}</span>
                <input type="number" min={1} className={`${inputCls} !w-16 !min-h-10`} value={c.qty}
                  onChange={(e) => setCart(cart.map((x, j) => j === i ? { ...x, qty: Math.max(1, Number(e.target.value)) } : x))} />
                {m?.item_type === 'set_meal' && (
                  <select className={`${inputCls} !w-36 !min-h-10 text-sm`} value={c.discount_type_id ?? ''}
                    onChange={(e) => setCart(cart.map((x, j) => j === i ? { ...x, discount_type_id: e.target.value || null } : x))}>
                    <option value="">Regular</option>
                    {discounts.filter((d) => d.kind !== 'none').map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                )}
                <button className="text-red-300 px-2" onClick={() => setCart(cart.filter((_, j) => j !== i))}>✕</button>
              </div>
            )
          })}
          <Button variant="gold" className="w-full mt-3" disabled={!cart.length || s.status !== 'open'} onClick={() => submit()}>Send order</Button>
        </Card>
        <Card>
          <h3 className="font-bold mb-2">On this table</h3>
          {(s.lines ?? []).map((l: any) => (
            <div key={l.id} className={`flex items-center gap-2 py-1.5 text-sm border-b border-charcoal-800 ${l.status === 'voided' ? 'line-through text-silver' : ''}`}>
              <span className="flex-1">{Number(l.qty)}× {l.name}{l.discount_name && l.discount_name !== 'Regular' ? ` (${l.discount_name})` : ''}{l.served ? ' ✓' : ''}</span>
              <span>{peso(l.net_amount)}</span>
              {l.status === 'active' && s.status !== 'closed' && <button className="text-xs text-red-300 underline" onClick={async () => {
                const reason = prompt('Reason for void?')
                if (!reason) return
                try { await mutate('void_order_line', { p_token: auth.token, p_line_id: l.id, p_reason: reason }) }
                catch (e: any) {
                  if (e.code === 'NEEDS_MANAGER') {
                    const tok = await askPin(e.message)
                    if (tok) await mutate('void_order_line', { p_token: auth.token, p_line_id: l.id, p_reason: reason, p_override: tok }).catch((x) => toast(x.message, 'error'))
                  } else toast(e.message, 'error')
                }
              }}>void</button>}
            </div>
          ))}
        </Card>
      </div>
      {wasteFor && <PlateWasteDialog sessionId={s.id} onClose={() => setWasteFor(false)} />}
    </div>
  )
}

function PlateWasteDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const auth = useAuth()
  const toast = useToast()
  const boot = useRpc<any>('get_bootstrap', { p_branch: auth.branchId }, { cache: true })
  const [grams, setGrams] = useState<Record<string, number>>({})
  const items = (boot.data?.items ?? []).filter((i: any) => i.is_refillable)
  return (
    <Modal open onClose={onClose} title="Log plate waste (leftover fee)">
      <p className="text-silver text-sm mb-3">Estimate the grams left on the table.</p>
      <div className="max-h-80 overflow-y-auto">
        {items.map((i: any) => (
          <Field key={i.id} label={i.name}>
            <input type="number" min={0} step={10} className={inputCls} placeholder="g" value={grams[i.id] ?? ''}
              onChange={(e) => setGrams({ ...grams, [i.id]: Number(e.target.value) })} />
          </Field>
        ))}
      </div>
      <Button variant="gold" className="w-full" onClick={async () => {
        for (const [item, g] of Object.entries(grams).filter(([, g]) => g > 0)) {
          await mutate('log_waste', { p_client_uuid: uuid(), p_token: auth.token, p_branch: auth.branchId, p_item_id: item, p_qty: g,
            p_reason: 'plate_waste', p_session_id: sessionId, p_occurred_at: deviceNow().toISOString() }, { queueable: true, label: 'Plate waste' })
            .catch((e) => toast(e.message, 'error'))
        }
        toast('Plate waste logged', 'ok'); onClose()
      }}>Save</Button>
    </Modal>
  )
}
