-- Voz: reativa o worker da fila regular. A migration anterior de reativação
-- deixou este job de fora, fazendo campanhas de voz agendadas permanecerem em
-- audio_ready mesmo com o provedor configurado.
do $$
declare
  v_job record;
begin
  for v_job in select jobid from cron.job where jobname = 'betleads-dispatch-call'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule('betleads-dispatch-call', '* * * * *', $job$
  select net.http_post(
    url := 'https://betleads.io/api/public/hooks/dispatch?channel=call',
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
