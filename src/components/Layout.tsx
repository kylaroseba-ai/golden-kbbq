import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { hasRole, isManager, useAuth, type Role } from '../lib/auth'
import { getBackend } from '../lib/backend'
import { flushOutbox, localDb } from '../lib/outbox'
import { setServerTime, useLiveRefresh, useNow, useOnline, useRpc } from '../lib/hooks'
import { Avatar, Logo } from './ui'

type NavItem = { to: string; key: string; label: string; icon: string; roles: Role[] | 'all'; badge?: string; group: string }
const NAV: NavItem[] = [
  { to: '/dashboard', key: 'dashboard', label: 'Dashboard', icon: '◧', roles: ['owner', 'manager'], group: 'Overview' },
  { to: '/time', key: 'time', label: 'Time clock', icon: '◷', roles: ['server', 'cashier', 'kitchen', 'utility', 'manager'], group: 'Overview' },
  { to: '/floor', key: 'floor', label: 'Tables & POS', icon: '▦', roles: ['server', 'cashier', 'manager', 'owner'], group: 'Service' },
  { to: '/kitchen', key: 'kitchen', label: 'Kitchen', icon: '♨', roles: ['kitchen', 'manager'], badge: 'kitchen', group: 'Service' },
  { to: '/reservations', key: 'reservations', label: 'Reservations', icon: '☷', roles: ['cashier', 'manager', 'owner'], badge: 'reservations', group: 'Service' },
  { to: '/shift', key: 'shift', label: 'Cashier shift', icon: '₱', roles: ['cashier', 'manager'], group: 'Service' },
  { to: '/stock', key: 'stock', label: 'Live stock', icon: '▤', roles: 'all', badge: 'stock', group: 'Inventory' },
  { to: '/deliveries', key: 'deliveries', label: 'Deliveries', icon: '⇣', roles: ['kitchen', 'manager'], group: 'Inventory' },
  { to: '/prep', key: 'prep', label: 'Prep', icon: '✂', roles: ['kitchen', 'manager'], group: 'Inventory' },
  { to: '/waste', key: 'waste', label: 'Waste log', icon: '⌫', roles: 'all', group: 'Inventory' },
  { to: '/counts', key: 'counts', label: 'Counts', icon: '#', roles: ['kitchen', 'manager'], badge: 'counts', group: 'Inventory' },
  { to: '/reorder', key: 'reorder', label: 'Reorder', icon: '↻', roles: ['manager', 'owner'], badge: 'reorder', group: 'Inventory' },
  { to: '/suppliers', key: 'suppliers', label: 'Suppliers', icon: '☎', roles: ['manager', 'owner', 'kitchen'], group: 'Inventory' },
  { to: '/shifts', key: 'shifts', label: 'Staff & shifts', icon: '☰', roles: ['manager', 'owner'], badge: 'staff', group: 'Back office' },
  { to: '/reports', key: 'reports', label: 'Reports', icon: '◫', roles: ['manager', 'owner'], group: 'Back office' },
  { to: '/admin', key: 'admin', label: 'Setup', icon: '⚙', roles: ['manager', 'owner'], group: 'Back office' },
]
// Owner and admin can open every screen; dispatch opens the kitchen screens; utility (dishwasher) only the time clock.
export const navFor = (roles: Role[]) => NAV.filter((n) => roles.length > 0 &&
  (n.roles === 'all' ? !(roles.length === 1 && roles[0] === 'utility') : hasRole(roles, n.roles)))
const GROUPS = ['Overview', 'Service', 'Inventory', 'Back office']

