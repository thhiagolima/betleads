-- Saldo único e razão (PG1, Task 3): uma carteira em BRL por casa
-- (`tenant_wallets`), um razão append-only (`wallet_ledger`) e o consumo
-- mensal por item/franquia (`tenant_monthly_usage`).
--
-- `wallet_mutation` é o único lugar que grava no razão e move o saldo: trava
-- a linha da carteira com FOR UPDATE antes de ler, cria a carteira com
-- `insert ... on conflict do nothing` antes do lock (igual a
-- apply_sms_credit_mutation em 20260922193000_create_sms_credit_billing.sql) e
-- é idempotente por (tenant_id, idempotency_key). É interno: não recebe
-- grant de EXECUTE para authenticated, só para service_role (quem chama são
-- as outras RPCs desta migration, que herdam o privilégio do owner da
-- function ao chamar outra SECURITY DEFINER).
--
-- `wallet_reserve`/`wallet_refund` são só para service_role ou superadmin
-- (quem envia SMS/e-mail/voz é o backend, nunca o navegador da casa).
-- `wallet_reserve` lê o custo do fornecedor direto de `billing_price_book`
-- (pela mesma regra de vigência de `billing_effective_price`) em vez de usar
-- a chave `provider_unit_cost` de `billing_effective_price`, porque essa
-- function remove a chave para qualquer usuário autenticado que não seja
-- superadmin — e o razão precisa do custo mesmo quando quem chama é um
-- superadmin com JWT.
--
-- `billing_now()` existe para o teste de virada de mês: em produção é só
-- `now()`; os testes fixam `test.now` para simular 31/10 23:59 e 01/11 00:01
-- (horário de Brasília) sem esperar o relógio.

create or replace function public.billing_now()
returns timestamptz
language sql
stable
as $$
  select coalesce(nullif(current_setting('test.now', true), '')::timestamptz, now())
$$;

create table public.tenant_wallets (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  balance numeric(14,4) not null default 0 check (balance >= 0),
  lifetime_purchased numeric(14,4) not null default 0,
  lifetime_used numeric(14,4) not null default 0,
  updated_at timestamptz not null default now()
);

create table public.wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  entry_type text not null check (
    entry_type in ('purchase', 'manual_adjustment', 'usage_reservation', 'usage_refund', 'migration')
  ),
  item text null,
  units integer null,
  free_units integer null,
  usage_month date null,
  unit_price numeric(12,4) null,
  provider_unit_cost numeric(12,4) null,
  amount numeric(14,4) not null,
  balance_after numeric(14,4) not null,
  reference_type text null,
  reference_id text null,
  idempotency_key text null,
  reason text null,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid null,
  created_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

create index idx_wallet_ledger_tenant_reference
  on public.wallet_ledger (tenant_id, reference_id);
create index idx_wallet_ledger_tenant_created
  on public.wallet_ledger (tenant_id, created_at desc);

create table public.tenant_monthly_usage (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  month date not null,
  item text not null,
  units bigint not null default 0,
  free_units_used bigint not null default 0,
  billed_amount numeric(14,4) not null default 0,
  primary key (tenant_id, month, item)
);

-- Grava a mutação no razão e move o saldo. Trava a linha da carteira com
-- FOR UPDATE antes de ler o saldo para garantir que reservas concorrentes
-- nunca deixem o saldo negativo (a carteira é criada com ON CONFLICT DO
-- NOTHING antes do lock, nunca depois). Idempotente por
-- (tenant_id, idempotency_key): repetir a chave devolve a linha já gravada
-- sem gravar de novo. Interno: não é chamado diretamente pelo cliente, só
-- por wallet_reserve / wallet_refund / admin_adjust_wallet.
create or replace function public.wallet_mutation(
  _tenant uuid,
  _amount numeric,
  _entry_type text,
  _item text,
  _units integer,
  _free_units integer,
  _usage_month date,
  _unit_price numeric,
  _provider_unit_cost numeric,
  _reference_type text,
  _reference_id text,
  _idempotency_key text,
  _reason text,
  _metadata jsonb,
  _created_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_existing public.wallet_ledger%rowtype;
  v_balance numeric(14,4);
  v_after numeric(14,4);
  v_ledger_id uuid;
begin
  if _tenant is null or _amount is null or _entry_type is null then
    raise exception 'invalid_wallet_mutation';
  end if;

  if _idempotency_key is not null then
    select * into v_existing
    from public.wallet_ledger
    where tenant_id = _tenant and idempotency_key = _idempotency_key;

    if found then
      return jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'ledger_id', v_existing.id,
        'amount', v_existing.amount,
        'balance', v_existing.balance_after
      );
    end if;
  end if;

  insert into public.tenant_wallets (tenant_id)
  values (_tenant)
  on conflict (tenant_id) do nothing;

  select balance into v_balance
  from public.tenant_wallets
  where tenant_id = _tenant
  for update;

  v_after := v_balance + _amount;
  if v_after < 0 then
    raise exception 'insufficient_balance';
  end if;

  update public.tenant_wallets
     set balance = v_after,
         lifetime_purchased = lifetime_purchased
           + case when _entry_type = 'purchase' and _amount > 0 then _amount else 0 end,
         lifetime_used = lifetime_used
           + case when _entry_type = 'usage_reservation' and _amount < 0 then -_amount else 0 end,
         updated_at = now()
   where tenant_id = _tenant;

  insert into public.wallet_ledger (
    tenant_id, entry_type, item, units, free_units, usage_month,
    unit_price, provider_unit_cost, amount, balance_after,
    reference_type, reference_id, idempotency_key, reason, metadata, created_by
  ) values (
    _tenant, _entry_type, _item, _units, _free_units, _usage_month,
    _unit_price, _provider_unit_cost, _amount, v_after,
    _reference_type, _reference_id, _idempotency_key, _reason,
    coalesce(_metadata, '{}'::jsonb), _created_by
  )
  returning id into v_ledger_id;

  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'ledger_id', v_ledger_id,
    'amount', _amount,
    'balance', v_after
  );
