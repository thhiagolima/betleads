-- Run several independent workers per minute. Claims use SKIP LOCKED, so the
-- workers share the backlog without sending the same enrollment twice.
-- A batch of 250 with bounded application concurrency drains a normal SMS
-- backlog in seconds instead of one five-message batch per minute.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Webhook audit is tenant-scoped. Without this index the operational query
-- ordered by newest event can scan the entire table and time out under load.
create index if not exists webhook_logs_tenant_created_idx
  on public.webhook_logs (tenant_id, created_at desc);

do $$
declare v_job record;
begin
  for v_job in select jobid from cron.job where jobname = 'betleads-dispatch-journey'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'betleads-dispatch-journey',
  '* * * * *',
  $job$
    select net.http_post(
      url := 'https://betleads.io/api/public/hooks/dispatch?channel=journey',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'betleads_cron_secret' limit 1)
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    )
    from generate_series(1, 5);
  $job$
);
