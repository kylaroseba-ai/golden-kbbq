import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { buildRpcSql, parseError, signatureSql, type ArgTypes } from '../src/lib/rpcSql'

const root = path.resolve(__dirname, '..')

// Same file list the browser demo backend uses: local shim, migrations (minus Supabase-only), seed.
export function sqlFiles(): string[] {
  const mig = fs.readdirSync(path.join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql') && !f.includes('supabase_only')).sort()
  return [
    path.join(root, 'supabase/local/0000_local_shim.sql'),
    ...mig.map((f) => path.join(root, 'supabase/migrations', f)),
    path.join(root, 'supabase/seed.sql'),
  ]
}

export const ids = {
  candon: '10000000-0000-0000-0000-000000000001',
  taft: '10000000-0000-0000-0000-000000000002',
  owner: { auth: 'a0000000-0000-0000-0000-000000000001', id: '20000000-0000-0000-0000-000000000001' },
  admin: { auth: 'a0000000-0000-0000-0000-000000000002', id: '20000000-0000-0000-0000-000000000002' },
  manager: { auth: 'a0000000-0000-0000-0000-000000000003', id: '20000000-0000-0000-0000-000000000003', pin: '1111' },
  cashier: { id: '20000000-0000-0000-0000-000000000004', pin: '2222' },
  server1: { id: '20000000-0000-0000-0000-000000000005', pin: '3333' },
  server2: { id: '20000000-0000-0000-0000-000000000006', pin: '4444' },
  kitchen: { id: '20000000-0000-0000-0000-000000000007', pin: '5555' },
  taftManager: { auth: 'a0000000-0000-0000-0000-000000000008', id: '20000000-0000-0000-0000-000000000008', pin: '9999' },
  counter: { id: '30000000-0000-0000-0000-000000000001', auth: 'd0000000-0000-0000-0000-000000000001' },
  phone1: { id: '30000000-0000-0000-0000-000000000002', auth: 'd0000000-0000-0000-0000-000000000002' },
  phone2: { id: '30000000-0000-0000-0000-000000000003', auth: 'd0000000-0000-0000-0000-000000000003' },
  kitchenTab: { id: '30000000-0000-0000-0000-000000000004', auth: 'd0000000-0000-0000-0000-000000000004' },
  terminal: '40000000-0000-0000-0000-000000000001',
  unliPork: '80000000-0000-0000-0000-000000000001',
  unliBeef: '80000000-0000-0000-0000-000000000002',
  bulgogiBowl: '80000000-0000-0000-0000-000000000011',
  coke: '80000000-0000-0000-0000-000000000031',
  regular: '90000000-0000-0000-0000-000000000001',
  senior: '90000000-0000-0000-0000-000000000002',
  kids: '90000000-0000-0000-0000-000000000004',
  managerDiscount: '90000000-0000-0000-0000-000000000007',
  supplierMeat: '60000000-0000-0000-0000-000000000001',
}

export class RpcFailure extends Error {
  constructor(public code: string, message: string) { super(`${code}: ${message}`) }
}

export async function makeDb() {
  const db = new PGlite()
  for (const f of sqlFiles()) {
    try { await db.exec(fs.readFileSync(f, 'utf8')) } catch (e) { throw new Error(`${path.basename(f)}: ${(e as Error).message}`) }
  }
  const sig = await db.query<{ name: string; argname: string; argtype: string }>(signatureSql)
  const types: Record<string, ArgTypes> = {}
  for (const r of sig.rows) { types[r.name] ??= {}; if (r.argname) types[r.name][r.argname] = r.argtype }

  async function rpc<T = any>(authUid: string | null, name: string, args: Record<string, unknown> = {}): Promise<T> {
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [authUid ?? ''])
    const fnTypes = types[name] ?? {}
    // personal logins (owner/manager/admin) act without a staff token
    if ('p_token' in fnTypes && !('p_token' in args)) args = { ...args, p_token: null }
    const { sql, params } = buildRpcSql(name, args, fnTypes)
    try {
      const res = await db.query<{ r: T }>(sql, params)
      return res.rows[0].r
    } catch (e) {
      const err = parseError(e)
      throw new RpcFailure(err.code, err.message)
    }
  }

  // Sign a person in on a shared device and return their staff token.
  async function pin(device: { id: string; auth: string }, user: { id: string; pin: string }, purpose = 'session'): Promise<string> {
    const r = await rpc(device.auth, 'verify_pin', { p_device_id: device.id, p_user_id: user.id, p_pin: user.pin, p_purpose: purpose })
    if (!r.ok) throw new Error(r.message)
    return r.token
  }

  async function one<T = any>(sql: string, params: unknown[] = []): Promise<T> {
    return (await db.query<T>(sql, params)).rows[0]
  }

  // Move the server clock (app.now()) used by every rule.
  async function clock(iso: string | null) {
    await db.query(`select set_config('app.fake_now', $1, false)`, [iso ?? ''])
  }

  return { db, rpc, pin, one, clock }
}

// Manila wall-clock time as an ISO timestamp, e.g. manila('2026-12-05 18:00').
export const manila = (local: string) => new Date(local.replace(' ', 'T') + ':00+08:00').toISOString()

export const uuid = () => crypto.randomUUID()
