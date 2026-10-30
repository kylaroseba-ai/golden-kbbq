import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../lib/auth'
import { deviceNow, useNow, useRpc, useWakeLock } from '../lib/hooks'
import { mutate, uuid } from '../lib/outbox'
import { manilaDate, mmss, time } from '../lib/format'
import { Button, ErrorBox, Field, Modal, PageHeader, inputCls, useManagerPin, useToast } from '../components/ui'
import { SessionView } from './Session'

export function Floor() {
  const auth = useAuth()
  const { t } = useTranslation()
  const nav = useNavigate()
  const toast = useToast()
  const now = useNow()
  useWakeLock()
  const floor = useRpc<any>('get_floor', { p_branch: auth.branchId }, { cache: true, refetchInterval: 15_000 })
  const [openFor, setOpenFor] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const wide = useMedia('(min-width: 1180px)')
  const seating: string | undefined = (useLocation().state as { reservation?: string } | null)?.reservation
  const tables: any[] = floor.data?.tables ?? []
  const branchName = (auth.branches.find((b) => b.id === auth.branchId)?.name ?? '').replace('Golden Korean BBQ — ', '')

  const tap = async (tb: any) => {
    const s = tb.session
    if (s) { if (wide) setSelected(s.id); else nav(`/session/${s.id}`) }
    else if (tb.status === 'dirty') {
      await mutate('set_table_status', { p_token: auth.token, p_table_id: tb.id, p_status: 'free' }).catch((e) => toast(e.message, 'error'))
      floor.refetch()
    } else setOpenFor(tb.id)
  }

  return (
    <div className={wide && selected ? 'grid grid-cols-[1fr_440px] gap-5 items-start' : ''}>
      <div>
        <PageHeader eyebrow={branchName} title="Floor · Main hall">
          <div className="flex flex-wrap gap-3 text-xs text-silver">
            <span><i className="inline-block size-2.5 rounded-sm bg-charcoal-600 mr-1.5" />Dining</span>
            <span><i className="inline-block size-2.5 rounded-sm bg-[#6b3b1e] mr-1.5" />Under 15 min</span>
            <span><i className="inline-block size-2.5 rounded-sm bg-info/60 mr-1.5" />Billing</span>
            <span><i className="inline-block size-2.5 rounded-sm border border-dashed border-silver mr-1.5" />Reserved</span>
          </div>
        </PageHeader>
        <ErrorBox error={floor.error} />
        {seating && <div className="rounded-xl border border-gold-600/60 bg-gold-700/20 p-3 mb-4 text-sm">Seating a reservation — tap a free table.</div>}
        <div className={`grid gap-3 ${wide && selected ? 'grid-cols-3 xl:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'}`}>
          {tables.map((tb) => {
            const s = tb.session
            const left = s?.timer_ends_at ? new Date(s.timer_ends_at).getTime() - now.getTime() : null
            const over = left !== null && left < 0
            const soon = left !== null && left >= 0 && left < 15 * 60_000
            const r = !s ? tb.reservation : null
            const tone = over ? 'border-bad/60 bg-bad-bg' : tb.status === 'billing' ? 'border-info/40 bg-info-bg' : soon ? 'border-[#8a4a22] bg-[#2e1c10]'
              : s ? 'border-charcoal-600 bg-charcoal-800' : tb.status === 'dirty' ? 'border-warn/40 bg-warn-bg/60' : r ? 'border-dashed border-silver/50 bg-transparent' : 'border-charcoal-700 bg-charcoal-900/60'
            const sel = s && selected === s.id
            return (
              <button key={tb.id} onClick={() => tap(tb)}
                className={`rounded-2xl border p-4 min-h-28 text-left transition hover:brightness-125 ${tone} ${sel ? '!border-gold-400 ring-2 ring-gold-400/40' : ''}`}>
                <div className="flex justify-between items-start">
                  <span className={`font-display text-xl font-bold ${!s && !r && tb.status === 'free' ? 'text-silver' : ''}`}>T{tb.label}</span>
                  {s?.last_round && s.last_round.status !== 'served' && <span className="text-[11px] rounded-full bg-gold-700/50 text-gold-200 px-2 py-0.5">R{s.last_round.round_no} ⏳</span>}
                </div>
                <div className="mt-5 text-sm">
                  {s ? <span className={over ? 'text-bad font-semibold' : soon ? 'text-warn font-semibold' : ''}>{s.pax_total} pax · {tb.status === 'billing' ? 'billing' : left === null ? (s.package_name ?? 'sets') : over ? `+${mmss(left).slice(1)} over` : `${mmss(left).replace(/:\d\d$/, '')} left`}</span>
                    : tb.status === 'dirty' ? <span className="text-warn">Tap when cleaned</span>
                    : r ? <span>{r.customer_name.split(' ').slice(-1)[0]} · {r.party_size} pax · {time(r.reserved_for).replace(/ [AP]M/, '')}</span>
                    : <span className="text-silver">{t('free')}</span>}
                </div>
              </button>
            )
          })}
        </div>
      </div>
      {wide && selected && (
        <div className="sticky top-20 rounded-2xl border border-charcoal-700 bg-charcoal-900 p-5 max-h-[calc(100vh-6rem)] overflow-y-auto">
          <SessionView id={selected} embedded onClose={() => setSelected(null)} />
        </div>
      )}
      {openFor && <OpenTableDialog tableId={openFor} tables={tables} reservationId={seating} onClose={() => setOpenFor(null)}
        onOpened={(id) => { setOpenFor(null); floor.refetch(); if (wide) setSelected(id); else nav(`/session/${id}`) }} />}
    </div>
  )
}

