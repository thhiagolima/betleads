-- Index every lookup performed while reserving a journey delivery.  The
-- reservation runs once per recipient, so sequential scans here can exhaust
-- PostgREST's statement timeout and stall the whole CRM.
CREATE INDEX IF NOT EXISTS journey_enrollments_tenant_player_due_idx
  ON public.journey_enrollments (tenant_id, player_id, next_run_at, journey_id)
  WHERE status IN ('active', 'waiting');

CREATE INDEX IF NOT EXISTS journey_step_executions_daily_reservation_idx
  ON public.journey_step_executions (tenant_id, journey_id, channel, created_at DESC)
  WHERE status IN ('claimed', 'sent', 'delivered');

CREATE INDEX IF NOT EXISTS journey_step_executions_enrollment_channel_recent_idx
  ON public.journey_step_executions (enrollment_id, channel, completed_at DESC, created_at DESC)
  WHERE status IN ('claimed', 'sent', 'delivered');

-- The previous five simultaneous HTTP requests created contention in the
-- reservation function. Keep one controller request; application-level
-- bounded parallelism delivers a large batch without multiplying SQL workers.
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
    );
  $job$
);
