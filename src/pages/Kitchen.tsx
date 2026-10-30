import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../lib/auth'
import { deviceNow, useNow, useRpc, useWakeLock } from '../lib/hooks'
import { mutate } from '../lib/outbox'
import { time } from '../lib/format'
import { Button, Empty, StatusChip, useToast } from '../components/ui'

let audio: AudioContext | null = null
function chime(volume: number) {
  if (!audio) return
  const t0 = audio.currentTime
  for (const [i, f] of [880, 1320, 880].entries()) {
    const o = audio.createOscillator(), g = audio.createGain()
    o.frequency.value = f; o.type = 'square'
    g.gain.setValueAtTime(0.0001, t0 + i * 0.22)
    g.gain.exponentialRampToValueAtTime(volume, t0 + i * 0.22 + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.22 + 0.2)
    o.connect(g).connect(audio.destination); o.start(t0 + i * 0.22); o.stop(t0 + i * 0.22 + 0.21)
  }
}

// Kitchen / Dispatch screen — replaces paper slips (§6.5)
export function Kitchen() {
  const auth = useAuth()
  const { t } = useTranslation()
  const toast = useToast()
  const now = useNow()
  const [started, setStarted] = useState(false)
  const [volume, setVolume] = useState(Number(localStorage.getItem('gkb-volume') ?? 0.6))
  const wake = useWakeLock(started)
  const q = useRpc<any>('get_kitchen_queue', { p_branch: auth.branchId }, { refetchInterval: 3000, cache: true })
  const boot = useRpc<any>('get_bootstrap', { p_branch: auth.branchId }, { cache: true, staleTime: 60_000 })
  const seen = useRef<Set<string> | null>(null)
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  const amber = Number(boot.data?.settings?.kitchen_ticket_amber_min ?? 5)
  const red = Number(boot.data?.settings?.kitchen_ticket_red_min ?? 10)
  const tickets: any[] = q.data?.tickets ?? []

  useEffect(() => {
    const ids = new Set(tickets.map((x) => x.id))
    if (seen.current) {
      const added = [...ids].filter((id) => !seen.current!.has(id))
      if (added.length) {
        if (started) chime(volume)
        setFresh(new Set(added))
        setTimeout(() => setFresh(new Set()), 5000)
      }
    }
    seen.current = ids
  }, [q.data]) // eslint-disable-line react-hooks/exhaustive-deps

  // Browsers block sound until someone taps; this also turns on the wake lock.
  if (!started || (audio && audio.state !== 'running')) {
    return (
      <div className="grid place-items-center min-h-[60vh]">
        <button className="rounded-3xl bg-gold-400 text-charcoal-950 font-display text-3xl font-bold px-14 py-10 shadow-[0_0_60px_rgba(212,176,98,.25)]"
          onClick={async () => { audio ??= new AudioContext(); await audio.resume(); chime(volume); setStarted(true) }}>
          ▶ {t('start_service')}
        </button>
      </div>
    )
  }

  const serve = (ticketId: string, lineIds?: string[]) =>
    mutate('mark_ticket_served', { p_token: auth.token, p_ticket_id: ticketId, p_line_ids: lineIds ?? null },
      { queueable: true, label: 'Mark served' }).then(() => q.refetch()).catch((e) => toast(e.message, 'error'))

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <h1 className="font-display text-2xl font-bold">Kitchen · dispatch <span className="text-silver text-lg">({tickets.length} open)</span></h1>
        <span className="text-sm text-silver">{wake ? '☀ Screen stays on' : 'Wake lock unavailable'}</span>
        <label className="ml-auto flex items-center gap-2 text-sm">Volume
          <input type="range" min={0.05} max={1} step={0.05} value={volume} onChange={(e) => { setVolume(Number(e.target.value)); localStorage.setItem('gkb-volume', e.target.value) }} />
        </label>
        <Button onClick={() => chime(volume)}>Test chime</Button>
      </div>
      {tickets.length === 0 && <Empty>No open tickets. New orders and refill rounds appear here automatically.</Empty>}
      <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {tickets.map((tk) => {
          const mins = (deviceNow().getTime() - new Date(tk.created_at).getTime()) / 60000
          const tone = mins >= red ? 'border-bad/60 bg-bad-bg/60' : mins >= amber ? 'border-warn/50 bg-warn-bg/50' : 'border-charcoal-700 bg-charcoal-900'
          return (
            <div key={tk.id} className={`rounded-2xl border-2 p-4 ${tone} ${fresh.has(tk.id) ? 'flash' : ''}`}>
              <div className="flex justify-between items-start mb-2">
                <div><div className="font-display text-3xl font-bold">T{tk.table_label}</div><div className="text-sm text-silver">{tk.title} · {tk.server_name}</div></div>
                <div className="text-right"><div className="font-mono text-xl">{Math.floor(mins)}:{String(Math.floor((mins % 1) * 60)).padStart(2, '0')}</div>
                  <div className="text-xs text-silver">{time(tk.created_at)}</div></div>
              </div>
              <ul className="mb-3">
                {(tk.lines ?? []).filter((l: any) => !l.voided).map((l: any) => (
                  <li key={l.id} className="flex items-center gap-2 py-1.5 border-b border-charcoal-700">
                    <button className={`size-10 rounded-lg border ${l.served_at ? 'bg-ok-bg border-ok/50 text-ok' : 'border-charcoal-600 bg-charcoal-800'}`}
                      onClick={() => !l.served_at && serve(tk.id, [l.id])} aria-label="Serve line">{l.served_at ? '✓' : ''}</button>
                    <span className={`text-lg flex-1 ${l.served_at ? 'line-through text-silver' : ''}`}><strong>{Number(l.qty)}×</strong> {l.label}</span>
                    {l.stock_status && l.stock_status !== 'ok' && <StatusChip status={l.stock_status} />}
                  </li>
                ))}
              </ul>
              <Button variant="gold" big className="w-full" onClick={() => serve(tk.id)}>✓ {t('served')}</Button>
            </div>
          )
        })}
      </div>
      <p className="text-xs text-silver mt-6">Tickets only arrive once the sending phone is online. Updated {time(now.toISOString())}.</p>
    </div>
  )
}
