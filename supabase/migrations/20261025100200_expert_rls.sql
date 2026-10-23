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
-- are OR-ed together for every caller, admins included. The tenant
-- comparisons are wrapped in coalesce(..., false) so that, for a non-expert
-- (current_expert_tenant_id() IS NULL), the AND short-circuits on false
-- instead of continuing on NULL and calling the per-row helper / EXISTS for
-- every row. Semantics are unchanged (NULL and false both deny in USING).

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

-- Whether the caller, as an active expert of _tenant, may see a player with
-- this affiliate id: always for tipo 'total', else only for its own ids
-- (compared after btrim, case-sensitive).
create or replace function public.expert_can_see_player(_tenant uuid, _affiliate_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.experts e
    where e.user_id = auth.uid()
      and e.tenant_id = _tenant
      and e.ativo
      and (
        e.tipo = 'total'
        or exists (
          select 1 from public.expert_affiliates ea
          where ea.expert_id = e.id
            and ea.tenant_id = _tenant
            and ea.affiliate_id = btrim(_affiliate_id)
        )
      )
  )
$$;

revoke all on function public.expert_can_see_player(uuid, text) from public, anon;
grant execute on function public.expert_can_see_player(uuid, text) to authenticated, service_role;

-- 2. policies ----------------------------------------------------------------

drop policy if exists players_expert_select on public.players;
create policy players_expert_select on public.players
  as permissive for select to authenticated
  using (
    coalesce(tenant_id = (select public.current_expert_tenant_id()), false)
    and public.expert_can_see_player(tenant_id, affiliate_id)
  );

-- The EXISTS below runs under players RLS, so it only matches players the
-- caller can see (for an expert: players_expert_select).
drop policy if exists deposits_expert_select on public.deposits;
create policy deposits_expert_select on public.deposits
  as permissive for select to authenticated
  using (
    coalesce(tenant_id = (select public.current_expert_tenant_id()), false)
    and exists (select 1 from public.players p where p.id = player_id)
  );

drop policy if exists withdrawals_expert_select on public.withdrawals;
create policy withdrawals_expert_select on public.withdrawals
  as permissive for select to authenticated
  using (
    coalesce(tenant_id = (select public.current_expert_tenant_id()), false)
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
