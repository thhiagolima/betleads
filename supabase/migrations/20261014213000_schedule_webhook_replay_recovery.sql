-- Replay only a short bounded batch per minute. This drains received/failed
-- webhook logs without creating a long HTTP request that Nginx will abort.
do $$
declare
  v_job record;
begin
  for v_job in
    select jobid from cron.job where jobname = 'betleads-webhook-replay'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule('betleads-webhook-replay', '* * * * *', $job$
  select net.http_post(
    url := 'https://betleads.io/api/public/hooks/webhook-replay',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'betleads_cron_secret'
        limit 1
      )
    ),
    body := '{"limit":20}'::jsonb
  );
$job$);
