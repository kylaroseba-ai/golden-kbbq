// Setup → People and Setup → Devices (v0.6, §3.1, §11.1).
import { useState } from 'react'
import { useAuth, type Role } from '../lib/auth'
import { getBackend } from '../lib/backend'
import { useRpc } from '../lib/hooks'
import { mutate } from '../lib/outbox'
import { time } from '../lib/format'
import { LANGUAGES } from '../lib/i18n'
import { Avatar, Button, Card, Empty, ErrorBox, Field, Modal, Pill, inputCls, useToast } from '../components/ui'

const STAFF_ROLES: [Role, string][] = [
  ['server', 'Server'], ['cashier', 'Cashier'], ['kitchen', 'Kitchen (cooks)'], ['dispatch', 'Dispatch (prepares, plates)'],
  ['utility', 'Utility (time clock only)'],
]
const LOGIN_ROLES: Role[] = ['owner', 'admin', 'manager']
const roleLabel = (r: string) => r.charAt(0).toUpperCase() + r.slice(1)

type Person = {
  id: string; full_name: string; phone: string | null; email: string | null; language: string; roles: Role[]; role: Role
  is_active: boolean; has_pin: boolean; has_login: boolean; invited_at: string | null; locked: boolean
}

export function PeopleAdmin() {
  const auth = useAuth()
  const toast = useToast()
  const people = useRpc<Person[]>('list_people', { p_branch: auth.branchId }, { enabled: !!auth.branchId })
  const [edit, setEdit] = useState<Partial<Person> | null>(null)
  const [pinFor, setPinFor] = useState<Person | null>(null)
  const [inviteFor, setInviteFor] = useState<Partial<Person> | null>(null)
  const isOwner = auth.roles.includes('owner') || auth.roles.includes('admin')
  const isAdmin = auth.roles.includes('admin')
  const grantable: [Role, string][] = [...STAFF_ROLES, ...(isOwner ? [['manager', 'Manager'] as [Role, string]] : []),
    ...(isAdmin ? [['owner', 'Owner'], ['admin', 'Admin']] as [Role, string][] : [])]
  const act = (name: string, args: Record<string, unknown>, ok: string) =>
    mutate(name, { p_branch: auth.branchId, ...args }).then(() => { toast(ok, 'ok'); people.refetch() }).catch((e) => toast(e.message, 'error'))

  const list = people.data ?? []
  return (
    <>
      <div className="flex flex-wrap gap-2 mb-3">
        <Button variant="gold" onClick={() => setEdit({ full_name: '', roles: ['server'], language: 'en' })}>+ Add staff</Button>
        {isOwner && <Button onClick={() => setInviteFor({ full_name: '', roles: ['manager'] })}>+ Invite manager / owner by email</Button>}
      </div>
      <p className="text-sm text-silver mb-3">Staff sign in on restaurant devices with a 4–6 digit PIN. Owners and managers can also get an email login for their own phone or laptop.</p>
      <ErrorBox error={people.error} />
      {people.isSuccess && list.length === 0 && <Empty>No staff yet. Add the first person.</Empty>}
      <div className="grid gap-2">
        {list.map((p) => {
          // only people whose every role you could give yourself can be changed by you (the database checks this too)
          const manageable = p.id !== auth.userId && p.roles.every((r) => grantable.some(([g]) => g === r))
          return (
          <Card key={p.id} className={p.is_active ? '' : 'opacity-60'}>
            <div className="flex flex-wrap items-center gap-3">
              <Avatar name={p.full_name} />
              <div className="flex-1 min-w-48">
                <div className="font-semibold">{p.full_name} {!p.is_active && <span className="text-xs text-silver">(inactive)</span>}</div>
                <div className="flex flex-wrap gap-1 mt-1">{p.roles.map((r) => <Pill key={r} tone="info">{roleLabel(r)}</Pill>)}
                  {p.has_pin ? <Pill tone="ok">PIN set</Pill> : <Pill tone="warn">No PIN</Pill>}
                  {p.locked && <Pill tone="bad">PIN locked</Pill>}
                  {p.email && <Pill tone={p.has_login ? 'ok' : 'warn'}>{p.has_login ? `Login: ${p.email}` : `Invited: ${p.email}`}</Pill>}
                </div>
              </div>
              {manageable && <div className="flex flex-wrap gap-2">
                <Button onClick={() => setEdit(p)}>Edit</Button>
                <Button onClick={() => setPinFor(p)}>{p.has_pin ? 'Reset PIN' : 'Set PIN'}</Button>
                {p.locked && <Button onClick={() => act('unlock_pin', { p_user_id: p.id }, 'PIN unlocked')}>Unlock</Button>}
                {isOwner && !p.has_login && p.roles.some((r) => LOGIN_ROLES.includes(r)) &&
                  <Button onClick={() => setInviteFor(p)}>{p.email ? 'Resend invite' : 'Invite login'}</Button>}
                {(p.is_active
                  ? <Button variant="danger" onClick={() => confirm(`Deactivate ${p.full_name}? They are signed out at once; their history stays.`) &&
                      act('set_person_active', { p_user_id: p.id, p_active: false }, 'Deactivated')}>Deactivate</Button>
                  : <Button onClick={() => act('set_person_active', { p_user_id: p.id, p_active: true }, 'Reactivated')}>Reactivate</Button>)}
              </div>}
            </div>
          </Card>
          )
        })}
      </div>

      {edit && <PersonForm person={edit} grantable={grantable} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); people.refetch() }} />}
      {pinFor && <PinForm person={pinFor} onClose={() => setPinFor(null)} onSaved={() => { setPinFor(null); people.refetch() }} />}
      {inviteFor && <InviteForm person={inviteFor} isAdmin={isAdmin} onClose={() => setInviteFor(null)} onSaved={() => { setInviteFor(null); people.refetch() }} />}
    </>
  )
}

