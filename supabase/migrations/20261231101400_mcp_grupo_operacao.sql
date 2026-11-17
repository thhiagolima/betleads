-- MCP do grupo, operação fase 1 (docs/superpowers/specs/2026-11-17-mcp-grupo-design.md §4, §6, §7).
--
-- O MCP passa a ter duas áreas: financeiro (o que já existe) e operação (só
-- leitura, por casa, grupo ou todas as casas que o usuário vê). Esta migração:
--   1. `mcp_access.areas`: quais áreas o usuário pode usar. Linhas existentes
--      ficam só com financeiro, então ninguém ganha a operação sem o super
--      admin ligar no painel.
--   2. `mcp_call_log.args` e `scope`: argumentos da chamada (cortados em 4 KB
--      pelo servidor, nunca com dado de jogador) e o escopo resolvido
--      (`{tipo, id, casas}`).
--   3. `mcp_ops_tenant_ids` / `mcp_ops_can_view`: a única regra de quem vê a
--      operação de qual casa pelo MCP — super admin vê todas; senão, as casas
--      onde é admin mais as casas dos grupos que gerencia. Gestor e membro de
--      casa não veem. Nada além do MCP usa essas funções: `has_tenant_access`,
--      `accessible_tenant_ids`, `managed_tenant_ids` e `current_tenant_id` não
--      mudam (o gestor de grupo não ganha acesso operacional fora do MCP).
--   4. `mcp_affiliate_metrics`: números por (casa, affiliate_id) para a
--      ferramenta `afiliados`, com o expert vinculado quando existe.
--   5. índice parcial `players (tenant_id, affiliate_id)`.
--
-- Todas as funções são `security definer` e só `service_role` executa (recebem
-- um `_user`/`_tenants` arbitrário; o servidor MCP já resolveu a permissão).
--
-- Idempotente.

-- ---------------------------------------------------------------------------
-- 1. Áreas liberadas por usuário
-- ---------------------------------------------------------------------------

alter table public.mcp_access
  add column if not exists areas text[] not null default '{financeiro}';

alter table public.mcp_access drop constraint if exists mcp_access_areas_check;
alter table public.mcp_access
  add constraint mcp_access_areas_check
  check (
    cardinality(areas) > 0
    and areas <@ array['financeiro', 'operacao']::text[]
  );

-- ---------------------------------------------------------------------------
-- 2. Log de chamadas: argumentos e escopo
-- ---------------------------------------------------------------------------

alter table public.mcp_call_log add column if not exists args jsonb null;
alter table public.mcp_call_log add column if not exists scope jsonb null;

-- ---------------------------------------------------------------------------
-- 3. Quem vê a operação de qual casa (só o MCP usa)
-- ---------------------------------------------------------------------------

create or replace function public.mcp_ops_tenant_ids(_user uuid)
returns setof uuid
language sql
stable security definer
set search_path = public, pg_temp
as $$
  select t.id
  from public.tenants t
  where public.is_super_admin(_user)
  union
  select ur.tenant_id
  from public.user_roles ur
  where ur.user_id = _user
    and ur.role = 'admin'
    and ur.tenant_id is not null
    and not public.is_super_admin(_user)
  union
  select gt
  from public.group_ids_managed_by(_user) as g
  cross join lateral public.group_tenant_ids(g) as gt
  where not public.is_super_admin(_user)
$$;

revoke all on function public.mcp_ops_tenant_ids(uuid) from public, anon, authenticated;
grant execute on function public.mcp_ops_tenant_ids(uuid) to service_role;

create or replace function public.mcp_ops_can_view(_user uuid, _tenant uuid)
returns boolean
language sql
stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.mcp_ops_tenant_ids(_user) as t where t = _tenant
  )
$$;