end;
$$;

-- Reserva o uso de um item (sms/voice_30s/email). free = quanto da franquia
-- mensal ainda resta; o restante é cobrado ao preço efetivo da casa, ou 0 se
-- a casa for isenta (o consumo ainda é registrado, só não é debitado). Só
-- atualiza tenant_monthly_usage quando a mutação não é idempotente (uma
-- repetição não deve contar a unidade duas vezes).
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

  if _tenant is null or _item is null or _units is null or _units <= 0 then
    raise exception 'invalid_wallet_reserve';
  end if;

  v_at := public.billing_now();
  v_month := date_trunc('month', v_at at time zone 'America/Sao_Paulo')::date;

  v_price := public.billing_effective_price(_tenant, _item, v_at);
  v_unit_price := (v_price ->> 'unit_price')::numeric;
  v_free_limit := coalesce((v_price ->> 'free_monthly_units')::integer, 0);
  v_exempt := (v_price ->> 'exempt')::boolean;

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

-- Estorna a última reserva de uso com esse reference_id, devolvendo
-- exatamente o amount gravado na reserva (nunca units x preço atual, que
-- pode ter mudado). Sem reserva encontrada, devolve ok:false em vez de
-- lançar exceção (cobre o SMS que reservou no razão antigo e cuja resposta
-- do provedor chega depois do deploy desta migration). Desconta de
-- tenant_monthly_usage no usage_month gravado na reserva, não no mês atual.
create or replace function public.wallet_refund(
  _tenant uuid,
  _reference_id text,
  _idempotency_key text,
  _reason text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reservation public.wallet_ledger%rowtype;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' and not public.is_super_admin() then
    raise exception 'forbidden';
  end if;

  select * into v_reservation
  from public.wallet_ledger
  where tenant_id = _tenant
    and reference_id = _reference_id
    and entry_type = 'usage_reservation'
  order by created_at desc
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'reservation_not_found');
  end if;

  v_result := public.wallet_mutation(
    _tenant, -v_reservation.amount, 'usage_refund', v_reservation.item,
    v_reservation.units, v_reservation.free_units, v_reservation.usage_month,
    v_reservation.unit_price, v_reservation.provider_unit_cost,
    v_reservation.reference_type, _reference_id, _idempotency_key,
    _reason, '{}'::jsonb, null
  );

  if not (v_result ->> 'idempotent')::boolean then
    update public.tenant_monthly_usage
       set units = units - v_reservation.units,
           free_units_used = free_units_used - v_reservation.free_units,
           billed_amount = billed_amount - abs(v_reservation.amount)
     where tenant_id = _tenant and month = v_reservation.usage_month and item = v_reservation.item;
  end if;

  return v_result;
end;
$$;

