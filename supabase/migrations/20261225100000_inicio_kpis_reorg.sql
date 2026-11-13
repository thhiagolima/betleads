-- Início (casa e expert): os números da reorganização dos KPIs.
--
-- Novos campos (todos os antigos seguem iguais):
-- * ftdAmount / previousFtdAmount: soma do PRIMEIRO depósito aprovado de cada
--   jogador com players.ftd_em no período (dias inteiros de Brasília, como o
--   `ftd` de tenant_daily_metrics). Primeiro = o mais antigo por
--   (created_at, id), só se não for mais de 10 min depois do ftd_em (mesma
--   tolerância de 20261019100000_aquisicao_ltv_al1.sql); sem depósito que
--   case, o jogador entra com 0.
-- * ftdCohort / ftdCohortRedeposited (+ previous*): quantos jogadores fizeram
--   FTD no período e quantos deles também redepositaram (aprovado depois de
--   ftd_em + 1 min, a regra do redepósito) dentro do mesmo período.
-- * withdrawalCount, previousWithdrawalAmount: mesma fonte do withdrawalAmount.
-- * pixUnpaidAmount: R$ dos PIX gerados no período que não foram pagos (as
--   linhas de deposits fora de 'aprovado'), coerente com pixGenerated -
--   depositCount (generated_pix_count conta toda linha de deposits do dia).
-- * smsClicks (só casa): cliques humanos de crm_results_daily.
-- * cashflowChart: quando o período é um único dia de Brasília, 24 barras por
--   hora (key '00'..'23', label '14h'; hoje só até a hora atual), a partir de
--   deposits/withdrawals aprovados por created_at (como o dia em
--   tenant_daily_metrics). Mais de um dia segue igual (por dia).
--
-- Copiadas inteiras de 20261223100000_ao_vivo_hora_do_pagamento.sql; só
-- acrescentam CTEs e campos. Assinaturas, security definer e grants iguais.

