-- Área do Expert — fase 3: métricas por expert e série diária.
--
-- * expert_metrics(tenant, from, to): uma linha por expert da casa
--   (inclusive inativos, inclusive sem nenhuma atividade no período, com
--   zeros), agregando:
--     - depositado / depositado_clique / depositado_afiliado / depositos /
--       depositantes / reativacoes / ftds a partir de
--       expert_deposit_credits (Task 1), filtrando por deposit_at no
--       período [from, to);
--     - links: linhas de expert_links criadas no período;
--     - cliques: cliques humanos (click_events.is_human) em dispatches
--       source_type = 'expert' cujo source_id é o próprio expert, com
--       occurred_at no período;
--     - contatos: linhas de expert_lead_contacts criadas no período.
--   Como a base da consulta é a tabela experts, um expert excluído some
--   junto com seus créditos/links/contatos (todos ON DELETE CASCADE).
-- * expert_metrics_daily(tenant, expert, from, to): uma linha por dia em
--   São Paulo cobrindo [from, to), preenchendo com zeros os dias sem
--   movimento (generate_series), com depositado/depositado_clique/
--   depositado_afiliado/cliques do mesmo expert.
-- * Ambas SECURITY DEFINER, apenas service_role (as telas do admin/gestor
--   leem via função server-side, nunca direto do navegador).

begin;

-- 1. expert_metrics -----------------------------------------------------------

create or replace function public.expert_metrics(_tenant uuid, _from timestamptz, _to timestamptz)
returns table (
  expert_id uuid,
  depositado numeric,
  depositado_clique numeric,
  depositado_afiliado numeric,
  depositos integer,
  depositantes integer,
  reativacoes integer,
  ftds integer,
  links integer,
  cliques integer,
  contatos integer
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with
  cte_credits as (
    select c.expert_id,
           sum(c.valor) depositado,
           sum(c.valor) filter (where c.via = 'clique') depositado_clique,
           sum(c.valor) filter (where c.via = 'afiliado') depositado_afiliado,
           count(*) depositos,
           count(distinct c.player_id) depositantes,
           count(*) filter (where c.is_reativacao) reativacoes,
           count(*) filter (where c.is_ftd) ftds
    from public.expert_deposit_credits c
    where c.tenant_id = _tenant and c.deposit_at >= _from and c.deposit_at < _to
    group by c.expert_id
  ),
  cte_links as (
    select l.expert_id, count(*) links
    from public.expert_links l
    where l.tenant_id = _tenant and l.created_at >= _from and l.created_at < _to
    group by l.expert_id
  ),
  cte_clicks as (
    select ld.source_id::uuid expert_id, count(*) cliques
    from public.link_dispatches ld
    join public.click_events cl on cl.link_dispatch_id = ld.id and cl.tenant_id = _tenant
    where ld.tenant_id = _tenant
      and ld.source_type = 'expert'
      and ld.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and cl.is_human
      and cl.occurred_at >= _from and cl.occurred_at < _to
    group by ld.source_id::uuid
  ),
  cte_contacts as (
    select ct.expert_id, count(*) contatos
    from public.expert_lead_contacts ct
    where ct.tenant_id = _tenant and ct.created_at >= _from and ct.created_at < _to
    group by ct.expert_id
  )
  select e.id,
         coalesce(cr.depositado, 0),
         coalesce(cr.depositado_clique, 0),
         coalesce(cr.depositado_afiliado, 0),
         coalesce(cr.depositos, 0)::integer,
         coalesce(cr.depositantes, 0)::integer,
         coalesce(cr.reativacoes, 0)::integer,
         coalesce(cr.ftds, 0)::integer,
         coalesce(lk.links, 0)::integer,
         coalesce(cl.cliques, 0)::integer,
         coalesce(ct.contatos, 0)::integer
  from public.experts e
  left join cte_credits cr on cr.expert_id = e.id
  left join cte_links lk on lk.expert_id = e.id
  left join cte_clicks cl on cl.expert_id = e.id
  left join cte_contacts ct on ct.expert_id = e.id
  where e.tenant_id = _tenant;
$$;

revoke all on function public.expert_metrics(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.expert_metrics(uuid, timestamptz, timestamptz) to service_role;

-- 2. expert_metrics_daily ------------------------------------------------------

create or replace function public.expert_metrics_daily(
  _tenant uuid, _expert_id uuid, _from timestamptz, _to timestamptz
)
returns table (
  dia date,
  depositado numeric,
  depositado_clique numeric,
  depositado_afiliado numeric,
  cliques integer
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with
  dias as (
    select generate_series(
      (_from at time zone 'America/Sao_Paulo')::date,
      ((_to - interval '1 second') at time zone 'America/Sao_Paulo')::date,
      interval '1 day'
    )::date dia
  ),
  cte_credits as (
    select ((c.deposit_at at time zone 'America/Sao_Paulo')::date) dia,
           sum(c.valor) depositado,
           sum(c.valor) filter (where c.via = 'clique') depositado_clique,
           sum(c.valor) filter (where c.via = 'afiliado') depositado_afiliado
    from public.expert_deposit_credits c
    where c.tenant_id = _tenant and c.expert_id = _expert_id
      and c.deposit_at >= _from and c.deposit_at < _to
    group by 1
  ),
  cte_clicks as (
    select ((cl.occurred_at at time zone 'America/Sao_Paulo')::date) dia,
           count(*) cliques
    from public.link_dispatches ld
    join public.click_events cl on cl.link_dispatch_id = ld.id and cl.tenant_id = _tenant
    where ld.tenant_id = _tenant
      and ld.source_type = 'expert'
      and ld.source_id = _expert_id::text
      and cl.is_human
      and cl.occurred_at >= _from and cl.occurred_at < _to
    group by 1
  )
  select d.dia,
         coalesce(cr.depositado, 0),
         coalesce(cr.depositado_clique, 0),
         coalesce(cr.depositado_afiliado, 0),
         coalesce(ck.cliques, 0)::integer
  from dias d
  left join cte_credits cr on cr.dia = d.dia
  left join cte_clicks ck on ck.dia = d.dia
  order by d.dia;
$$;

revoke all on function public.expert_metrics_daily(uuid, uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.expert_metrics_daily(uuid, uuid, timestamptz, timestamptz) to service_role;

commit;
