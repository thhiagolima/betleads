-- Alerta de saldo por autonomia (P0.5, docs/ESCOPO_AUDITORIA_JORNADAS_CUSTO_RECUPERACAO_2026-10-29.md).
--
-- O alerta de saldo baixo só olha o limite fixo da casa (padrão R$ 200). Uma casa
-- que gasta muito fica sem saldo antes de chegar nele: em 29/10 a betgreen tinha
-- R$ 552 e gastava R$ 1.090 por dia, cerca de 12 h de autonomia, sem alerta.
--
-- * `billing_runway_alert_candidates(_after, _limit, _hours)`: casas com saldo,
--   gasto líquido nas últimas 24 h (reservas menos estornos do `wallet_ledger`)
--   e autonomia (saldo ÷ gasto por hora) abaixo de `_hours`. Mesmos filtros de
--   `billing_low_balance_candidates` (ativa/trial, não demo, não isenta, não
--   bloqueada). Paginada por tenant_id (keyset). Só service_role.
--
-- Só adiciona uma função: o código já publicado não a usa, então pode ser
-- aplicada antes do deploy.

create or replace function public.billing_runway_alert_candidates(
  _after uuid default null,
  _limit integer default 500,
  _hours numeric default 24
)
returns table (
  tenant_id uuid,
  tenant_name text,
  balance numeric,
  spend_24h numeric,
  runway_hours numeric
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  v_now timestamptz := public.billing_now();
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden';
  end if;

  if _limit is null or _limit < 1 or _limit > 1000 then
    raise exception 'invalid_limit';
  end if;

  if _hours is null or _hours <= 0 then
    raise exception 'invalid_hours';
  end if;

  return query
  select w.tenant_id,
         t.nome::text,
         w.balance::numeric,
         s.spend::numeric,
         round((w.balance * 24 / s.spend)::numeric, 1)
  from public.tenant_wallets w
  join public.tenants t on t.id = w.tenant_id
  cross join lateral (
    select coalesce(-sum(l.amount), 0) as spend
    from public.wallet_ledger l
    where l.tenant_id = w.tenant_id
      and l.entry_type in ('usage_reservation', 'usage_refund')
      and l.created_at > v_now - interval '24 hours'
      and l.created_at <= v_now
  ) s
  where w.balance > 0
    and s.spend > 0
    -- saldo ÷ (gasto ÷ 24) < _hours, sem divisão: evita 100 / (100 / 24) = 23,99…
    and w.balance * 24 < _hours * s.spend
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

revoke all on function public.billing_runway_alert_candidates(uuid, integer, numeric)
  from public, anon, authenticated;
grant execute on function public.billing_runway_alert_candidates(uuid, integer, numeric)
  to service_role;