create or replace function public.dashboard_summary_v2(
  _tenant uuid,
  _from timestamptz,
  _to timestamptz,
  _prev_from timestamptz,
  _prev_to timestamptz,
  _reset_at timestamptz default '1970-01-01T00:00:00Z'
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with
guard as (
  select (public.has_tenant_access(_tenant) or auth.role() = 'service_role') ok
),
bounds as (
  select greatest(_from, _reset_at) cur_from, _to cur_to,
         greatest(_prev_from, _reset_at) prev_from, _prev_to prev_to
),
-- [*_day_lo, *_day_hi): os dias inteiros de Brasília que tenant_daily_metrics
-- soma (metric_date between data(from) and data(to)); single_day = o período
-- é um dia só (o gráfico vira por hora).
day_bounds as (
  select
    ((cur_from at time zone 'America/Sao_Paulo')::date::timestamp
      at time zone 'America/Sao_Paulo') cur_day_lo,
    (((cur_to at time zone 'America/Sao_Paulo')::date + 1)::timestamp
      at time zone 'America/Sao_Paulo') cur_day_hi,
    ((prev_from at time zone 'America/Sao_Paulo')::date::timestamp
      at time zone 'America/Sao_Paulo') prev_day_lo,
    (((prev_to at time zone 'America/Sao_Paulo')::date + 1)::timestamp
      at time zone 'America/Sao_Paulo') prev_day_hi,
    (cur_from at time zone 'America/Sao_Paulo')::date cur_day,
    (cur_from at time zone 'America/Sao_Paulo')::date
      = (cur_to at time zone 'America/Sao_Paulo')::date single_day
  from bounds
),
cur_daily as (
  select coalesce(sum(registrations),0)::int registrations,
         coalesce(sum(ftds),0)::int ftds,
         coalesce(sum(approved_deposit_count),0)::int deposit_count,
         coalesce(sum(approved_deposit_amount),0)::numeric deposit_amount,
         coalesce(sum(approved_withdrawal_amount),0)::numeric withdrawal_amount,
         coalesce(sum(approved_withdrawal_count),0)::int withdrawal_count,
         coalesce(sum(generated_pix_count),0)::int pix_generated
  from public.tenant_daily_metrics, bounds
  where tenant_id = _tenant
    and metric_date between (cur_from at time zone 'America/Sao_Paulo')::date
                        and (cur_to at time zone 'America/Sao_Paulo')::date
),
prev_daily as (
  select coalesce(sum(registrations),0)::int registrations,
         coalesce(sum(ftds),0)::int ftds,
         coalesce(sum(approved_deposit_count),0)::int deposit_count,
         coalesce(sum(approved_deposit_amount),0)::numeric deposit_amount,
         coalesce(sum(approved_withdrawal_amount),0)::numeric withdrawal_amount,
         coalesce(sum(generated_pix_count),0)::int pix_generated
  from public.tenant_daily_metrics, bounds
  where tenant_id = _tenant
    and metric_date between (prev_from at time zone 'America/Sao_Paulo')::date
                        and (prev_to at time zone 'America/Sao_Paulo')::date
),
cur_depositors as (
  select count(distinct d.player_id)::int value
  from public.deposits d, bounds
  where d.tenant_id = _tenant and d.status = 'aprovado' and d.player_id is not null
    and d.created_at between cur_from and cur_to
),
prev_depositors as (
  select count(distinct d.player_id)::int value
  from public.deposits d, bounds
  where d.tenant_id = _tenant and d.status = 'aprovado' and d.player_id is not null
    and d.created_at between prev_from and prev_to
),
cur_redeposits as (
  select coalesce(sum(d.valor),0)::numeric amount, count(*)::int count,
         count(distinct d.player_id)::int players
  from public.deposits d
  join public.players p on p.id = d.player_id and p.tenant_id = d.tenant_id
  cross join bounds
  where d.tenant_id = _tenant and d.status = 'aprovado'
    and d.created_at between cur_from and cur_to
    and p.ftd_em is not null and d.created_at > p.ftd_em + interval '1 minute'
),
prev_redeposits as (
  select coalesce(sum(d.valor),0)::numeric amount
  from public.deposits d
  join public.players p on p.id = d.player_id and p.tenant_id = d.tenant_id
  cross join bounds
  where d.tenant_id = _tenant and d.status = 'aprovado'
    and d.created_at between prev_from and prev_to
    and p.ftd_em is not null and d.created_at > p.ftd_em + interval '1 minute'
),
-- Quem fez FTD (players.ftd_em) nos dias do período atual ou do anterior
-- (índice players_tenant_ftd_idx). Para cada um, o primeiro depósito
-- aprovado (mais antigo por created_at, id; índice por jogador) vale como
-- FTD só se não for mais de 10 min depois do ftd_em; e se redepositou
-- (aprovado depois de ftd_em + 1 min) dentro do mesmo período.
ftd_cohort as (
  select p.ftd_em >= db.cur_day_lo and p.ftd_em < db.cur_day_hi is_cur,
         p.ftd_em >= db.prev_day_lo and p.ftd_em < db.prev_day_hi is_prev,
         coalesce(f.valor, 0) ftd_amount,
         exists (
           select 1 from public.deposits r
           where r.tenant_id = _tenant and r.player_id = p.id and r.status = 'aprovado'
             and r.created_at > p.ftd_em + interval '1 minute'
             and r.created_at < case when p.ftd_em >= db.cur_day_lo
                                     then db.cur_day_hi else db.prev_day_hi end
         ) redeposited
  from public.players p
  cross join day_bounds db
  left join lateral (
    select d.valor, d.created_at from public.deposits d
    where d.tenant_id = _tenant and d.player_id = p.id and d.status = 'aprovado'
    order by d.created_at, d.id
    limit 1
  ) f on f.created_at <= p.ftd_em + interval '10 minutes'
  where p.tenant_id = _tenant
    and ((p.ftd_em >= db.cur_day_lo and p.ftd_em < db.cur_day_hi)
      or (p.ftd_em >= db.prev_day_lo and p.ftd_em < db.prev_day_hi))
),
ftd_totals as (
  select
    coalesce(sum(c.ftd_amount) filter (where c.is_cur),0)::numeric cur_amount,
    count(*) filter (where c.is_cur)::int cur_cohort,
    count(*) filter (where c.is_cur and c.redeposited)::int cur_redeposited,
    coalesce(sum(c.ftd_amount) filter (where c.is_prev),0)::numeric prev_amount,
    count(*) filter (where c.is_prev)::int prev_cohort,
    count(*) filter (where c.is_prev and c.redeposited)::int prev_redeposited
  from ftd_cohort c
),
-- Valor dos PIX gerados e não pagos: só as linhas 'pendente' do período.
-- 'falhou' fica de fora porque carrega valores lixo antigos (R$ 1-5 mi) que
-- inflariam o total; a contagem (pixGenerated - depositCount) segue como era.
pix_unpaid as (
  select coalesce(sum(d.valor),0)::numeric amount
  from public.deposits d, day_bounds db
  where d.tenant_id = _tenant and d.status = 'pendente'
    and d.created_at >= db.cur_day_lo and d.created_at < db.cur_day_hi
),
-- D-01: deposits attributed to a campaign or journey by a human click (7-day
-- direct window, conversion_attributions). Manual follow-ups no longer count.
-- Players already active at the click are not a recovery (rule_version 3).
recovered as (
  select
    coalesce(sum(a.monetary_value),0)::numeric amount,
    count(distinct a.player_id)::int players,
    coalesce(sum(a.monetary_value) filter (where p.created_at >= b.cur_from),0)::numeric new_amount,
    coalesce(sum(a.monetary_value) filter (where a.source_type = 'journey'),0)::numeric reactivated_amount
  from public.conversion_attributions a
  left join public.players p on p.id = a.player_id
  cross join bounds b
  where a.tenant_id = _tenant and a.event_type = 'deposit_approved'
    and a.classification = 'direct'
    and a.occurred_at between b.cur_from and b.cur_to
    and not public.crm_dispatch_was_active(a.tenant_id, a.link_dispatch_id)
),
-- D-04: what the tenant was charged for SMS in the period, from the Central
-- de Resultados' own daily rollup (already on the price book and
-- billed_units -- segments, not sends -- since Task 6). Replaces the legacy
-- credit-ledger-or-flat-price computation.
sms_results as (
  select coalesce(sum(d.sent),0)::int sent,
         coalesce(sum(d.cost),0)::numeric cost,
         coalesce(sum(d.human_clicks),0)::int clicks
  from public.crm_results_daily d, bounds
  where d.tenant_id = _tenant
    and d.metric_date between (cur_from at time zone 'America/Sao_Paulo')::date
                          and (cur_to at time zone 'America/Sao_Paulo')::date
),
-- Wallet balance (0 when the house has no row yet) and the `interno`
-- exemption flag, replacing the legacy tenant_sms_credit_balances field.
wallet as (
  select coalesce((select w.balance from public.tenant_wallets w where w.tenant_id = _tenant), 0)::numeric balance,
         public.billing_tenant_exempt(_tenant) exempt
),
-- D-05: the journeys engine, not the legacy sms_flows table.
flow_counts as (
  select count(*) filter (where status <> 'archived')::int total,
         count(*) filter (where status = 'active')::int active,
         count(*) filter (where status = 'paused')::int paused
  from public.journeys where tenant_id = _tenant
),
series as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', to_char(day, 'YYYY-MM-DD'),
    'label', to_char(day, 'DD/MM'),
    'deposits', coalesce(m.approved_deposit_amount,0),
    'withdrawals', coalesce(m.approved_withdrawal_amount,0)
  ) order by day), '[]'::jsonb) value
  from bounds b
  cross join lateral generate_series(
    (b.cur_from at time zone 'America/Sao_Paulo')::date,
    (b.cur_to at time zone 'America/Sao_Paulo')::date,
    interval '1 day'
  ) day
  left join public.tenant_daily_metrics m
    on m.tenant_id = _tenant and m.metric_date = day::date
),
-- Período de um dia só: 24 barras por hora de Brasília (hoje, até a hora
-- atual), dos aprovados por created_at (como o dia de tenant_daily_metrics).
-- Fora disso não lê nada (single_day falso corta antes dos índices).
hourly_series as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', lpad(h::text, 2, '0'),
    'label', lpad(h::text, 2, '0') || 'h',
    'deposits', coalesce(dd.amount,0),
    'withdrawals', coalesce(ww.amount,0)
  ) order by h), '[]'::jsonb) value
  from day_bounds db
  cross join lateral generate_series(0,
    case when db.cur_day = (now() at time zone 'America/Sao_Paulo')::date
         then extract(hour from now() at time zone 'America/Sao_Paulo')::int
         else 23 end) h
  left join (
    select extract(hour from d.created_at at time zone 'America/Sao_Paulo')::int hr,
           sum(d.valor) amount
    from day_bounds db2
    join public.deposits d
      on d.tenant_id = _tenant and d.status = 'aprovado'
     and d.created_at >= db2.cur_day_lo and d.created_at < db2.cur_day_hi
    where db2.single_day
    group by 1
  ) dd on dd.hr = h
  left join (
    select extract(hour from w.created_at at time zone 'America/Sao_Paulo')::int hr,
           sum(w.valor) amount
    from day_bounds db2
    join public.withdrawals w
      on w.tenant_id = _tenant and w.status = 'aprovado'
     and w.created_at >= db2.cur_day_lo and w.created_at < db2.cur_day_hi
    where db2.single_day
    group by 1
  ) ww on ww.hr = h
  where db.single_day
),
live as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', x.kind || '-' || x.id::text,
    'tone', x.tone,
    'player', coalesce(x.player_name, 'jogador'),
    'action', x.action,
    'amount', x.amount,
    'at', x.created_at,
    'playerId', x.player_id
  ) order by x.created_at desc), '[]'::jsonb) value
  from (
    (select 'player' kind, p.id, 'blue' tone, p.nome player_name,
            'criou conta' action, null::numeric amount, p.created_at, p.id player_id
     from public.players p where p.tenant_id = _tenant order by p.created_at desc limit 12)
    union all
    (select 'deposit', d.id, 'green', p.nome, 'depositou', d.valor, coalesce(d.completed_at, d.created_at), d.player_id
     from public.deposits d left join public.players p on p.id = d.player_id
     where d.tenant_id = _tenant and d.status = 'aprovado' order by d.created_at desc limit 12)
    union all
    (select 'withdrawal', w.id, 'purple', p.nome, 'sacou', w.valor, coalesce(w.completed_at, w.created_at), w.player_id
     from public.withdrawals w left join public.players p on p.id = w.player_id
     where w.tenant_id = _tenant and w.status = 'aprovado' order by w.created_at desc limit 12)
    union all
    (select 'event', e.id, 'orange', p.nome, 'gerou um PIX', e.valor, e.created_at, e.player_id
     from public.events e left join public.players p on p.id = e.player_id
     where e.tenant_id = _tenant
       and e.tipo = 'deposito-pendente'
     order by e.created_at desc limit 8)
  ) x
  limit 8
),
-- D-06: distinct players inside a journey now (not "no login for 7 days").
other as (
  select
    (select count(distinct e.player_id)::int from public.journey_enrollments e
      where e.tenant_id = _tenant
        and e.status in ('active','waiting','paused_by_priority')) reactivation_queue
)
select jsonb_build_object(
  'depositAmount', c.deposit_amount,
  'previousDepositAmount', p.deposit_amount,
  'depositCount', c.deposit_count,
  'previousDepositCount', p.deposit_count,
  'depositors', cd.value,
  'previousDepositors', pd.value,
  'newPlayers', c.registrations,
  'previousNewPlayers', p.registrations,
  'ftd', c.ftds,
  'previousFtd', p.ftds,
  'withdrawalAmount', c.withdrawal_amount,
  'redepositAmount', cr.amount,
  'previousRedepositAmount', pr.amount,
  'redepositCount', cr.count,
  'redepositPlayers', cr.players,
  'recoveredAmount', r.amount,
  'recoveredPlayers', r.players,
  'recoveredNew', r.new_amount,
  'recoveredReactivated', r.reactivated_amount,
  'smsSent', sr.sent,
  'messageCost', sr.cost,
  'pausedFlows', f.paused,
  'walletBalance', w.balance,
  'exempt', w.exempt,
  'pixGenerated', c.pix_generated,
  'previousPixGenerated', p.pix_generated,
  'reactivationQueue', o.reactivation_queue,
  'activeFlows', f.active,
  'totalFlows', f.total,
  'cashflowChart', case when db.single_day then hs.value else se.value end,
  'liveEvents', l.value,
  'ftdAmount', ft.cur_amount,
  'previousFtdAmount', ft.prev_amount,
  'ftdCohort', ft.cur_cohort,
  'ftdCohortRedeposited', ft.cur_redeposited,
  'previousFtdCohort', ft.prev_cohort,
  'previousFtdCohortRedeposited', ft.prev_redeposited,
  'withdrawalCount', c.withdrawal_count,
  'previousWithdrawalAmount', p.withdrawal_amount,
  'pixUnpaidAmount', pu.amount,
  'smsClicks', sr.clicks
)
from guard, cur_daily c, prev_daily p, cur_depositors cd, prev_depositors pd,
     cur_redeposits cr, prev_redeposits pr, recovered r, sms_results sr, wallet w,
     flow_counts f, series se, live l, other o,
     day_bounds db, ftd_totals ft, pix_unpaid pu, hourly_series hs
