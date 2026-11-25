import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { getBackend, isOfflineError, RpcError, setStaffToken } from './backend'
import i18n from './i18n'

export type Role = 'owner' | 'admin' | 'manager' | 'cashier' | 'dispatch' | 'kitchen' | 'server' | 'utility'
type Branch = { id: string; code: string; name: string; role?: Role; roles?: Role[] }
type Who =
  | { mode: 'none' }
  | { mode: 'device'; device: { id: string; label: string; kind: string; branch_id: string }; branches: Branch[] }
  | { mode: 'personal'; user: { id: string; full_name: string; language: string; email?: string }; branches: Branch[] }
export type Staff = { token: string; expires_at: string; user: { id: string; full_name: string; role: Role; roles?: Role[]; language: string } }

interface Auth {
  ready: boolean
  who: Who
  branchId: string | null
  branches: Branch[]
  /** Highest role of the person acting (shown on screen). */
  role: Role | null
  /** Every role of the person acting in this branch (e.g. server + dispatch). */
  roles: Role[]
  /** True when the person has one of these roles; owner and admin always, dispatch counts as kitchen. */
  can(...roles: Role[]): boolean
  userName: string | null
  userId: string | null
  /** Staff token for RPCs from shared devices; null for personal logins. */
  token: string | null
  staff: Staff | null
  cachedStaff: Staff[]
  /** Set after opening an invite or password-reset link: the person must choose a password. */
  needsPassword: boolean
  passwordDone(): void
  refresh(): Promise<void>
  signIn(email: string, password: string): Promise<void>
  signOut(): Promise<void>
  registerDevice(label: string, kind: string): Promise<void>
  pinSignIn(userId: string, pin: string): Promise<{ ok: boolean; message?: string }>
  managerOverride(userId: string, pin: string): Promise<string>
  switchToCached(userId: string): void
  lock(): void
  setBranch(id: string): void
}

const Ctx = createContext<Auth | null>(null)
const TOKENS = 'gkb-staff-tokens'
const ACTIVE = 'gkb-active-staff'
const BRANCH = 'gkb-branch'
const WHO = 'gkb-who'

// Read the link type before Supabase clears the address bar (invite and password-reset links).
const linkType = new URLSearchParams(location.hash.slice(1)).get('type')
const store = localStorage
const read = <T,>(k: string, d: T): T => { try { return JSON.parse(store.getItem(k) ?? '') ?? d } catch { return d } }
const valid = (s: Staff) => new Date(s.expires_at).getTime() > Date.now()

