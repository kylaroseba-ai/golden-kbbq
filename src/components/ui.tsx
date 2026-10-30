import { createContext, useCallback, useContext, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../lib/auth'
import { getBackend } from '../lib/backend'

import logoUrl from '../assets/logo.jpg'

type Variant = 'gold' | 'dark' | 'ghost' | 'danger' | 'ok'
const variants: Record<Variant, string> = {
  gold: 'bg-gold-400 text-charcoal-950 hover:bg-gold-300 font-semibold shadow-[0_1px_0_rgba(255,255,255,.25)_inset]',
  dark: 'bg-charcoal-800 text-[#ece6da] border border-charcoal-700 hover:border-charcoal-600 hover:bg-charcoal-700 font-medium',
  ghost: 'bg-transparent text-gold-300 border border-charcoal-700 hover:border-gold-600 font-medium',
  danger: 'bg-bad-bg text-bad border border-bad/30 hover:border-bad/60 font-semibold',
  ok: 'bg-emerald-600/90 text-white hover:bg-emerald-500 font-semibold',
}

export function Button({ variant = 'dark', className = '', big, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; big?: boolean }) {
  return <button {...p} className={`${variants[variant]} ${big ? 'min-h-14 px-6 text-base' : 'min-h-11 px-4 text-sm'} rounded-xl transition active:scale-[.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 ${className}`} />
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl bg-charcoal-900 border border-charcoal-700 p-5 ${className}`}>{children}</div>
}

export function CardTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return <div className="flex items-center justify-between gap-3 mb-4"><h3 className="font-semibold text-[15px]">{children}</h3>{right}</div>
}

export function Logo({ className = 'h-10' }: { className?: string }) {
  return <img src={logoUrl} alt="Golden Korean BBQ" className={`logo w-auto select-none ${className}`} draggable={false} />
}

export function PageHeader({ title, eyebrow, children }: { title: string; eyebrow?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
      <div>
        {eyebrow && <div className="label mb-1">{eyebrow}</div>}
        <h1 className="font-display text-2xl sm:text-[28px] font-bold tracking-wide text-[#f3ecdd]">{title}</h1>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block mb-4">
      <span className="block text-sm text-silver mb-1.5">{label}</span>
      {children}
      {hint && <span className="block text-xs text-silver/80 mt-1">{hint}</span>}
    </label>
  )
}

export const inputCls = 'w-full min-h-12 rounded-xl bg-charcoal-800 border border-charcoal-700 px-3.5 text-[#ece6da] placeholder:text-silver/50 focus:outline-none focus:border-gold-500 focus:ring-2 focus:ring-gold-500/20 transition'

// Status never relies on colour alone: text + icon (§9.5).
const PILL: Record<string, string> = {
  ok: 'bg-ok-bg text-ok', low: 'bg-bad-bg text-bad', out: 'bg-bad-bg text-bad', expired: 'bg-bad-bg text-bad',
  expiring: 'bg-warn-bg text-warn', near: 'bg-warn-bg text-warn', pending: 'bg-warn-bg text-warn', late: 'bg-warn-bg text-warn',
  confirmed: 'bg-ok-bg text-ok', working: 'bg-ok-bg text-ok', seated: 'bg-info-bg text-info', billing: 'bg-info-bg text-info',
  on_break: 'bg-info-bg text-info', absent: 'bg-bad-bg text-bad', declined: 'bg-bad-bg text-bad', cancelled: 'bg-bad-bg text-bad',
  no_show: 'bg-bad-bg text-bad', completed: 'bg-charcoal-700 text-silver', done: 'bg-charcoal-700 text-silver', off: 'bg-charcoal-700 text-silver',
  scheduled: 'bg-charcoal-700 text-silver',
}
export function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${PILL[tone] ?? 'bg-charcoal-700 text-silver'}`}>{children}</span>
}
export function StatusChip({ status }: { status: string }) {
  const { t } = useTranslation()
  const label: Record<string, string> = { ok: 'OK', low: 'Low', out: 'Out', expiring: 'Expiring', expired: 'Expired', near: 'Near reorder' }
  const icon: Record<string, string> = { ok: '✓', low: '▼', out: '✕', expiring: '⏱', expired: '⚠', near: '◔' }
  return <Pill tone={status}>{icon[status]} {t(`chip_${status}`, { defaultValue: label[status] ?? status })}</Pill>
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'bad' | 'warn' | 'info' }) {
  const c = tone === 'ok' ? 'text-ok' : tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : tone === 'info' ? 'text-info' : 'text-[#f3ecdd]'
  return (
    <div className="rounded-2xl bg-charcoal-900 border border-charcoal-700 p-5 min-w-0">
      <div className="label mb-2">{label}</div>
      <div className={`font-display text-[28px] leading-none font-bold ${c}`}>{value}</div>
      {sub && <div className="text-xs text-silver mt-2">{sub}</div>}
    </div>
  )
}

