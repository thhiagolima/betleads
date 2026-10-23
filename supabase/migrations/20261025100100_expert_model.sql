-- Área do Expert — Fase 1, Task 1: data model.
--
-- * user_roles' canonical-scope CHECK accepts the new 'expert' role (added by
--   the preceding 20261025100000 migration), still requiring a tenant.
-- * experts gets the columns the expert area needs (user_id, tipo, ativo,
--   envio_modo, teto_mensal, assumir_prazo_dias, updated_at) and stops using
--   its legacy single global affiliate_id: that column is deprecated (kept,
--   nullable, no longer unique) in favor of a per-house expert_affiliates
--   table, so the same affiliate id can belong to different experts in
--   different houses.
-- * expert_affiliates: one row per (tenant, affiliate_id), owned by an
--   expert of that same tenant (enforced by a trigger, since a naive FK
--   cannot check both expert_id and tenant_id together here).
-- * save_expert / delete_expert / tenant_unassigned_affiliate_ids are the
--   only way to write this model; service_role only (called from server
--   functions, never from the browser).
-- * Backfill: production only has legacy rows shaped like
--   ('Queiroz', AFF-a), ('Queiroz', AFF-b), ('Andrade', AFF-c), all in one
--   tenant — several rows per person, one affiliate_id each, no tenant_id
--   collisions across names. They are merged per (tenant, nome) into the
--   row with the earliest created_at (lowest id breaks a tie); every
--   affiliate_id in the group becomes an expert_affiliates row on that
--   canonical expert, and the canonical row's own affiliate_id is cleared.

begin;

-- 1. user_roles: allow role = 'expert', still tenant-scoped. Same
--    constraint name as 20261003101500_lock_tenant_role_contract.sql, kept
--    NOT VALID (existing rows are not re-checked).
alter table public.user_roles
  drop constraint if exists user_roles_canonical_scope;

alter table public.user_roles
  add constraint user_roles_canonical_scope
  check (
    (role = 'super_admin' and tenant_id is null)
    or (role in ('admin', 'gestor', 'member', 'expert') and tenant_id is not null)
  ) not valid;

-- 2. experts: new columns used by the expert area (modo/teto/prazo are only
--    stored in this phase; phases 2 and 4 read them).
alter table public.experts
  add column if not exists user_id uuid references auth.users(id) on delete set null,
  add column if not exists tipo text not null default 'restrito' check (tipo in ('restrito', 'total')),
  add column if not exists ativo boolean not null default true,
  add column if not exists envio_modo text not null default 'livre' check (envio_modo in ('livre', 'aprovacao')),
  add column if not exists teto_mensal numeric(12, 2) check (teto_mensal >= 0),
  add column if not exists assumir_prazo_dias integer not null default 3 check (assumir_prazo_dias between 1 and 30),
  add column if not exists updated_at timestamptz not null default now();

create trigger experts_updated_at
  before update on public.experts
  for each row execute function public.set_updated_at();

-- affiliate_id stops being mandatory/globally unique; expert_affiliates
-- below is the per-house source of truth for which affiliate ids an expert
-- owns.
alter table public.experts
  alter column affiliate_id drop not null;

-- 3. expert_affiliates: per-house affiliate ids, each owned by exactly one
--    expert of that house.
create table if not exists public.expert_affiliates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  expert_id uuid not null references public.experts(id) on delete cascade,
  affiliate_id text not null check (affiliate_id = btrim(affiliate_id) and affiliate_id <> ''),
  created_at timestamptz not null default now(),
  unique (tenant_id, affiliate_id)
);

create index if not exists expert_affiliates_expert_id_idx
  on public.expert_affiliates (expert_id);

alter table public.expert_affiliates enable row level security;

drop policy if exists expert_affiliates_tenant_rls on public.expert_affiliates;
create policy expert_affiliates_tenant_rls on public.expert_affiliates
  as permissive for all to authenticated
  using ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()))
  with check ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()));

-- Reads go straight to tenant members via RLS above; writes only via
-- save_expert/delete_expert (service_role), which also keep players.expert
-- and the affiliate_taken check consistent.
grant select on public.expert_affiliates to authenticated;
grant all on public.expert_affiliates to service_role;

-- A row's tenant_id must match the tenant_id of the expert it points to —
-- a plain FK cannot express "the two columns agree", so this trigger does.
create or replace function public.expert_affiliates_check_tenant()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_expert_tenant uuid;
begin
  select tenant_id into v_expert_tenant
  from public.experts
  where id = new.expert_id;

  if v_expert_tenant is null or v_expert_tenant <> new.tenant_id then
    raise exception 'expert_affiliates_tenant_mismatch';
  end if;

  return new;
end;
$$;

drop trigger if exists expert_affiliates_tenant_guard on public.expert_affiliates;
create trigger expert_affiliates_tenant_guard
  before insert or update on public.expert_affiliates
  for each row execute function public.expert_affiliates_check_tenant();

-- 4. Backfill legacy experts rows (one per affiliate_id) into one expert
--    per (tenant, nome) with all of its affiliate ids in expert_affiliates.
do $backfill$
declare
  grp record;
  canonical_id uuid;
