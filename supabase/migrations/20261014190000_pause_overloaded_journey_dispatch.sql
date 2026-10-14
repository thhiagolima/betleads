-- Emergency circuit breaker: the parallel dispatcher exposed a slow contact
-- reservation query and is exhausting database workers. Preserve the queue
-- and stop new claims until the query is indexed and revalidated.
do $$
declare v_job record;
begin
  for v_job in select jobid from cron.job where jobname = 'betleads-dispatch-journey'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;