function PersonForm({ person, grantable, onClose, onSaved }: { person: Partial<Person>; grantable: [Role, string][]; onClose(): void; onSaved(): void }) {
  const auth = useAuth()
  const toast = useToast()
  const [p, setP] = useState<Partial<Person>>(person)
  const [err, setErr] = useState<unknown>(null)
  const roles = p.roles ?? []
  const toggle = (r: Role) => setP({ ...p, roles: roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r] })
  // roles the current user cannot give are shown but locked
  const shown: [Role, string][] = [...grantable, ...roles.filter((r) => !grantable.some(([g]) => g === r)).map((r) => [r, roleLabel(r)] as [Role, string])]
  return (
    <Modal open onClose={onClose} title={p.id ? `Edit ${person.full_name}` : 'Add staff'}>
      <Field label="Full name"><input className={inputCls} value={p.full_name ?? ''} onChange={(e) => setP({ ...p, full_name: e.target.value })} /></Field>
      <Field label="Mobile (optional)"><input className={inputCls} inputMode="tel" value={p.phone ?? ''} onChange={(e) => setP({ ...p, phone: e.target.value })} /></Field>
      <div className="label mb-2">Roles — tick every job this person does</div>
      <div className="grid sm:grid-cols-2 gap-2 mb-4">
        {shown.map(([r, l]) => {
          const locked = !grantable.some(([g]) => g === r)
          return (
            <label key={r} className={`flex items-center gap-2 rounded-xl border border-charcoal-700 px-3 min-h-11 ${locked ? 'opacity-50' : ''}`}>
              <input type="checkbox" className="size-5" disabled={locked} checked={roles.includes(r)} onChange={() => toggle(r)} />{l}
            </label>
          )
        })}
      </div>
      <Field label="Screen language"><select className={inputCls} value={p.language ?? 'en'} onChange={(e) => setP({ ...p, language: e.target.value })}>
        {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</select></Field>
      <ErrorBox error={err} />
      <Button variant="gold" className="w-full" disabled={!p.full_name || roles.length === 0}
        onClick={() => mutate('save_person', { p_branch: auth.branchId, p_person: { id: p.id ?? null, full_name: p.full_name, phone: p.phone, language: p.language, roles } })
          .then(() => { toast('Saved', 'ok'); onSaved() }).catch(setErr)}>Save</Button>
    </Modal>
  )
}

function PinForm({ person, onClose, onSaved }: { person: Person; onClose(): void; onSaved(): void }) {
  const auth = useAuth()
  const toast = useToast()
  const [pin, setPin] = useState('')
  const [pin2, setPin2] = useState('')
  const [err, setErr] = useState<unknown>(null)
  return (
    <Modal open onClose={onClose} title={`PIN for ${person.full_name}`}>
      <p className="text-sm text-silver mb-3">Let {person.full_name.split(' ')[0]} type their own PIN here, or tell it to them privately. It is never shown again.</p>
      <Field label="4–6 digits"><input className={inputCls} type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /></Field>
      <Field label="Type it again"><input className={inputCls} type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))} /></Field>
      {pin2.length >= 4 && pin !== pin2 && <p className="text-bad text-sm mb-3">The two PINs do not match.</p>}
      <ErrorBox error={err} />
      <Button variant="gold" className="w-full" disabled={pin.length < 4 || pin !== pin2}
        onClick={() => mutate('set_pin', { p_token: auth.token, p_branch: auth.branchId, p_user_id: person.id, p_pin: pin })
          .then(() => { toast('PIN saved', 'ok'); onSaved() }).catch(setErr)}>Save PIN</Button>
    </Modal>
  )
}