begin
  for grp in
    select distinct tenant_id, lower(btrim(nome)) as nome_key
    from public.experts
  loop
    select id into canonical_id
    from public.experts
    where tenant_id = grp.tenant_id
      and lower(btrim(nome)) = grp.nome_key
    order by created_at asc, id asc
    limit 1;

    insert into public.expert_affiliates (tenant_id, expert_id, affiliate_id)
    select grp.tenant_id, canonical_id, affiliate_id
    from public.experts
    where tenant_id = grp.tenant_id
      and lower(btrim(nome)) = grp.nome_key
      and affiliate_id is not null
    on conflict (tenant_id, affiliate_id) do nothing;

    delete from public.experts
    where tenant_id = grp.tenant_id
      and lower(btrim(nome)) = grp.nome_key
      and id <> canonical_id;

    update public.experts
    set affiliate_id = null
    where id = canonical_id;
  end loop;
end
$backfill$;

-- 5. affiliate_id is now redundant and deprecated; experts_tenant_nome_uniq
--    only makes sense once the backfill above has deduped names per house.
alter table public.experts
  drop constraint if exists experts_affiliate_id_key;

comment on column public.experts.affiliate_id is
  'Descontinuado: os ids de afiliado agora vivem em expert_affiliates (um por casa). Sempre NULL a partir desta migração; não usar em código novo.';

create unique index if not exists experts_tenant_nome_uniq
  on public.experts (tenant_id, lower(btrim(nome)));

create unique index if not exists experts_tenant_user_uniq
  on public.experts (tenant_id, user_id)
  where user_id is not null;

-- 6. save_expert / delete_expert / tenant_unassigned_affiliate_ids:
--    service_role only — called from server functions after
--    requireTenantAdmin/assertTenantNotDemo, never from the browser.

create or replace function public.save_expert(
  _tenant uuid,
  _expert_id uuid,
  _nome text,
  _tipo text,
  _affiliate_ids text[],
  _envio_modo text,
  _teto_mensal numeric,
  _assumir_prazo_dias integer
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_expert_id uuid;
  v_old_nome text;
  v_expert_tenant uuid;
  v_ids text[];
  v_taken text;
begin
  select array_agg(distinct btrim(v))
  into v_ids
  from unnest(coalesce(_affiliate_ids, array[]::text[])) as v
  where btrim(v) <> '';
  v_ids := coalesce(v_ids, array[]::text[]);

  if _expert_id is null then
    insert into public.experts (tenant_id, nome, tipo, envio_modo, teto_mensal, assumir_prazo_dias)
    values (_tenant, _nome, _tipo, _envio_modo, _teto_mensal, _assumir_prazo_dias)
    returning id into v_expert_id;
    v_old_nome := _nome;
  else
    select nome, tenant_id
    into v_old_nome, v_expert_tenant
    from public.experts
    where id = _expert_id
    for update;

    if v_expert_tenant is null or v_expert_tenant <> _tenant then
      raise exception 'expert_not_found';
    end if;

    update public.experts
    set nome = _nome,
        tipo = _tipo,
        envio_modo = _envio_modo,
        teto_mensal = _teto_mensal,
        assumir_prazo_dias = _assumir_prazo_dias,
        updated_at = now()
    where id = _expert_id;

    v_expert_id := _expert_id;
  end if;

  select affiliate_id
  into v_taken
  from public.expert_affiliates
  where tenant_id = _tenant
    and expert_id <> v_expert_id
    and affiliate_id = any(v_ids)
  limit 1;

  if v_taken is not null then
    raise exception 'affiliate_taken:%', v_taken;
  end if;

  delete from public.expert_affiliates where expert_id = v_expert_id;

  if array_length(v_ids, 1) > 0 then
    insert into public.expert_affiliates (tenant_id, expert_id, affiliate_id)
    select _tenant, v_expert_id, x from unnest(v_ids) as x;
  end if;

  update public.players
  set expert = _nome
  where tenant_id = _tenant
    and affiliate_id = any(v_ids);

  update public.players
  set expert = null
  where tenant_id = _tenant
    and expert in (v_old_nome, _nome)
    and not (affiliate_id = any(v_ids));

  return v_expert_id;
end;
$$;

revoke all on function public.save_expert(uuid, uuid, text, text, text[], text, numeric, integer)
  from public, anon, authenticated;
grant execute on function public.save_expert(uuid, uuid, text, text, text[], text, numeric, integer)
  to service_role;

create or replace function public.delete_expert(_tenant uuid, _expert_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
begin
  select user_id
  into v_user_id
  from public.experts
  where id = _expert_id and tenant_id = _tenant;

  if not found then
    return;
  end if;

  if v_user_id is not null then
    raise exception 'expert_has_user';
  end if;

  update public.players p
  set expert = null
  where p.tenant_id = _tenant
    and p.affiliate_id in (
      select affiliate_id from public.expert_affiliates where expert_id = _expert_id
    );

  -- expert_affiliates rows for this expert cascade-delete with it.
  delete from public.experts where id = _expert_id and tenant_id = _tenant;
end;
$$;

revoke all on function public.delete_expert(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_expert(uuid, uuid) to service_role;

create or replace function public.tenant_unassigned_affiliate_ids(_tenant uuid, _limit integer default 20)
returns table(affiliate_id text, leads bigint)
language sql
security definer
set search_path = public, pg_temp
as $$
  select btrim(p.affiliate_id) as affiliate_id, count(*) as leads
  from public.players p
  where p.tenant_id = _tenant
    and p.affiliate_id is not null
    and btrim(p.affiliate_id) <> ''
    and btrim(p.affiliate_id) not in (
      select affiliate_id from public.expert_affiliates where tenant_id = _tenant
    )
  group by btrim(p.affiliate_id)
  order by leads desc
  limit _limit;
$$;

revoke all on function public.tenant_unassigned_affiliate_ids(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.tenant_unassigned_affiliate_ids(uuid, integer)
  to service_role;

commit;

notify pgrst, 'reload schema';
