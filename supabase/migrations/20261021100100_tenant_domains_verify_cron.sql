-- Periodic DNS verification job for tenant custom domains (shortener +
-- email). DNS can change state at any time outside a user-triggered refresh,
-- so a background cron keeps tenant_domains.status current without relying
-- on the house owner to come back and check manually.
do $$
declare v_job record;
begin
  for v_job in select jobid from cron.job where jobname = 'betleads-tenant-domains-verify'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule('betleads-tenant-domains-verify', '*/10 * * * *', $job$
  select net.http_post(
    url := 'https://betleads.io/api/public/tenant-domains/verify',
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

notify pgrst, 'reload schema';
