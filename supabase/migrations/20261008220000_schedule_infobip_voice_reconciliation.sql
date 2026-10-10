-- Reconciliação diária de callbacks de Voz, E-mail e SMS. 09:00 UTC = 06:00 BRT (Brasília).
-- O job apenas audita pendências; ele não inventa resultado de chamada sem o
-- notifyUrl/relatório do provedor explicitamente aceito.
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare v_job record;
begin
  for v_job in select jobid from cron.job where jobname = 'betleads-reconcile-infobip-voice'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule('betleads-reconcile-infobip-voice', '0 9 * * *', $job$
  select net.http_post(
    url := 'https://betleads.io/api/public/infobip/voice/reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'betleads_cron_secret' limit 1
      )
    ),
    body := '{}'::jsonb
  );
$job$);
