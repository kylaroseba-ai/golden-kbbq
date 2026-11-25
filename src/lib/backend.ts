// The app talks to one Supabase project: TEST on the developer laptop and preview builds, PROD on the live site.
export interface Backend {
  rpc<T = any>(name: string, args?: Record<string, unknown>): Promise<T>
  /** Calls an Edge Function with the current login (and staff token). */
  invoke<T = any>(fn: string, body: Record<string, unknown>): Promise<T>
  /** Called whenever data may have changed (Realtime events). */
  onChange(cb: (table?: string) => void): () => void
  /** Called when the Supabase login changes (sign-in, sign-out, invite or password-reset link). */
  onAuth(cb: (event: string) => void): () => void
  signIn(email: string, password: string): Promise<void>
  signOut(): Promise<void>
  sendPasswordReset(email: string): Promise<void>
  setPassword(password: string): Promise<void>
}

// Staff member signed in by PIN on this shared device; sent as the x-staff-token header on every request.
// Kept outside React so it is set before any screen starts loading data.
let staffToken: string | null = null
export const setStaffToken = (t: string | null) => { staffToken = t }
export const getStaffToken = () => staffToken

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

export const isConfigured = () => !!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY)

// Cache the promise, not the result: screens ask for the backend at the same time on first load.
let current: Promise<Backend> | null = null

export function getBackend(): Promise<Backend> {
  current ??= import('./supabaseBackend').then((m) => m.createSupabaseBackend())
  return current
}