/** Level bar: on hand vs par, coloured by status. */
export function LevelBar({ value, max, status }: { value: number; max: number; status: string }) {
  const pct = Math.max(0, Math.min(100, max > 0 ? (value / max) * 100 : 0))
  const c = status === 'out' || status === 'low' ? 'bg-bad' : status === 'near' ? 'bg-warn' : 'bg-gold-400'
  return <div className="h-2 w-full rounded-full bg-charcoal-700 overflow-hidden"><div className={`h-full rounded-full ${c}`} style={{ width: `${Math.max(pct, value > 0 ? 3 : 0)}%` }} /></div>
}

export function Avatar({ name, className = '' }: { name: string; className?: string }) {
  const initials = name.replace(/\(.*?\)/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
  return <span className={`inline-grid place-items-center rounded-full bg-gold-700/50 text-gold-200 font-semibold text-xs size-9 shrink-0 ${className}`}>{initials}</span>
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: [T, ReactNode][] }) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-xl bg-charcoal-900 border border-charcoal-700 p-1">
      {items.map(([v, l]) => (
        <button key={v} onClick={() => onChange(v)} className={`min-h-10 px-4 rounded-lg text-sm font-medium transition ${value === v ? 'bg-charcoal-700 text-gold-300' : 'text-silver hover:text-[#ece6da]'}`}>{l}</button>
      ))}
    </div>
  )
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className={`w-full ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'} max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-2xl bg-charcoal-900 border border-charcoal-700 p-6 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-xl font-bold tracking-wide">{title}</h2>
          <button onClick={onClose} className="min-h-10 min-w-10 rounded-lg text-silver hover:bg-charcoal-700" aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ───── Toasts ─────
type Toast = { id: number; text: string; kind: 'ok' | 'error' | 'info' }
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {})
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3000)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-20 lg:bottom-4 inset-x-4 sm:left-auto sm:w-96 z-[60] space-y-2 no-print">
        {toasts.map((t) => (
          <div key={t.id} role="status" className={`rounded-xl px-4 py-3 shadow-2xl border text-sm font-medium ${t.kind === 'error' ? 'bg-bad-bg border-bad/40 text-bad'
            : t.kind === 'ok' ? 'bg-ok-bg border-ok/40 text-ok' : 'bg-charcoal-800 border-charcoal-600'}`}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}
export const useToast = () => useContext(ToastCtx)

// ───── Manager PIN override (§6, §11.1) ─────
type PinRequest = { reason: string; resolve: (token: string | null) => void }
const PinCtx = createContext<(reason: string) => Promise<string | null>>(async () => null)

export function ManagerPinProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<PinRequest | null>(null)
  const ask = useCallback((reason: string) => new Promise<string | null>((resolve) => setReq({ reason, resolve })), [])
  return (
    <PinCtx.Provider value={ask}>
      {children}
      {req && <ManagerPinDialog reason={req.reason} onDone={(tok) => { req.resolve(tok); setReq(null) }} />}
    </PinCtx.Provider>
  )
}
export const useManagerPin = () => useContext(PinCtx)

function ManagerPinDialog({ reason, onDone }: { reason: string; onDone: (t: string | null) => void }) {
  const auth = useAuth()
  const [managers, setManagers] = useState<{ id: string; full_name: string; role: string }[] | null>(null)
  const [mgr, setMgr] = useState('')
  const [pin, setPin] = useState('')
  const [err, setErr] = useState('')
  if (managers === null && auth.who.mode === 'device') {
    const deviceId = auth.who.device.id
    getBackend().then((b) => b.rpc('list_device_staff', { p_device_id: deviceId }))
      .then((list: any[]) => { const m = list.filter((s) => ['manager', 'owner', 'admin'].includes(s.role)); setManagers(m); setMgr(m[0]?.id ?? '') })
      .catch(() => setManagers([]))
  }
  return (
    <Modal open onClose={() => onDone(null)} title="Manager PIN">
      <p className="mb-4 text-silver">{reason}</p>
      {auth.who.mode !== 'device' ? <p className="text-amber-300">Overrides are entered on a shared device.</p> : (
        <>
          <Field label="Manager">
            <select className={inputCls} value={mgr} onChange={(e) => setMgr(e.target.value)}>
              {(managers ?? []).map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
            </select>
          </Field>
          <Field label="PIN">
            <input className={inputCls} type="password" inputMode="numeric" autoFocus value={pin} maxLength={6}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
          </Field>
          {err && <p className="text-red-300 mb-3">{err}</p>}
          <div className="flex gap-2">
            <Button variant="gold" className="flex-1" disabled={pin.length < 4 || !mgr} onClick={async () => {
              try { onDone(await auth.managerOverride(mgr, pin)) } catch (e) { setErr((e as Error).message); setPin('') }
            }}>Approve</Button>
            <Button onClick={() => onDone(null)}>Cancel</Button>
          </div>
        </>
      )}
    </Modal>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-center text-silver py-12 text-sm">{children}</div>
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null
  return <div className="rounded-xl border border-bad/30 bg-bad-bg text-bad p-3 my-3 text-sm">{(error as Error).message}</div>
}
