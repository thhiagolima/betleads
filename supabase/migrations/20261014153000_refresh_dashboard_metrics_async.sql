-- O dashboard deve apenas ler o resumo materializado. Recalcular cada dia do
-- intervalo durante a requisição HTTP pode exceder o statement_timeout em
-- tenants com histórico grande e impede a página de abrir.
create or replace function public.refresh_recent_dashboard_metrics()
returns void
language plpgsql
security definer
set search_path = public
set statement_timeout = '0'
as $$
declare
  v_tenant_id uuid;
  v_day date;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  for v_tenant_id in select id from public.tenants loop
    -- Eventos podem chegar com atraso; atualizamos hoje e ontem fora da
    -- requisição do usuário. Dias mais antigos já permanecem materializados.
    for v_day in select generate_series(v_today - 1, v_today, interval '1 day')::date loop
      perform public.refresh_tenant_daily_metric_day(v_tenant_id, v_day);
    end loop;
  end loop;
end;
$$;

revoke all on function public.refresh_recent_dashboard_metrics() from public, anon, authenticated;
grant execute on function public.refresh_recent_dashboard_metrics() to service_role;

create extension if not exists pg_cron;

do $$
declare
  v_job record;
begin
  for v_job in select jobid from cron.job where jobname = 'betleads-refresh-dashboard-metrics'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'betleads-refresh-dashboard-metrics',
  '*/5 * * * *',
  $job$select public.refresh_recent_dashboard_metrics();$job$
);
