-- PG3 Task 3: liquidação pelo uso real (voz e e-mail) e colunas de cobrança.
--
-- Voz reserva um teto antes da ligação (ceil((maxSeconds + 10) / 30) blocos)
-- e, quando o resultado chega, liquida pelo uso real. `wallet_settle` é um
-- estorno parcial modelado em `wallet_refund` (20261022100100_billing_wallet.sql):
--   * mesma ordem de lock (garante a carteira, FOR UPDATE nela, só depois lê
--     a reserva e o estorno existente);
--   * nunca reprecifica: devolve a parte proporcional do amount gravado na
--     reserva (casa isenta reservou 0, então devolve 0, mas o consumo conta);
--   * devolve a franquia como `wallet_refund` (free_units na linha de estorno
--     e em tenant_monthly_usage.free_units_used);
--   * desconta tenant_monthly_usage no usage_month da reserva, não no mês
--     corrente;
--   * idempotente pela chave: a mesma chave devolve o resultado gravado; outra
--     chave numa reserva já revertida devolve `already_reversed`.
-- A linha `usage_refund` é gravada mesmo quando nada volta (uso = reserva),
-- com reverses_ledger_id = a reserva: o índice único
-- idx_wallet_ledger_reverses_once garante que a reserva só pode ser liquidada
-- OU estornada, uma única vez (wallet_refund depois de um settle devolve
-- `already_refunded`; wallet_settle depois de um refund devolve
-- `already_reversed`).
--
-- Unidades devolvidas: primeiro as cobradas, depois as da franquia. O uso
-- real consome a franquia antes do saldo (mesma ordem de wallet_reserve), então
-- o que sobra da reserva é a parte cobrada. Valor devolvido =
-- abs(reserva.amount) * cobradas_devolvidas / cobradas_reservadas.
--
-- `wallet_settle_voice` converte duração em blocos de 30 s:
--   * atendida com duração > 0: ceil(duração / 30);
--   * atendida sem duração no callback (null): mantém o teto (decisão 3 do
--     spec; o brief só fala de "answered and duration > 0", e null não é 0);
--   * não atendida, ou atendida com duração 0: charge_unanswered_blocks da
--     linha do billing_price_book vigente no momento da reserva
--     (wallet_ledger.created_at da reserva; created_at é now(), a mesma base
--     de valid_from gravado por admin_set_price).
--
-- `billing_price_book.charge_unanswered_blocks` (default 0: chamada não
-- atendida é grátis por ora) deixa o superadmin mudar a regra sem código.
-- `admin_set_price` ganha o parâmetro (drop + create, grants refeitos). Sem o
-- argumento (null), a nova vigência herda o valor da vigência atual do item,
-- para que editar só o preço nunca zere a regra sem querer.

-- ─── Price book ─────────────────────────────────────────────────────────────

alter table public.billing_price_book
  add column if not exists charge_unanswered_blocks integer not null default 0
    check (charge_unanswered_blocks >= 0);

-- A coluna é configuração comercial, não custo: authenticated pode ler (o
-- grant por coluna de 20261022100000 não inclui colunas novas).
grant select (charge_unanswered_blocks) on public.billing_price_book to authenticated;

drop function if exists public.admin_set_price(text, numeric, numeric, integer);

create or replace function public.admin_set_price(
  _item text,
  _unit_price numeric,
  _provider_unit_cost numeric default null,
  _free_monthly_units integer default 0,
  _charge_unanswered_blocks integer default null
)
returns public.billing_price_book
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row public.billing_price_book;
  v_charge_unanswered integer;
