-- PG3 Task 8 (PG3-06): limite de saldo baixo por casa e alertas por e-mail.
--
-- * `tenant_wallets.low_balance_threshold`: abaixo dele a casa vê o aviso de
--   saldo baixo e os pagadores (admin/owner/gestor) recebem e-mail. Padrão
--   R$ 200 (decisão 10 do design). 0 desliga o alerta (saldo nunca < 0).
-- * `wallet_alerts`: último envio de cada alerta por (casa, tipo). RLS ligado
--   e nenhuma policy para authenticated: só service_role lê/grava.
-- * `billing_claim_wallet_alert(_tenant, _kind, _interval)`: reserva o direito
--   de enviar o alerta `_kind` da casa. Um único INSERT ... ON CONFLICT DO
--   UPDATE ... WHERE: a linha em conflito é travada e o WHERE é reavaliado
--   sobre a versão mais recente, então de duas chamadas concorrentes só uma
--   move `last_sent_at` (e só ela recebe true). Usado pelo alerta de saldo
--   baixo (24 h, varredura horária) e pelo de saldo zerado (1 h, Task 7).
--   Usa billing_now() para os testes poderem fixar o relógio.
-- * `billing_set_low_balance_threshold(_tenant, _value)`: pagador da casa
--   (admin/owner/gestor com has_tenant_access) ou superadmin; 0 a 100000;
--   grava tenant_audit_logs.
-- * `billing_low_balance_candidates(_after, _limit)`: casas ativas/trial,
--   não demo, não isentas, com carteira e 0 < saldo < limite (saldo zero é
--   do alerta 'no_balance' da Task 7). Paginada por tenant_id (keyset), para
--   nunca ser cortada em silêncio pelo teto de 1000 linhas do PostgREST.
--   Só service_role.
-- * `wallet_summary` passa a devolver `low_balance_threshold`.

alter table public.tenant_wallets
  add column low_balance_threshold numeric(14,2) not null default 200
    constraint tenant_wallets_low_balance_threshold_check check (low_balance_threshold >= 0);

create table public.wallet_alerts (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null check (char_length(btrim(kind)) between 1 and 60),
  last_sent_at timestamptz not null,
  primary key (tenant_id, kind)
);

alter table public.wallet_alerts enable row level security;
revoke all on public.wallet_alerts from anon, authenticated;
grant all on public.wallet_alerts to service_role;

-- Devolve true só para a chamada que moveu last_sent_at: na primeira vez (a
-- linha não existe) ou quando o último envio tem pelo menos `_interval`.
create or replace function public.billing_claim_wallet_alert(
  _tenant uuid,
  _kind text,
  _interval interval
)
returns boolean
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare
  v_now timestamptz := public.billing_now();
  v_claimed boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden';
  end if;

  if _tenant is null
     or _kind is null
     or btrim(_kind) = ''
     or _interval is null
     or _interval <= interval '0' then
    raise exception 'invalid_wallet_alert';
  end if;

  insert into public.wallet_alerts as a (tenant_id, kind, last_sent_at)
  values (_tenant, _kind, v_now)
  on conflict (tenant_id, kind) do update
    set last_sent_at = excluded.last_sent_at
    where a.last_sent_at <= excluded.last_sent_at - _interval
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

