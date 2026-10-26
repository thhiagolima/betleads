-- Task 3: ciclo da hora de cobrança (mensalidade). O segredo fica no
-- Supabase Vault, nunca na migration (padrão de 20261022110100).
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  v_job record;
begin
  for v_job in
    select jobid from cron.job
    where jobname in (
      'betleads-billing-cycle'
    )
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'betleads-billing-cycle',
  '7 * * * *',
  $job$
    select net.http_post(
      url := 'https://betleads.io/api/public/hooks/billing-cycle',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'betleads_cron_secret' limit 1)
      ),
      body := '{}'::jsonb
    );
  $job$
);

notify pgrst, 'reload schema';
