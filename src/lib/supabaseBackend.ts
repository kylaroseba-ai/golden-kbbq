import { createClient } from '@supabase/supabase-js'
import { type Backend, getStaffToken, RpcError, setStaffToken } from './backend'
import { parseError } from './rpcSql'

// Tables whose changes refresh open screens (see the Realtime publication in 0099_supabase_only.sql).
const LIVE_TABLES = ['item_stock_levels', 'kitchen_tickets', 'kitchen_ticket_lines', 'refill_rounds', 'notifications',
  'reservations', 'table_sessions', 'dining_tables', 'order_lines', 'time_entries', 'shift_schedules']

const fail = (error: { message: string; code?: string; details?: string; hint?: string }) => {
  if (/fetch|network|Load failed/i.test(error.message)) return new RpcError('OFFLINE', error.message)
  const e = parseError(error)
  return new RpcError(e.code, e.message)
}

export function createSupabaseBackend(): Backend {
  // Every request from a shared device carries the PIN-verified staff member, so the database knows who is acting.
  const withStaff: typeof fetch = (input, init = {}) => {
    const staffToken = getStaffToken()
    if (!staffToken) return fetch(input, init)
    const headers = new Headers(init.headers)
    headers.set('x-staff-token', staffToken)
    return fetch(input, { ...init, headers })
  }
  const sb = createClient(import.meta.env.VITE_SUPABASE_URL!, import.meta.env.VITE_SUPABASE_ANON_KEY!, {
    global: { fetch: withStaff },
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
  })
  const listeners = new Set<(t?: string) => void>()

  const channel = sb.channel('live')
  for (const table of LIVE_TABLES) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => listeners.forEach((l) => l(table)))
  }
  channel.subscribe()
  // Realtime needs the current login to apply row-level security to events.
  sb.auth.onAuthStateChange((_e, s) => { sb.realtime.setAuth(s?.access_token ?? null) })

  return {
    async rpc(name, args = {}) {
      if (!navigator.onLine) throw new RpcError('OFFLINE', 'No internet connection.')
      const { data, error } = await sb.rpc(name, args)
      if (error) throw fail(error)
      return data
    },
    async invoke(fn, body) {
      if (!navigator.onLine) throw new RpcError('OFFLINE', 'No internet connection.')
      const { data, error } = await sb.functions.invoke(fn, { body })
      if (error) {
        let message = error.message
        try { message = (await (error as any).context?.json())?.message ?? message } catch { /* keep default */ }
        throw new RpcError('FUNCTION', message)
      }
      return data
    },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb) },
    onAuth(cb) {
      const { data } = sb.auth.onAuthStateChange((event) => cb(event))
      return () => data.subscription.unsubscribe()
    },
    async signIn(email, password) {
      const { error } = await sb.auth.signInWithPassword({ email, password })
      if (error) throw new RpcError('SIGN_IN', error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message)
    },
    async signOut() { setStaffToken(null); await sb.auth.signOut() },
    async sendPasswordReset(email) {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/set-password` })
      if (error) throw new RpcError('RESET', error.message)
    },
    async setPassword(password) {
      const { error } = await sb.auth.updateUser({ password })
      if (error) throw new RpcError('PASSWORD', error.message)
    },
  }
}
