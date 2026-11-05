-- Web push (OneSignal) Task 2: item de cobrança `webpush`, R$ 0,01 por push
-- aceito pela OneSignal, provider_unit_cost 0 (nenhuma tela da casa mostra
-- custo por inscrito ou custo da OneSignal, só o preço de venda).
--
-- Troca os checks de item de `billing_price_book`/`tenant_price_overrides`
-- de 20261022100000_billing_price_book.sql para incluir 'webpush' e recria
-- `wallet_reserve`/`wallet_summary` com o corpo idêntico ao das versões mais
-- recentes (20261022100100_billing_wallet.sql:223 e
-- 20261024100100_billing_wallet_alerts.sql:201), mudando só a lista de itens
-- aceitos.

alter table public.billing_price_book
  drop constraint billing_price_book_item_check;
alter table public.billing_price_book
  add constraint billing_price_book_item_check
    check (item in ('sms', 'voice_30s', 'email', 'webpush'));

alter table public.tenant_price_overrides
  drop constraint tenant_price_overrides_item_check;
alter table public.tenant_price_overrides
  add constraint tenant_price_overrides_item_check
    check (item in ('sms', 'voice_30s', 'email', 'webpush'));

insert into public.billing_price_book (item, valid_from, unit_price, provider_unit_cost, free_monthly_units)
values ('webpush', '2026-11-01', 0.01, 0, 0);

