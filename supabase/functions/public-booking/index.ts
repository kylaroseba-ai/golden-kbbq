// Public booking endpoint (§7.1): verifies Cloudflare Turnstile, then creates the reservation with the service role.
// Secret: TURNSTILE_SECRET_KEY.
import { createClient } from 'npm:@supabase/supabase-js@2'

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, OPTIONS' }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
  const { branch_code, booking, turnstile_token } = await req.json()
  const form = new URLSearchParams({ secret: Deno.env.get('TURNSTILE_SECRET_KEY')!, response: turnstile_token ?? '',
    remoteip: req.headers.get('cf-connecting-ip') ?? '' })
  const check = await (await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })).json()
  if (!check.success) return Response.json({ message: 'Please complete the anti-spam check.' }, { status: 400, headers: cors })
  const { data, error } = await sb.rpc('create_public_reservation', { p_branch_code: branch_code, p_booking: booking })
  if (error) return Response.json({ message: error.message.replace(/^[A-Z_]+: /, '') }, { status: 400, headers: cors })
  return Response.json(data, { headers: cors })
})
