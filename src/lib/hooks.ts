import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { getBackend, getStaffToken, isOfflineError } from './backend'
import { cacheGet, cacheSet } from './outbox'

/** Read RPC with TanStack Query. Falls back to the last cached copy when offline. */
export function useRpc<T = any>(name: string, args: Record<string, unknown>, opts: Partial<UseQueryOptions<T>> & { cache?: boolean } = {}) {
  // The staff member is part of the key: on a shared device each person sees only what their role allows.
  const key = [name, args, getStaffToken()]
  return useQuery<T>({
    queryKey: key,
    queryFn: async () => {
      const b = await getBackend()
      try {
        const r = await b.rpc<T>(name, args)
        if (opts.cache) cacheSet(JSON.stringify(key), r)
        return r
      } catch (e) {
        if (opts.cache && isOfflineError(e)) {
          const c = await cacheGet<T>(JSON.stringify(key))
          if (c !== undefined) return c
        }
        throw e
      }
    },
    ...opts,
  })
}

/** Refresh every query when the backend reports a change (Realtime, or another tab in the demo). */
export function useLiveRefresh() {
  const qc = useQueryClient()
  useEffect(() => {
    let off = () => {}
    getBackend().then((b) => { off = b.onChange(() => qc.invalidateQueries()) })
    return () => off()
  }, [qc])
}

// ───── Clock: corrected device time (§10.1) ─────
let offsetMs = 0
export const setServerTime = (iso: string) => { offsetMs = new Date(iso).getTime() - Date.now() }
export const deviceNow = () => new Date(Date.now() + offsetMs)
export const clockOffset = () => offsetMs

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(deviceNow())
  useEffect(() => { const t = setInterval(() => setNow(deviceNow()), intervalMs); return () => clearInterval(t) }, [intervalMs])
  return now
}

/** Screen Wake Lock on POS, kitchen and count screens (§9.4). */
export function useWakeLock(enabled = true) {
  const lock = useRef<WakeLockSentinel | null>(null)
  const [active, setActive] = useState(false)
  useEffect(() => {
    if (!enabled || !('wakeLock' in navigator)) return
    const request = async () => {
      try {
        lock.current = await navigator.wakeLock.request('screen')
        setActive(true)
        lock.current.addEventListener('release', () => setActive(false))
      } catch { setActive(false) }
    }
    request()
    const onVis = () => { if (document.visibilityState === 'visible') request() }
    document.addEventListener('visibilitychange', onVis)
    return () => { document.removeEventListener('visibilitychange', onVis); lock.current?.release().catch(() => {}) }
  }, [enabled])
  return active
}

export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine && sessionStorage.getItem('gkb-demo-offline') !== '1')
  useEffect(() => {
    const update = () => setOnline(navigator.onLine && sessionStorage.getItem('gkb-demo-offline') !== '1')
    window.addEventListener('online', update); window.addEventListener('offline', update); window.addEventListener('storage', update)
    window.addEventListener('gkb-offline-toggle', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update)
      window.removeEventListener('storage', update); window.removeEventListener('gkb-offline-toggle', update) }
  }, [])
  return online
}
