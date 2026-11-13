-- Web push: cobrança POR LEAD. Novo item de cobrança `webpush_lead`,
-- R$ 0,01 por inscrição nova de push (linha nova em push_subscriptions com
-- status 'ativa', ou seja, o navegador aceitou), cobrada UMA vez por
-- inscrição, num lote de hora em hora (cron betleads-webpush-lead-billing,
-- 20261222100000_webpush_lead_billing_cron.sql). A inscrição pública
-- (src/lib/webpush/subscriptions.server.ts) não muda: nunca consulta a
-- carteira e nunca é bloqueada pela cobrança.
--
-- Uma casa pode ser cobrada só por lead, só por envio (`webpush`) ou pelos
-- dois: quem decide é o preço por casa em tenant_price_overrides (preço 0 =
-- não cobra; a inscrição ainda é marcada como cobrada, com R$ 0). Casa
-- isenta (plano interno) também fica com R$ 0 via wallet_reserve e também é
-- marcada.
--
-- Nunca retroativo: só entram inscrições com first_seen_at >=
-- '2026-11-07 00:00:00-03' (00:00 de Brasília do dia seguinte à entrega
-- desta função). As inscrições anteriores ficam com lead_billed_at nulo
-- para sempre e nunca são cobradas. Literal fixo (e não now() na hora de
-- aplicar a migration) para que o corte seja o mesmo em todo ambiente e
-- fique legível no código; aparece em 3 lugares que precisam ficar iguais
-- (índice parcial, webpush_lead_billing_tenants, webpush_lead_bill_tenant).
-- Se o deploy atrasar para depois desse dia, trocar o literal nos 3 lugares
-- por uma data >= a do deploy ANTES de aplicar.
--
-- Troca os checks de item de `billing_price_book`/`tenant_price_overrides`
-- (última versão em 20261210100100_webpush_billing_item.sql) para incluir
-- 'webpush_lead' e recria `wallet_reserve`/`wallet_summary` com o corpo
-- idêntico ao de 20261210100100_webpush_billing_item.sql (versões mais
-- recentes), mudando só a lista de itens aceitos.
--
-- ROLLBACK (manual, aditivo):
--   drop function public.webpush_lead_bill_tenant(uuid, integer);
--   drop function public.webpush_lead_billing_tenants(integer);
--   drop index public.push_subscriptions_lead_billing_pending_idx;
--   alter table public.push_subscriptions
--     drop column lead_billing_ledger_id, drop column lead_billed_at;
--   (wallet_reserve/wallet_summary/checks: reaplicar
--   20261210100100_webpush_billing_item.sql, depois de apagar as linhas
--   'webpush_lead' de billing_price_book/tenant_price_overrides.)

set lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Item de cobrança
-- ---------------------------------------------------------------------------
alter table public.billing_price_book
  drop constraint billing_price_book_item_check;
alter table public.billing_price_book
  add constraint billing_price_book_item_check
    check (item in ('sms', 'voice_30s', 'email', 'webpush', 'webpush_lead'));

alter table public.tenant_price_overrides
  drop constraint tenant_price_overrides_item_check;
alter table public.tenant_price_overrides
  add constraint tenant_price_overrides_item_check
    check (item in ('sms', 'voice_30s', 'email', 'webpush', 'webpush_lead'));

-- valid_from no começo do mês (como o 'webpush'): o preço precisa existir
-- antes da primeira inscrição cobrável; quem impede cobrança retroativa é o
-- corte em first_seen_at, não a vigência do preço.
insert into public.billing_price_book (item, valid_from, unit_price, provider_unit_cost, free_monthly_units)
values ('webpush_lead', '2026-11-01', 0.01, 0, 0);

-- Igual a 20261210100100_webpush_billing_item.sql:29, só muda a lista de
-- itens aceitos (linha 64 de lá).
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

  if _item is null or _item not in ('sms', 'voice_30s', 'email', 'webpush', 'webpush_lead') then
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

-- Igual a 20261210100100_webpush_billing_item.sql:143, só acrescenta
-- ('webpush_lead') ao `values` da lista de itens (linha 194 de lá).
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
  from (values ('sms'), ('voice_30s'), ('email'), ('webpush'), ('webpush_lead')) as items(item);

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

-- ---------------------------------------------------------------------------
-- 2. push_subscriptions: marca de cobrança por lead
-- ---------------------------------------------------------------------------
-- lead_billed_at: quando a inscrição entrou num lote cobrado (nulo = ainda
-- não cobrada, ou anterior ao corte e nunca cobrável). Nunca volta a nulo.
-- lead_billing_ledger_id: a reserva (wallet_ledger) do lote que a cobrou;
-- todas as inscrições do mesmo lote apontam para a mesma linha.
alter table public.push_subscriptions
  add column if not exists lead_billed_at timestamptz,
  add column if not exists lead_billing_ledger_id uuid
    references public.wallet_ledger(id) on delete set null;

