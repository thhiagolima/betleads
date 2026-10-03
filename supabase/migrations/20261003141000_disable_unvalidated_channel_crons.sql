-- Ligações e WhatsApp ainda não possuem validação operacional fim a fim.
-- Mantemos os canais fora do cron até provider, fila e relatórios serem aceitos.
do $$
declare
  v_job record;
begin
  for v_job in
    select jobid from cron.job
    where jobname in ('betleads-dispatch-call', 'betleads-dispatch-whatsapp')
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;
