-- SMS price (client, 16/10): the real cost of an SMS is R$ 0,059, and Sorte Alta,
-- PixReals and ForrandoBet use it as their sale price per credit too. The default
-- sale price for other houses stays as is.
--
-- crm_results_daily is rebuilt afterwards with the new price, so the cost check
-- now reconciles the number of credits charged at the current price instead of
-- the unit price recorded at the time (R$ 0,12 before this change), which would
-- flag every restated day.

update public.sms_credit_settings set provider_cost_per_sms = 0.059, updated_at = now();

do $$
declare
  tenant_count integer;
begin
  select count(*) into tenant_count
  from public.tenants
  where slug in ('pixpgf', 'pixreals', 'forrandobet');
  if tenant_count <> 3 then
    raise exception 'Expected Sorte Alta, PixReals and ForrandoBet tenants, found %', tenant_count;
  end if;

  insert into public.tenant_sms_pricing (tenant_id, sale_price_per_sms, provider_cost_per_sms)
  select id, 0.059, 0.059
  from public.tenants
  where slug in ('pixpgf', 'pixreals', 'forrandobet')
  on conflict (tenant_id) do update
    set sale_price_per_sms = excluded.sale_price_per_sms,
        provider_cost_per_sms = excluded.provider_cost_per_sms,
        updated_at = now();
end $$;

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

  -- Credits charged at the current price, the same price the table uses.
  select coalesce(sum(-delta_credits), 0) * v_price into v_raw_cost
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
