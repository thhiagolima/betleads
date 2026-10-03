-- P4: processa a fila por conta da Meta Ads e cria as sincronizações diárias.
-- O endpoint exige CRON_SECRET; o valor permanece no Vault do Supabase.
do $$
declare
  v_job record;
begin
  for v_job in
    select jobid from cron.job where jobname = 'betleads-meta-sync-worker'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule('betleads-meta-sync-worker', '*/5 * * * *', $job$
  select net.http_post(
    url := 'https://betleads.io/api/public/meta-sync/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization',
      'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'betleads_cron_secret'
        limit 1
      )
    ),
    body := '{}'::jsonb
  );
$job$);
