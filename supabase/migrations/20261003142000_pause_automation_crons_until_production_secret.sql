-- A aplicação publicada ainda não possui CRON_SECRET. Pausa os jobs para não
-- gerar falhas contínuas até que o segredo seja provisionado no ambiente web.
do $$
declare
  v_job record;
begin
  for v_job in
    select jobid from cron.job
    where jobname in (
      'betleads-dispatch-sms',
      'betleads-dispatch-email',
      'betleads-automation-recovery',
      'betleads-orchestrate-tenants'
    )
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;
