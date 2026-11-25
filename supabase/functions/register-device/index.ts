// Registers a shared device (§11.1). A manager signed in with their own login calls this from the device;
// it creates the device's own Auth account with a random password and returns it once so the app can
// sign the device in. Nobody types or sees that password; if the device loses its sign-in, register it again.
import { admin, callerClient, clean, cors, fail, ok } from '../_shared/auth.ts'

const randomSecret = () => {
  const b = new Uint8Array(32); crypto.getRandomValues(b)
  return btoa(String.fromCharCode(...b)).replace(/[^A-Za-z0-9]/g, '').slice(0, 40)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
  try {
    const { branch_id, label, kind } = await req.json()
    const { data: prep, error } = await callerClient(req).rpc('prepare_device', { p_branch: branch_id, p_label: label ?? '', p_kind: kind ?? '' })
    if (error) return fail(clean(error.message), 403)
    const email = `device-${prep.device_id}@devices.goldenkoreanbbq.com`
    const password = randomSecret()
    const { data: user, error: cErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true,
      app_metadata: { device_id: prep.device_id, kind: 'device' } })
    if (cErr || !user?.user) {
      await admin.from('devices').update({ revoked_at: new Date().toISOString() }).eq('id', prep.device_id)
      return fail(cErr?.message ?? 'Could not create the device sign-in.', 500)
    }
    const { error: upErr } = await admin.from('devices').update({ auth_user_id: user.user.id }).eq('id', prep.device_id)
    if (upErr) return fail('Could not link the device sign-in.', 500)
    return ok({ ok: true, device_id: prep.device_id, email, password })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Registration failed', 500)
  }
})
