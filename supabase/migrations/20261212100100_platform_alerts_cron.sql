-- Console do superadmin F3: crons dos alertas da plataforma.
--   betleads-platform-alerts  a cada 5 min — recalcula os alertas técnicos,
--                             abre/atualiza/resolve platform_alerts e manda o
--                             e-mail dos críticos (só com
--                             PLATFORM_ALERTS_EMAIL_ENABLED=true no app).
--   betleads-platform-digest  11:00 UTC (08:00 BRT) — resumo diário por e-mail
--                             aos superadmins (mesma flag; uma vez por dia via
--                             platform_digest_log).
-- Aplicar DEPOIS do deploy do app (as rotas /api/public/hooks/platform-alerts e
-- /platform-digest precisam existir) e depois de 20261212100000_platform_alerts.
-- O segredo fica no Supabase Vault, nunca na migration.
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  v_job record;
begin
  for v_job in
    select jobid from cron.job
    where jobname in (
      'betleads-platform-alerts',
      'betleads-platform-digest'
    )
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'betleads-platform-alerts',
  '*/5 * * * *',
  $job$
    select net.http_post(
      url := 'https://betleads.io/api/public/hooks/platform-alerts',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'betleads_cron_secret' limit 1)
      ),
      body := '{}'::jsonb
    );
  $job$
);

select cron.schedule(
  'betleads-platform-digest',
  '0 11 * * *',
  $job$
    select net.http_post(
      url := 'https://betleads.io/api/public/hooks/platform-digest',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'betleads_cron_secret' limit 1)
      ),
      body := '{}'::jsonb
    );
  $job$
);

notify pgrst, 'reload schema';
