-- Pull Short.io click aggregates every 15 minutes. The shared endpoint secret
-- stays in Supabase Vault and is never persisted in cron.job text.
do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid from cron.job where jobname = 'betleads-shortio-sync'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end;
$$;

select cron.schedule('betleads-shortio-sync', '*/15 * * * *', $job$
  select net.http_post(
    url := 'https://betleads.io/api/public/shortio/sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'betleads_cron_secret'
        limit 1
      )
    ),
    body := '{}'::jsonb
  );
$job$);
