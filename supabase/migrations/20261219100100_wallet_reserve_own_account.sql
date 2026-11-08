-- Conta própria de provedor por casa — Fase 2 (Task 2): `wallet_reserve`
-- reconhece conta com dono. Escopo:
-- docs/superpowers/specs/2026-11-07-conta-propria-provedor-design.md
--
-- O QUE ESTA MIGRAÇÃO FAZ
--   * `wallet_reserve` ganha o 7º parâmetro `_provider_account_id uuid
--     default null`. Quando a conta informada tem `owner_tenant_id = _tenant`
--     (conta própria da própria casa, Task 1), a reserva é gratuita para a
--     casa: franquia não é consumida (`free_units := 0`), custo do
--     fornecedor zerado (`provider_unit_cost := 0`), preço unitário zerado
--     (`unit_price := 0`, então `amount := 0` sem depender da isenção/
--     franquia) e o razão guarda `metadata.provider_account_id` +
--     `metadata.own_account = true`. `tenant_monthly_usage.units` ainda soma
--     normalmente (a casa continua enviando essas unidades); `free_units_used`
--     e `billed_amount` não sobem, porque os valores que alimentam esse
--     incremento (`v_free`/`abs(v_amount)`) já são 0 nesse caminho — não há
--     um `if` separado pulando a atualização. O resultado ganha a chave
--     `own_account boolean`. Conta de outra casa (`owner_tenant_id` de outro
--     tenant) ou sem dono (`owner_tenant_id is null`, conta da BetLeads) não
--     é "própria": cobra normal, como hoje.
--   * `expert_wallet_reserve` ganha o mesmo 8º parâmetro e repassa para
--     `wallet_reserve`. Como o preço unitário gravado no razão já é 0 para a
--     conta própria, o cálculo existente do custo do teto
--     (`v_ledger.unit_price * unidades`) já fica 0 nesse caminho — nenhuma
--     mudança extra na checagem do teto foi necessária para o expert não
--     consumir o teto enviando pela conta própria da casa (Review Focus 5).
--   * `drop function` das duas assinaturas antigas (6 e 7 argumentos) antes
--     de recriar: um `create or replace` com um parâmetro a mais criaria uma
--     sobrecarga nova e ambígua, deixando a assinatura antiga intacta (e
--     resolvendo chamadas de 6/7 argumentos para a função errada) em vez de
--     substituí-la. Com o `drop` antes, a única função que sobra tem o novo
--     parâmetro com `default null`, então uma chamada com os argumentos
--     antigos (6 e 7, respectivamente) continua funcionando sem o
--     `provider_account_id` — PL/pgSQL resolve `wallet_reserve(...)` pelo
--     nome no momento da chamada, então qualquer função que já chame
--     `wallet_reserve` (ex. `expert_wallet_reserve`) continua funcionando
--     com a função recriada.
--   * Corpo das duas funções = versão atual (`wallet_reserve` de
--     20261210100100_webpush_billing_item.sql, `expert_wallet_reserve` de
--     20261126100000_expert_campaigns.sql), só com o parâmetro novo e a
--     checagem de dono. `grant`/`revoke execute` refeitos iguais aos atuais,
--     com a assinatura nova.
--
-- COMPATIBILIDADE / ORDEM DE DEPLOY
--   * Aplicar ANTES do app novo. O app atual chama `wallet_reserve` com 6
--     argumentos (sem `_provider_account_id`) — continua funcionando sem
--     reconhecer conta própria (o 7º parâmetro usa o `default null`), porque
--     a função recriada aceita a chamada antiga.
--
-- ROLLBACK
--   drop function public.expert_wallet_reserve(uuid, uuid, text, integer, text, text, text, uuid);
--   drop function public.wallet_reserve(uuid, text, integer, text, text, text, uuid);
--   -- (recriar as duas com o corpo de 20261210100100_webpush_billing_item.sql
--   -- e 20261126100000_expert_campaigns.sql, sem o 7º/8º parâmetro.)

drop function if exists public.wallet_reserve(uuid, text, integer, text, text, text);
drop function if exists public.expert_wallet_reserve(uuid, uuid, text, integer, text, text, text);

