-- Área do Expert — Fase 1, Task 2: deny-by-default RLS for the expert role.
--
-- An expert is NOT a house member: current_tenant_id(), has_tenant_access(),
-- accessible_tenant_ids() and managed_tenant_ids() keep accepting only
-- admin/gestor/member and are not touched here. Every existing
-- "is_super_admin() OR tenant_id = current_tenant_id()" policy therefore
-- denies an expert by default. This migration adds the only exceptions, as
-- extra PERMISSIVE SELECT policies:
--   * players: the active expert house, filtered by the expert's tipo
--     ('total' = every player of the house; 'restrito' = only players whose
--     btrim(affiliate_id) is one of the expert's expert_affiliates);
--   * deposits / withdrawals: rows of a player the caller can see (the
--     EXISTS runs under players RLS, so it inherits the rule above);
--   * experts / expert_affiliates: the caller's own expert rows.
--
-- An expert only counts while it has BOTH a user_roles row role='expert' in
-- the house and an experts row with user_id = auth.uid() and ativo = true.
--
-- Performance: players has ~35k rows per big house, and permissive policies
-- are OR-ed together for every caller, admins included. Each expert policy
-- is "tenant_id = (select current_expert_tenant_id()) AND (select
-- current_expert_tenant_id()) IS NOT NULL AND ...":
--   * the bare tenant_id = (InitPlan) comparison stays an indexable
--     condition the planner can combine with the other tenant arms (a
--     coalesce(...) wrapper would hide it from the planner);
--   * for a non-expert (current_expert_tenant_id() IS NULL) the comparison is
--     NULL, which does not stop an AND; the IS NOT NULL arm is false and
--     does, so the EXISTS never runs for non-experts;
--   * the tipo / affiliate-id rule is also two scalar subqueries
--     (current_expert_tipo(), current_expert_affiliate_ids()): each is an
--     InitPlan, evaluated once per query, never per row. A SECURITY DEFINER
--     function taking row columns would never be inlined and would run once
--     per player (and again per deposit/withdrawal through the EXISTS).

begin;

-- 1. helpers -----------------------------------------------------------------

-- Houses where the caller is an active expert.
create or replace function public.expert_tenant_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct e.tenant_id order by e.tenant_id), '{}'::uuid[])
  from public.experts e
  where e.user_id = auth.uid()
    and e.ativo
    and exists (
      select 1 from public.user_roles ur
      where ur.user_id = e.user_id
        and ur.tenant_id = e.tenant_id
        and ur.role = 'expert'
    )
$$;

revoke all on function public.expert_tenant_ids() from public, anon;
grant execute on function public.expert_tenant_ids() to authenticated, service_role;

-- The expert house in effect for this request. The X-Active-Tenant header is
-- read the same way as current_tenant_id() does; when present it must be one
-- of the caller's expert houses, otherwise NULL (never a fallback to another
-- house). Without the header: the first expert house by tenant_id.
create or replace function public.current_expert_tenant_id()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenants uuid[];
  v_requested text;
  v_tenant uuid;
begin
  if auth.uid() is null then
    return null;
  end if;

  v_tenants := public.expert_tenant_ids();

  begin
    v_requested := current_setting('request.headers', true)::jsonb ->> 'x-active-tenant';
  exception when others then
    v_requested := null;
  end;

  if v_requested is not null and v_requested <> '' then
    begin
      v_tenant := v_requested::uuid;
    exception when others then
      return null;
    end;

    if v_tenant = any(v_tenants) then
      return v_tenant;
    end if;
    return null;
  end if;

  return v_tenants[1];
end;
$$;

revoke all on function public.current_expert_tenant_id() from public, anon;
grant execute on function public.current_expert_tenant_id() to authenticated, service_role;

-- The tipo of the caller's active expert row in current_expert_tenant_id(),
-- or NULL when the caller is not an active expert there.
create or replace function public.current_expert_tipo()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select e.tipo
  from public.experts e
  where e.user_id = auth.uid()
    and e.tenant_id = public.current_expert_tenant_id()
    and e.ativo
  order by e.id
  limit 1
$$;

revoke all on function public.current_expert_tipo() from public, anon;
grant execute on function public.current_expert_tipo() to authenticated, service_role;

-- The affiliate ids of the caller's active expert row in
-- current_expert_tenant_id() (empty when none). expert_affiliates stores
-- them already btrim-ed (save_expert), compared case-sensitively.
create or replace function public.current_expert_affiliate_ids()
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(ea.affiliate_id order by ea.affiliate_id), '{}'::text[])
  from public.experts e
  join public.expert_affiliates ea
    on ea.expert_id = e.id
   and ea.tenant_id = e.tenant_id
  where e.user_id = auth.uid()
    and e.tenant_id = public.current_expert_tenant_id()
    and e.ativo
$$;

revoke all on function public.current_expert_affiliate_ids() from public, anon;
grant execute on function public.current_expert_affiliate_ids() to authenticated, service_role;

-- 2. policies ----------------------------------------------------------------

drop policy if exists players_expert_select on public.players;
create policy players_expert_select on public.players
  as permissive for select to authenticated
  using (
    tenant_id = (select public.current_expert_tenant_id())
    and (select public.current_expert_tenant_id()) is not null
    and (
      (select public.current_expert_tipo()) = 'total'
      -- The ::text[] makes this the array form of ANY over an InitPlan;
      -- without it, "any ((select ...))" parses as ANY (subquery).
      or btrim(affiliate_id) = any ((select public.current_expert_affiliate_ids())::text[])
    )
  );

-- The EXISTS below runs under players RLS, so it only matches players the
-- caller can see (for an expert: players_expert_select).
drop policy if exists deposits_expert_select on public.deposits;
create policy deposits_expert_select on public.deposits
  as permissive for select to authenticated
  using (
    tenant_id = (select public.current_expert_tenant_id())
    and (select public.current_expert_tenant_id()) is not null
    and exists (select 1 from public.players p where p.id = player_id)
  );

drop policy if exists withdrawals_expert_select on public.withdrawals;
create policy withdrawals_expert_select on public.withdrawals
  as permissive for select to authenticated
  using (
    tenant_id = (select public.current_expert_tenant_id())
    and (select public.current_expert_tenant_id()) is not null
    and exists (select 1 from public.players p where p.id = player_id)
  );

drop policy if exists experts_expert_select_own on public.experts;
create policy experts_expert_select_own on public.experts
  as permissive for select to authenticated
  using (user_id = (select auth.uid()));

-- The subquery runs under experts RLS; experts_expert_select_own lets the
-- caller see its own rows there.
drop policy if exists expert_affiliates_expert_select_own on public.expert_affiliates;
create policy expert_affiliates_expert_select_own on public.expert_affiliates
  as permissive for select to authenticated
  using (expert_id in (select e.id from public.experts e where e.user_id = (select auth.uid())));

commit;

notify pgrst, 'reload schema';