export function Layout() {
  const auth = useAuth()
  const { t } = useTranslation()
  const nav = useNavigate()
  const loc = useLocation()
  const online = useOnline()
  const now = useNow(30_000)
  useLiveRefresh()
  const pending = useLiveQuery(() => localDb.outbox.where('status').equals('pending').count(), [], 0)
  const failed = useLiveQuery(() => localDb.outbox.where('status').equals('failed').count(), [], 0)
  const boot = useRpc('get_bootstrap', { p_branch: auth.branchId }, { enabled: !!auth.branchId, cache: true, staleTime: 60_000 })
  const counts = useRpc<Record<string, number>>('get_nav_counts', { p_branch: auth.branchId }, { enabled: !!auth.branchId, refetchInterval: 30_000 })
  const notes = useRpc<any[]>('get_notifications', { p_token: auth.token, p_branch: auth.branchId, p_limit: 30 },
    { enabled: !!auth.branchId && !!auth.role, refetchInterval: 20_000 })
  const me = useRpc<any>('get_my_time', { p_token: auth.token, p_branch: auth.branchId },
    { enabled: !!auth.branchId && !!auth.role && auth.role !== 'owner' && auth.role !== 'admin', refetchInterval: 60_000 })
  const unread = (notes.data ?? []).filter((n) => !n.read).length
  const [more, setMore] = useState(false)

  useEffect(() => { if (boot.data?.server_time) setServerTime(boot.data.server_time) }, [boot.data])
  useEffect(() => setMore(false), [loc.pathname])

  // Post queued offline actions when the connection comes back (Background Sync is not available on iOS, §10).
  useEffect(() => {
    const report = async (item: { label: string; branch_id?: string }, error: string) => {
      const b = await getBackend()
      await b.rpc('report_sync_conflict', { p_token: auth.token, p_branch: item.branch_id ?? auth.branchId, p_action: item.label, p_error: error })
    }
    const run = () => flushOutbox(report)
    run()
    const iv = setInterval(run, 10_000)
    window.addEventListener('online', run)
    document.addEventListener('visibilitychange', run)
    window.addEventListener('gkb-offline-toggle', run)
    return () => { clearInterval(iv); window.removeEventListener('online', run); document.removeEventListener('visibilitychange', run); window.removeEventListener('gkb-offline-toggle', run) }
  }, [auth.token, auth.branchId])

  const items = navFor(auth.roles)
  const badge = (n: NavItem) => (n.badge ? Number(counts.data?.[n.badge] ?? 0) : 0)
  // phones: first four screens in the bottom bar, the rest under "More"
  const primary = items.filter((n) => n.to !== '/dashboard' || isManager(auth.role)).slice(0, 4)
  const rest = items.filter((n) => !primary.includes(n))
  const todayShift = (me.data?.schedule ?? []).find((s: any) => new Date(s.starts_at).getTime() - now.getTime() < 3600_000 && new Date(s.ends_at) > now)
  const notTimedIn = me.data && me.data.status === 'off' && todayShift && !me.data.entries_today?.length && loc.pathname !== '/time'

  const navLink = (n: NavItem) => (
    <NavLink key={n.to} to={n.to} className={({ isActive }) => `group flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] transition ${isActive ? 'bg-charcoal-800 text-gold-300 font-semibold' : 'text-[#d9d2c4] hover:bg-charcoal-900'}`}>
      <span className="w-4 text-center text-silver group-[.active]:text-gold-300">{n.icon}</span>
      <span className="flex-1">{t(`nav_${n.key}`, { defaultValue: n.label })}</span>
      {badge(n) > 0 && <span className="rounded-full bg-gold-700/60 text-gold-200 text-[11px] font-bold min-w-5 h-5 px-1.5 grid place-items-center">{badge(n)}</span>}
    </NavLink>
  )

  return (
    <div className="min-h-full flex flex-col">
      <div className="flex flex-1 min-h-0">
        <aside className="no-print hidden lg:flex flex-col w-64 shrink-0 sticky top-0 h-screen overflow-y-auto border-r border-charcoal-800 bg-[#0a0907] px-4 py-6">
          <Logo className="h-14 mx-auto mb-7" />
          <div className="label mb-2 px-1">Branch</div>
          {auth.who.mode === 'personal' && auth.branches.length > 1 ? (
            <select className="mb-6 w-full rounded-xl bg-charcoal-900 border border-charcoal-700 px-3 h-11 text-sm font-medium" value={auth.branchId ?? ''}
              onChange={(e) => auth.setBranch(e.target.value)}>
              {auth.branches.map((b) => <option key={b.id} value={b.id}>{b.name.replace('Golden Korean BBQ — ', '')}</option>)}
            </select>
          ) : <div className="mb-6 rounded-xl bg-charcoal-900 border border-charcoal-700 px-3 h-11 grid items-center text-sm font-medium">{(auth.branches.find((b) => b.id === auth.branchId)?.name ?? '').replace('Golden Korean BBQ — ', '')}</div>}
          {GROUPS.map((g) => {
            const list = items.filter((n) => n.group === g)
            if (!list.length) return null
            return <div key={g} className="mb-4"><div className="label px-1 mb-1.5">{g}</div><div className="space-y-0.5">{list.map(navLink)}</div></div>
          })}
          <div className="mt-auto pt-4 border-t border-charcoal-800 flex items-center gap-3">
            <Avatar name={auth.userName ?? '?'} />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="text-sm font-semibold truncate">{auth.userName}</div>
              <div className="text-xs text-silver capitalize truncate">{auth.roles.join(" + ")}{auth.who.mode === 'device' ? ` · ${auth.who.device.label}` : ''}</div>
            </div>
          </div>
        </aside>

        <div className="flex-1 min-w-0 flex flex-col">
          <header className="no-print sticky top-0 z-30 bg-charcoal-950/90 backdrop-blur border-b border-charcoal-800">
            <div className="flex items-center gap-3 px-4 sm:px-6 h-16">
              <Logo className="h-9 lg:hidden" />
              <div className="hidden lg:block label">
                {now.toLocaleDateString('en-PH', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Manila' })} · {now.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' })}
                {online && <span className="ml-2 text-ok"><span className="live-dot">●</span> Live</span>}
              </div>
              <div className="ml-auto flex items-center gap-2">
                {!online && <span className="rounded-full px-3 py-1.5 text-xs font-bold bg-bad-bg text-bad">● {t('offline')}</span>}
                {(pending > 0 || failed > 0) && (
                  <NavLink to="/sync" className={`rounded-full px-3 py-1.5 text-xs font-bold ${failed ? 'bg-bad-bg text-bad' : 'bg-warn-bg text-warn'}`}>
                    {failed ? `${failed} failed to sync` : `${pending} ${t('pending_sync')}`}
                  </NavLink>
                )}
                <NavLink to="/alerts" className="relative h-11 min-w-11 px-3 grid place-items-center rounded-xl border border-charcoal-700 bg-charcoal-900 hover:border-charcoal-600" aria-label={t('alerts')}>
                  <span className="flex items-center gap-2 text-sm">🔔{unread > 0 && <span className="rounded-full bg-gold-700/60 text-gold-200 text-[11px] font-bold px-1.5">{unread}</span>}</span>
                </NavLink>
                <div className="hidden sm:flex lg:hidden items-center gap-2 pl-1"><Avatar name={auth.userName ?? '?'} /><span className="text-sm font-semibold">{auth.userName?.split(' ')[0]} · <span className="capitalize text-silver font-normal">{auth.roles.join(" + ")}</span></span></div>
                {auth.who.mode === 'device'
                  ? <button className="h-11 px-4 rounded-xl bg-charcoal-900 border border-charcoal-700 hover:border-charcoal-600 text-sm font-medium" onClick={() => { auth.lock(); nav('/') }}>{t('switch_user')}</button>
                  : <button className="h-11 px-4 rounded-xl bg-charcoal-900 border border-charcoal-700 hover:border-charcoal-600 text-sm font-medium" onClick={() => auth.signOut().then(() => nav('/'))}>Sign out</button>}
              </div>
            </div>
          </header>
          {notTimedIn && (
            <div className="no-print mx-4 sm:mx-6 mt-4 rounded-2xl border border-gold-600/60 bg-gold-700/20 px-4 py-3 flex flex-wrap items-center gap-3">
              <span>◷ Your shift starts {new Date(todayShift.starts_at).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' })}. You haven't timed in yet.</span>
              <NavLink to="/time" className="ml-auto rounded-xl bg-gold-400 text-charcoal-950 font-semibold px-4 h-10 grid place-items-center text-sm">Time in</NavLink>
            </div>
          )}
          <main className="flex-1 min-w-0 px-4 sm:px-6 py-6 pb-28 lg:pb-8 max-w-[1500px] w-full"><Outlet /></main>
        </div>
      </div>

      {/* Phone / tablet bottom bar */}
      <nav className="no-print lg:hidden fixed bottom-0 inset-x-0 z-40 bg-[#0a0907]/95 backdrop-blur border-t border-charcoal-800 grid" style={{ gridTemplateColumns: `repeat(${primary.length + (rest.length ? 1 : 0)}, 1fr)`, paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {primary.map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => `relative flex flex-col items-center justify-center gap-0.5 h-16 text-[11px] font-medium ${isActive ? 'text-gold-300' : 'text-silver'}`}>
            <span className="text-lg leading-none">{n.icon}</span>{t(`nav_${n.key}`, { defaultValue: n.label })}
            {badge(n) > 0 && <span className="absolute top-2 right-[calc(50%-22px)] rounded-full bg-gold-500 text-charcoal-950 text-[10px] font-bold px-1.5">{badge(n)}</span>}
          </NavLink>
        ))}
        {rest.length > 0 && <button onClick={() => setMore(!more)} className={`flex flex-col items-center justify-center gap-0.5 h-16 text-[11px] font-medium ${more ? 'text-gold-300' : 'text-silver'}`}><span className="text-lg leading-none">⋯</span>More</button>}
      </nav>
      {more && (
        <div className="no-print lg:hidden fixed inset-0 z-30 bg-black/60" onClick={() => setMore(false)}>
          <div className="absolute bottom-16 inset-x-0 rounded-t-3xl bg-charcoal-900 border-t border-charcoal-700 p-4 grid grid-cols-3 gap-2" onClick={(e) => e.stopPropagation()}>
            {rest.map((n) => (
              <NavLink key={n.to} to={n.to} className="relative rounded-2xl bg-charcoal-800 border border-charcoal-700 p-3 text-center text-sm">
                <div className="text-xl mb-1">{n.icon}</div>{t(`nav_${n.key}`, { defaultValue: n.label })}
                {badge(n) > 0 && <span className="absolute top-2 right-2 rounded-full bg-gold-500 text-charcoal-950 text-[10px] font-bold px-1.5">{badge(n)}</span>}
              </NavLink>
            ))}
            {isManager(auth.role) && <NavLink to="/sync" className="rounded-2xl bg-charcoal-800 border border-charcoal-700 p-3 text-center text-sm"><div className="text-xl mb-1">⇅</div>{t('sync')}</NavLink>}
          </div>
        </div>
      )}
    </div>
  )
}

export function Gate({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const auth = useAuth()
  // owner and admin can open every screen; the database checks the same rules again
  if (!auth.can(...roles)) {
    return <div className="text-silver p-8">Your role ({auth.role ?? 'none'}) can’t open this screen.</div>
  }
  return <>{children}</>
}
