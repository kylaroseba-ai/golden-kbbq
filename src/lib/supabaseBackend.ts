import { createClient } from '@supabase/supabase-js'
import { type Backend, RpcError } from './backend'
import { parseError } from './rpcSql'

// Tables whose changes refresh open screens (see 0007_supabase_only.sql publication).
const LIVE_TABLES = ['item_stock_levels', 'kitchen_tickets', 'kitchen_ticket_lines', 'refill_rounds', 'notifications',
  'reservations', 'table_sessions', 'dining_tables', 'order_lines']

export function createSupabaseBackend(): Backend {
  const sb = createClient(import.meta.env.VITE_SUPABASE_URL!, import.meta.env.VITE_SUPABASE_ANON_KEY!)
  const listeners = new Set<(t?: string) => void>()
  let signedIn = false
  sb.auth.getSession().then(({ data }) => { signedIn = !!data.session })
  sb.auth.onAuthStateChange((_e, s) => { signedIn = !!s })

  const channel = sb.channel('live')
  for (const table of LIVE_TABLES) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => listeners.forEach((l) => l(table)))
  }
  channel.subscribe()

  return {
    kind: 'supabase',
    async rpc(name, args = {}) {
      if (!navigator.onLine) throw new RpcError('OFFLINE', 'No internet connection.')
      const { data, error } = await sb.rpc(name, args)
      if (error) {
        if (/fetch|network/i.test(error.message)) throw new RpcError('OFFLINE', error.message)
        const e = parseError(error)
        throw new RpcError(e.code, e.message)
      }
      return data
    },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb) },
    async signIn({ email, password }) {
      const { error } = await sb.auth.signInWithPassword({ email: email!, password: password! })
      if (error) throw new RpcError('SIGN_IN', error.message)
      signedIn = true
    },
    async signOut() { await sb.auth.signOut(); signedIn = false },
    isSignedIn: () => signedIn,
  }
}
