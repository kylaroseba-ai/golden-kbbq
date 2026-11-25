import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../lib/auth'
import { getBackend } from '../lib/backend'
import { useRpc } from '../lib/hooks'
import { Avatar, Button, ErrorBox, Field, Logo, inputCls } from '../components/ui'

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-full grid place-items-center p-4 bg-[radial-gradient(ellipse_at_top,rgba(212,176,98,.10),transparent_60%)]">
      <div className="w-full max-w-xl">
        <Logo className="h-24 sm:h-28 mx-auto mb-10" />
        {children}
      </div>
    </div>
  )
}

export function Login() {
  const auth = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [resetSent, setResetSent] = useState(false)
  const submit = async () => {
    setBusy(true); setErr(null)
    try { await auth.signIn(email, password) } catch (e) { setErr(e) } finally { setBusy(false) }
  }
  const forgot = async () => {
    setErr(null)
    if (!email.includes('@')) { setErr(new Error('Type your email first, then tap “Forgot password?”.')); return }
    try { await (await getBackend()).sendPasswordReset(email.trim()); setResetSent(true) } catch (e) { setErr(e) }
  }
  return (
    <Shell>
      <form className="rounded-3xl bg-charcoal-900/70 border border-charcoal-700 p-6" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <h2 className="font-display text-xl font-bold mb-1">Sign in</h2>
        <p className="text-sm text-silver mb-5">Owners and managers sign in with their email. Staff use their PIN on a restaurant device.</p>
        <Field label="Email"><input className={inputCls} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password"><input className={inputCls} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <ErrorBox error={err} />
        {resetSent && <p className="text-ok text-sm mb-3">Check your email for a link to set a new password.</p>}
        <Button variant="gold" big className="w-full" type="submit" disabled={busy || !email || !password}>{busy ? 'Signing in…' : 'Sign in'}</Button>
        <button type="button" className="mt-4 text-sm text-silver hover:text-gold-300" onClick={forgot}>Forgot password?</button>
      </form>
      <p className="text-center mt-6 text-sm text-silver">New restaurant phone or tablet? A manager signs in here once, then opens <b>Setup → Devices</b> to make it a shared device.</p>
      <p className="text-center mt-3 text-sm"><Link className="text-gold-300 hover:underline" to="/book">Customer booking page →</Link></p>
    </Shell>
  )
}

// Opened from an invite or password-reset email: the person chooses their own password.
export function SetPassword() {
  const auth = useAuth()
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [err, setErr] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const name = auth.who.mode === 'personal' ? auth.who.user.full_name : ''
  const save = async () => {
    setErr(null)
    if (pw.length < 8) { setErr(new Error('Use at least 8 characters.')); return }
    if (pw !== pw2) { setErr(new Error('The two passwords do not match.')); return }
    setBusy(true)
    try { await (await getBackend()).setPassword(pw); auth.passwordDone() } catch (e) { setErr(e) } finally { setBusy(false) }
  }
  return (
    <Shell>
      <form className="rounded-3xl bg-charcoal-900/70 border border-charcoal-700 p-6" onSubmit={(e) => { e.preventDefault(); save() }}>
        <h2 className="font-display text-xl font-bold mb-1">Choose your password</h2>
        <p className="text-sm text-silver mb-5">{name ? `Welcome, ${name}. ` : ''}You will use this password with your email to sign in.</p>
        <Field label="New password"><input className={inputCls} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
        <Field label="Type it again"><input className={inputCls} type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
        <ErrorBox error={err} />
        <Button variant="gold" big className="w-full" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</Button>
      </form>
    </Shell>
  )
}

export function NotConfigured() {
  return (
    <Shell>
      <div className="rounded-3xl bg-charcoal-900/70 border border-charcoal-700 p-6">
        <h2 className="font-display text-xl font-bold mb-2">Database not connected</h2>
        <p className="text-sm text-silver">Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> (see <code>.env.example</code>), then restart.</p>
      </div>
    </Shell>
  )
}