where guard.ok;
$$;

revoke all on function public.dashboard_summary_v2(uuid,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz) from public, anon;
grant execute on function public.dashboard_summary_v2(uuid,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz) to authenticated, service_role;

create or replace function public.expert_home_summary(
  _tenant uuid,
  _affiliate_ids text[],
  _from timestamptz,
  _to timestamptz,
  _prev_from timestamptz,
  _prev_to timestamptz,
  _reset_at timestamptz default '1970-01-01T00:00:00Z'
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with
raw_bounds as (
  select greatest(_from, _reset_at) cur_from, _to cur_to,
         greatest(_prev_from, _reset_at) prev_from, _prev_to prev_to
),
-- [*_day_lo, *_day_hi): os dias inteiros de Brasília que a casa soma em
-- tenant_daily_metrics (metric_date between data(from) and data(to)).
bounds as (
  select r.*,
         ((r.cur_from at time zone 'America/Sao_Paulo')::date::timestamp
           at time zone 'America/Sao_Paulo') cur_day_lo,
         (((r.cur_to at time zone 'America/Sao_Paulo')::date + 1)::timestamp
           at time zone 'America/Sao_Paulo') cur_day_hi,
         ((r.prev_from at time zone 'America/Sao_Paulo')::date::timestamp
           at time zone 'America/Sao_Paulo') prev_day_lo,
         (((r.prev_to at time zone 'America/Sao_Paulo')::date + 1)::timestamp
           at time zone 'America/Sao_Paulo') prev_day_hi
  from raw_bounds r
),
-- Leads do expert restrito (vazio quando _affiliate_ids é null: aí o filtro
-- `_affiliate_ids is null or ...` abaixo libera a casa inteira).
lead as materialized (
  select p.id, p.nome, p.created_at
  from public.players p
  where p.tenant_id = _tenant and p.affiliate_id = any(_affiliate_ids)
),
player_counts as (
  select
    count(*) filter (where p.created_at >= b.cur_day_lo and p.created_at < b.cur_day_hi)::int cur_registrations,
    count(*) filter (where p.ftd_em >= b.cur_day_lo and p.ftd_em < b.cur_day_hi)::int cur_ftds,
    count(*) filter (where p.created_at >= b.prev_day_lo and p.created_at < b.prev_day_hi)::int prev_registrations,
    count(*) filter (where p.ftd_em >= b.prev_day_lo and p.ftd_em < b.prev_day_hi)::int prev_ftds
  from public.players p
  cross join bounds b
  where p.tenant_id = _tenant
    and (_affiliate_ids is null or p.affiliate_id = any(_affiliate_ids))
),
-- Uma leitura de deposits cobrindo os dois períodos (todos os status: PIX
-- gerado conta qualquer status).
dep as materialized (
  select d.player_id, d.valor, d.status = 'aprovado' approved,
         d.status = 'pendente' pending, d.created_at
  from public.deposits d
  cross join bounds b
  where d.tenant_id = _tenant
    and d.created_at >= least(b.cur_day_lo, b.prev_day_lo)
    and d.created_at < greatest(b.cur_day_hi, b.prev_day_hi)
    and (_affiliate_ids is null or d.player_id in (select l.id from lead l))
),
dep_counts as (
  select
    count(*) filter (where d.approved and d.created_at >= b.cur_day_lo and d.created_at < b.cur_day_hi)::int cur_count,
    coalesce(sum(d.valor) filter (where d.approved and d.created_at >= b.cur_day_lo and d.created_at < b.cur_day_hi),0)::numeric cur_amount,
    count(*) filter (where d.created_at >= b.cur_day_lo and d.created_at < b.cur_day_hi)::int cur_pix,
    count(*) filter (where d.approved and d.created_at >= b.prev_day_lo and d.created_at < b.prev_day_hi)::int prev_count,
    coalesce(sum(d.valor) filter (where d.approved and d.created_at >= b.prev_day_lo and d.created_at < b.prev_day_hi),0)::numeric prev_amount,
    count(*) filter (where d.created_at >= b.prev_day_lo and d.created_at < b.prev_day_hi)::int prev_pix,
    count(distinct d.player_id) filter (where d.approved and d.player_id is not null
      and d.created_at between b.cur_from and b.cur_to)::int cur_depositors,
    count(distinct d.player_id) filter (where d.approved and d.player_id is not null
      and d.created_at between b.prev_from and b.prev_to)::int prev_depositors
  from dep d
  cross join bounds b
),
redeposits as (
  select
    coalesce(sum(d.valor) filter (where d.created_at between b.cur_from and b.cur_to),0)::numeric cur_amount,
    count(*) filter (where d.created_at between b.cur_from and b.cur_to)::int cur_count,
    count(distinct d.player_id) filter (where d.created_at between b.cur_from and b.cur_to)::int cur_players,
    coalesce(sum(d.valor) filter (where d.created_at between b.prev_from and b.prev_to),0)::numeric prev_amount
  from dep d
  join public.players p on p.id = d.player_id and p.tenant_id = _tenant
  cross join bounds b
  where d.approved
    and p.ftd_em is not null and d.created_at > p.ftd_em + interval '1 minute'
),
wd as (
  select w.valor, w.created_at
  from public.withdrawals w
  cross join bounds b
  where w.tenant_id = _tenant and w.status = 'aprovado'
    and w.created_at >= b.cur_day_lo and w.created_at < b.cur_day_hi
    and (_affiliate_ids is null or w.player_id in (select l.id from lead l))
),
-- Saques aprovados do período anterior (o wd acima só cobre o atual).
wd_prev as (
  select coalesce(sum(w.valor),0)::numeric amount
  from public.withdrawals w
  cross join bounds b
  where w.tenant_id = _tenant and w.status = 'aprovado'
    and w.created_at >= b.prev_day_lo and w.created_at < b.prev_day_hi
    and (_affiliate_ids is null or w.player_id in (select l.id from lead l))
),
-- Como na casa: os leads com FTD (players.ftd_em, a mesma contagem do `ftd`
-- em player_counts) nos dias do período atual ou do anterior, o valor do
-- primeiro depósito aprovado (até 10 min depois do ftd_em) e se
-- redepositaram (aprovado depois de ftd_em + 1 min) no mesmo período.
ftd_cohort as (
  select p.ftd_em >= b.cur_day_lo and p.ftd_em < b.cur_day_hi is_cur,
         p.ftd_em >= b.prev_day_lo and p.ftd_em < b.prev_day_hi is_prev,
         coalesce(f.valor, 0) ftd_amount,
         exists (
           select 1 from public.deposits r
           where r.tenant_id = _tenant and r.player_id = p.id and r.status = 'aprovado'
             and r.created_at > p.ftd_em + interval '1 minute'
             and r.created_at < case when p.ftd_em >= b.cur_day_lo
                                     then b.cur_day_hi else b.prev_day_hi end
         ) redeposited
  from public.players p
  cross join bounds b
  left join lateral (
    select d.valor, d.created_at from public.deposits d
    where d.tenant_id = _tenant and d.player_id = p.id and d.status = 'aprovado'
    order by d.created_at, d.id
    limit 1
  ) f on f.created_at <= p.ftd_em + interval '10 minutes'
  where p.tenant_id = _tenant
    and (_affiliate_ids is null or p.affiliate_id = any(_affiliate_ids))
    and ((p.ftd_em >= b.cur_day_lo and p.ftd_em < b.cur_day_hi)
      or (p.ftd_em >= b.prev_day_lo and p.ftd_em < b.prev_day_hi))
),
ftd_totals as (
  select
    coalesce(sum(c.ftd_amount) filter (where c.is_cur),0)::numeric cur_amount,
    count(*) filter (where c.is_cur)::int cur_cohort,
    count(*) filter (where c.is_cur and c.redeposited)::int cur_redeposited,
    coalesce(sum(c.ftd_amount) filter (where c.is_prev),0)::numeric prev_amount,
    count(*) filter (where c.is_prev)::int prev_cohort,
    count(*) filter (where c.is_prev and c.redeposited)::int prev_redeposited
  from ftd_cohort c
),
-- Valor dos PIX gerados e não pagos no período: só as linhas 'pendente' de
-- dep ('falhou' carrega valores lixo antigos), como na casa.
pix_unpaid as (
  select coalesce(sum(d.valor) filter (where d.pending),0)::numeric amount
  from dep d
  cross join bounds b
  where d.created_at >= b.cur_day_lo and d.created_at < b.cur_day_hi
),
-- D-01 (como na casa): depósitos atribuídos a campanha/jornada por clique
-- humano (janela direta de 7 dias), sem quem já estava ativo no clique.
recovered as (
  select
    coalesce(sum(a.monetary_value),0)::numeric amount,
    count(distinct a.player_id)::int players,
    coalesce(sum(a.monetary_value) filter (where p.created_at >= b.cur_from),0)::numeric new_amount,
    coalesce(sum(a.monetary_value) filter (where a.source_type = 'journey'),0)::numeric reactivated_amount
  from public.conversion_attributions a
  left join public.players p on p.id = a.player_id
  cross join bounds b
  where a.tenant_id = _tenant and a.event_type = 'deposit_approved'
    and a.classification = 'direct'
    and a.occurred_at between b.cur_from and b.cur_to
    and (_affiliate_ids is null or a.player_id in (select l.id from lead l))
    and not public.crm_dispatch_was_active(a.tenant_id, a.link_dispatch_id)
),
series as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', to_char(day, 'YYYY-MM-DD'),
    'label', to_char(day, 'DD/MM'),
    'deposits', coalesce(dd.amount,0),
    'withdrawals', coalesce(ww.amount,0)
  ) order by day), '[]'::jsonb) value
  from bounds b
  cross join lateral generate_series(
    (b.cur_from at time zone 'America/Sao_Paulo')::date,
    (b.cur_to at time zone 'America/Sao_Paulo')::date,
    interval '1 day'
  ) day
  left join (
    select (d.created_at at time zone 'America/Sao_Paulo')::date metric_date, sum(d.valor) amount
    from dep d cross join bounds b2
    where d.approved and d.created_at >= b2.cur_day_lo and d.created_at < b2.cur_day_hi
    group by 1
  ) dd on dd.metric_date = day::date
  left join (
    select (w.created_at at time zone 'America/Sao_Paulo')::date metric_date, sum(w.valor) amount
    from wd w
    group by 1
  ) ww on ww.metric_date = day::date
),
-- Período de um dia só (como na casa): 24 barras por hora de Brasília
-- (hoje, até a hora atual), dos mesmos dep/wd do gráfico por dia.
hourly_series as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', lpad(h::text, 2, '0'),
    'label', lpad(h::text, 2, '0') || 'h',
    'deposits', coalesce(dd.amount,0),
    'withdrawals', coalesce(ww.amount,0)
  ) order by h), '[]'::jsonb) value
  from bounds b
  cross join lateral generate_series(0,
    case when (b.cur_from at time zone 'America/Sao_Paulo')::date
              = (now() at time zone 'America/Sao_Paulo')::date
         then extract(hour from now() at time zone 'America/Sao_Paulo')::int
         else 23 end) h
  left join (
    select extract(hour from d.created_at at time zone 'America/Sao_Paulo')::int hr,
           sum(d.valor) amount
    from dep d cross join bounds b2
    where d.approved and d.created_at >= b2.cur_day_lo and d.created_at < b2.cur_day_hi
    group by 1
  ) dd on dd.hr = h
  left join (
    select extract(hour from w.created_at at time zone 'America/Sao_Paulo')::int hr,
           sum(w.valor) amount
    from wd w
    group by 1
  ) ww on ww.hr = h
  where (b.cur_from at time zone 'America/Sao_Paulo')::date
        = (b.cur_to at time zone 'America/Sao_Paulo')::date
),
-- As 4 fontes do "Ao vivo" da casa. Cada uma tem dois ramos: a casa inteira
-- (só quando _affiliate_ids é null) e, para o restrito, por lead (índices
-- por player), para não varrer a casa toda atrás de 12 linhas dos leads.
live_rows as (
  (select 'player' kind, p.id, 'blue' tone, p.nome player_name,
          'criou conta' action, null::numeric amount, p.created_at, p.id player_id
   from public.players p
   where _affiliate_ids is null and p.tenant_id = _tenant
   order by p.created_at desc limit 12)
  union all
  (select 'player', l.id, 'blue', l.nome, 'criou conta', null::numeric, l.created_at, l.id
   from lead l order by l.created_at desc limit 12)
  union all
  (select 'deposit', d.id, 'green', p.nome, 'depositou', d.valor, coalesce(d.completed_at, d.created_at), d.player_id
   from public.deposits d left join public.players p on p.id = d.player_id
   where _affiliate_ids is null and d.tenant_id = _tenant and d.status = 'aprovado'
   order by d.created_at desc limit 12)
  union all
  (select 'deposit', d.id, 'green', l.nome, 'depositou', d.valor, coalesce(d.completed_at, d.created_at), l.id
   from lead l
   cross join lateral (
     select d.id, d.valor, d.created_at, d.completed_at from public.deposits d
     where d.tenant_id = _tenant and d.player_id = l.id and d.status = 'aprovado'
     order by d.created_at desc limit 12
   ) d
   order by d.created_at desc limit 12)
  union all
  (select 'withdrawal', w.id, 'purple', p.nome, 'sacou', w.valor, coalesce(w.completed_at, w.created_at), w.player_id
   from public.withdrawals w left join public.players p on p.id = w.player_id
   where _affiliate_ids is null and w.tenant_id = _tenant and w.status = 'aprovado'
   order by w.created_at desc limit 12)
  union all
  (select 'withdrawal', w.id, 'purple', l.nome, 'sacou', w.valor, coalesce(w.completed_at, w.created_at), l.id
   from lead l
   cross join lateral (
     select w.id, w.valor, w.created_at, w.completed_at from public.withdrawals w
     where w.tenant_id = _tenant and w.player_id = l.id and w.status = 'aprovado'
     order by w.created_at desc limit 12
   ) w
   order by w.created_at desc limit 12)
  union all
  (select 'event', e.id, 'orange', p.nome, 'gerou um PIX', e.valor, e.created_at, e.player_id
   from public.events e left join public.players p on p.id = e.player_id
   where _affiliate_ids is null and e.tenant_id = _tenant
     and e.tipo = 'deposito-pendente'
   order by e.created_at desc limit 8)
  union all
  (select 'event', e.id, 'orange', l.nome, 'gerou um PIX', e.valor, e.created_at, l.id
   from lead l
   cross join lateral (
     select e.id, e.valor, e.created_at from public.events e
     where e.player_id = l.id and e.tenant_id = _tenant
       and e.tipo = 'deposito-pendente'
     order by e.created_at desc limit 8
   ) e
   order by e.created_at desc limit 8)
),
live as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', x.kind || '-' || x.id::text,
    'tone', x.tone,
    'player', coalesce(x.player_name, 'jogador'),
    'action', x.action,
    'amount', x.amount,
    'at', x.created_at,
    'playerId', x.player_id
  ) order by x.created_at desc), '[]'::jsonb) value
  from (select * from live_rows order by created_at desc limit 8) x
),
-- D-06 (como na casa): leads dentro de uma jornada agora.
queue as (
  select count(distinct e.player_id)::int value
  from public.journey_enrollments e
  where e.tenant_id = _tenant
    and e.status in ('active','waiting','paused_by_priority')
    and (_affiliate_ids is null or e.player_id in (select l.id from lead l))
)
select jsonb_build_object(
  'depositAmount', dc.cur_amount,
  'previousDepositAmount', dc.prev_amount,
  'depositCount', dc.cur_count,
  'previousDepositCount', dc.prev_count,
  'depositors', dc.cur_depositors,
  'previousDepositors', dc.prev_depositors,
  'newPlayers', pc.cur_registrations,
  'previousNewPlayers', pc.prev_registrations,
  'ftd', pc.cur_ftds,
  'previousFtd', pc.prev_ftds,
  'withdrawalAmount', (select coalesce(sum(w.valor),0)::numeric from wd w),
  'redepositAmount', rd.cur_amount,
  'previousRedepositAmount', rd.prev_amount,
  'redepositCount', rd.cur_count,
  'redepositPlayers', rd.cur_players,
  'recoveredAmount', r.amount,
  'recoveredPlayers', r.players,
  'recoveredNew', r.new_amount,
  'recoveredReactivated', r.reactivated_amount,
  'pixGenerated', dc.cur_pix,
  'previousPixGenerated', dc.prev_pix,
  'reactivationQueue', q.value,
  'cashflowChart', case
    when (b.cur_from at time zone 'America/Sao_Paulo')::date
         = (b.cur_to at time zone 'America/Sao_Paulo')::date
    then hs.value else se.value end,
  'liveEvents', l.value,
  'ftdAmount', ft.cur_amount,
  'previousFtdAmount', ft.prev_amount,
  'ftdCohort', ft.cur_cohort,
  'ftdCohortRedeposited', ft.cur_redeposited,
  'previousFtdCohort', ft.prev_cohort,
  'previousFtdCohortRedeposited', ft.prev_redeposited,
  'withdrawalCount', (select count(*)::int from wd w),
  'previousWithdrawalAmount', wp.amount,
  'pixUnpaidAmount', pu.amount
)
from player_counts pc, dep_counts dc, redeposits rd, recovered r, series se, live l, queue q,
     bounds b, ftd_totals ft, wd_prev wp, pix_unpaid pu, hourly_series hs;
$$;

revoke all on function public.expert_home_summary(uuid, text[], timestamptz, timestamptz, timestamptz, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.expert_home_summary(uuid, text[], timestamptz, timestamptz, timestamptz, timestamptz, timestamptz)
  to service_role;
