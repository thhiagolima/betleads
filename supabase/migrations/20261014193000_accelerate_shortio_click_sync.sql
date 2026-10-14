-- Clicks are a live operational signal.  Poll once a minute as a durable
-- fallback for providers that do not push click webhooks; the sync worker
-- prioritises recently-created tracked links and keeps history reconciled.
do $$
declare v_job record;
begin
  for v_job in select jobid from cron.job where jobname = 'betleads-shortio-sync'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule('betleads-shortio-sync', '* * * * *', $job$
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
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
$job$);
