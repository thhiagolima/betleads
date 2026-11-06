-- Área do Expert — "Início" com a mesma cara do Início da casa, mas só com
-- os números dos leads do próprio expert.
--
-- * expert_home_summary(tenant, affiliate_ids, from, to, prev_from, prev_to,
--   reset_at): devolve um jsonb com as MESMAS chaves de dashboard_summary_v2
--   (definição mais recente: 20261022100400_billing_dashboard_and_grants.sql)
--   menos as que são só da casa (smsSent, messageCost, walletBalance, exempt,
--   activeFlows, totalFlows, pausedFlows).
-- * Conjunto de leads: `_affiliate_ids` null = todos os jogadores da casa
--   (expert tipo 'total'); um array = só players.affiliate_id = any(array)
--   (tipo 'restrito'; array vazio = nada, tudo zero). Quem decide o array é
--   o servidor (requireExpertContext), nunca o navegador.
-- * Mesmas definições da casa, só que calculadas das tabelas brutas (a casa
--   lê tenant_daily_metrics, que é agregada por casa e não dá para recortar
--   por lead). Cada métrica diária replica refresh_tenant_daily_metric_day
--   (20261002170000_optimize_analytics_queries.sql):
--     registrations = players.created_at no dia; ftds = players.ftd_em no dia;
--     depósitos = deposits status 'aprovado'; saques = withdrawals 'aprovado';
--     PIX gerados = deposits de qualquer status.
--   Como na casa, essas métricas cobrem dias inteiros de Brasília entre a
--   data de greatest(_from, _reset_at) e a de _to; depositantes, redepósitos
--   e recuperado usam o instante exato (between), também como na casa.
-- * Com `_affiliate_ids` null os números batem com dashboard_summary_v2 a
--   menos do atraso da tabela diária (a casa só recalcula hoje e ontem por
--   cron; aqui é sempre ao vivo).
-- * "Ao vivo": as mesmas 4 fontes (cadastro, depósito, saque, PIX), só dos
--   leads, ordenadas pelo horário e cortadas em 8.
-- * SECURITY DEFINER, apenas service_role (como expert_metrics): a tela do
--   expert lê por server function, nunca direto do navegador.

begin;

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
  select d.player_id, d.valor, d.status = 'aprovado' approved, d.created_at
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
-- As 4 fontes do "Ao vivo" da casa. Cada uma tem dois ramos: a casa inteira
-- (só quando _affiliate_ids é null) e, para o restrito, por lead (índices
-- por player), para não varrer a casa toda atrás de 12 linhas dos leads.
live_rows as (
  (select 'player' kind, p.id, 'blue' tone, p.nome player_name,
          'criou conta' action, null::numeric amount, p.created_at
   from public.players p
   where _affiliate_ids is null and p.tenant_id = _tenant
   order by p.created_at desc limit 12)
  union all
  (select 'player', l.id, 'blue', l.nome, 'criou conta', null::numeric, l.created_at
   from lead l order by l.created_at desc limit 12)
  union all
  (select 'deposit', d.id, 'green', p.nome, 'depositou', d.valor, d.created_at
   from public.deposits d left join public.players p on p.id = d.player_id
   where _affiliate_ids is null and d.tenant_id = _tenant and d.status = 'aprovado'
   order by d.created_at desc limit 12)
  union all
  (select 'deposit', d.id, 'green', l.nome, 'depositou', d.valor, d.created_at
   from lead l
   cross join lateral (
     select d.id, d.valor, d.created_at from public.deposits d
     where d.tenant_id = _tenant and d.player_id = l.id and d.status = 'aprovado'
     order by d.created_at desc limit 12
   ) d
   order by d.created_at desc limit 12)
  union all
  (select 'withdrawal', w.id, 'purple', p.nome, 'sacou', w.valor, w.created_at
   from public.withdrawals w left join public.players p on p.id = w.player_id
   where _affiliate_ids is null and w.tenant_id = _tenant and w.status = 'aprovado'
   order by w.created_at desc limit 12)
  union all
  (select 'withdrawal', w.id, 'purple', l.nome, 'sacou', w.valor, w.created_at
   from lead l
   cross join lateral (
     select w.id, w.valor, w.created_at from public.withdrawals w
     where w.tenant_id = _tenant and w.player_id = l.id and w.status = 'aprovado'
     order by w.created_at desc limit 12
   ) w
   order by w.created_at desc limit 12)
  union all
  (select 'event', e.id, 'orange', p.nome, 'gerou um PIX', e.valor, e.created_at
   from public.events e left join public.players p on p.id = e.player_id
   where _affiliate_ids is null and e.tenant_id = _tenant
     and (lower(coalesce(e.tipo,'')) like '%pix%' or lower(coalesce(e.tipo,'')) like '%deposit%')
   order by e.created_at desc limit 8)
  union all
  (select 'event', e.id, 'orange', l.nome, 'gerou um PIX', e.valor, e.created_at
   from lead l
   cross join lateral (
     select e.id, e.valor, e.created_at from public.events e
     where e.player_id = l.id and e.tenant_id = _tenant
       and (lower(coalesce(e.tipo,'')) like '%pix%' or lower(coalesce(e.tipo,'')) like '%deposit%')
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
    'at', x.created_at
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
  'cashflowChart', se.value,
  'liveEvents', l.value
)
from player_counts pc, dep_counts dc, redeposits rd, recovered r, series se, live l, queue q;
$$;

revoke all on function public.expert_home_summary(uuid, text[], timestamptz, timestamptz, timestamptz, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.expert_home_summary(uuid, text[], timestamptz, timestamptz, timestamptz, timestamptz, timestamptz)
  to service_role;

commit;

notify pgrst, 'reload schema';
