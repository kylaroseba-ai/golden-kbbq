import { useState } from 'react'
import { DEMO_CLOCK_KEY, DEMO_OFFLINE_KEY, demoNow, resetDemoDatabase } from '../lib/localBackend'
import { manilaDate } from '../lib/format'

// Local demo only: move the restaurant clock, simulate losing internet, reset data.
export function DemoBar() {
  const [clock] = useState(demoNow())
  const [open, setOpen] = useState(window.innerWidth >= 768)
  const [offline, setOffline] = useState(sessionStorage.getItem(DEMO_OFFLINE_KEY) === '1')
  const setAt = (hhmm: string | null) => {
    if (hhmm) localStorage.setItem(DEMO_CLOCK_KEY, JSON.stringify({ base: `${manilaDate()}T${hhmm}:00+08:00`, at: Date.now() }))
    else localStorage.removeItem(DEMO_CLOCK_KEY)
    location.reload()
  }
  return (
    <div className="no-print bg-[#15130e] border-b border-gold-700/40 text-silver text-xs px-4 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
      <button className="font-bold text-gold-300 tracking-widest" onClick={() => setOpen(!open)}>DEMO {open ? '▴' : '▾'}</button>
      <span>Data lives in this browser only.</span>
      {open && <>
      <span className="ml-auto">Clock:</span>
      {[['12:00', 'Lunch 12 PM'], ['14:55', '2:55 PM'], ['18:00', 'Unli 6 PM'], ['19:16', '7:16 PM']].map(([v, l]) => (
        <button key={v} className="rounded-md bg-charcoal-800 border border-charcoal-700 px-2 py-1 hover:border-gold-600" onClick={() => setAt(v)}>{l}</button>
      ))}
      <button className={`rounded-md px-2 py-1 border ${clock ? 'bg-charcoal-800 border-charcoal-700' : 'bg-gold-700/50 border-gold-600 text-gold-200'}`} onClick={() => setAt(null)}>Real time</button>
      {clock && <span className="text-gold-300">(demo time {new Date(clock).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' })})</span>}
      <label className="flex items-center gap-1 ml-2">
        <input type="checkbox" checked={offline} onChange={(e) => {
          sessionStorage.setItem(DEMO_OFFLINE_KEY, e.target.checked ? '1' : '0'); setOffline(e.target.checked)
          window.dispatchEvent(new Event('gkb-offline-toggle'))
        }} /> Simulate offline
      </label>
      <button className="rounded-md bg-bad-bg text-bad px-2 py-1" onClick={async () => {
        if (!confirm('Reset all demo data in this browser?')) return
        localStorage.clear(); sessionStorage.clear(); await resetDemoDatabase(); location.reload()
      }}>Reset demo</button>
      </>}
    </div>
  )
}
