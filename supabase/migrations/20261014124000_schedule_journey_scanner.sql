-- The scanner has its own cron and fail-closed runtime flag. This keeps large
-- eligibility scans independent from due delivery processing.
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare v_job record;
begin
  for v_job in select jobid from cron.job where jobname = 'betleads-scan-journeys'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'betleads-scan-journeys',
  '* * * * *',
  $job$
    select net.http_post(
      url := 'https://betleads.io/api/public/hooks/journey-scan',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'betleads_cron_secret' limit 1)
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $job$
);
