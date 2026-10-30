// Sends queued reservation messages (§7.3): SMS via Semaphore, email via Resend. Called every minute by pg_cron.
// Secrets (Edge Function env only, §11): SEMAPHORE_API_KEY, SEMAPHORE_SENDER, RESEND_API_KEY, EMAIL_FROM.
import { createClient } from 'npm:@supabase/supabase-js@2'

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

async function sendSms(to: string, body: string) {
  const form = new URLSearchParams({ apikey: Deno.env.get('SEMAPHORE_API_KEY')!, number: to, message: body })
  const sender = Deno.env.get('SEMAPHORE_SENDER')   // e.g. GOLDENKBBQ once approved; default sender until then
  if (sender) form.set('sendername', sender)
  const r = await fetch('https://api.semaphore.co/api/v4/messages', { method: 'POST', body: form })
  const j = await r.json()
  if (!r.ok || !Array.isArray(j)) throw new Error(JSON.stringify(j))
  return String(j[0]?.message_id ?? '')
}

async function sendEmail(to: string, subject: string, body: string) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: Deno.env.get('EMAIL_FROM'), to, subject, text: body.replace(/\\n/g, '\n') }),
  })
  const j = await r.json()
  if (!r.ok) throw new Error(JSON.stringify(j))
  return String(j.id ?? '')
}

Deno.serve(async () => {
  const { data: queued, error } = await sb.from('outbound_messages').select('*')
    .eq('status', 'queued').lte('send_after', new Date().toISOString()).order('send_after').limit(50)
  if (error) return new Response(error.message, { status: 500 })
  let sent = 0, failed = 0
  for (const m of queued ?? []) {
    try {
      const provider_id = m.channel === 'sms' ? await sendSms(m.to_address, m.body) : await sendEmail(m.to_address, m.subject ?? '', m.body)
      await sb.from('outbound_messages').update({ status: 'sent', provider_id, sent_at: new Date().toISOString() }).eq('id', m.id)
      sent++
    } catch (e) {
      await sb.from('outbound_messages').update({ status: 'failed', error: String(e).slice(0, 500) }).eq('id', m.id)
      failed++
    }
  }
  return Response.json({ sent, failed })
})
