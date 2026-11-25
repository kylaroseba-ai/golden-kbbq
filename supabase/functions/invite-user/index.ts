// Invites an owner, manager or admin by email (§3.1). The database checks the caller may give that role;
// Supabase Auth sends the invite email and the person sets their own password from the link.
import { admin, callerClient, clean, cors, fail, ok } from '../_shared/auth.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
  try {
    const { branch_id, user_id, full_name, email, roles, redirect_to } = await req.json()
    const caller = callerClient(req)
    const { data: prep, error } = await caller.rpc('prepare_invite', {
      p_branch: branch_id, p_user_id: user_id ?? null, p_full_name: full_name ?? '', p_email: email ?? '', p_roles: roles ?? [] })
    if (error) return fail(clean(error.message), 403)
    if (prep.auth_user_id) return ok({ ok: true, id: prep.id, already_linked: true })

    const { data: inv, error: invErr } = await admin.auth.admin.inviteUserByEmail(prep.email, { redirectTo: redirect_to })
    let authId = inv?.user?.id
    if (invErr) {
      // already has an Auth account (e.g. invited before): link it and send a password-reset link instead
      const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'recovery', email: prep.email,
        options: { redirectTo: redirect_to } })
      if (linkErr || !link?.user) return fail(clean(invErr.message))
      authId = link.user.id
      await admin.auth.resetPasswordForEmail(prep.email, { redirectTo: redirect_to })
    }
    const { error: upErr } = await admin.from('profiles').update({ auth_user_id: authId }).eq('id', prep.id)
    if (upErr) return fail('Invite sent, but linking the login failed. Try again.')
    return ok({ ok: true, id: prep.id, email: prep.email })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Invite failed', 500)
  }
})