revoke all on function public.mcp_ops_can_view(uuid, uuid) from public, anon, authenticated;
grant execute on function public.mcp_ops_can_view(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Métricas por affiliate_id (ferramenta `afiliados`)
-- ---------------------------------------------------------------------------
--
-- Por (casa, affiliate_id) das casas em `_tenants`:
--   jogadores_base: jogadores com esse affiliate_id, sem período;
--   cadastros: players.created_at no período;
--   ftds: players.ftd_em no período;
--   depositos/depositado/depositantes: deposits 'aprovado' por created_at no
--     período (mesma regra do dashboard_summary_v2), de jogadores com o id;
--   primeiro_cadastro/ultimo_cadastro: sem período;
--   expert_id/expert_nome: vínculo em expert_affiliates, ou null.
-- Período meio-aberto [_from, _to), como expert_metrics. Jogadores sem
-- affiliate_id não entram. Com `_affiliate`, só esse id (vinculado ou não).
-- Nenhuma coluna de jogador individual sai daqui: tudo é agregado.

create or replace function public.mcp_affiliate_metrics(
  _tenants uuid[],
  _from timestamptz,
  _to timestamptz,
  _affiliate text default null
)
returns table (
  tenant_id uuid,
  affiliate_id text,
  jogadores_base integer,
  cadastros integer,
  ftds integer,
  depositos integer,
  depositado numeric,
  depositantes integer,
  primeiro_cadastro timestamptz,
  ultimo_cadastro timestamptz,
  expert_id uuid,
  expert_nome text
)
language sql
stable security definer
set search_path = public, pg_temp
as $$
  with
  base as (
    select p.tenant_id,
           p.affiliate_id,
           count(*) jogadores_base,
           count(*) filter (where p.created_at >= _from and p.created_at < _to) cadastros,
           count(*) filter (where p.ftd_em >= _from and p.ftd_em < _to) ftds,
           min(p.created_at) primeiro_cadastro,
           max(p.created_at) ultimo_cadastro
    from public.players p
    where p.tenant_id = any(_tenants)
      and p.affiliate_id is not null
      and (_affiliate is null or p.affiliate_id = _affiliate)
    group by p.tenant_id, p.affiliate_id
  ),
  deps as (
    select p.tenant_id,
           p.affiliate_id,
           count(*) depositos,
           sum(d.valor) depositado,
           count(distinct d.player_id) depositantes
    from public.deposits d
    join public.players p on p.id = d.player_id and p.tenant_id = d.tenant_id
    where d.tenant_id = any(_tenants)
      and d.status = 'aprovado'
      and d.created_at >= _from and d.created_at < _to
      and p.affiliate_id is not null
      and (_affiliate is null or p.affiliate_id = _affiliate)
    group by p.tenant_id, p.affiliate_id
  )
  select b.tenant_id,
         b.affiliate_id,
         b.jogadores_base::integer,
         b.cadastros::integer,
         b.ftds::integer,
         coalesce(dp.depositos, 0)::integer,
         coalesce(dp.depositado, 0),
         coalesce(dp.depositantes, 0)::integer,
         b.primeiro_cadastro,
         b.ultimo_cadastro,
         ea.expert_id,
         e.nome
  from base b
  left join deps dp on dp.tenant_id = b.tenant_id and dp.affiliate_id = b.affiliate_id
  left join public.expert_affiliates ea
    on ea.tenant_id = b.tenant_id and ea.affiliate_id = b.affiliate_id
  left join public.experts e on e.id = ea.expert_id
$$;

revoke all on function public.mcp_affiliate_metrics(uuid[], timestamptz, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.mcp_affiliate_metrics(uuid[], timestamptz, timestamptz, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. Índice para agrupar jogadores por affiliate_id dentro da casa
-- ---------------------------------------------------------------------------
-- Hoje só existe idx_players_affiliate_id (affiliate_id sozinho).

create index if not exists players_tenant_affiliate_idx
  on public.players (tenant_id, affiliate_id)
  where affiliate_id is not null;
