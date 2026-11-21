-- Cron da leitura do saldo da Short Brasil: a cada 15 min chama a rota que
-- entra no painel e grava o saldo (sem SHORT_BRASIL_PAINEL_USUARIO/SENHA no
-- servidor ela só registra o erro).
-- Aplicar DEPOIS do deploy do app (a rota /api/public/hooks/sms-balance-check
-- precisa existir) e depois de 20261231101800_sms_balance_monitor.
-- O segredo fica no Supabase Vault, nunca na migration.
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  v_job record;
begin
  for v_job in select jobid from cron.job where jobname = 'betleads-sms-balance-check'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'betleads-sms-balance-check',
  '*/15 * * * *',
  $job$
    select net.http_post(
      url := 'https://betleads.io/api/public/hooks/sms-balance-check',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'betleads_cron_secret' limit 1)
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $job$
);
