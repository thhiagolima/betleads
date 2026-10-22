-- Task 5: 5-minute reconciliation of pending Pix charges. The segredo fica
-- no Supabase Vault, nunca na migration.
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  v_job record;
begin
  for v_job in
    select jobid from cron.job
    where jobname in (
      'betleads-billing-reconcile'
    )
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'betleads-billing-reconcile',
  '*/5 * * * *',
  $job$
    select net.http_post(
      url := 'https://betleads.io/api/public/hooks/billing-reconcile',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'betleads_cron_secret' limit 1)
      ),
      body := '{}'::jsonb
    );
  $job$
);