-- Pendentes de cobrança: o mesmo predicado de webpush_lead_billing_tenants e
-- webpush_lead_bill_tenant (manter o literal do corte igual nos 3).
-- Inscrições anteriores ao corte nunca entram no índice.
create index if not exists push_subscriptions_lead_billing_pending_idx
  on public.push_subscriptions (tenant_id, id)
  where lead_billed_at is null
    and status = 'ativa'
    and first_seen_at >= '2026-11-07 00:00:00-03'::timestamptz;

-- ---------------------------------------------------------------------------
-- 3. Lote de cobrança (chamado pelo hook /api/public/hooks/webpush-lead-billing)
-- ---------------------------------------------------------------------------
-- Casas com inscrições pendentes de cobrança por lead. O hook chama
-- webpush_lead_bill_tenant uma vez por casa (uma transação por casa: a falha
-- de uma não trava as outras).
create or replace function public.webpush_lead_billing_tenants(_limit integer default 500)
returns setof uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden';
  end if;

  return query
    select distinct ps.tenant_id
    from public.push_subscriptions ps
    where ps.lead_billed_at is null
      and ps.status = 'ativa'
      and ps.first_seen_at >= '2026-11-07 00:00:00-03'::timestamptz
    order by ps.tenant_id
    limit least(greatest(coalesce(_limit, 500), 1), 5000);
end;
$$;

-- Cobra, numa transação só, até _limit inscrições pendentes de UMA casa:
-- trava as linhas (for update skip locked: um lote concorrente da mesma casa
-- pega outras linhas, nunca as mesmas), reserva `webpush_lead` x N na
-- carteira e marca as linhas como cobradas. Retorno:
--   {status: 'nada', units: 0}                       nada pendente
--   {status: 'cobrado', units, amount, ledger_id, exempt, idempotent}
--   {status: 'saldo_insuficiente', units}            nada cobrado nem marcado;
--                                                    as linhas ficam pendentes
--                                                    para o próximo lote
-- Qualquer outro erro (ex.: price_not_found) sobe e desfaz tudo.
--
-- Idempotência: a chave é derivada do CONJUNTO exato de inscrições do lote
-- ('webpush_lead:' || md5 dos ids em ordem). Reserva e marcação estão na
-- mesma transação, então uma queda no meio desfaz as duas (a próxima rodada
-- refaz o mesmo lote com a mesma chave e cobra uma vez só); se por algum
-- motivo a reserva desse conjunto já existir (idempotent = true), as linhas
-- são só marcadas, sem cobrar de novo. Uma chave nunca se repete para um
-- conjunto diferente, então nunca pula a cobrança de inscrições novas (a
-- chave de wallet_mutation deduplica para sempre por (tenant, chave)).
create or replace function public.webpush_lead_bill_tenant(_tenant uuid, _limit integer default 1000)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_limit integer;
  v_ids uuid[];
  v_units integer;
  v_batch text;
  v_key text;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden';
  end if;

  if _tenant is null then
    raise exception 'invalid_tenant';
  end if;

  v_limit := least(greatest(coalesce(_limit, 1000), 1), 5000);

  select array_agg(s.id order by s.id) into v_ids
  from (
    select ps.id
    from public.push_subscriptions ps
    where ps.tenant_id = _tenant
      and ps.lead_billed_at is null
      and ps.status = 'ativa'
      and ps.first_seen_at >= '2026-11-07 00:00:00-03'::timestamptz
    order by ps.id
    limit v_limit
    for update skip locked
  ) s;

  v_units := coalesce(cardinality(v_ids), 0);
  if v_units = 0 then
    return jsonb_build_object('ok', true, 'status', 'nada', 'tenant_id', _tenant, 'units', 0);
  end if;

  v_batch := md5(array_to_string(v_ids, ','));
  v_key := 'webpush_lead:' || v_batch;

  begin
    v_result := public.wallet_reserve(
      _tenant, 'webpush_lead', v_units, 'webpush_lead_batch', v_batch, v_key
    );
  exception when others then
    if sqlerrm = 'insufficient_balance' then
      -- O bloco desfez só a reserva; as linhas continuam pendentes (as
      -- travas são liberadas no fim da transação).
      return jsonb_build_object(
        'ok', false, 'status', 'saldo_insuficiente', 'tenant_id', _tenant, 'units', v_units
      );
    end if;
    raise;
  end;

  update public.push_subscriptions
     set lead_billed_at = now(),
         lead_billing_ledger_id = (v_result ->> 'ledger_id')::uuid
   where id = any(v_ids);

  return jsonb_build_object(
    'ok', true,
    'status', 'cobrado',
    'tenant_id', _tenant,
    'units', v_units,
    'amount', abs((v_result ->> 'amount')::numeric),
    'ledger_id', v_result ->> 'ledger_id',
    'exempt', coalesce((v_result ->> 'exempt')::boolean, false),
    'idempotent', coalesce((v_result ->> 'idempotent')::boolean, false)
  );
end;
$$;

revoke execute on function public.webpush_lead_billing_tenants(integer) from public, anon, authenticated;
grant execute on function public.webpush_lead_billing_tenants(integer) to service_role;
revoke execute on function public.webpush_lead_bill_tenant(uuid, integer) from public, anon, authenticated;
grant execute on function public.webpush_lead_bill_tenant(uuid, integer) to service_role;

notify pgrst, 'reload schema';
