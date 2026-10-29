-- Financeiro redesign (Task 4, spec docs/ESCOPO_AUDITORIA_FINANCEIRO_2026-10-29.md
-- §3.5 and §4.4): each "other cost" gets a date and enters any period that
-- contains it, and a cost can repeat every month.
--
-- tenant_finance_other_costs (20261101100100_tenant_finance.sql):
--   * cost_date: the day of the cost, backfilled with month (the 1st); month
--     is kept for compatibility and always holds cost_date's month.
--   * repeat_monthly: "Repetir todo mês" (off by default).
--   * series_id: null for a lone cost; a repeating cost and its monthly
--     copies share it (the first one's id). One row per series and month.
--
-- finance_materialize_recurring_costs copies the latest row of each repeating
-- series into the current month (São Paulo) on the series' original day,
-- clamped to the month's last day; it runs daily with pg_cron.

alter table public.tenant_finance_other_costs
  add column if not exists cost_date date,
  add column if not exists repeat_monthly boolean not null default false,
  add column if not exists series_id uuid;

update public.tenant_finance_other_costs set cost_date = month where cost_date is null;

alter table public.tenant_finance_other_costs alter column cost_date set not null;

alter table public.tenant_finance_other_costs
  drop constraint if exists tenant_finance_other_costs_cost_date_in_month;
alter table public.tenant_finance_other_costs
  add constraint tenant_finance_other_costs_cost_date_in_month
    check (date_trunc('month', cost_date::timestamp)::date = month);

create unique index if not exists tenant_finance_other_costs_series_month_key
  on public.tenant_finance_other_costs (series_id, month)
  where series_id is not null;

create index if not exists tenant_finance_other_costs_tenant_date_idx
  on public.tenant_finance_other_costs (tenant_id, cost_date);

comment on column public.tenant_finance_other_costs.cost_date is
  'Day of the cost: it enters every period that contains this date. month is its first day.';
comment on column public.tenant_finance_other_costs.repeat_monthly is
  '"Repetir todo mês": the latest row of a series with this on is copied into each new month.';
comment on column public.tenant_finance_other_costs.series_id is
  'Repeating series (the first row''s id); null for a cost that never repeated.';

-- Keeps month and cost_date together while a writer only knows one of them
-- (the app before this change writes month only).
create or replace function public.tenant_finance_other_costs_sync_dates()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.cost_date := coalesce(new.cost_date, new.month);
    new.month := coalesce(new.month, date_trunc('month', new.cost_date::timestamp)::date);
  elsif new.month is distinct from old.month and new.cost_date is not distinct from old.cost_date then
    new.cost_date := new.month;
  elsif new.cost_date is distinct from old.cost_date and new.month is not distinct from old.month then
    new.month := date_trunc('month', new.cost_date::timestamp)::date;
  end if;
  return new;
end;
$$;

drop trigger if exists tenant_finance_other_costs_sync_dates on public.tenant_finance_other_costs;
create trigger tenant_finance_other_costs_sync_dates
  before insert or update on public.tenant_finance_other_costs
  for each row execute function public.tenant_finance_other_costs_sync_dates();

-- One copy per repeating series for _today's month, once _today reaches the
-- target day (the original day of month, clamped to the month's last day).
-- Only a series whose latest row repeats and lies in an earlier month is
-- copied; the unique (series_id, month) index makes reruns no-ops.
create or replace function public.finance_materialize_recurring_costs(
  _today date default (now() at time zone 'America/Sao_Paulo')::date
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', _today::timestamp)::date;
  v_last date := (date_trunc('month', _today::timestamp) + interval '1 month - 1 day')::date;
  v_count integer;
begin
  insert into public.tenant_finance_other_costs
    (tenant_id, month, cost_date, descricao, valor, categoria, repeat_monthly, series_id, created_by)
  select latest.tenant_id, v_month, target.day, latest.descricao, latest.valor, latest.categoria,
         true, latest.series_id, null
    from (
      select distinct on (c.series_id) c.*
        from public.tenant_finance_other_costs c
       where c.series_id is not null
       order by c.series_id, c.cost_date desc, c.created_at desc
    ) latest
    left join public.tenant_finance_other_costs origin on origin.id = latest.series_id
    cross join lateral (
      select least(
        v_month + (extract(day from coalesce(origin.cost_date, latest.cost_date))::int - 1),
        v_last
      ) as day
    ) target
   where latest.repeat_monthly
     and latest.month < v_month
     and _today >= target.day
  on conflict (series_id, month) where series_id is not null do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.finance_materialize_recurring_costs(date) from public, anon, authenticated;
grant execute on function public.finance_materialize_recurring_costs(date) to service_role;

-- Daily at 03:10 UTC (00:10 in São Paulo), same pattern as
-- 20261023100100_billing_cycle_cron.sql.
create extension if not exists pg_cron;

do $$
declare
  v_job record;
begin
  for v_job in
    select jobid from cron.job where jobname = 'finance-recurring-costs'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'finance-recurring-costs',
  '10 3 * * *',
  $$select public.finance_materialize_recurring_costs()$$
);

notify pgrst, 'reload schema';
