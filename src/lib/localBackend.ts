import { PGliteWorker } from '@electric-sql/pglite/worker'
import { type Backend, RpcError, isRead } from './backend'
import { buildRpcSql, parseError, signatureSql, type ArgTypes } from './rpcSql'

// Same SQL as Supabase: local shim, migrations (minus Supabase-only) and the demo seed.
const files = import.meta.glob(['../../supabase/local/*.sql', '../../supabase/migrations/*.sql', '../../supabase/seed.sql'],
  { query: '?raw', import: 'default', eager: true }) as Record<string, string>

function orderedSql(): string[] {
  const keys = Object.keys(files)
  const pick = (dir: string) => keys.filter((k) => k.includes(dir) && !k.includes('supabase_only')).sort()
  return [...pick('/local/'), ...pick('/migrations/'), ...keys.filter((k) => k.endsWith('seed.sql'))].map((k) => files[k])
}

function hash(text: string) {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export const DEMO_AUTH_KEY = 'gkb-demo-auth'        // per tab: each tab is its own demo device
export const DEMO_CLOCK_KEY = 'gkb-demo-clock'      // {"base": ISO, "at": ms} — simulated clock that keeps ticking

/** Current simulated time as ISO, or '' for the real clock. */
export function demoNow(): string {
  try {
    const c = JSON.parse(localStorage.getItem(DEMO_CLOCK_KEY) ?? '')
    return new Date(new Date(c.base).getTime() + (Date.now() - c.at)).toISOString()
  } catch { return '' }
}
export const DEMO_OFFLINE_KEY = 'gkb-demo-offline'  // '1' simulates this device losing internet

const bus = new BroadcastChannel('gkb-demo-changes')

export async function resetDemoDatabase() {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('/pglite/golden-kbbq-demo')
    req.onsuccess = req.onerror = req.onblocked = () => resolve()
  })
  sessionStorage.removeItem(DEMO_AUTH_KEY)
}

export async function createLocalBackend(): Promise<Backend> {
  const db = new PGliteWorker(new Worker(new URL('./pglite.worker.ts', import.meta.url), { type: 'module' }))
  await db.waitReady
  // First run, or the SQL changed since this browser built its demo database: (re)build it in one transaction.
  const sqls = orderedSql()
  const version = hash(sqls.join('\n'))
  await db.transaction(async (tx) => {
    const meta = await tx.query<{ r: string | null }>(`select to_regclass('demo_meta')::text r`)
    const have = meta.rows[0].r ? (await tx.query<{ v: string }>('select version v from demo_meta')).rows[0]?.v : null
    if (have === version && localStorage.getItem('gkb-demo-rebuild') !== '1') return
    await tx.exec('drop schema if exists public cascade; drop schema if exists app cascade; drop schema if exists auth cascade; create schema public;')
    for (const sql of sqls) await tx.exec(sql)
    await tx.exec(`create table demo_meta(version text); insert into demo_meta values ('${version}');`)
  })
  localStorage.removeItem('gkb-demo-rebuild')
  const sig = await db.query<{ name: string; argname: string; argtype: string }>(signatureSql)
  const types: Record<string, ArgTypes> = {}
  for (const r of sig.rows) { types[r.name] ??= {}; if (r.argname) types[r.name][r.argname] = r.argtype }

  const listeners = new Set<(t?: string) => void>()
  bus.onmessage = () => listeners.forEach((l) => l())
  const emit = () => { bus.postMessage('change'); listeners.forEach((l) => l()) }

  return {
    kind: 'local',
    async rpc(name, args = {}) {
      if (sessionStorage.getItem(DEMO_OFFLINE_KEY) === '1') throw new RpcError('OFFLINE', 'No internet connection (simulated).')
      const fnTypes = types[name]
      if (!fnTypes) throw new RpcError('ERROR', `Unknown function ${name}`)
      const a = { ...args }
      if ('p_token' in fnTypes && !('p_token' in a)) a.p_token = null
      const { sql, params } = buildRpcSql(name, a, fnTypes)
      try {
        // one transaction per call: the auth claim and clock can't leak between tabs, and errors roll back
        const r = await db.transaction(async (tx) => {
          await tx.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('app.fake_now', $2, true)`,
            [sessionStorage.getItem(DEMO_AUTH_KEY) ?? '', demoNow()])
          return tx.query<{ r: unknown }>(sql, params)
        })
        if (!isRead(name)) emit()
        return r.rows[0].r as any
      } catch (e) {
        const err = parseError(e)
        throw new RpcError(err.code, err.message)
      }
    },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb) },
    async signIn({ authUid }) { sessionStorage.setItem(DEMO_AUTH_KEY, authUid!); emit() },
    async signOut() { sessionStorage.removeItem(DEMO_AUTH_KEY) },
    isSignedIn: () => !!sessionStorage.getItem(DEMO_AUTH_KEY),
  }
}

// Demo accounts to pick from on the sign-in screen (local demo only).
// Admin and the Taft test branch are not listed; open the sign-in page with ?staff=all to see them.
export const DEMO_ACCOUNTS = [
  { authUid: 'd0000000-0000-0000-0000-000000000001', label: 'Front counter', kind: 'device', icon: '₱', hint: 'Cashier & manager tablet' },
  { authUid: 'd0000000-0000-0000-0000-000000000002', label: 'Server phone 1', kind: 'device', icon: '▦', hint: 'Tables, refills, orders' },
  { authUid: 'd0000000-0000-0000-0000-000000000003', label: 'Server phone 2', kind: 'device', icon: '▦', hint: 'Tables, refills, orders' },
  { authUid: 'd0000000-0000-0000-0000-000000000004', label: 'Kitchen tablet', kind: 'device', icon: '♨', hint: 'Dispatch screen, stock, counts' },
  { authUid: 'a0000000-0000-0000-0000-000000000001', label: 'Owner', kind: 'personal', icon: '◧', hint: 'JD · all branches' },
  { authUid: 'a0000000-0000-0000-0000-000000000003', label: 'Branch manager', kind: 'personal', icon: '☰', hint: 'Mara Santos · Candon' },
  { authUid: 'a0000000-0000-0000-0000-000000000002', label: 'System admin', kind: 'personal', icon: '⚙', hint: 'Setup', hidden: true },
  { authUid: 'a0000000-0000-0000-0000-000000000008', label: 'Taft manager (test)', kind: 'personal', icon: '☰', hint: 'Branch isolation test', hidden: true },
] as const
