-- Relatório de rendimento: resumo de uma pessoa, série diária e equipe.
--
-- Todos os valores de depósito vêm de expert_deposit_credits (a regra de
-- crédito não muda; aqui só se lê), filtrando deposit_at em [from, to).
-- Redepósito = crédito com is_ftd = false; reativado = is_reativacao.
--
-- * expert_click_conversion(tenant, experts[], from, to): uma linha por
--   expert pedido com
--     - leads_clicaram: leads distintos (recipient_player_id) com clique
--       humano no período em link_dispatches source_type 'expert',
--       send_status 'sent', source_id = o expert;
--     - leads_depositaram_clique: leads distintos com crédito via 'clique'
--       no período.
--   "Clique→depósito" = a razão dos dois. É a mesma função no relatório
--   individual e no ranking da equipe, para os números baterem.
-- * expert_report(tenant, expert, from, to): uma linha (zeros sem
--   movimento). links / leads_com_link vêm de expert_links criados no
--   período; contatos de expert_lead_contacts.
-- * expert_report_daily(tenant, expert, from, to): um dia de São Paulo por
--   linha cobrindo [from, to), com zeros nos dias sem movimento.
-- * expert_team_report(tenant, from, to): uma linha por perfil da casa,
--   inclusive inativos e sem movimento (zeros), numa única chamada.
-- * house_deposit_totals(tenant, from, to): depósitos aprovados da casa por
--   created_at no período, e quantos são FTD pelo critério da fase 3
--   (refresh_expert_credits): nenhum depósito aprovado anterior do jogador
--   (empate em created_at desempata por id) e players.ftd_em nulo ou a no
--   máximo 10 minutos antes do depósito.
-- * expert_last_computed_at(tenant): maior computed_at dos créditos da casa
--   (NULL sem créditos), servido pelo índice novo (tenant_id, computed_at).
-- * Todas SECURITY DEFINER, apenas service_role.

begin;

create index if not exists expert_deposit_credits_tenant_computed_idx
  on public.expert_deposit_credits (tenant_id, computed_at desc);

-- 1. expert_click_conversion -------------------------------------------------

