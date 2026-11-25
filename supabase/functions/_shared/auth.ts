// Shared helpers for staff Edge Functions: the caller's own client (their login and staff token)
// for permission checks, and the service-role client for Auth admin work.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

export const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, x-staff-token',
  'access-control-allow-methods': 'POST, OPTIONS',
}

export const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false, autoRefreshToken: false } })

export function callerClient(req: Request): SupabaseClient {
  const headers: Record<string, string> = { authorization: req.headers.get('authorization') ?? '' }
  const staff = req.headers.get('x-staff-token')
  if (staff) headers['x-staff-token'] = staff
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers }, auth: { persistSession: false, autoRefreshToken: false } })
}

export const fail = (message: string, status = 400) => Response.json({ message }, { status, headers: cors })
export const ok = (body: unknown) => Response.json(body, { headers: cors })
export const clean = (m: string) => m.replace(/^[A-Z_]+: /, '')
