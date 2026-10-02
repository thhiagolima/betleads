-- Recompute each affected tenant/day once per SQL statement. This preserves
-- fast webhook writes and, importantly, avoids O(n²) work during bulk imports.
drop trigger if exists trg_daily_metrics_players on public.players;
drop trigger if exists trg_daily_metrics_deposits on public.deposits;
drop trigger if exists trg_daily_metrics_withdrawals on public.withdrawals;

create or replace function public.refresh_player_daily_metrics_statement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare r record;
begin
  if tg_op = 'INSERT' then
    for r in
      select distinct tenant_id, metric_date from (
        select tenant_id, (created_at at time zone 'America/Sao_Paulo')::date metric_date from new_rows
        union all
        select tenant_id, (ftd_em at time zone 'America/Sao_Paulo')::date from new_rows where ftd_em is not null
      ) x where tenant_id is not null and metric_date is not null
    loop perform public.refresh_tenant_daily_metric_day(r.tenant_id, r.metric_date); end loop;
  elsif tg_op = 'DELETE' then
    for r in
      select distinct tenant_id, metric_date from (
        select tenant_id, (created_at at time zone 'America/Sao_Paulo')::date metric_date from old_rows
        union all
        select tenant_id, (ftd_em at time zone 'America/Sao_Paulo')::date from old_rows where ftd_em is not null
      ) x where tenant_id is not null and metric_date is not null
    loop perform public.refresh_tenant_daily_metric_day(r.tenant_id, r.metric_date); end loop;
  else
    for r in
      select distinct tenant_id, metric_date from (
        select o.tenant_id, (o.created_at at time zone 'America/Sao_Paulo')::date metric_date
        from old_rows o join new_rows n using (id)
        where o.tenant_id is distinct from n.tenant_id or o.created_at is distinct from n.created_at or o.ftd_em is distinct from n.ftd_em
        union all
        select n.tenant_id, (n.created_at at time zone 'America/Sao_Paulo')::date
        from old_rows o join new_rows n using (id)
        where o.tenant_id is distinct from n.tenant_id or o.created_at is distinct from n.created_at or o.ftd_em is distinct from n.ftd_em
        union all
        select o.tenant_id, (o.ftd_em at time zone 'America/Sao_Paulo')::date
        from old_rows o join new_rows n using (id)
        where o.ftd_em is not null and o.ftd_em is distinct from n.ftd_em
        union all
        select n.tenant_id, (n.ftd_em at time zone 'America/Sao_Paulo')::date
        from old_rows o join new_rows n using (id)
        where n.ftd_em is not null and o.ftd_em is distinct from n.ftd_em
      ) x where tenant_id is not null and metric_date is not null
    loop perform public.refresh_tenant_daily_metric_day(r.tenant_id, r.metric_date); end loop;
  end if;
  return null;
end;
$$;

create or replace function public.refresh_financial_daily_metrics_statement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare r record;
begin
  if tg_op = 'INSERT' then
    for r in select distinct tenant_id, (created_at at time zone 'America/Sao_Paulo')::date metric_date
      from new_rows where tenant_id is not null
    loop perform public.refresh_tenant_daily_metric_day(r.tenant_id, r.metric_date); end loop;
  elsif tg_op = 'DELETE' then
    for r in select distinct tenant_id, (created_at at time zone 'America/Sao_Paulo')::date metric_date
      from old_rows where tenant_id is not null
    loop perform public.refresh_tenant_daily_metric_day(r.tenant_id, r.metric_date); end loop;
  else
    for r in
      select distinct tenant_id, metric_date from (
        select o.tenant_id, (o.created_at at time zone 'America/Sao_Paulo')::date metric_date
        from old_rows o join new_rows n using (id)
        where to_jsonb(o) is distinct from to_jsonb(n)
        union all
        select n.tenant_id, (n.created_at at time zone 'America/Sao_Paulo')::date
        from old_rows o join new_rows n using (id)
        where to_jsonb(o) is distinct from to_jsonb(n)
      ) x where tenant_id is not null and metric_date is not null
    loop perform public.refresh_tenant_daily_metric_day(r.tenant_id, r.metric_date); end loop;
  end if;
  return null;
end;
$$;

create trigger trg_daily_metrics_players_insert
after insert on public.players referencing new table as new_rows
for each statement execute function public.refresh_player_daily_metrics_statement();
create trigger trg_daily_metrics_players_update
after update on public.players referencing old table as old_rows new table as new_rows
for each statement execute function public.refresh_player_daily_metrics_statement();
create trigger trg_daily_metrics_players_delete
after delete on public.players referencing old table as old_rows
for each statement execute function public.refresh_player_daily_metrics_statement();

create trigger trg_daily_metrics_deposits_insert
after insert on public.deposits referencing new table as new_rows
for each statement execute function public.refresh_financial_daily_metrics_statement();
create trigger trg_daily_metrics_deposits_update
after update on public.deposits referencing old table as old_rows new table as new_rows
for each statement execute function public.refresh_financial_daily_metrics_statement();
create trigger trg_daily_metrics_deposits_delete
after delete on public.deposits referencing old table as old_rows
for each statement execute function public.refresh_financial_daily_metrics_statement();

create trigger trg_daily_metrics_withdrawals_insert
after insert on public.withdrawals referencing new table as new_rows
for each statement execute function public.refresh_financial_daily_metrics_statement();
create trigger trg_daily_metrics_withdrawals_update
after update on public.withdrawals referencing old table as old_rows new table as new_rows
for each statement execute function public.refresh_financial_daily_metrics_statement();
create trigger trg_daily_metrics_withdrawals_delete
after delete on public.withdrawals referencing old table as old_rows
for each statement execute function public.refresh_financial_daily_metrics_statement();

create index if not exists deposits_tenant_player_status_idx
  on public.deposits (tenant_id, player_id, status);
create index if not exists withdrawals_tenant_player_status_idx
  on public.withdrawals (tenant_id, player_id, status);
