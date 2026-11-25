import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { getBackend } from '../lib/backend'
import { deviceNow, useRpc } from '../lib/hooks'
import { mutate } from '../lib/outbox'
import { dateTime, manilaDate, time } from '../lib/format'
import { Button, Empty, ErrorBox, Field, Logo, Modal, PageHeader, Pill, Tabs, inputCls, useToast } from '../components/ui'

// Staff reservation list (§7.2, §7.4)
export function ReservationsPage() {
  const auth = useAuth()
  const toast = useToast()
  const nav = useNavigate()
  const today = manilaDate(deviceNow())
  const tomorrow = manilaDate(new Date(deviceNow().getTime() + 86400_000))
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState(today)
  const list = useRpc<any[]>('get_reservations', { p_branch: auth.branchId, p_from: from, p_to: to }, { refetchInterval: 15_000, cache: true })
  const [newOpen, setNewOpen] = useState(false)
  const seen = useRef<Set<string> | null>(null)

  // New booking → sound on the front-desk device (§7.2)
  useEffect(() => {
    const pending = new Set((list.data ?? []).filter((r) => r.status === 'pending').map((r) => r.id))
    if (seen.current && [...pending].some((id) => !seen.current!.has(id))) {
      try { const a = new AudioContext(); const o = a.createOscillator(); o.frequency.value = 988; o.connect(a.destination); o.start(); o.stop(a.currentTime + 0.4) } catch { /* sound needs a tap first */ }
      toast('New booking request!', 'info')
    }
    seen.current = pending
  }, [list.data]) // eslint-disable-line react-hooks/exhaustive-deps

  const act = (name: string, args: Record<string, unknown>) =>
    mutate(name, { p_token: auth.token, ...args }).then(() => list.refetch()).catch((e) => toast(e.message, 'error'))

  const all = list.data ?? []
  const pending = all.filter((r) => r.status === 'pending')
  const counts = ['pending', 'confirmed', 'seated', 'no_show'].map((k) => [k, all.filter((r) => r.status === k).length] as const).filter(([, n]) => n > 0)
  const range = from === today && to === today ? 'today' : from === tomorrow && to === tomorrow ? 'tomorrow' : 'week'
  const setRange = (v: string) => { if (v === 'today') { setFrom(today); setTo(today) } else if (v === 'tomorrow') { setFrom(tomorrow); setTo(tomorrow) } else { setFrom(today); setTo(manilaDate(new Date(deviceNow().getTime() + 7 * 86400_000))) } }

  return (
    <div>
      {pending[0] && (
        <div className="rounded-2xl border border-gold-600/70 bg-gold-700/20 p-4 mb-5 flex flex-wrap items-center gap-3">
          <span className="text-2xl">🔔</span>
          <div className="flex-1 min-w-48"><div className="font-semibold text-gold-200">New booking · waiting for confirmation</div>
            <div className="text-sm">{pending[0].customer_name} · {pending[0].party_size} pax · {dateTime(pending[0].reserved_for)}{pending[0].notes ? ` · ${pending[0].notes}` : ''}</div></div>
          <a href={`tel:${pending[0].phone}`} className="min-h-11 px-4 rounded-xl bg-charcoal-800 border border-charcoal-700 grid place-items-center text-sm font-medium">Call guest</a>
          <Button variant="gold" onClick={() => act('confirm_reservation', { p_reservation_id: pending[0].id })}>Confirm &amp; send SMS{pending[0].email ? ' + email' : ''}</Button>
        </div>
      )}
      <PageHeader eyebrow="Service" title="Reservations">
        <Tabs value={range} onChange={setRange} items={[['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'Next 7 days']]} />
        <Button variant="gold" onClick={() => setNewOpen(true)}>+ Phone / FB booking</Button>
      </PageHeader>
      {counts.length > 0 && <div className="flex flex-wrap gap-2 mb-4">{counts.map(([k, n]) => <Pill key={k} tone={k}>{n} {k.replace('_', '-')}</Pill>)}</div>}
      <ErrorBox error={list.error} />
      {all.length === 0 && <Empty>No bookings in this range.</Empty>}
      <div className="space-y-2">
        {all.map((r) => (
          <div key={r.id} className={`rounded-2xl border bg-charcoal-900 p-4 flex flex-wrap items-center gap-x-5 gap-y-3 ${r.status === 'pending' ? 'border-gold-600/70' : 'border-charcoal-700'}`}>
            <div className="w-20"><div className="font-display text-xl font-bold">{time(r.reserved_for).replace(/ [AP]M/, '')}</div>{range !== 'today' && <div className="text-xs text-silver">{r.reserved_for.slice(5, 10)}</div>}</div>
            <div className="flex-1 min-w-52">
              <div className="font-semibold">{r.customer_name}</div>
              <div className="text-sm text-silver">{r.party_size} pax{r.table_label ? ` · T${r.table_label}` : ''} · {r.package_interest.replace(/_/g, ' ')} · {r.code}{r.notes ? ` · “${r.notes}”` : ''}</div>
              {r.messages?.length > 0 && <div className="text-xs text-silver mt-0.5">{r.messages.map((m: any) => `${m.channel.toUpperCase()} ${m.event}: ${m.status}`).join(' · ')}</div>}
            </div>
            <Pill tone={r.status}>{r.status === 'no_show' ? 'No-show' : r.status[0].toUpperCase() + r.status.slice(1)}</Pill>
            <div className="flex flex-wrap gap-2">
              {r.status === 'pending' && <><Button onClick={() => { const reason = prompt('Reason (e.g. fully booked — suggest another time)'); if (reason) act('decline_reservation', { p_reservation_id: r.id, p_reason: reason }) }}>Decline</Button>
                <Button variant="gold" onClick={() => act('confirm_reservation', { p_reservation_id: r.id })}>Confirm</Button></>}
              {r.status === 'confirmed' && <><Button onClick={() => act('mark_no_show', { p_reservation_id: r.id })}>{r.suggest_no_show ? 'No-show?' : 'No-show'}</Button>
                <Button variant="gold" onClick={() => nav('/floor', { state: { reservation: r.id } })}>Seat</Button>
                <Button variant="ghost" onClick={() => { const reason = prompt('Cancellation note'); if (reason !== null) act('decline_reservation', { p_reservation_id: r.id, p_reason: reason, p_status: 'cancelled' }) }}>Cancel</Button></>}
            </div>
          </div>
        ))}
      </div>
      {newOpen && <StaffBooking onClose={() => { setNewOpen(false); list.refetch() }} />}
    </div>
  )
}

function StaffBooking({ onClose }: { onClose: () => void }) {
  const auth = useAuth()
  const [f, setF] = useState<any>({ date: manilaDate(deviceNow()), time: '18:00', party_size: 4, package_interest: 'unli_pork', source: 'phone' })
  const [err, setErr] = useState<unknown>(null)
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value })
  return (
    <Modal open onClose={onClose} title="New booking (phone / Facebook)">
      <div className="grid grid-cols-2 gap-x-3">
        <Field label="Date"><input type="date" className={inputCls} value={f.date} onChange={set('date')} /></Field>
        <Field label="Time"><input type="time" step={1800} className={inputCls} value={f.time} onChange={set('time')} /></Field>
        <Field label="Party size"><input type="number" min={1} className={inputCls} value={f.party_size} onChange={set('party_size')} /></Field>
        <Field label="Source"><select className={inputCls} value={f.source} onChange={set('source')}>{['phone', 'facebook', 'walk_in'].map((s) => <option key={s}>{s}</option>)}</select></Field>
      </div>
      <Field label="Name"><input className={inputCls} value={f.customer_name ?? ''} onChange={set('customer_name')} /></Field>
      <Field label="Mobile"><input className={inputCls} inputMode="tel" value={f.phone ?? ''} onChange={set('phone')} /></Field>
      <Field label="Package"><select className={inputCls} value={f.package_interest} onChange={set('package_interest')}>
        {[['unli_pork', 'Unli Pork'], ['unli_beef_pork', 'Unli Beef + Pork'], ['lunch', 'Lunch'], ['not_sure', 'Not sure']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
      <Field label="Notes"><input className={inputCls} value={f.notes ?? ''} onChange={set('notes')} /></Field>
      <ErrorBox error={err} />
      <Button variant="gold" className="w-full" onClick={() => mutate('create_staff_reservation', { p_token: auth.token, p_branch: auth.branchId, p_booking: f }).then(onClose).catch(setErr)}>Save &amp; confirm</Button>
    </Modal>
  )
}

// ───── Public booking page (§7.1) — ivory / gold / black, mobile-first ─────
export function BookPage() {
  const branchCode = new URLSearchParams(location.search).get('branch') ?? 'CANDON'
  const [date, setDate] = useState(manilaDate(new Date(Date.now() + 86400_000)))
  const [party, setParty] = useState(4)
  const [interest, setInterest] = useState('unli_pork')
  const [slot, setSlot] = useState('')
  const [form, setForm] = useState({ customer_name: '', phone: '', email: '', notes: '', consent_privacy: false })
  const [avail, setAvail] = useState<any>(null)
  const [done, setDone] = useState<any>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    setSlot('')
    getBackend().then((b) => b.rpc('public_availability', { p_branch_code: branchCode, p_date: date, p_party: party, p_interest: interest }))
      .then(setAvail).catch((e) => setErr(e.message))
  }, [date, party, interest, branchCode])

  // Cloudflare Turnstile anti-spam widget (production only; the Edge Function verifies the token)
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY
  useEffect(() => {
    if (!siteKey || document.getElementById('cf-turnstile-js')) return
    ;(window as any).onTurnstile = (token: string) => { (window as any).turnstileToken = token }
    const sc = document.createElement('script')
    sc.id = 'cf-turnstile-js'; sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'; sc.async = true
    document.head.appendChild(sc)
  }, [siteKey])

  const submit = async () => {
    setErr('')
    try {
      const booking = { ...form, date, time: slot, party_size: party, package_interest: interest }
      // The Edge Function verifies Cloudflare Turnstile, then creates the booking.
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/public-booking`, { method: 'POST',
        headers: { 'content-type': 'application/json', apikey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? '' },
        body: JSON.stringify({ branch_code: branchCode, booking, turnstile_token: (window as any).turnstileToken }) })
        .then(async (x) => { const j = await x.json(); if (!x.ok) throw new Error(j.message); return j })
      setDone(r)
    } catch (e) { setErr((e as Error).message) }
  }

  const ic = 'w-full min-h-12 rounded-xl border border-charcoal-700 bg-charcoal-800 px-3.5 text-[#ece6da] placeholder:text-silver/50 focus:outline-none focus:border-gold-500'
  const branchName = avail?.branch?.name?.replace('Golden Korean BBQ — ', '') ?? 'Candon City'
  const PKG = [['unli_pork', 'Unli Pork'], ['unli_beef_pork', 'Unli Beef + Pork'], ['lunch', 'Lunch'], ['not_sure', 'Not sure']]
  const when = new Date(`${date}T12:00:00+08:00`).toLocaleDateString('en-PH', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'Asia/Manila' })
  const slotLabel = avail?.slots?.find((x: any) => x.time === slot)?.label
  return (
    <div className="min-h-full bg-black text-[#ece6da]">
      <header className="border-b border-charcoal-800">
        <div className="max-w-5xl mx-auto px-4 h-20 flex items-center justify-between"><Logo className="h-12" /><span className="label">{branchName}</span></div>
      </header>
      <main className="max-w-5xl mx-auto px-4 py-10 grid lg:grid-cols-[1fr_440px] gap-10 items-start">
        <div className="hidden lg:block pt-6">
          <div className="label text-gold-400 mb-3">Unlimited Korean barbecue</div>
          <h1 className="font-display text-5xl font-bold leading-tight mb-5">Grilled at your table. Gold on every plate.</h1>
          <p className="text-silver mb-8 max-w-md">Samgyupsal, marinated meats and banchan refills for two full hours. Lunch 11 AM – 3 PM · Unlimited grill 3 PM – 10 PM.</p>
          <div className="flex gap-10"><div><div className="font-display text-2xl font-bold">2 hrs</div><div className="text-xs text-silver">dining time</div></div>
            <div><div className="font-display text-2xl font-bold">3 PM</div><div className="text-xs text-silver">unli starts</div></div>
            <div><div className="font-display text-2xl font-bold">SMS</div><div className="text-xs text-silver">confirmation</div></div></div>
        </div>
        {done ? (
          <div className="rounded-3xl bg-charcoal-900 border border-charcoal-700 p-7 text-center">
            <div className="size-16 rounded-full bg-gold-400 text-charcoal-950 grid place-items-center text-3xl mx-auto mb-4">✓</div>
            <h2 className="font-display text-2xl font-bold mb-1">Request received, {form.customer_name.split(' ')[0]}</h2>
            <p className="text-silver text-sm mb-6">The restaurant will confirm shortly. We'll text you at {form.phone}.</p>
            <div className="rounded-2xl border border-charcoal-700 divide-y divide-charcoal-800 text-sm text-left mb-6">
              {[['Branch', branchName], ['Date', when], ['Time', slotLabel], ['Guests', String(party)], ['Reference', done.code]].map(([k, v]) => (
                <div key={k} className="flex justify-between px-4 py-3"><span className="text-silver">{k}</span><span className={`font-semibold ${k === 'Reference' ? 'text-gold-300 tracking-wider' : ''}`}>{v}</span></div>))}
            </div>
            <ol className="text-left text-sm space-y-3">
              <li className="flex gap-3"><span className="size-3 mt-1 rounded-full bg-gold-400" /><span><b>Booking received</b><br /><span className="text-silver">Just now</span></span></li>
              <li className="flex gap-3"><span className="size-3 mt-1 rounded-full border border-gold-400" /><span><b>Confirmed by staff</b><br /><span className="text-silver">You'll get an SMS{form.email ? ' and email' : ''}</span></span></li>
              <li className="flex gap-3"><span className="size-3 mt-1 rounded-full border border-gold-400" /><span><b>Reminder</b><br /><span className="text-silver">We'll text you before your booking</span></span></li>
            </ol>
            <p className="text-xs text-silver mt-6">Questions or changes? Call {avail?.branch?.phone}.</p>
          </div>
        ) : (
          <div className="rounded-3xl bg-charcoal-900 border border-charcoal-700 p-6">
            <h2 className="font-display text-xl font-bold text-gold-300 mb-5">Reserve your table</h2>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <label className="block"><span className="text-sm text-silver">Date</span><input type="date" className={ic} value={date} min={manilaDate()} onChange={(e) => setDate(e.target.value)} /></label>
              <label className="block"><span className="text-sm text-silver">Guests</span><input type="number" min={1} max={avail?.max_online_party ?? 16} className={ic} value={party} onChange={(e) => setParty(Number(e.target.value))} /></label>
            </div>
            {party > Number(avail?.max_online_party ?? 16) && <p className="text-sm text-bad mb-3">For groups over {avail?.max_online_party}, please call {avail?.branch?.phone}.</p>}
            <div className="grid grid-cols-2 gap-2 mb-4">
              {PKG.map(([v, l]) => <button key={v} onClick={() => setInterest(v)} className={`min-h-11 rounded-xl border text-sm ${interest === v ? 'border-gold-400 bg-gold-400/10 text-gold-200 font-semibold' : 'border-charcoal-700 bg-charcoal-800'}`}>{l}</button>)}
            </div>
            <span className="text-sm text-silver">Time</span>
            <div className="grid grid-cols-4 gap-2 mt-1 mb-5">
              {(avail?.slots ?? []).map((s: any) => (
                <button key={s.time} disabled={!s.available} onClick={() => setSlot(s.time)}
                  className={`min-h-11 rounded-xl border text-sm transition ${slot === s.time ? 'bg-gold-400 text-charcoal-950 border-gold-400 font-semibold' : s.available ? 'bg-charcoal-800 border-charcoal-700 hover:border-gold-600' : 'border-transparent text-silver/30 line-through'}`}>{s.label.replace(':00 ', ' ')}</button>
              ))}
            </div>
            <div className="space-y-3 mb-4">
              <label className="block"><span className="text-sm text-silver">Full name</span><input className={ic} autoComplete="name" placeholder="Juan Dela Cruz" value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} /></label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block"><span className="text-sm text-silver">Mobile</span><input className={ic} inputMode="tel" autoComplete="tel" placeholder="09XX XXX XXXX" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
                <label className="block"><span className="text-sm text-silver">Email (optional)</span><input className={ic} type="email" autoComplete="email" placeholder="you@email.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
              </div>
              <label className="block"><span className="text-sm text-silver">Notes (birthday, high chair, PWD access)</span><input className={ic} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
              <label className="flex gap-3 items-start text-sm text-silver">
                <input type="checkbox" className="mt-1 size-5 accent-[#d4b062]" checked={form.consent_privacy} onChange={(e) => setForm({ ...form, consent_privacy: e.target.checked })} />
                <span>I agree that Golden Korean BBQ may use my name and contact details only to handle this reservation (Data Privacy Act, RA 10173).</span>
              </label>
            </div>
            {siteKey && <div className="cf-turnstile mb-3" data-sitekey={siteKey} data-callback="onTurnstile" data-theme="dark" />}
            {err && <p className="rounded-xl bg-bad-bg text-bad p-3 mb-3 text-sm">{err}</p>}
            <button className="w-full min-h-14 rounded-xl bg-gold-400 text-charcoal-950 text-base font-bold disabled:opacity-40 hover:bg-gold-300 transition"
              disabled={!slot || !form.customer_name || !form.phone || !form.consent_privacy} onClick={submit}>Book now</button>
            <p className="text-xs text-silver text-center mt-3">You'll get a confirmation by SMS once the restaurant confirms, and a reminder before your booking.</p>
          </div>
        )}
      </main>
    </div>
  )
}
