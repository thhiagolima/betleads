-- Mantém a tabela diária como fonte única do dashboard sem colocar agregações
-- pesadas no caminho dos webhooks. O intervalo é atualizado sob demanda e o
-- servidor aplica cache à chamada do dashboard.
create or replace function public.refresh_dashboard_daily_metrics_range(
  _tenant uuid,
  _from date,
  _to date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from date := least(_from, _to);
  v_to date := greatest(_from, _to);
  v_day date;
begin
  if not (public.has_tenant_access(_tenant) or auth.role() = 'service_role') then
    raise exception 'Tenant access denied';
  end if;

  if v_to - v_from > 731 then
    raise exception 'O período de métricas não pode exceder 732 dias';
  end if;

  for v_day in
    select metric_date::date
    from generate_series(v_from, v_to, interval '1 day') as days(metric_date)
  loop
    perform public.refresh_tenant_daily_metric_day(_tenant, v_day);
  end loop;
end;
$$;

revoke all on function public.refresh_dashboard_daily_metrics_range(uuid, date, date)
  from public, anon;
grant execute on function public.refresh_dashboard_daily_metrics_range(uuid, date, date)
  to authenticated, service_role;
