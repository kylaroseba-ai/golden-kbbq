-- Run once in the Supabase SQL editor AFTER deploying the send-messages and push-fanout Edge Functions
-- and setting their secrets (see README).

-- Scheduled jobs (pg_cron + pg_net). Set the project URL and service key with:
--   select vault.create_secret('https://<project>.supabase.co', 'project_url');
--   select vault.create_secret('<service_role_key>', 'service_role_key');
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule('send-messages', '* * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/send-messages',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')))
$$);

select cron.schedule('push-fanout', '* * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/push-fanout',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')))
$$);

