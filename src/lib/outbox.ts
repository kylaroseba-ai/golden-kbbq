import Dexie, { type Table } from 'dexie'
import { backendKind, getBackend, isOfflineError, RpcError } from './backend'

// Offline outbox (§10): actions are kept in IndexedDB with their idempotency key and posted in order.
export interface OutboxItem {
  id?: number
  client_uuid: string
  name: string
  args: Record<string, unknown>
  label: string
  session_id?: string
  status: 'pending' | 'failed'
  error?: string
  created_at: string
  branch_id?: string
}

// One outbox per device. In the demo every browser tab is its own device, so each tab gets its own.
function deviceDbName() {
  if (backendKind() !== 'local') return 'gkb-device'
  let id = sessionStorage.getItem('gkb-tab-id')
  if (!id) { id = crypto.randomUUID().slice(0, 8); sessionStorage.setItem('gkb-tab-id', id) }
  return `gkb-device-${id}`
}

class LocalDb extends Dexie {
  outbox!: Table<OutboxItem, number>
  cache!: Table<{ key: string; value: unknown; at: string }, string>
  constructor() {
    super(deviceDbName())
    this.version(1).stores({ outbox: '++id, status, session_id', cache: 'key' })
  }
}
export const localDb = new LocalDb()

const listeners = new Set<() => void>()
export const onOutboxChange = (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb) }
const changed = () => listeners.forEach((l) => l())

export const uuid = () => crypto.randomUUID()

/**
 * Run a write. Online: posted now and errors are thrown to the caller.
 * Offline (and `queueable`): saved to the outbox, shown as "pending sync", posted later.
 */
export async function mutate<T = any>(name: string, args: Record<string, unknown>,
  opts: { queueable?: boolean; label?: string; session_id?: string; branch_id?: string } = {}): Promise<{ queued: boolean; result?: T }> {
  const backend = await getBackend()
  const pending = await localDb.outbox.where('status').equals('pending').count()
  const client_uuid = (args.p_client_uuid as string) ?? uuid()
  const item: OutboxItem = { client_uuid, name, args, label: opts.label ?? name, session_id: opts.session_id,
    status: 'pending', created_at: new Date().toISOString(), branch_id: opts.branch_id }
  // keep order: if older actions are still waiting, this one waits behind them
  if (pending === 0) {
    try {
      return { queued: false, result: await backend.rpc<T>(name, item.args) }
    } catch (e) {
      if (!(opts.queueable && isOfflineError(e))) throw e
    }
  } else if (!opts.queueable) {
    throw new RpcError('OFFLINE', 'Waiting for earlier actions to sync. Try again when online.')
  }
  await localDb.outbox.add(item)
  changed()
  return { queued: true }
}

let flushing = false
export async function flushOutbox(report?: (item: OutboxItem, error: string) => Promise<void>) {
  if (flushing) return
  flushing = true
  try {
    const backend = await getBackend()
    const items = await localDb.outbox.where('status').equals('pending').sortBy('id')
    for (const item of items) {
      try {
        await backend.rpc(item.name, item.args)
        await localDb.outbox.delete(item.id!)
      } catch (e) {
        if (isOfflineError(e)) break
        const msg = (e as Error).message
        await localDb.outbox.update(item.id!, { status: 'failed', error: msg })
        await report?.(item, msg).catch(() => {})
      }
      changed()
    }
  } finally {
    flushing = false
  }
}

export async function cacheSet(key: string, value: unknown) {
  await localDb.cache.put({ key, value, at: new Date().toISOString() })
}
export async function cacheGet<T>(key: string): Promise<T | undefined> {
  return (await localDb.cache.get(key))?.value as T | undefined
}