create function public.wallet_reserve(
  _tenant uuid,
  _item text,
  _units integer,
  _reference_type text,
  _reference_id text,
  _idempotency_key text,
  _provider_account_id uuid default null
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
  v_own boolean;
  v_metadata jsonb;
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

  -- Conta com dono (Task 1) só é "própria" para quem chamou se o dono é a
  -- MESMA casa; conta sem dono (BetLeads) ou dono de outra casa cobra
  -- normal. v_unit_price/v_provider_cost zerados aqui fazem o custo do
  -- expert (unit_price x unidades gravadas no razão) também sair 0, sem
  -- precisar de nenhuma checagem extra em expert_wallet_reserve.
  v_own := _provider_account_id is not null and exists (
    select 1 from public.provider_accounts a
    where a.id = _provider_account_id and a.owner_tenant_id = _tenant
  );

  select free_units_used into v_free_used
  from public.tenant_monthly_usage
  where tenant_id = _tenant and month = v_month and item = _item;

  v_free_used := coalesce(v_free_used, 0);

  if v_own then
    v_unit_price := 0;
    v_provider_cost := 0;
    v_free := 0;
    v_amount := 0;
    v_metadata := jsonb_build_object(
      'provider_account_id', _provider_account_id,
      'own_account', true
    );
  else
    v_free := least(_units, greatest(v_free_limit - v_free_used, 0));
    v_billable := _units - v_free;

    if v_exempt then
      v_amount := 0;
    else
      v_amount := -(v_billable * v_unit_price);
    end if;

    v_metadata := '{}'::jsonb;
  end if;

  v_result := public.wallet_mutation(
    _tenant, v_amount, 'usage_reservation', _item, _units, v_free, v_month,
    v_unit_price, v_provider_cost, _reference_type, _reference_id, _idempotency_key,
    'Reserva de uso', v_metadata, null
  );

  -- v_free/v_amount já são 0 no caminho de conta própria, então o incremento
  -- abaixo soma `units` normalmente mas não move free_units_used nem
  -- billed_amount (sem precisar de um `if` separado para pular a conta
  -- própria).
  if not (v_result ->> 'idempotent')::boolean then
    insert into public.tenant_monthly_usage (tenant_id, month, item, units, free_units_used, billed_amount)
    values (_tenant, v_month, _item, _units, v_free, abs(v_amount))
    on conflict (tenant_id, month, item) do update
      set units = public.tenant_monthly_usage.units + excluded.units,
          free_units_used = public.tenant_monthly_usage.free_units_used + excluded.free_units_used,
          billed_amount = public.tenant_monthly_usage.billed_amount + excluded.billed_amount;
  end if;

  return v_result || jsonb_build_object('exempt', v_exempt, 'own_account', v_own);
end;
$$;

-- wallet_reserve + teto do expert, atômicos. Mesmo contrato de retorno de
-- wallet_reserve (+ expert_id, expert_cost, expert_month). Erros:
-- 'expert_inactive', 'expert_cap_reached' (e os de wallet_reserve, ex.
-- 'insufficient_balance'). teto 0 bloqueia tudo; teto NULL = sem teto.
-- Ordem de travas: experts -> tenant_wallets -> expert_monthly_usage. O
-- estorno trava tenant_wallets -> expert_usage_entries ->
-- expert_monthly_usage (nunca experts): sem ciclo.
--
-- Repassa _provider_account_id para wallet_reserve (Review Focus 5): como o
-- razão grava unit_price = 0 para conta própria, v_cost abaixo (unit_price x
-- unidades) já sai 0 e o teto do expert não é consumido mandando pela conta
-- própria da casa.
create function public.expert_wallet_reserve(
  _expert uuid,
  _tenant uuid,
  _item text,
  _units integer,
  _reference_type text,
  _reference_id text,
  _idempotency_key text,
  _provider_account_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_ativo boolean;
  v_teto numeric(12,2);
  v_result jsonb;
  v_ledger public.wallet_ledger%rowtype;
  v_cost numeric(14,4);
  v_used numeric(14,4);
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden';
  end if;

  -- Serializa as reservas do mesmo expert (duas reservas no limite nunca
  -- passam juntas).
  select ativo, teto_mensal into v_ativo, v_teto
  from public.experts
  where id = _expert and tenant_id = _tenant
  for update;
  if not found or not coalesce(v_ativo, false) then
    raise exception 'expert_inactive';
  end if;

  if v_teto is not null and v_teto <= 0 then
    raise exception 'expert_cap_reached';
  end if;

  v_result := public.wallet_reserve(
    _tenant, _item, _units, _reference_type, _reference_id, _idempotency_key,
    _provider_account_id
  );
  -- Repetição da mesma reserva: já foi contada (ou é anterior ao teto).
  if coalesce((v_result ->> 'idempotent')::boolean, false) then
    return v_result || jsonb_build_object('expert_id', _expert);
  end if;

  select * into v_ledger
  from public.wallet_ledger
  where id = (v_result ->> 'ledger_id')::uuid;

  -- Preço de venda da casa × unidades reservadas, mesmo dentro da franquia
  -- ou para casa isenta (senão o teto não valeria nessas casas). Para conta
  -- própria, unit_price já está zerado no razão, então v_cost sai 0.
  v_cost := round(coalesce(v_ledger.unit_price, 0) * coalesce(v_ledger.units, _units), 4);

  insert into public.expert_monthly_usage (tenant_id, expert_id, month, amount)
  values (_tenant, _expert, v_ledger.usage_month, 0)
  on conflict (expert_id, month) do nothing;

  select amount into v_used
  from public.expert_monthly_usage
  where expert_id = _expert and month = v_ledger.usage_month
  for update;

  if v_teto is not null and v_used + v_cost > v_teto then
    -- Desfaz também a reserva da carteira (mesma transação).
    raise exception 'expert_cap_reached';
  end if;

  update public.expert_monthly_usage
     set amount = amount + v_cost, updated_at = now()
   where expert_id = _expert and month = v_ledger.usage_month;

  insert into public.expert_usage_entries (
    ledger_id, tenant_id, expert_id, month, item, units, unit_price, amount
  ) values (
    v_ledger.id, _tenant, _expert, v_ledger.usage_month, _item,
    coalesce(v_ledger.units, _units), coalesce(v_ledger.unit_price, 0), v_cost
  );

  return v_result || jsonb_build_object(
    'expert_id', _expert,
    'expert_cost', v_cost,
    'expert_month', v_ledger.usage_month
  );
end;
$$;

revoke execute on function public.wallet_reserve(uuid, text, integer, text, text, text, uuid) from public, anon;
grant execute on function public.wallet_reserve(uuid, text, integer, text, text, text, uuid) to service_role;

revoke execute on function public.expert_wallet_reserve(uuid, uuid, text, integer, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.expert_wallet_reserve(uuid, uuid, text, integer, text, text, text, uuid)
  to service_role;

notify pgrst, 'reload schema';
