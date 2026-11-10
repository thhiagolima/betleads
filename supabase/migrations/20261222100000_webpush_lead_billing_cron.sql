-- Web push, cobrança por lead: cron do lote de cobrança.
--   betleads-webpush-lead-billing  de hora em hora (minuto 7) — cobra as
--                             inscrições de push novas (item webpush_lead,
--                             uma vez por inscrição) de cada casa, via
--                             webpush_lead_bill_tenant. Casa sem saldo fica
--                             pendente e entra de novo no lote seguinte.
-- Aplicar DEPOIS do deploy do app (a rota
-- /api/public/hooks/webpush-lead-billing precisa existir) e depois de
-- 20261217100000_webpush_lead_billing.
-- O segredo fica no Supabase Vault, nunca na migration.
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  v_job record;
begin
  for v_job in
    select jobid from cron.job
    where jobname in ('betleads-webpush-lead-billing')
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'betleads-webpush-lead-billing',
  '7 * * * *',
  $job$
    select net.http_post(
      url := 'https://betleads.io/api/public/hooks/webpush-lead-billing',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'betleads_cron_secret' limit 1)
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $job$
);

notify pgrst, 'reload schema';