-- Igual a 20261022100100_billing_wallet.sql:223, só muda a lista de itens
-- aceitos na linha 258.
create or replace function public.wallet_reserve(
  _tenant uuid,
  _item text,
  _units integer,
  _reference_type text,
  _reference_id text,
  _idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_at timestamptz;
  v_price jsonb;
  v_unit_price numeric(12,4);
  v_provider_cost numeric(12,4);
  v_free_limit integer;
  v_exempt boolean;
  v_month date;
  v_free_used bigint;
  v_free integer;
  v_billable integer;
  v_amount numeric(14,4);
  v_result jsonb;
begin
  if auth.role() <> 'service_role' and not public.is_super_admin() then
    raise exception 'forbidden';
  end if;

  if _tenant is null then
    raise exception 'invalid_wallet_reserve';
  end if;

  if _item is null or _item not in ('sms', 'voice_30s', 'email', 'webpush') then
    raise exception 'invalid_item';
  end if;

  if _units is null or _units <= 0 then
    raise exception 'invalid_units';
  end if;

  -- Garante a carteira e trava a linha ANTES de ler a franquia do mês: sem
  -- isso, duas reservas concorrentes no mesmo mês poderiam ler o mesmo
  -- free_units_used e gastar a franquia duas vezes. wallet_mutation trava a
  -- mesma linha de novo mais abaixo (a mesma transação pode travar outra vez
  -- a linha que já travou, sem autodeadlock).
  insert into public.tenant_wallets (tenant_id)
  values (_tenant)
  on conflict (tenant_id) do nothing;

  perform 1 from public.tenant_wallets where tenant_id = _tenant for update;

  v_at := public.billing_now();
  v_month := date_trunc('month', v_at at time zone 'America/Sao_Paulo')::date;

  v_price := public.billing_effective_price(_tenant, _item, v_at);
  v_unit_price := (v_price ->> 'unit_price')::numeric;
  v_free_limit := coalesce((v_price ->> 'free_monthly_units')::integer, 0);
  v_exempt := (v_price ->> 'exempt')::boolean;

  -- Mesmo para uma casa isenta: sem preço cadastrado, algo está errado com
  -- o catálogo e a reserva deve falhar de forma clara, não silenciar o
  -- custo do fornecedor nem virar um 'invalid_wallet_mutation' opaco.
  if v_unit_price is null then
    raise exception 'price_not_found';
  end if;

  -- Custo do fornecedor lido direto da tabela (mesma regra de vigência de
  -- billing_effective_price), nunca da chave provider_unit_cost acima: ela
  -- pode ter sido removida da resposta se quem chamou for um superadmin
  -- autenticado (ainda que permitido a chamar wallet_reserve).
  select bp.provider_unit_cost into v_provider_cost
  from public.billing_price_book bp
  where bp.item = _item and bp.valid_from <= v_at
  order by bp.valid_from desc
  limit 1;

  select free_units_used into v_free_used
  from public.tenant_monthly_usage
  where tenant_id = _tenant and month = v_month and item = _item;

  v_free_used := coalesce(v_free_used, 0);
  v_free := least(_units, greatest(v_free_limit - v_free_used, 0));
  v_billable := _units - v_free;

  if v_exempt then
    v_amount := 0;
  else
    v_amount := -(v_billable * v_unit_price);
  end if;

  v_result := public.wallet_mutation(
    _tenant, v_amount, 'usage_reservation', _item, _units, v_free, v_month,
    v_unit_price, v_provider_cost, _reference_type, _reference_id, _idempotency_key,
    'Reserva de uso', '{}'::jsonb, null
  );

  if not (v_result ->> 'idempotent')::boolean then
    insert into public.tenant_monthly_usage (tenant_id, month, item, units, free_units_used, billed_amount)
    values (_tenant, v_month, _item, _units, v_free, abs(v_amount))
    on conflict (tenant_id, month, item) do update
      set units = public.tenant_monthly_usage.units + excluded.units,
          free_units_used = public.tenant_monthly_usage.free_units_used + excluded.free_units_used,
          billed_amount = public.tenant_monthly_usage.billed_amount + excluded.billed_amount;
  end if;

  return v_result || jsonb_build_object('exempt', v_exempt);
end;
$$;

-- Igual a 20261024100100_billing_wallet_alerts.sql:201, só acrescenta
-- ('webpush') ao `values` da lista de itens (antes na linha 252).
create or replace function public.wallet_summary(_tenant uuid default public.current_tenant_id())
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_wallet public.tenant_wallets%rowtype;
  v_at timestamptz;
  v_month date;
  v_usage jsonb;
  v_prices jsonb;
  v_exempt boolean;
begin
  if _tenant is null
     or (
       not public.has_tenant_access(_tenant)
       and not public.is_super_admin()
       and auth.role() <> 'service_role'
     ) then
    raise exception 'forbidden';
  end if;

  select * into v_wallet from public.tenant_wallets where tenant_id = _tenant;

  v_at := public.billing_now();
  v_month := date_trunc('month', v_at at time zone 'America/Sao_Paulo')::date;
  v_exempt := public.billing_tenant_exempt(_tenant);

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'item', item,
        'units', units,
        'free_units_used', free_units_used,
        'billed_amount', billed_amount
      )
      order by item
    ),
    '[]'::jsonb
  )
  into v_usage
  from public.tenant_monthly_usage
  where tenant_id = _tenant and month = v_month;

  select coalesce(
    jsonb_object_agg(items.item, public.billing_effective_price(_tenant, items.item, v_at)),
    '{}'::jsonb
  )
  into v_prices
  from (values ('sms'), ('voice_30s'), ('email'), ('webpush')) as items(item);

  return jsonb_build_object(
    'balance', coalesce(v_wallet.balance, 0),
    'lifetime_purchased', coalesce(v_wallet.lifetime_purchased, 0),
    'lifetime_used', coalesce(v_wallet.lifetime_used, 0),
    'low_balance_threshold', coalesce(v_wallet.low_balance_threshold, 200),
    'exempt', v_exempt,
    'month_usage', v_usage,
    'prices', v_prices
  );
end;
$$;

revoke execute on function public.wallet_reserve(uuid, text, integer, text, text, text) from public, anon;
grant execute on function public.wallet_reserve(uuid, text, integer, text, text, text) to service_role;

revoke execute on function public.wallet_summary(uuid) from public, anon;
grant execute on function public.wallet_summary(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
