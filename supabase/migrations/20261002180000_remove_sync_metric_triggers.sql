-- Financial webhooks must never wait for analytics aggregation. The previous
-- statement triggers recomputed an entire tenant/day for every incoming event,
-- causing lock contention on tenant_daily_metrics and saturating PostgREST.
drop trigger if exists trg_daily_metrics_players on public.players;
drop trigger if exists trg_daily_metrics_deposits on public.deposits;
drop trigger if exists trg_daily_metrics_withdrawals on public.withdrawals;

drop trigger if exists trg_daily_metrics_players_insert on public.players;
drop trigger if exists trg_daily_metrics_players_update on public.players;
drop trigger if exists trg_daily_metrics_players_delete on public.players;
drop trigger if exists trg_daily_metrics_deposits_insert on public.deposits;
drop trigger if exists trg_daily_metrics_deposits_update on public.deposits;
drop trigger if exists trg_daily_metrics_deposits_delete on public.deposits;
drop trigger if exists trg_daily_metrics_withdrawals_insert on public.withdrawals;
drop trigger if exists trg_daily_metrics_withdrawals_update on public.withdrawals;
drop trigger if exists trg_daily_metrics_withdrawals_delete on public.withdrawals;

-- Authenticated users can refresh only a tenant they are allowed to access.
-- The expensive aggregation now runs on dashboard reads (behind the server
-- cache), outside the webhook transaction path.
create or replace function public.refresh_dashboard_daily_metric(
  _tenant uuid,
  _date date default (now() at time zone 'America/Sao_Paulo')::date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (public.has_tenant_access(_tenant) or auth.role() = 'service_role') then
    raise exception 'Tenant access denied';
  end if;

  perform public.refresh_tenant_daily_metric_day(_tenant, _date);
end;
$$;

revoke all on function public.refresh_dashboard_daily_metric(uuid, date)
  from public, anon;
grant execute on function public.refresh_dashboard_daily_metric(uuid, date)
  to authenticated, service_role;