// Shared device: tap your name, enter your PIN (§3, §11.1).
export function PinScreen() {
  const auth = useAuth()
  const { t } = useTranslation()
  const deviceId = auth.who.mode === 'device' ? auth.who.device.id : null
  const staff = useRpc<any[]>('list_device_staff', { p_device_id: deviceId }, { enabled: !!deviceId, cache: true })
  const [userId, setUserId] = useState<string | null>(null)
  const [pin, setPin] = useState('')
  const [msg, setMsg] = useState('')
  const cached = new Set(auth.cachedStaff.map((s) => s.user.id))
  const person = staff.data?.find((s) => s.id === userId)
  const submit = async (p: string) => {
    try {
      const r = await auth.pinSignIn(userId!, p)
      if (!r.ok) { setMsg(r.message ?? 'Wrong PIN'); setPin('') }
    } catch (e) {
      // offline: switch to someone who already verified on this device today
      if (cached.has(userId!)) auth.switchToCached(userId!)
      else { setMsg((e as Error).message); setPin('') }
    }
  }
  return (
    <Shell>
      <div className="rounded-3xl bg-charcoal-900/70 border border-charcoal-700 p-6">
        <div className="label mb-1">{auth.who.mode === 'device' ? auth.who.device.label : ''}</div>
        {!person ? (
          <>
            <h2 className="font-display text-xl font-bold mb-5">{t('who_are_you')}</h2>
            <div className="grid grid-cols-2 gap-2">
              {(staff.data ?? []).map((s) => (
                <button key={s.id} onClick={() => { setUserId(s.id); setMsg('') }}
                  className="rounded-2xl bg-charcoal-900 border border-charcoal-700 hover:border-gold-500 p-3 min-h-16 text-left flex items-center gap-3 transition">
                  <Avatar name={s.full_name} />
                  <span className="min-w-0"><span className="block font-semibold truncate">{s.full_name}</span>
                    <span className="block text-xs text-silver capitalize">{(s.roles ?? [s.role]).join(' + ')}{cached.has(s.id) ? ' · signed in today' : ''}</span></span>
                </button>
              ))}
            </div>
            <ErrorBox error={staff.error} />
            <button className="mt-5 text-sm text-silver hover:text-gold-300" onClick={() => auth.signOut()}>Sign this device out</button>
          </>
        ) : (
          <div className="max-w-xs mx-auto text-center">
            <Avatar name={person.full_name} className="!size-14 !text-base mb-2" />
            <h2 className="font-display text-xl font-bold">{person.full_name}</h2>
            <p className="text-silver text-sm mb-4">{t('enter_pin')}</p>
            <div className="flex justify-center gap-3 mb-4" aria-label="PIN">
              {[0, 1, 2, 3, 4, 5].map((i) => <span key={i} className={`size-3.5 rounded-full transition ${i < pin.length ? 'bg-gold-400' : 'bg-charcoal-700'}`} />)}
            </div>
            {msg && <p className="text-bad text-sm mb-3">{msg}</p>}
            <div className="grid grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'].map((k) => (
                <button key={k} disabled={k === '✓' && pin.length < 4}
                  className={`h-16 rounded-2xl text-2xl font-semibold transition active:scale-95 disabled:opacity-40 ${k === '✓' ? 'bg-gold-400 text-charcoal-950' : 'bg-charcoal-800 border border-charcoal-700 hover:border-charcoal-600'}`}
                  onClick={() => { if (k === '⌫') setPin(pin.slice(0, -1)); else if (k === '✓') submit(pin); else if (pin.length < 6) setPin(pin + k) /* PINs are 4–6 digits */ }}>{k}</button>
              ))}
            </div>
            <button className="mt-5 text-sm text-silver hover:text-gold-300" onClick={() => { setUserId(null); setPin('') }}>← Not you?</button>
          </div>
        )}
      </div>
    </Shell>
  )
}
