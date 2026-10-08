-- O dispatcher de Jornadas é agendado, porém o runtime permanece fail-closed
-- até JOURNEYS_DISPATCH_ENABLED=true após o aceite P1.
create extension if not exists pg_cron;
create extension if not exists pg_net;

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
      body := '{}'::jsonb
    );
  $job$
);