begin
  if not public.is_super_admin() then
    raise exception 'forbidden';
  end if;

  v_charge_unanswered := _charge_unanswered_blocks;
  if v_charge_unanswered is null then
    select bp.charge_unanswered_blocks into v_charge_unanswered
    from public.billing_price_book bp
    where bp.item = _item and bp.valid_from <= now()
    order by bp.valid_from desc
    limit 1;
  end if;

  insert into public.billing_price_book (
    item, valid_from, unit_price, provider_unit_cost, free_monthly_units,
    charge_unanswered_blocks, created_by
  )
  values (
    _item, now(), _unit_price, _provider_unit_cost, _free_monthly_units,
    coalesce(v_charge_unanswered, 0), auth.uid()
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- ─── Colunas de cobrança ────────────────────────────────────────────────────

alter table public.call_history
  add column if not exists billing_reference_id text,
  add column if not exists billed_blocks integer,
  add column if not exists billed_amount numeric(14,4),
  add column if not exists billing_settled_at timestamptz;

alter table public.email_send_logs
  add column if not exists billing_reference_id text,
  add column if not exists billed_amount numeric(14,4);

-- ─── wallet_settle ──────────────────────────────────────────────────────────

create or replace function public.wallet_settle(
  _tenant uuid,
  _reference_id text,
  _actual_units integer,
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
  v_existing public.wallet_ledger%rowtype;
  v_refund public.wallet_ledger%rowtype;
  v_reserved integer;
  v_reserved_free integer;
  v_reserved_billable integer;
  v_actual integer;
  v_over_cap boolean;
  v_returned integer;
  v_returned_billable integer;
  v_returned_free integer;
  v_amount numeric(14,4);
  v_metadata jsonb;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' and not public.is_super_admin() then
    raise exception 'forbidden';
  end if;

  if _tenant is null then
    raise exception 'invalid_wallet_settle';
  end if;

  if _idempotency_key is null or btrim(_idempotency_key) = '' then
    raise exception 'invalid_idempotency_key';
  end if;

  if _actual_units is null then
    raise exception 'invalid_units';
  end if;

  insert into public.tenant_wallets (tenant_id)
  values (_tenant)
  on conflict (tenant_id) do nothing;

  perform 1 from public.tenant_wallets where tenant_id = _tenant for update;

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

  v_reserved := coalesce(v_reservation.units, 0);
  v_reserved_free := least(coalesce(v_reservation.free_units, 0), v_reserved);
  v_reserved_billable := v_reserved - v_reserved_free;

  select * into v_existing
  from public.wallet_ledger
  where reverses_ledger_id = v_reservation.id
    and entry_type = 'usage_refund';

  if found then
    if v_existing.idempotency_key is distinct from _idempotency_key then
      return jsonb_build_object('ok', false, 'reason', 'already_reversed');
    end if;
    v_refund := v_existing;
    v_result := jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'ledger_id', v_existing.id,
      'amount', v_existing.amount,
      'balance', v_existing.balance_after
    );
  else
    -- A chave já usada por outra linha do razão (ex.: a chave da própria
    -- reserva) faria wallet_mutation devolver aquela linha como "idempotente"
    -- sem liquidar nada. Recusa em vez de responder com dados de outra linha.
    if exists (
      select 1 from public.wallet_ledger
      where tenant_id = _tenant and idempotency_key = _idempotency_key
    ) then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;

    v_actual := greatest(least(_actual_units, v_reserved), 0);
    v_over_cap := _actual_units > v_reserved;
    v_returned := v_reserved - v_actual;
    v_returned_billable := least(v_returned, v_reserved_billable);
    v_returned_free := v_returned - v_returned_billable;

    if v_reserved_billable > 0 then
      v_amount := round(abs(v_reservation.amount) * v_returned_billable / v_reserved_billable, 4);
    else
      v_amount := 0;
    end if;

    v_metadata := jsonb_build_object('settlement', true, 'actual_units', v_actual);
    if v_over_cap then
      v_metadata := v_metadata || jsonb_build_object('over_cap', true, 'requested_units', _actual_units);
    end if;

    v_result := public.wallet_mutation(
      _tenant, v_amount, 'usage_refund', v_reservation.item,
      v_returned, v_returned_free, v_reservation.usage_month,
      v_reservation.unit_price, v_reservation.provider_unit_cost,
      v_reservation.reference_type, _reference_id, _idempotency_key,
      coalesce(_reason, 'Liquidação de uso'), v_metadata, null, v_reservation.id
    );

    select * into v_refund
    from public.wallet_ledger
    where id = (v_result ->> 'ledger_id')::uuid;

    if not (v_result ->> 'idempotent')::boolean then
      update public.tenant_monthly_usage
         set units = greatest(units - v_returned, 0),
             free_units_used = greatest(free_units_used - v_returned_free, 0),
             billed_amount = greatest(billed_amount - v_amount, 0)
       where tenant_id = _tenant and month = v_reservation.usage_month and item = v_reservation.item;
    end if;
  end if;

  -- Resposta derivada da linha gravada, igual na primeira chamada e na
  -- repetição (a repetição nunca recalcula com a entrada nova).
  return v_result || jsonb_build_object(
    'item', v_reservation.item,
    'reserved_units', v_reserved,
    'actual_units', coalesce((v_refund.metadata ->> 'actual_units')::integer, v_reserved - coalesce(v_refund.units, 0)),
    'billed_units', v_reserved - coalesce(v_refund.units, 0),
    'units_returned', coalesce(v_refund.units, 0),
    'free_units_returned', coalesce(v_refund.free_units, 0),
    'billed_amount', abs(v_reservation.amount) - coalesce(v_refund.amount, 0),
    'over_cap', coalesce((v_refund.metadata ->> 'over_cap')::boolean, false)
  );
end;
$$;

-- ─── wallet_settle_voice ────────────────────────────────────────────────────

create or replace function public.wallet_settle_voice(
  _tenant uuid,
  _reference_id text,
  _duration_seconds integer,
  _answered boolean,
  _idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reservation public.wallet_ledger%rowtype;
  v_blocks integer;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' and not public.is_super_admin() then
    raise exception 'forbidden';
  end if;

  if _tenant is null then
    raise exception 'invalid_wallet_settle';
  end if;

  if _duration_seconds is not null and _duration_seconds < 0 then
    raise exception 'invalid_duration';
  end if;

  -- Mesma ordem de lock de wallet_settle (que trava de novo a mesma linha,
  -- sem autodeadlock).
  insert into public.tenant_wallets (tenant_id)
  values (_tenant)
  on conflict (tenant_id) do nothing;

  perform 1 from public.tenant_wallets where tenant_id = _tenant for update;

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

  if v_reservation.item is distinct from 'voice_30s' then
    raise exception 'invalid_item';
  end if;

  if coalesce(_answered, false) and _duration_seconds is null then
    v_blocks := v_reservation.units;
  elsif coalesce(_answered, false) and _duration_seconds > 0 then
    v_blocks := ceil(_duration_seconds / 30.0)::integer;
  else
    select coalesce(bp.charge_unanswered_blocks, 0) into v_blocks
    from public.billing_price_book bp
    where bp.item = 'voice_30s' and bp.valid_from <= v_reservation.created_at
    order by bp.valid_from desc
    limit 1;
    v_blocks := coalesce(v_blocks, 0);
  end if;

  v_result := public.wallet_settle(
    _tenant, _reference_id, v_blocks, _idempotency_key, 'Liquidação de chamada'
  );

  if not coalesce((v_result ->> 'ok')::boolean, false) then
    return v_result;
  end if;

  return v_result || jsonb_build_object('blocks', (v_result ->> 'billed_units')::integer);
end;
$$;

-- ─── Grants ─────────────────────────────────────────────────────────────────
-- EXECUTE nunca para PUBLIC/anon (padrão F6). wallet_settle* só service_role.

revoke execute on function public.admin_set_price(text, numeric, numeric, integer, integer) from public, anon;
grant execute on function public.admin_set_price(text, numeric, numeric, integer, integer) to authenticated, service_role;

revoke execute on function public.wallet_settle(uuid, text, integer, text, text) from public, anon, authenticated;
grant execute on function public.wallet_settle(uuid, text, integer, text, text) to service_role;

revoke execute on function public.wallet_settle_voice(uuid, text, integer, boolean, text) from public, anon, authenticated;
grant execute on function public.wallet_settle_voice(uuid, text, integer, boolean, text) to service_role;

notify pgrst, 'reload schema';