function useMedia(q: string) {
  const [m, setM] = useState(() => window.matchMedia(q).matches)
  useEffect(() => { const mq = window.matchMedia(q); const f = () => setM(mq.matches); mq.addEventListener('change', f); return () => mq.removeEventListener('change', f) }, [q])
  return m
}

function OpenTableDialog({ tableId, tables, reservationId, onClose, onOpened }: { tableId: string; tables: any[]; reservationId?: string; onClose: () => void; onOpened: (id: string) => void }) {
  const auth = useAuth()
  const { t } = useTranslation()
  const toast = useToast()
  const askPin = useManagerPin()
  const boot = useRpc<any>('get_bootstrap', { p_branch: auth.branchId }, { cache: true, staleTime: 60_000 })
  const today = manilaDate(deviceNow())
  const resv = useRpc<any[]>('get_reservations', { p_branch: auth.branchId, p_from: today, p_to: today }, { cache: true })
  const [selected, setSelected] = useState<string[]>([tableId])
  const [pkg, setPkg] = useState<string | null>(null)
  const [pax, setPax] = useState<Record<string, number>>({})
  const [reservation, setReservation] = useState<string>(reservationId ?? '')
  const [err, setErr] = useState<unknown>(null)
  const packages = (boot.data?.menu_items ?? []).filter((m: any) => m.item_type === 'unli_package' && m.is_active)
  const discounts: any[] = boot.data?.discount_types ?? []
  const regular = discounts.find((d) => d.kind === 'none')
  const totalPax = Object.values(pax).reduce((a, b) => a + b, 0)
  const free = tables.filter((x) => x.status === 'free')
  useEffect(() => {
    // default to what the time window allows: lunch sets before 3 PM, unli after
    const hour = Number(new Date(deviceNow().getTime() + 8 * 3600_000).toISOString().slice(11, 13))
    if (packages[0] && pkg === null) setPkg(hour >= 15 ? packages[0].id : '')
    const r = resv.data?.find((x) => x.id === reservationId)
    if (regular && !Object.keys(pax).length) setPax({ [regular.id]: r?.party_size ?? 4 })  // seated reservation pre-fills pax (§7.4)
  }, [packages.length, regular?.id, resv.data]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (override?: string | null) => {
    const sessionId = uuid()
    const args = { p_client_uuid: uuid(), p_token: auth.token, p_branch: auth.branchId, p_session_id: sessionId, p_table_ids: selected,
      p_package_id: pkg || null, p_pax: Object.entries(pax).filter(([, n]) => n > 0).map(([discount_type_id, pax_count]) => ({ discount_type_id, pax_count })),
      p_reservation_id: reservation || null, p_occurred_at: deviceNow().toISOString(), p_override: override ?? null }
    try {
      const r = await mutate('open_session', args, { queueable: true, label: `Open table ${tables.find((x) => x.id === tableId)?.label}`, session_id: sessionId, branch_id: auth.branchId! })
      if (r.queued) toast('Table opened offline — pending sync', 'info')
      onOpened(sessionId)
    } catch (e: any) {
      if (['TIME_WINDOW', 'NEEDS_MANAGER'].includes(e.code)) {
        const tok = await askPin(e.message)
        if (tok) return submit(tok)
      }
      setErr(e)
    }
  }

  return (
    <Modal open onClose={onClose} title={t('open_table')} wide>
      <Field label="Tables (tap more to merge, e.g. 1 & 2)">
        <div className="flex flex-wrap gap-2">
          {[tables.find((x) => x.id === tableId), ...free.filter((x) => x.id !== tableId)].filter(Boolean).map((x: any) => (
            <button key={x.id} onClick={() => setSelected(selected.includes(x.id) ? selected.filter((i) => i !== x.id || i === tableId) : [...selected, x.id])}
              className={`min-h-12 min-w-12 rounded-xl border font-bold ${selected.includes(x.id) ? 'border-gold-400 bg-gold-400/15 text-gold-200' : 'border-charcoal-700 bg-charcoal-800'}`}>T{x.label}</button>
          ))}
        </div>
      </Field>
      <Field label="Package">
        <div className="grid sm:grid-cols-3 gap-2">
          {packages.map((p: any) => (
            <button key={p.id} onClick={() => setPkg(p.id)} className={`rounded-xl border p-3 text-left ${pkg === p.id ? 'border-gold-400 bg-gold-400/10' : 'border-charcoal-700 bg-charcoal-800'}`}>
              <div className="font-semibold">{p.name}</div><div className="text-sm text-silver">₱{Number(p.price).toFixed(0)}/person · 2 h</div>
            </button>
          ))}
          <button onClick={() => setPkg('')} className={`rounded-xl border p-3 text-left ${pkg === '' ? 'border-gold-400 bg-gold-400/10' : 'border-charcoal-700 bg-charcoal-800'}`}>
            <div className="font-semibold">Lunch / sets</div><div className="text-sm text-silver">No refills</div>
          </button>
        </div>
      </Field>
      <Field label={`Headcount by type — total ${totalPax}`} hint="SC/PWD guests' name and ID are taken at billing.">
        <div className="grid sm:grid-cols-2 gap-2">
          {discounts.map((d) => (
            <div key={d.id} className="flex items-center justify-between rounded-xl bg-charcoal-800 border border-charcoal-700 px-3 py-2">
              <span>{d.name}{d.requires_manager_pin ? ' 🔒' : ''}</span>
              <div className="flex items-center gap-2">
                <button className="size-10 rounded-lg bg-charcoal-700 text-xl" onClick={() => setPax({ ...pax, [d.id]: Math.max(0, (pax[d.id] ?? 0) - 1) })}>−</button>
                <span className="w-6 text-center font-bold">{pax[d.id] ?? 0}</span>
                <button className="size-10 rounded-lg bg-gold-400 text-charcoal-950 text-xl font-bold" onClick={() => setPax({ ...pax, [d.id]: (pax[d.id] ?? 0) + 1 })}>+</button>
              </div>
            </div>
          ))}
        </div>
      </Field>
      <Field label="Reservation (optional)">
        <select className={inputCls} value={reservation} onChange={(e) => {
          setReservation(e.target.value)
          const r = resv.data?.find((x) => x.id === e.target.value)
          if (r && regular) setPax({ [regular.id]: r.party_size })
        }}>
          <option value="">Walk-in</option>
          {(resv.data ?? []).filter((r) => r.status === 'confirmed').map((r) => (
            <option key={r.id} value={r.id}>{time(r.reserved_for)} · {r.customer_name} · {r.party_size} pax · {r.code}</option>
          ))}
        </select>
      </Field>
      <ErrorBox error={err} />
      <Button variant="gold" big className="w-full" disabled={totalPax === 0 && !!pkg} onClick={() => submit()}>{t('open_table')}</Button>
    </Modal>
  )
}
