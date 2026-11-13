-- Popups nas casas: cron de hora em hora (minuto 13).
--   betleads-popups-hourly — encerra popups que passaram da data de fim e
--                            recalcula o público "filtro do CRM" dos popups
--                            ativos/pausados (audience.server.ts).
-- Aplicar DEPOIS do deploy do app (a rota /api/public/hooks/popups-hourly
-- precisa existir) e depois de 20261230100000_site_popups.
-- O segredo fica no Supabase Vault, nunca na migration.
--
-- ROLLBACK: select cron.unschedule('betleads-popups-hourly');
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  v_job record;
begin
  for v_job in
    select jobid from cron.job
    where jobname in ('betleads-popups-hourly')
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'betleads-popups-hourly',
  '13 * * * *',
  $job$
    select net.http_post(
      url := 'https://betleads.io/api/public/hooks/popups-hourly',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'betleads_cron_secret' limit 1)
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $job$
);