-- Ajuste manual do saldo (compra registrada manualmente, correção, etc). Só
-- superadmin, motivo obrigatório.
create or replace function public.admin_adjust_wallet(
  _tenant uuid,
  _amount numeric,
  _reason text,
  _idempotency_key text default gen_random_uuid()::text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not public.is_super_admin() then
    raise exception 'forbidden';
  end if;

  if _reason is null or btrim(_reason) = '' then
    raise exception 'invalid_reason';
  end if;

  return public.wallet_mutation(
    _tenant, _amount, 'manual_adjustment', null, null, null, null,
    null, null, 'manual_adjustment', _idempotency_key, _idempotency_key,
    _reason, '{}'::jsonb, auth.uid()
  );
end;
$$;

-- Resumo da carteira de uma casa: saldo, totais vitalícios, isenção, consumo
-- do mês corrente por item e o preço efetivo de cada item. A regra de acesso
-- é a mesma de sms_credit_summary; o custo do fornecedor nunca aparece aqui
-- porque "prices" vem de billing_effective_price, que já o remove para
-- qualquer usuário autenticado que não seja superadmin.
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
  from (values ('sms'), ('voice_30s'), ('email')) as items(item);

  return jsonb_build_object(
    'balance', coalesce(v_wallet.balance, 0),
    'lifetime_purchased', coalesce(v_wallet.lifetime_purchased, 0),
    'lifetime_used', coalesce(v_wallet.lifetime_used, 0),
    'exempt', v_exempt,
    'month_usage', v_usage,
    'prices', v_prices
  );
end;
$$;

-- Lista as casas cujo saldo não bate com a soma do razão (deveria vir sempre
-- vazia; serve para detectar uma escrita direta na carteira, fora das RPCs).
-- Só service_role ou superadmin.
create or replace function public.billing_wallet_integrity()
returns table (tenant_id uuid, balance numeric, ledger_sum numeric)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if auth.role() <> 'service_role' and not public.is_super_admin() then
    raise exception 'forbidden';
  end if;

  return query
  select w.tenant_id, w.balance, coalesce(sum(l.amount), 0) as ledger_sum
  from public.tenant_wallets w
  left join public.wallet_ledger l on l.tenant_id = w.tenant_id
  group by w.tenant_id, w.balance
  having w.balance <> coalesce(sum(l.amount), 0);
end;
$$;

-- RLS: mesma regra de has_tenant_access, no padrão de
-- 20261015090000_consolidate_tenant_rls.sql (is_super_admin() OR tenant_id =
-- ANY(accessible_tenant_ids()), funções embrulhadas em (select ...)).
alter table public.tenant_wallets enable row level security;
create policy tenant_wallets_select on public.tenant_wallets
  for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = any ((select public.accessible_tenant_ids())::uuid[]));

alter table public.wallet_ledger enable row level security;
create policy wallet_ledger_select on public.wallet_ledger
  for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = any ((select public.accessible_tenant_ids())::uuid[]));

alter table public.tenant_monthly_usage enable row level security;
create policy tenant_monthly_usage_select on public.tenant_monthly_usage
  for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = any ((select public.accessible_tenant_ids())::uuid[]));

-- Nenhuma escrita direta por authenticated: tudo passa pelas RPCs acima ou
-- por service_role.
grant select on public.tenant_wallets to authenticated;
grant all on public.tenant_wallets to service_role;

-- O custo do fornecedor nunca vai para authenticated (grant por coluna, como
-- billing_price_book).
revoke select on public.wallet_ledger from anon, authenticated;
grant select (
  id, tenant_id, entry_type, item, units, free_units, usage_month,
  unit_price, amount, balance_after, reference_type, reference_id,
  idempotency_key, reason, metadata, created_by, created_at
) on public.wallet_ledger to authenticated;
grant all on public.wallet_ledger to service_role;

grant select on public.tenant_monthly_usage to authenticated;
grant all on public.tenant_monthly_usage to service_role;

-- EXECUTE nunca para PUBLIC/anon (padrão F6). wallet_mutation é interno: só
-- service_role (quem chama são as outras RPCs, que herdam o privilégio do
-- owner da function ao chamar outra SECURITY DEFINER).
revoke execute on function public.billing_now() from public, anon;
grant execute on function public.billing_now() to authenticated, service_role;

revoke execute on function public.wallet_mutation(
  uuid, numeric, text, text, integer, integer, date, numeric, numeric,
  text, text, text, text, jsonb, uuid
) from public, anon, authenticated;
grant execute on function public.wallet_mutation(
  uuid, numeric, text, text, integer, integer, date, numeric, numeric,
  text, text, text, text, jsonb, uuid
) to service_role;

revoke execute on function public.wallet_reserve(uuid, text, integer, text, text, text) from public, anon;
grant execute on function public.wallet_reserve(uuid, text, integer, text, text, text) to service_role;

revoke execute on function public.wallet_refund(uuid, text, text, text) from public, anon;
grant execute on function public.wallet_refund(uuid, text, text, text) to service_role;

revoke execute on function public.admin_adjust_wallet(uuid, numeric, text, text) from public, anon;
grant execute on function public.admin_adjust_wallet(uuid, numeric, text, text) to authenticated, service_role;

revoke execute on function public.wallet_summary(uuid) from public, anon;
grant execute on function public.wallet_summary(uuid) to authenticated, service_role;

revoke execute on function public.billing_wallet_integrity() from public, anon, authenticated;
grant execute on function public.billing_wallet_integrity() to service_role;

notify pgrst, 'reload schema';
