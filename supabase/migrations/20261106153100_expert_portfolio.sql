-- Relatório de rendimento: carteira da pessoa e histórico do lead com ela.
--
-- * expert_portfolio(tenant, expert, from, to, search, only_ftd,
--   only_reativados, limit, offset): os leads com ao menos um crédito da
--   pessoa com deposit_at em [from, to), paginados no banco.
--     - creditado / depositos / origem ('clique' | 'afiliado' | 'ambos') /
--       tem_ftd (algum crédito is_ftd no período) / reativado (algum
--       is_reativacao no período) só com os créditos do período;
--     - primeiro_credito: o primeiro crédito da pessoa para o lead em todo o
--       histórico; ultimo_deposito: o último depósito aprovado do lead;
--     - último contato: o mais recente de expert_lead_contacts da pessoa;
--     - search: ilike sobre nome e telefone, com \ % _ escapados aqui;
--       vazio ou só espaços = sem busca;
--     - ordem creditado desc, player_id; total_count = linhas antes do
--       limite.
-- * expert_lead_timeline(tenant, expert, lead, before, limit): os `limit`
--   itens mais recentes com at < coalesce(before, infinity), juntando os
--   links da pessoa para o lead (expert_links), os cliques humanos do lead
--   nos links dela, os contatos dela e todos os depósitos aprovados do lead
--   desde least(primeiro link, primeiro crédito) da pessoa para o lead. Sem
--   link nem crédito, nada. Nunca devolve notas, links ou contatos de outra
--   pessoa, nem quem recebeu o crédito.
--   Each source and the merged result use FETCH FIRST ... WITH TIES on at, so
--   a page may hold more than `limit` items but never splits a timestamp:
--   the next page is before = at of the last item.
--   Depósito: status 'creditado' (detalhe "clique em dd/mm hh:mi" em São
--   Paulo, ou "afiliado"), 'outra_pessoa' ("contou para outro membro da
--   equipe") ou 'nao_creditado', com o primeiro motivo que se aplicar,
--   pelos dados da data do depósito:
--     0. sem crédito e criado há menos de 15 minutos: status 'pendente',
--        "aguardando cálculo (até 10 min)" (o cron ainda não passou);
--     1. "antes do seu cadastro" (antes de experts.created_at);
--     2. "perfil desativado na data" (em ou depois de desativado_em);
--     3. "ID de afiliado não era seu na data": o lead tem affiliate_id, o
--        expert_affiliate_history não o liga à pessoa naquele instante, e
--        não houve clique dela dentro da janela;
--     4. "sem clique seu nas {janela}h anteriores". A janela é a gravada no
--        crédito da casa mais recente até o depósito (a que valia quando
--        aquele trecho foi calculado), senão expert_settings, senão 72.
--   O clique segue a regra de refresh_expert_credits: link_dispatches
--   'expert' / 'sent' da pessoa para o lead, clique humano em
--   [greatest(sent_at, depósito - janela), depósito].
-- * Ambas SECURITY DEFINER, apenas service_role.

begin;

-- 1. expert_portfolio ---------------------------------------------------------

create or replace function public.expert_portfolio(
  _tenant uuid,
  _expert uuid,
  _from timestamptz,
  _to timestamptz,
  _search text,
  _only_ftd boolean,
  _only_reativados boolean,
  _limit integer,
  _offset integer
)
returns table (
  player_id uuid,
  nome text,
  telefone text,
  creditado numeric,
  depositos integer,
  origem text,
  primeiro_credito timestamptz,
  ultimo_deposito timestamptz,
  ultimo_contato_resultado text,
  ultimo_contato_em timestamptz,
  tem_ftd boolean,
  reativado boolean,
  total_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with
  cte_period as (
    select c.player_id,
           sum(c.valor) creditado,
           count(*) depositos,
           bool_or(c.via = 'clique') tem_clique,
           bool_or(c.via = 'afiliado') tem_afiliado,
           bool_or(c.is_ftd) tem_ftd,
           bool_or(c.is_reativacao) reativado
    from public.expert_deposit_credits c
    where c.tenant_id = _tenant and c.expert_id = _expert
      and c.deposit_at >= _from and c.deposit_at < _to
    group by c.player_id
  ),
  cte_search as (
    select case
             when nullif(btrim(_search), '') is null then null
             else '%' || replace(replace(replace(btrim(_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
           end pattern
  ),
  cte_page as (
    select pr.*, p.nome, p.telefone, count(*) over () total_count
    from cte_period pr
    join public.players p on p.id = pr.player_id and p.tenant_id = _tenant
    cross join cte_search s
    where (not coalesce(_only_ftd, false) or pr.tem_ftd)
      and (not coalesce(_only_reativados, false) or pr.reativado)
      and (s.pattern is null
           or p.nome ilike s.pattern escape '\'
           or p.telefone ilike s.pattern escape '\')
    order by pr.creditado desc, pr.player_id
    limit _limit offset coalesce(_offset, 0)
  ),
  cte_first as (
    select c.player_id, min(c.deposit_at) primeiro_credito
    from public.expert_deposit_credits c
    where c.tenant_id = _tenant and c.expert_id = _expert
      and c.player_id in (select pg.player_id from cte_page pg)
    group by c.player_id
  )
  select pg.player_id,
         pg.nome,
         pg.telefone,
         pg.creditado,
         pg.depositos::integer,
         case
           when pg.tem_clique and pg.tem_afiliado then 'ambos'
           when pg.tem_clique then 'clique'
           else 'afiliado'
         end,
         f.primeiro_credito,
         ud.ultimo_deposito,
         uc.resultado,
         uc.created_at,
         pg.tem_ftd,
         pg.reativado,
         pg.total_count
  from cte_page pg
  join cte_first f on f.player_id = pg.player_id
  left join lateral (
    select max(d.created_at) ultimo_deposito
    from public.deposits d
    where d.tenant_id = _tenant and d.player_id = pg.player_id and d.status = 'aprovado'
  ) ud on true
  left join lateral (
    select ct.resultado, ct.created_at
    from public.expert_lead_contacts ct
    where ct.tenant_id = _tenant and ct.player_id = pg.player_id and ct.expert_id = _expert
    order by ct.created_at desc
    limit 1
  ) uc on true
  order by pg.creditado desc, pg.player_id;
$$;

revoke all on function public.expert_portfolio(uuid, uuid, timestamptz, timestamptz, text, boolean, boolean, integer, integer)
  from public, anon, authenticated;
grant execute on function public.expert_portfolio(uuid, uuid, timestamptz, timestamptz, text, boolean, boolean, integer, integer)
  to service_role;

-- 2. expert_lead_timeline ------------------------------------------------------

create or replace function public.expert_lead_timeline(
  _tenant uuid,
  _expert uuid,
  _player uuid,
  _before timestamptz,
  _limit integer
)
returns table (
  at timestamptz,
  kind text,
  titulo text,
  detalhe text,
  valor numeric,
  status text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with
  cte_expert as (
    select e.id, e.created_at, e.desativado_em
    from public.experts e
    where e.id = _expert and e.tenant_id = _tenant
  ),
  cte_lead as (
    select p.id, nullif(btrim(p.affiliate_id), '') affiliate_id
    from public.players p
    where p.id = _player and p.tenant_id = _tenant
  ),
  -- Start of the relationship; no row (or a null start) = nothing to show.
  cte_start as (
    select least(
             (select min(l.created_at) from public.expert_links l
              where l.tenant_id = _tenant and l.player_id = _player and l.expert_id = _expert),
             (select min(c.deposit_at) from public.expert_deposit_credits c
              where c.tenant_id = _tenant and c.expert_id = _expert and c.player_id = _player)
           ) since
    from cte_expert, cte_lead
  ),
  cte_links as (
    select l.created_at at, 'link'::text kind, 'Link enviado'::text titulo,
           l.oferta detalhe, null::numeric valor, null::text status
    from public.expert_links l
    cross join cte_start s
    where s.since is not null
      and l.tenant_id = _tenant and l.player_id = _player and l.expert_id = _expert
      and l.created_at < coalesce(_before, 'infinity')
    order by l.created_at desc
    fetch first _limit rows with ties
  ),
  cte_clicks as (
    select cl.occurred_at at, 'clique'::text kind, 'Clique no link'::text titulo,
           ol.oferta detalhe, null::numeric valor, null::text status
    from public.link_dispatches ld
    join public.click_events cl on cl.link_dispatch_id = ld.id and cl.tenant_id = _tenant
    cross join cte_start s
    left join lateral (
      select l.oferta from public.expert_links l
      where l.tenant_id = _tenant and l.player_id = _player and l.link_dispatch_id = ld.id
      order by l.created_at, l.id
      limit 1
    ) ol on true
    where s.since is not null
      and ld.tenant_id = _tenant
      and ld.recipient_player_id = _player
      and ld.source_type = 'expert'
      and ld.send_status = 'sent'
      and ld.source_id = _expert::text
      and cl.is_human
      and cl.occurred_at < coalesce(_before, 'infinity')
    order by cl.occurred_at desc
    fetch first _limit rows with ties
  ),
  cte_contacts as (
    select ct.created_at at, 'contato'::text kind,
           case ct.resultado
             when 'chamei' then 'Chamei'
             when 'respondeu' then 'Respondeu'
             when 'prometeu_depositar' then 'Prometeu depositar'
             when 'sem_interesse' then 'Sem interesse'
             else ct.resultado
           end titulo,
           ct.nota detalhe, null::numeric valor, null::text status
    from public.expert_lead_contacts ct
    cross join cte_start s
    where s.since is not null
      and ct.tenant_id = _tenant and ct.player_id = _player and ct.expert_id = _expert
      and ct.created_at < coalesce(_before, 'infinity')
    order by ct.created_at desc
    fetch first _limit rows with ties
  ),
  cte_deps as (
    select d.id, d.created_at, d.valor
    from public.deposits d
    cross join cte_start s
    where s.since is not null
      and d.tenant_id = _tenant and d.player_id = _player and d.status = 'aprovado'
      and d.created_at >= s.since
      and d.created_at < coalesce(_before, 'infinity')
    order by d.created_at desc
    fetch first _limit rows with ties
  ),
  cte_deposits as (
    select d.created_at at, 'deposito'::text kind, 'Depósito aprovado'::text titulo,
           case
             when c.expert_id = _expert and c.via = 'clique'
               then 'clique em ' || to_char(c.click_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI')
             when c.expert_id = _expert then 'afiliado'
             when c.expert_id is not null then 'contou para outro membro da equipe'
             when d.created_at > now() - interval '15 minutes' then 'aguardando cálculo (até 10 min)'
             when d.created_at < e.created_at then 'antes do seu cadastro'
             when e.desativado_em is not null and d.created_at >= e.desativado_em
               then 'perfil desativado na data'
             when ld.affiliate_id is not null
                  and not exists (
                    select 1 from public.expert_affiliate_history h
                    where h.tenant_id = _tenant
                      and h.affiliate_id = ld.affiliate_id
                      and h.expert_id = _expert
                      and h.valid_from <= d.created_at
                      and (h.valid_to is null or d.created_at < h.valid_to)
                  )
                  and not exists (
                    select 1
                    from public.link_dispatches x
                    join public.click_events xc on xc.link_dispatch_id = x.id and xc.tenant_id = _tenant
                    where x.tenant_id = _tenant
                      and x.recipient_player_id = _player
                      and x.source_type = 'expert'
                      and x.send_status = 'sent'
                      and x.source_id = _expert::text
                      and x.sent_at is not null
                      and x.sent_at <= d.created_at
                      and xc.is_human
                      and xc.occurred_at >= greatest(x.sent_at, d.created_at - make_interval(hours => w.hours))
                      and xc.occurred_at <= d.created_at
                  )
               then 'ID de afiliado não era seu na data'
             else 'sem clique seu nas ' || w.hours || 'h anteriores'
           end detalhe,
           d.valor,
           case
             when c.expert_id = _expert then 'creditado'
             when c.expert_id is not null then 'outra_pessoa'
             when d.created_at > now() - interval '15 minutes' then 'pendente'
             else 'nao_creditado'
           end status
    from cte_deps d
    cross join cte_expert e
    cross join cte_lead ld
    left join public.expert_deposit_credits c on c.deposit_id = d.id and c.tenant_id = _tenant
    left join lateral (
      select coalesce(
               (select hc.click_window_hours from public.expert_deposit_credits hc
                where hc.tenant_id = _tenant and hc.deposit_at <= d.created_at
                order by hc.deposit_at desc
                limit 1),
               (select s.click_window_hours from public.expert_settings s where s.tenant_id = _tenant),
               72
             ) hours
      where c.expert_id is null
    ) w on true
  )
  select p.at, p.kind, p.titulo, p.detalhe, p.valor, p.status
  from (
    select t.*
    from (
      select * from cte_links
      union all select * from cte_clicks
      union all select * from cte_contacts
      union all select * from cte_deposits
    ) t
    -- With ties: a page never ends in the middle of a timestamp, so the
    -- next page can use _before = at of the last item.
    order by t.at desc
    fetch first _limit rows with ties
  ) p
  order by p.at desc, p.kind;
$$;

revoke all on function public.expert_lead_timeline(uuid, uuid, uuid, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.expert_lead_timeline(uuid, uuid, uuid, timestamptz, integer)
  to service_role;

commit;