export const hasRole = (mine: Role[], wanted: Role[]) =>
  mine.some((r) => r === 'owner' || r === 'admin' || wanted.includes(r) || (r === 'dispatch' && wanted.includes('kitchen')))

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [who, setWho] = useState<Who>(read<Who>(WHO, { mode: 'none' }))
  const [branchId, setBranchId] = useState<string | null>(store.getItem(BRANCH))
  const [tokens, setTokens] = useState<Record<string, Staff>>(read(TOKENS, {}))
  const [activeId, setActiveId] = useState<string | null>(store.getItem(ACTIVE))
  const [needsPassword, setNeedsPassword] = useState(linkType === 'invite' || linkType === 'recovery' || location.pathname === '/set-password')

  const refresh = useCallback(async () => {
    const b = await getBackend()
    try {
      const w = await b.rpc<Who>('whoami')
      setWho(w)
      store.setItem(WHO, JSON.stringify(w))
      if (w.mode !== 'none') {
        const ids = w.branches.map((x) => x.id)
        setBranchId((cur) => {
          const next = cur && ids.includes(cur) ? cur : ids[0] ?? null
          if (next) store.setItem(BRANCH, next)
          return next
        })
      }
    } catch (e) {
      if (!isOfflineError(e)) { setWho({ mode: 'none' }); store.removeItem(WHO) } // offline: keep the cached identity
    } finally {
      setReady(true)
    }
  }, [])

  useEffect(() => {
    refresh()
    let off = () => {}
    getBackend().then((b) => {
      off = b.onAuth((event) => {
        if (event === 'PASSWORD_RECOVERY') setNeedsPassword(true)
        if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'PASSWORD_RECOVERY') refresh()
      })
    })
    return () => off()
  }, [refresh])

  const saveTokens = (t: Record<string, Staff>) => { setTokens(t); store.setItem(TOKENS, JSON.stringify(t)) }
  const activate = (id: string | null) => { setActiveId(id); id ? store.setItem(ACTIVE, id) : store.removeItem(ACTIVE) }

  const staff = who.mode === 'device' && activeId && tokens[activeId] && valid(tokens[activeId]) ? tokens[activeId] : null
  // Set during render so the very first data requests already carry the staff token.
  setStaffToken(staff?.token ?? null)
  const branches = who.mode === 'none' ? [] : who.branches
  const branch = branches.find((b) => b.id === branchId)
  const roles: Role[] = who.mode === 'device' ? (staff ? staff.user.roles ?? [staff.user.role] : [])
    : who.mode === 'personal' ? (branch?.roles ?? (branch?.role ? [branch.role] : [])) : []
  const role: Role | null = who.mode === 'device' ? staff?.user.role ?? null : who.mode === 'personal' ? branch?.role ?? null : null

  useEffect(() => {
    const lang = staff?.user.language ?? (who.mode === 'personal' ? who.user.language : 'en')
    if (lang && i18n.language !== lang) i18n.changeLanguage(lang)
  }, [staff, who])

  const value = useMemo<Auth>(() => ({
    ready, who, branchId, branches, role, roles, staff, needsPassword,
    can: (...wanted: Role[]) => hasRole(roles, wanted),
    token: staff?.token ?? null,
    userName: staff?.user.full_name ?? (who.mode === 'personal' ? who.user.full_name : null),
    userId: staff?.user.id ?? (who.mode === 'personal' ? who.user.id : null),
    cachedStaff: Object.values(tokens).filter(valid),
    refresh,
    passwordDone() {
      setNeedsPassword(false)
      if (location.pathname === '/set-password') history.replaceState(null, '', '/')
    },
    async signIn(email, password) {
      const b = await getBackend()
      await b.signIn(email.trim(), password)
      saveTokens({}); activate(null)
      await refresh()
    },
    async signOut() {
      const b = await getBackend()
      await b.signOut()
      saveTokens({}); activate(null)
      store.removeItem(WHO)
      setWho({ mode: 'none' })
    },
    // A manager signed in on this phone/tablet turns it into a shared device (§11.1).
    async registerDevice(label, kind) {
      if (!branchId) throw new RpcError('NO_BRANCH', 'Pick a branch first.')
      const b = await getBackend()
      const r = await b.invoke<{ email: string; password: string }>('register-device', { branch_id: branchId, label, kind })
      await b.signOut()
      await b.signIn(r.email, r.password)
      saveTokens({}); activate(null)
      await refresh()
    },
    async pinSignIn(userId, pin) {
      if (who.mode !== 'device') throw new RpcError('ERROR', 'Not a shared device')
      const b = await getBackend()
      const r = await b.rpc('verify_pin', { p_device_id: who.device.id, p_user_id: userId, p_pin: pin, p_purpose: 'session' })
      if (!r.ok) return { ok: false, message: r.message }
      const s: Staff = { token: r.token, expires_at: r.expires_at, user: r.user }
      saveTokens({ ...tokens, [userId]: s })
      activate(userId)
      return { ok: true }
    },
    async managerOverride(userId, pin) {
      if (who.mode !== 'device') throw new RpcError('NEEDS_DEVICE', 'Manager overrides are entered on a shared device.')
      const b = await getBackend()
      const r = await b.rpc('verify_pin', { p_device_id: who.device.id, p_user_id: userId, p_pin: pin, p_purpose: 'override' })
      if (!r.ok) throw new RpcError(r.error, r.message)
      return r.token as string
    },
    switchToCached(userId) { if (tokens[userId] && valid(tokens[userId])) activate(userId) },
    lock() { activate(null) },
    setBranch(id) { setBranchId(id); store.setItem(BRANCH, id) },
  }), [ready, who, branchId, branches, role, roles.join(','), staff, tokens, refresh, needsPassword]) // eslint-disable-line react-hooks/exhaustive-deps

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAuth outside AuthProvider')
  return c
}

export const isManager = (r: Role | null) => r === 'manager' || r === 'owner' || r === 'admin'