create or replace function public.expert_click_conversion(
  _tenant uuid, _experts uuid[], _from timestamptz, _to timestamptz
)
returns table (expert_id uuid, leads_clicaram integer, leads_depositaram_clique integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with
  cte_clicked as (
    -- Index link_dispatches_expert_source_idx (tenant_id, source_id, sent_at),
    -- then click_events by (link_dispatch_id, occurred_at).
    select ld.source_id, count(distinct ld.recipient_player_id) leads
    from public.link_dispatches ld
    join public.click_events cl on cl.link_dispatch_id = ld.id and cl.tenant_id = _tenant
    where ld.tenant_id = _tenant
      and ld.source_type = 'expert'
      and ld.send_status = 'sent'
      and ld.source_id = any (array(select x::text from unnest(_experts) x))
      and ld.sent_at < _to
      and ld.recipient_player_id is not null
      and cl.is_human
      and cl.occurred_at >= _from and cl.occurred_at < _to
    group by ld.source_id
  ),
  cte_converted as (
    select c.expert_id, count(distinct c.player_id) leads
    from public.expert_deposit_credits c
    where c.tenant_id = _tenant
      and c.expert_id = any (_experts)
      and c.via = 'clique'
      and c.deposit_at >= _from and c.deposit_at < _to
    group by c.expert_id
  )
  select e.id,
         coalesce(ck.leads, 0)::integer,
         coalesce(cv.leads, 0)::integer
  from (select distinct x id from unnest(_experts) x) e
  left join cte_clicked ck on ck.source_id = e.id::text
  left join cte_converted cv on cv.expert_id = e.id;
$$;

revoke all on function public.expert_click_conversion(uuid, uuid[], timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.expert_click_conversion(uuid, uuid[], timestamptz, timestamptz)
  to service_role;

-- 2. expert_report -------------------------------------------------------------

create or replace function public.expert_report(
  _tenant uuid, _expert uuid, _from timestamptz, _to timestamptz
)
returns table (
  depositado numeric,
  depositado_clique numeric,
  depositado_afiliado numeric,
  ftds integer,
  valor_ftd numeric,
  redepositos integer,
  valor_redeposito numeric,
  reativados integer,
  depositantes integer,
  links integer,
  leads_com_link integer,
  leads_clicaram integer,
  leads_depositaram_clique integer,
  contatos integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with
  cte_credits as (
    select coalesce(sum(c.valor), 0) depositado,
           coalesce(sum(c.valor) filter (where c.via = 'clique'), 0) depositado_clique,
           coalesce(sum(c.valor) filter (where c.via = 'afiliado'), 0) depositado_afiliado,
           count(*) filter (where c.is_ftd) ftds,
           coalesce(sum(c.valor) filter (where c.is_ftd), 0) valor_ftd,
           count(*) filter (where not c.is_ftd) redepositos,
           coalesce(sum(c.valor) filter (where not c.is_ftd), 0) valor_redeposito,
           count(*) filter (where c.is_reativacao) reativados,
           count(distinct c.player_id) depositantes
    from public.expert_deposit_credits c
    where c.tenant_id = _tenant and c.expert_id = _expert
      and c.deposit_at >= _from and c.deposit_at < _to
  ),
  cte_links as (
    select count(*) links, count(distinct l.player_id) leads_com_link
    from public.expert_links l
    where l.tenant_id = _tenant and l.expert_id = _expert
      and l.created_at >= _from and l.created_at < _to
  ),
  cte_contacts as (
    select count(*) contatos
    from public.expert_lead_contacts ct
    where ct.tenant_id = _tenant and ct.expert_id = _expert
      and ct.created_at >= _from and ct.created_at < _to
  )
  select cr.depositado,
         cr.depositado_clique,
         cr.depositado_afiliado,
         cr.ftds::integer,
         cr.valor_ftd,
         cr.redepositos::integer,
         cr.valor_redeposito,
         cr.reativados::integer,
         cr.depositantes::integer,
         lk.links::integer,
         lk.leads_com_link::integer,
         coalesce(cv.leads_clicaram, 0),
         coalesce(cv.leads_depositaram_clique, 0),
         ct.contatos::integer
  from cte_credits cr
  cross join cte_links lk
  cross join cte_contacts ct
  left join public.expert_click_conversion(_tenant, array[_expert], _from, _to) cv on true;
$$;

revoke all on function public.expert_report(uuid, uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.expert_report(uuid, uuid, timestamptz, timestamptz) to service_role;

-- 3. expert_report_daily ---------------------------------------------------------

create or replace function public.expert_report_daily(
  _tenant uuid, _expert uuid, _from timestamptz, _to timestamptz
)
returns table (dia date, valor_ftd numeric, valor_redeposito numeric, depositantes integer)
language sql
stable
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
           sum(c.valor) filter (where c.is_ftd) valor_ftd,
           sum(c.valor) filter (where not c.is_ftd) valor_redeposito,
           count(distinct c.player_id) depositantes
    from public.expert_deposit_credits c
    where c.tenant_id = _tenant and c.expert_id = _expert
      and c.deposit_at >= _from and c.deposit_at < _to
    group by 1
  )
  select d.dia,
         coalesce(cr.valor_ftd, 0),
         coalesce(cr.valor_redeposito, 0),
         coalesce(cr.depositantes, 0)::integer
  from dias d
  left join cte_credits cr on cr.dia = d.dia
  order by d.dia;
$$;

revoke all on function public.expert_report_daily(uuid, uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.expert_report_daily(uuid, uuid, timestamptz, timestamptz)
  to service_role;

-- 4. expert_team_report ------------------------------------------------------------

create or replace function public.expert_team_report(_tenant uuid, _from timestamptz, _to timestamptz)
returns table (
  expert_id uuid,
  depositado numeric,
  ftds integer,
  redepositos integer,
  reativados integer,
  leads_clicaram integer,
  leads_depositaram_clique integer,
  depositos integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with
  cte_credits as (
    select c.expert_id,
           sum(c.valor) depositado,
           count(*) filter (where c.is_ftd) ftds,
           count(*) filter (where not c.is_ftd) redepositos,
           count(*) filter (where c.is_reativacao) reativados,
           count(*) depositos
    from public.expert_deposit_credits c
    where c.tenant_id = _tenant and c.deposit_at >= _from and c.deposit_at < _to
    group by c.expert_id
  )
  select e.id,
         coalesce(cr.depositado, 0),
         coalesce(cr.ftds, 0)::integer,
         coalesce(cr.redepositos, 0)::integer,
         coalesce(cr.reativados, 0)::integer,
         coalesce(cv.leads_clicaram, 0),
         coalesce(cv.leads_depositaram_clique, 0),
         coalesce(cr.depositos, 0)::integer
  from public.experts e
  left join cte_credits cr on cr.expert_id = e.id
  left join public.expert_click_conversion(
    _tenant,
    array(select x.id from public.experts x where x.tenant_id = _tenant),
    _from,
    _to
  ) cv on cv.expert_id = e.id
  where e.tenant_id = _tenant;
$$;

revoke all on function public.expert_team_report(uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.expert_team_report(uuid, timestamptz, timestamptz) to service_role;

-- 5. house_deposit_totals ------------------------------------------------------------

create or replace function public.house_deposit_totals(_tenant uuid, _from timestamptz, _to timestamptz)
returns table (depositado numeric, ftds integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(d.valor), 0),
         (count(*) filter (
           where p.id is not null
             and (p.ftd_em is null or p.ftd_em >= d.created_at - interval '10 minutes')
             and not exists (
               select 1 from public.deposits pd
               where pd.tenant_id = _tenant and pd.player_id = d.player_id and pd.status = 'aprovado'
                 and pd.created_at <= d.created_at
                 and (pd.created_at, pd.id) < (d.created_at, d.id)
             )
         ))::integer
  from public.deposits d
  left join public.players p on p.id = d.player_id and p.tenant_id = _tenant
  where d.tenant_id = _tenant and d.status = 'aprovado'
    and d.created_at >= _from and d.created_at < _to;
$$;

revoke all on function public.house_deposit_totals(uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.house_deposit_totals(uuid, timestamptz, timestamptz) to service_role;

-- 6. expert_last_computed_at -----------------------------------------------------------

create or replace function public.expert_last_computed_at(_tenant uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select max(c.computed_at) from public.expert_deposit_credits c where c.tenant_id = _tenant;
$$;

revoke all on function public.expert_last_computed_at(uuid) from public, anon, authenticated;
grant execute on function public.expert_last_computed_at(uuid) to service_role;

commit;
