-- Central de Resultados: daily consistency checks (Q-01 of
-- docs/ESCOPO_CENTRAL_RESULTADOS_CRM_2026-10-15.md).
--
-- Every morning, for yesterday (BRT) and every tenant, crm_results_daily is
-- compared with the raw data it is built from:
--   sends        accepted SMS in sms_send_logs              (tolerance 1 or 1%)
--   cost         net credits charged in sms_credit_ledger x price (tolerance 2%)
--   direct       direct deposit attributions                (tolerance 1 or 2%)
-- Results go to crm_results_health; the Central's "Saúde dos dados" tab shows
-- the latest result of each check and any failure.

create table if not exists public.crm_results_health (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  metric_date date not null,
  check_name text not null check (check_name in ('sends', 'cost', 'direct')),
  expected numeric not null,
  actual numeric not null,
  ok boolean not null,
  checked_at timestamptz not null default now(),
  primary key (tenant_id, metric_date, check_name)
);

alter table public.crm_results_health enable row level security;

drop policy if exists "crm results health read" on public.crm_results_health;
create policy "crm results health read"
on public.crm_results_health for select to authenticated
using (public.has_tenant_access(tenant_id));

create or replace function public.check_crm_results_day(_tenant uuid, _day date)
returns integer -- failed checks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from timestamptz := (_day::timestamp at time zone 'America/Sao_Paulo');
  v_to timestamptz := ((_day + 1)::timestamp at time zone 'America/Sao_Paulo');
  v_price numeric;
  v_table record;
  v_raw_sent numeric;
  v_raw_cost numeric;
  v_raw_direct numeric;
  v_failed integer := 0;
  v_ok boolean;
begin
  select coalesce(
    (select sale_price_per_sms from public.tenant_sms_pricing where tenant_id = _tenant),
    (select default_sale_price_per_sms from public.sms_credit_settings limit 1),
    0.12
  ) into v_price;

  select coalesce(sum(sent), 0) sent, coalesce(sum(cost), 0) cost,
         coalesce(sum(direct_conversions), 0) direct
    into v_table
  from public.crm_results_daily
  where tenant_id = _tenant and metric_date = _day;

  select count(*) into v_raw_sent
  from public.sms_send_logs
  where tenant_id = _tenant and created_at >= v_from and created_at < v_to
    and status in ('sent', 'delivered', 'enviado', 'entregue');

  select coalesce(sum(-delta_credits * coalesce(unit_sale_price, v_price)), 0) into v_raw_cost
  from public.sms_credit_ledger
  where tenant_id = _tenant and created_at >= v_from and created_at < v_to
    and entry_type in ('sms_reservation', 'sms_refund');

  select count(*) into v_raw_direct
  from public.conversion_attributions
  where tenant_id = _tenant and occurred_at >= v_from and occurred_at < v_to
    and classification = 'direct' and event_type = 'deposit_approved';

  v_ok := abs(v_table.sent - v_raw_sent) <= greatest(1, 0.01 * v_raw_sent);
  insert into public.crm_results_health values (_tenant, _day, 'sends', v_raw_sent, v_table.sent, v_ok, now())
  on conflict (tenant_id, metric_date, check_name) do update
    set expected = excluded.expected, actual = excluded.actual, ok = excluded.ok, checked_at = now();
  v_failed := v_failed + (not v_ok)::int;

  -- Tenants without a credit ledger have nothing to reconcile the cost with.
  if v_raw_cost > 0 then
    v_ok := abs(v_table.cost - v_raw_cost) <= greatest(v_price, 0.02 * v_raw_cost);
    insert into public.crm_results_health values (_tenant, _day, 'cost', v_raw_cost, v_table.cost, v_ok, now())
    on conflict (tenant_id, metric_date, check_name) do update
      set expected = excluded.expected, actual = excluded.actual, ok = excluded.ok, checked_at = now();
    v_failed := v_failed + (not v_ok)::int;
  end if;

  v_ok := abs(v_table.direct - v_raw_direct) <= greatest(1, 0.02 * v_raw_direct);
  insert into public.crm_results_health values (_tenant, _day, 'direct', v_raw_direct, v_table.direct, v_ok, now())
  on conflict (tenant_id, metric_date, check_name) do update
    set expected = excluded.expected, actual = excluded.actual, ok = excluded.ok, checked_at = now();
  v_failed := v_failed + (not v_ok)::int;

  return v_failed;
end;
$$;

create or replace function public.check_crm_results_recent()
returns integer -- failed checks across tenants (-1 = another run holds the lock)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'America/Sao_Paulo')::date - 1;
  v_tenant uuid;
  v_failed integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('betleads.check_crm_results')::bigint) then
    return -1;
  end if;
  for v_tenant in select id from public.tenants order by id loop
    begin
      v_failed := v_failed + public.check_crm_results_day(v_tenant, v_day);
    exception when others then
      raise warning 'check_crm_results: tenant % failed: % %', v_tenant, sqlstate, left(sqlerrm, 200);
    end;
  end loop;
  if v_failed > 0 then
    raise warning 'check_crm_results: % failed check(s) for %', v_failed, v_day;
  end if;
  return v_failed;
end;
$$;

revoke all on function public.check_crm_results_day(uuid, date) from public, anon, authenticated;
grant execute on function public.check_crm_results_day(uuid, date) to service_role;
revoke all on function public.check_crm_results_recent() from public, anon, authenticated;
grant execute on function public.check_crm_results_recent() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'betleads-crm-results-health';
    -- After the daily 8-day refresh (03:20 BRT): yesterday, every tenant, 03:40 BRT.
    perform cron.schedule(
      'betleads-crm-results-health',
      '40 6 * * *',
      $cron$set statement_timeout = '300s'; select public.check_crm_results_recent();$cron$
    );
  end if;
end $$;
