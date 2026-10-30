// One interface, two backends: Supabase (production) and an in-browser PGlite demo that runs the same SQL.
export interface Backend {
  kind: 'local' | 'supabase'
  rpc<T = any>(name: string, args?: Record<string, unknown>): Promise<T>
  /** Called whenever data may have changed (realtime events, or local writes in any tab). */
  onChange(cb: (table?: string) => void): () => void
  signIn(account: { email?: string; password?: string; authUid?: string }): Promise<void>
  signOut(): Promise<void>
  isSignedIn(): boolean
}

export class RpcError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

// Network-type failures are retried from the outbox; business-rule errors are not.
export const isOfflineError = (e: unknown) =>
  e instanceof RpcError ? e.code === 'OFFLINE' : e instanceof TypeError || /fetch|network/i.test(String(e))

export const READ_PREFIXES = ['get_', 'list_', 'report_', 'whoami', 'public_availability', 'shift_summary']
export const isRead = (name: string) => READ_PREFIXES.some((p) => name.startsWith(p))

// Cache the promise, not the result: screens ask for the backend at the same time on first load.
let current: Promise<Backend> | null = null

export function getBackend(): Promise<Backend> {
  current ??= import.meta.env.VITE_SUPABASE_URL
    ? import('./supabaseBackend').then((m) => m.createSupabaseBackend())
    : import('./localBackend').then((m) => m.createLocalBackend())
  return current
}

export const backendKind = (): 'local' | 'supabase' => (import.meta.env.VITE_SUPABASE_URL ? 'supabase' : 'local')
