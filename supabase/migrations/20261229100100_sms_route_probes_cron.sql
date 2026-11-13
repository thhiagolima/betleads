-- Cron da sonda da rota SMS: a cada 30 min chama a rota que manda o SMS de
-- controle (só envia com a sonda ligada e números cadastrados no admin).
-- Aplicar DEPOIS do deploy do app (a rota /api/public/hooks/sms-route-probe
-- precisa existir) e depois de 20261229100000_sms_route_probes.
-- O segredo fica no Supabase Vault, nunca na migration.
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  v_job record;
begin
  for v_job in select jobid from cron.job where jobname = 'betleads-sms-route-probe'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'betleads-sms-route-probe',
  '*/30 * * * *',
  $job$
    select net.http_post(
      url := 'https://betleads.io/api/public/hooks/sms-route-probe',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'betleads_cron_secret' limit 1)
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $job$
);
