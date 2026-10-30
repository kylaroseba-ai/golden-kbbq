// Fans new notifications out to staff phones with Web Push (§9.1). iPhone/iPad receive push only after
// the PWA is added to the Home Screen. Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:...).
import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT')!, Deno.env.get('VAPID_PUBLIC_KEY')!, Deno.env.get('VAPID_PRIVATE_KEY')!)

Deno.serve(async () => {
  const { data: fresh } = await sb.from('notifications').select('*').is('pushed_at', null).order('created_at').limit(100)
  let n = 0
  for (const note of fresh ?? []) {
    const { data: roles } = await sb.from('user_branch_roles').select('user_id, role').eq('branch_id', note.branch_id)
    const users = (roles ?? []).filter((r) => note.target_roles.includes(r.role) || ['owner', 'admin'].includes(r.role)).map((r) => r.user_id)
    const { data: subs } = await sb.from('push_subscriptions').select('*').eq('branch_id', note.branch_id).in('user_id', users)
    for (const s of subs ?? []) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify({ title: note.title, body: note.body, kind: note.kind }))
        n++
      } catch (e) {
        if ((e as { statusCode?: number }).statusCode === 410) await sb.from('push_subscriptions').delete().eq('id', s.id)  // expired subscription
      }
    }
    await sb.from('notifications').update({ pushed_at: new Date().toISOString() }).eq('id', note.id)
  }
  return Response.json({ pushed: n })
})