function InviteForm({ person, isAdmin, onClose, onSaved }: { person: Partial<Person>; isAdmin: boolean; onClose(): void; onSaved(): void }) {
  const auth = useAuth()
  const toast = useToast()
  const [name, setName] = useState(person.full_name ?? '')
  const [email, setEmail] = useState(person.email ?? '')
  const existingLoginRole = (person.roles ?? []).find((r) => LOGIN_ROLES.includes(r))
  const [role, setRole] = useState<Role>(existingLoginRole ?? 'manager')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<unknown>(null)
  const send = async () => {
    setBusy(true); setErr(null)
    try {
      const b = await getBackend()
      await b.invoke('invite-user', { branch_id: auth.branchId, user_id: person.id ?? null, full_name: name, email, roles: [role],
        redirect_to: `${location.origin}/set-password` })
      toast(`Invite sent to ${email}`, 'ok'); onSaved()
    } catch (e) { setErr(e) } finally { setBusy(false) }
  }
  return (
    <Modal open onClose={onClose} title={person.id ? `Email login for ${person.full_name}` : 'Invite by email'}>
      <p className="text-sm text-silver mb-3">They get an email with a link to choose their own password. Nobody else sees it.</p>
      {!person.id && <Field label="Full name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>}
      <Field label="Email"><input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      {!existingLoginRole && <Field label="Access"><select className={inputCls} value={role} onChange={(e) => setRole(e.target.value as Role)}>
        <option value="manager">Manager (this branch)</option>
        {isAdmin && <option value="owner">Owner</option>}
        {isAdmin && <option value="admin">System admin</option>}
      </select></Field>}
      <ErrorBox error={err} />
      <Button variant="gold" className="w-full" disabled={busy || !email.includes('@') || !name} onClick={send}>{busy ? 'Sending…' : 'Send invite'}</Button>
    </Modal>
  )
}

const KINDS: [string, string][] = [['cashier', 'Cashier counter (prints receipts)'], ['server', 'Server phone'], ['kitchen', 'Kitchen screen'], ['dispatch', 'Dispatch screen']]

export function DevicesAdmin() {
  const auth = useAuth()
  const toast = useToast()
  const devices = useRpc<any[]>('list_devices', { p_branch: auth.branchId }, { enabled: !!auth.branchId })
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState('server')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<unknown>(null)
  const register = async () => {
    if (!confirm(`Make this ${/Mobi/.test(navigator.userAgent) ? 'phone' : 'device'} the shared device “${label}”? You will be signed out here, and staff will sign in with their PIN.`)) return
    setBusy(true); setErr(null)
    try { await auth.registerDevice(label.trim(), kind) } catch (e) { setErr(e); setBusy(false) }
  }
  return (
    <>
      {auth.who.mode === 'personal' ? (
        <Card className="mb-4">
          <h3 className="font-bold mb-1">Make this device a shared restaurant device</h3>
          <p className="text-sm text-silver mb-3">Do this once on each counter tablet, kitchen tablet and server phone. Open the app on that device, sign in with your manager email, and register it here. Staff then use their PIN on it.</p>
          <div className="grid sm:grid-cols-[1fr_240px_auto] gap-2 items-end">
            <Field label="Device name"><input className={inputCls} placeholder="e.g. Server phone 1" value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
            <Field label="Used for"><select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <div className="mb-4"><Button variant="gold" disabled={busy || !label.trim()} onClick={register}>{busy ? 'Registering…' : 'Register this device'}</Button></div>
          </div>
          <ErrorBox error={err} />
        </Card>
      ) : auth.who.mode === 'device' && (
        <Card className="mb-4"><p className="text-sm">This is the shared device <b>{auth.who.device.label}</b>. To register another device, sign in with a manager email on that device.</p></Card>
      )}
      <ErrorBox error={devices.error} />
      <div className="overflow-x-auto rounded-2xl border border-charcoal-700"><table className="w-full text-sm">
        <thead className="bg-charcoal-900 text-silver text-left"><tr><th className="p-2">Device</th><th className="p-2">Used for</th><th className="p-2">Registered by</th><th className="p-2">Last used</th><th className="p-2">Status</th><th className="p-2" /></tr></thead>
        <tbody>{(devices.data ?? []).map((d) => (
          <tr key={d.id} className="border-t border-charcoal-800">
            <td className="p-2 font-medium">{d.label}{d.terminal ? <span className="text-silver"> · {d.terminal}</span> : ''}</td>
            <td className="p-2 capitalize">{d.kind}</td>
            <td className="p-2">{d.registered_by ?? '—'}</td>
            <td className="p-2">{d.last_seen_at ? `${new Date(d.last_seen_at).toLocaleDateString()} ${time(d.last_seen_at)}` : '—'}</td>
            <td className="p-2">{d.revoked_at ? <Pill tone="bad">Revoked</Pill> : d.registered ? <Pill tone="ok">Active</Pill> : <Pill tone="warn">Not finished</Pill>}</td>
            <td className="p-2 text-right">{!d.revoked_at && <Button variant="danger" onClick={() => confirm(`Revoke ${d.label}? It is signed out at once and can no longer be used.`) &&
              mutate('revoke_device', { p_token: auth.token, p_device_id: d.id }).then(() => { toast('Device revoked', 'ok'); devices.refetch() }).catch((e) => toast(e.message, 'error'))}>Revoke</Button>}</td>
          </tr>))}</tbody></table></div>
      <p className="text-xs text-silver mt-3">Lost or stolen phone? Revoke it here. If a device loses its sign-in (e.g. browser data cleared), register it again and revoke the old entry.</p>
    </>
  )
}
