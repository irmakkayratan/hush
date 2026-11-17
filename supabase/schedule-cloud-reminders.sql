-- Before running this file, store the full Edge Function URL and a
-- 64-character lowercase hex secret in Vault under these two names.
begin;

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if not exists (
    select from vault.decrypted_secrets
    where name = 'hush_reminder_function_url'
      and decrypted_secret ~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/send-hush-reminders$'
  ) or not exists (
    select from vault.decrypted_secrets
    where name = 'hush_reminder_cron_secret'
      and decrypted_secret ~ '^[a-f0-9]{64}$'
  ) then
    raise exception 'Set the HUSH reminder function URL and cron secret in Vault first.';
  end if;
end
$$;

select cron.schedule(
  'hush-send-reminders',
  '* * * * *',
  $job$
  select net.http_post(
    url := endpoint.decrypted_secret,
    headers := jsonb_build_object('x-hush-cron-secret', secret.decrypted_secret),
    timeout_milliseconds := 45000
  )
  from vault.decrypted_secrets endpoint
  cross join vault.decrypted_secrets secret
  where endpoint.name = 'hush_reminder_function_url'
    and secret.name = 'hush_reminder_cron_secret';
  $job$
);

commit;