create or replace function public.billing_set_low_balance_threshold(
  _tenant uuid,
  _value numeric
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare
  v_before numeric(14,2);
  v_after numeric(14,2);
begin
  if _tenant is null then
    raise exception 'forbidden';
  end if;

  if not public.is_super_admin()
     and not (
       public.has_tenant_access(_tenant)
       and exists (
         select 1
         from public.user_roles ur
         where ur.user_id = auth.uid()
           and ur.tenant_id = _tenant
           and ur.role::text in ('admin', 'owner', 'gestor')
       )
     ) then
    raise exception 'forbidden';
  end if;

  -- NaN ordena acima de qualquer número no Postgres, então cai em > 100000.
  if _value is null or _value < 0 or _value > 100000 then
    raise exception 'invalid_threshold';
  end if;

  select w.low_balance_threshold into v_before
  from public.tenant_wallets w
  where w.tenant_id = _tenant;

  insert into public.tenant_wallets as w (tenant_id, low_balance_threshold)
  values (_tenant, round(_value, 2))
  on conflict (tenant_id) do update
    set low_balance_threshold = excluded.low_balance_threshold,
        updated_at = now()
  returning w.low_balance_threshold into v_after;

  insert into public.tenant_audit_logs (
    tenant_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, metadata
  ) values (
    _tenant,
    auth.uid(),
    'billing.low_balance_threshold.update',
    'tenant_wallet',
    _tenant::text,
    jsonb_build_object('low_balance_threshold', coalesce(v_before, 200)),
    jsonb_build_object('low_balance_threshold', v_after),
    jsonb_build_object('source', 'billing_set_low_balance_threshold')
  );

  return jsonb_build_object('tenant_id', _tenant, 'low_balance_threshold', v_after);
end;
$$;

-- Casas que devem receber o alerta de saldo baixo agora (o throttle de 24 h
-- fica em billing_claim_wallet_alert). Só casas com carteira: uma casa que
-- nunca teve carteira nunca usou canal pago e não recebe alerta. Saldo zero
-- fica de fora: é o alerta 'no_balance' (Task 7). Casa bloqueada pela
-- cobrança (tenant_billing.access_state locked_unpaid, locked_manual ou
-- frozen) também fica de fora: não envia nada de qualquer jeito, e o alerta
-- só faria ruído ao lado dos e-mails da fatura. Paginação por keyset: a
-- próxima página passa como `_after` o último tenant_id recebido; `_limit`
-- vai de 1 a 1000 (o teto do PostgREST).
create or replace function public.billing_low_balance_candidates(
  _after uuid default null,
  _limit integer default 500
)
returns table (
  tenant_id uuid,
  tenant_name text,
  balance numeric,
  low_balance_threshold numeric
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden';
  end if;

  if _limit is null or _limit < 1 or _limit > 1000 then
    raise exception 'invalid_limit';
  end if;

  return query
  select w.tenant_id, t.nome::text, w.balance::numeric, w.low_balance_threshold::numeric
  from public.tenant_wallets w
  join public.tenants t on t.id = w.tenant_id
  where w.balance > 0
    and w.balance < w.low_balance_threshold
    and (_after is null or w.tenant_id > _after)
    and coalesce(t.is_demo, false) = false
    and t.status in ('active', 'trial')
    and not public.billing_tenant_exempt(w.tenant_id)
    and not exists (
      select 1 from public.tenant_billing tb
      where tb.tenant_id = w.tenant_id
        and tb.access_state in ('locked_unpaid', 'locked_manual', 'frozen')
    )
  order by w.tenant_id
  limit _limit;
end;
$$;

-- Igual à versão de 20261022100100_billing_wallet.sql, mais
-- `low_balance_threshold` (200 quando a casa ainda não tem carteira).
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
    'low_balance_threshold', coalesce(v_wallet.low_balance_threshold, 200),
    'exempt', v_exempt,
    'month_usage', v_usage,
    'prices', v_prices
  );
end;
$$;

revoke execute on function public.billing_claim_wallet_alert(uuid, text, interval) from public, anon, authenticated;
grant execute on function public.billing_claim_wallet_alert(uuid, text, interval) to service_role;

revoke execute on function public.billing_set_low_balance_threshold(uuid, numeric) from public, anon;
grant execute on function public.billing_set_low_balance_threshold(uuid, numeric) to authenticated;

revoke execute on function public.billing_low_balance_candidates(uuid, integer) from public, anon, authenticated;
grant execute on function public.billing_low_balance_candidates(uuid, integer) to service_role;

revoke execute on function public.wallet_summary(uuid) from public, anon;
grant execute on function public.wallet_summary(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
