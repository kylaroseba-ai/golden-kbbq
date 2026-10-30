import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { backendKind, getBackend, isOfflineError, RpcError } from './backend'
import i18n from './i18n'

export type Role = 'owner' | 'manager' | 'cashier' | 'server' | 'kitchen' | 'admin'
type Branch = { id: string; code: string; name: string; role?: Role }
type Who =
  | { mode: 'none' }
  | { mode: 'device'; device: { id: string; label: string; kind: string; branch_id: string }; branches: Branch[] }
  | { mode: 'personal'; user: { id: string; full_name: string; language: string }; branches: Branch[] }
export type Staff = { token: string; expires_at: string; user: { id: string; full_name: string; role: Role; language: string } }

interface Auth {
  ready: boolean
  who: Who
  branchId: string | null
  branches: Branch[]
  role: Role | null
  userName: string | null
  userId: string | null
  /** Staff token for RPCs from shared devices; null for personal logins. */
  token: string | null
  staff: Staff | null
  cachedStaff: Staff[]
  refresh(): Promise<void>
  signIn(account: { email?: string; password?: string; authUid?: string }): Promise<void>
  signOut(): Promise<void>
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

// A real device has one identity (localStorage). In the demo every browser tab is its own device (sessionStorage).
const store: Storage = backendKind() === 'local' ? sessionStorage : localStorage
const read = <T,>(k: string, d: T): T => { try { return JSON.parse(store.getItem(k) ?? '') ?? d } catch { return d } }
const valid = (s: Staff) => new Date(s.expires_at).getTime() > Date.now()

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [who, setWho] = useState<Who>(read<Who>(WHO, { mode: 'none' }))
  const [branchId, setBranchId] = useState<string | null>(store.getItem(BRANCH))
  const [tokens, setTokens] = useState<Record<string, Staff>>(read(TOKENS, {}))
  const [activeId, setActiveId] = useState<string | null>(store.getItem(ACTIVE))

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
      if (!isOfflineError(e)) throw e // offline: keep the cached identity
    } finally {
      setReady(true)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const saveTokens = (t: Record<string, Staff>) => { setTokens(t); store.setItem(TOKENS, JSON.stringify(t)) }
  const activate = (id: string | null) => { setActiveId(id); id ? store.setItem(ACTIVE, id) : store.removeItem(ACTIVE) }

  const staff = who.mode === 'device' && activeId && tokens[activeId] && valid(tokens[activeId]) ? tokens[activeId] : null
  const branches = who.mode === 'none' ? [] : who.branches
  const role: Role | null = who.mode === 'device' ? staff?.user.role ?? null
    : who.mode === 'personal' ? (branches.find((b) => b.id === branchId)?.role ?? null) : null

  useEffect(() => {
    const lang = staff?.user.language ?? (who.mode === 'personal' ? who.user.language : 'en')
    if (lang && i18n.language !== lang) i18n.changeLanguage(lang)
  }, [staff, who])

  const value = useMemo<Auth>(() => ({
    ready, who, branchId, branches, role, staff,
    token: staff?.token ?? null,
    userName: staff?.user.full_name ?? (who.mode === 'personal' ? who.user.full_name : null),
    userId: staff?.user.id ?? (who.mode === 'personal' ? who.user.id : null),
    cachedStaff: Object.values(tokens).filter(valid),
    refresh,
    async signIn(account) {
      const b = await getBackend()
      await b.signIn(account)
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
  }), [ready, who, branchId, branches, role, staff, tokens, refresh])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAuth outside AuthProvider')
  return c
}

export const isManager = (r: Role | null) => r === 'manager' || r === 'owner' || r === 'admin'
