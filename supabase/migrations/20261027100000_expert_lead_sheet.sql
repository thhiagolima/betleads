-- Área do Expert — Fase 2, Task 1: lead-sheet tables and atomic lead claim.
--
-- * expert_links / expert_lead_contacts / expert_lead_followups /
--   expert_lead_claims / expert_message_templates are all written only by
--   service_role (server functions); RLS gives tenant members (admin/gestor)
--   read access for phase 3, same "is_super_admin() OR tenant_id =
--   current_tenant_id()" shape as the rest of the schema. Experts get no
--   policy on them at all — they read/write exclusively through server
--   functions that call requireExpertContext/loadVisibleLead first, never
--   straight from the browser.
-- * expert_lead_tenant_consistency (trigger, every table above): the row's
--   tenant_id must match experts.tenant_id for its expert_id and, when the
--   table has a player_id column, players.tenant_id for its player_id too.
--   A plain FK cannot express "these two/three columns agree across
--   tables", same reasoning as expert_affiliates_check_tenant
--   (20261025100100_expert_model.sql).
-- * claim_expert_lead / release_expert_lead: SECURITY DEFINER, service_role
--   only. claim_expert_lead does the whole "assume" business rule — only a
--   tipo='total', ativo expert may hold a lead; one row per (tenant,
--   player) in expert_lead_claims; an attempt by someone other than the
--   current holder is refused (claimed=false, holder returned) unless the
--   existing claim has expired — in one INSERT .. ON CONFLICT .. WHERE ..
--   RETURNING statement, so the guard and the write happen atomically
--   against whatever row is actually committed at the time, no separate
--   lock step needed.

begin;

-- 1. tenant-consistency trigger, shared by every table below ----------------

create or replace function public.expert_lead_check_tenant()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_expert_tenant uuid;
  v_player_tenant uuid;
  v_payload jsonb;
begin
  select tenant_id into v_expert_tenant
  from public.experts
  where id = new.expert_id;

  if v_expert_tenant is null or v_expert_tenant <> new.tenant_id then
    raise exception 'expert_lead_tenant_mismatch';
  end if;

  -- Not every table below has a player_id column (expert_message_templates
  -- doesn't); to_jsonb(new) lets one trigger function serve all of them.
  v_payload := to_jsonb(new);
  if v_payload ? 'player_id' then
    select tenant_id into v_player_tenant
    from public.players
    where id = (v_payload ->> 'player_id')::uuid;

    if v_player_tenant is null or v_player_tenant <> new.tenant_id then
      raise exception 'expert_lead_tenant_mismatch';
    end if;
  end if;

  return new;
end;
$$;

-- 2. expert_links -------------------------------------------------------------

create table if not exists public.expert_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  expert_id uuid not null references public.experts(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  link_dispatch_id uuid references public.link_dispatches(id) on delete set null,
  oferta text not null check (char_length(btrim(oferta)) between 2 and 60),
  original_url text not null,
  sent_url text not null,
  shortened boolean not null,
  created_at timestamptz not null default now()
);

create index if not exists expert_links_tenant_player_idx
  on public.expert_links (tenant_id, player_id, created_at desc);
create index if not exists expert_links_tenant_expert_idx
  on public.expert_links (tenant_id, expert_id, created_at desc);

drop trigger if exists expert_links_tenant_guard on public.expert_links;
create trigger expert_links_tenant_guard
  before insert or update on public.expert_links
  for each row execute function public.expert_lead_check_tenant();

alter table public.expert_links enable row level security;

drop policy if exists expert_links_tenant_rls on public.expert_links;
create policy expert_links_tenant_rls on public.expert_links
  as permissive for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()));

grant select on public.expert_links to authenticated;
grant all on public.expert_links to service_role;
revoke insert, update, delete, truncate on public.expert_links from anon, authenticated;

-- 3. expert_lead_contacts ------------------------------------------------------

create table if not exists public.expert_lead_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  expert_id uuid not null references public.experts(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  resultado text not null check (resultado in ('chamei', 'respondeu', 'prometeu_depositar', 'sem_interesse')),
  nota text check (char_length(nota) <= 1000),
  created_at timestamptz not null default now()
);

create index if not exists expert_lead_contacts_tenant_player_idx
  on public.expert_lead_contacts (tenant_id, player_id, created_at desc);
create index if not exists expert_lead_contacts_tenant_expert_idx
  on public.expert_lead_contacts (tenant_id, expert_id, created_at desc);

drop trigger if exists expert_lead_contacts_tenant_guard on public.expert_lead_contacts;
create trigger expert_lead_contacts_tenant_guard
  before insert or update on public.expert_lead_contacts
  for each row execute function public.expert_lead_check_tenant();

alter table public.expert_lead_contacts enable row level security;

drop policy if exists expert_lead_contacts_tenant_rls on public.expert_lead_contacts;
create policy expert_lead_contacts_tenant_rls on public.expert_lead_contacts
  as permissive for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()));

grant select on public.expert_lead_contacts to authenticated;
grant all on public.expert_lead_contacts to service_role;
revoke insert, update, delete, truncate on public.expert_lead_contacts from anon, authenticated;

-- 4. expert_lead_followups -----------------------------------------------------

create table if not exists public.expert_lead_followups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  expert_id uuid not null references public.experts(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  due_date date not null,
  nota text check (char_length(nota) <= 1000),
  done_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists expert_lead_followups_pending_idx
  on public.expert_lead_followups (tenant_id, expert_id, due_date)
  where done_at is null;

drop trigger if exists expert_lead_followups_tenant_guard on public.expert_lead_followups;
create trigger expert_lead_followups_tenant_guard
  before insert or update on public.expert_lead_followups
  for each row execute function public.expert_lead_check_tenant();

alter table public.expert_lead_followups enable row level security;

drop policy if exists expert_lead_followups_tenant_rls on public.expert_lead_followups;
create policy expert_lead_followups_tenant_rls on public.expert_lead_followups
  as permissive for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()));

grant select on public.expert_lead_followups to authenticated;
grant all on public.expert_lead_followups to service_role;
revoke insert, update, delete, truncate on public.expert_lead_followups from anon, authenticated;

-- 5. expert_lead_claims ---------------------------------------------------------
-- One row per lead (tenant, player); who currently "owns" it and until when.
-- Written only by claim_expert_lead/release_expert_lead below.

create table if not exists public.expert_lead_claims (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  expert_id uuid not null references public.experts(id) on delete cascade,
  claimed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (tenant_id, player_id)
);

drop trigger if exists expert_lead_claims_tenant_guard on public.expert_lead_claims;
create trigger expert_lead_claims_tenant_guard
  before insert or update on public.expert_lead_claims
  for each row execute function public.expert_lead_check_tenant();

alter table public.expert_lead_claims enable row level security;

drop policy if exists expert_lead_claims_tenant_rls on public.expert_lead_claims;
create policy expert_lead_claims_tenant_rls on public.expert_lead_claims
  as permissive for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()));

grant select on public.expert_lead_claims to authenticated;
grant all on public.expert_lead_claims to service_role;
revoke insert, update, delete, truncate on public.expert_lead_claims from anon, authenticated;

-- 6. expert_message_templates ---------------------------------------------------

create table if not exists public.expert_message_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  expert_id uuid not null references public.experts(id) on delete cascade,
  nome text not null check (char_length(btrim(nome)) between 2 and 60),
  conteudo text not null check (char_length(conteudo) between 1 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists expert_message_templates_expert_nome_uniq
  on public.expert_message_templates (expert_id, lower(btrim(nome)));

drop trigger if exists expert_message_templates_tenant_guard on public.expert_message_templates;
create trigger expert_message_templates_tenant_guard
  before insert or update on public.expert_message_templates
  for each row execute function public.expert_lead_check_tenant();

drop trigger if exists expert_message_templates_updated_at on public.expert_message_templates;
create trigger expert_message_templates_updated_at
  before update on public.expert_message_templates
  for each row execute function public.set_updated_at();

alter table public.expert_message_templates enable row level security;

drop policy if exists expert_message_templates_tenant_rls on public.expert_message_templates;
create policy expert_message_templates_tenant_rls on public.expert_message_templates
  as permissive for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()));

grant select on public.expert_message_templates to authenticated;
grant all on public.expert_message_templates to service_role;
revoke insert, update, delete, truncate on public.expert_message_templates from anon, authenticated;

-- 7. claim_expert_lead / release_expert_lead -------------------------------------

create or replace function public.claim_expert_lead(_tenant uuid, _expert_id uuid, _player_id uuid)
returns table(expert_id uuid, expert_nome text, expires_at timestamptz, claimed boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tipo text;
  v_ativo boolean;
  v_prazo integer;
  v_nome text;
  v_new_expires timestamptz;
  v_got_expires timestamptz;
begin
  select tipo, ativo, assumir_prazo_dias, nome
  into v_tipo, v_ativo, v_prazo, v_nome
  from public.experts
  where id = _expert_id and tenant_id = _tenant;

  if not found or v_tipo is distinct from 'total' or not coalesce(v_ativo, false) then
    raise exception 'expert_claim_not_allowed';
  end if;

  v_new_expires := now() + (v_prazo || ' days')::interval;

  -- Atomic in one statement: the WHERE guard is evaluated against whatever
  -- row is actually committed at conflict time. If it holds, the row is
  -- (re)claimed and RETURNING produces a row; if it doesn't (another
  -- expert's claim is still active), nothing is written and RETURNING
  -- produces none, which FOUND below detects.
  insert into public.expert_lead_claims (tenant_id, player_id, expert_id, claimed_at, expires_at)
  values (_tenant, _player_id, _expert_id, now(), v_new_expires)
  on conflict (tenant_id, player_id) do update
  set expert_id = excluded.expert_id,
      claimed_at = excluded.claimed_at,
      expires_at = excluded.expires_at
  where public.expert_lead_claims.expert_id = _expert_id
     or public.expert_lead_claims.expires_at <= now()
  returning public.expert_lead_claims.expires_at
  into v_got_expires;

  if found then
    return query select _expert_id, v_nome, v_got_expires, true;
    return;
  end if;

  return query
    select c.expert_id, e.nome, c.expires_at, false
    from public.expert_lead_claims c
    join public.experts e on e.id = c.expert_id
    where c.tenant_id = _tenant and c.player_id = _player_id;
end;
$$;

revoke all on function public.claim_expert_lead(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_expert_lead(uuid, uuid, uuid) to service_role;

create or replace function public.release_expert_lead(_tenant uuid, _expert_id uuid, _player_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.expert_lead_claims
  where tenant_id = _tenant and player_id = _player_id and expert_id = _expert_id;
$$;

revoke all on function public.release_expert_lead(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_expert_lead(uuid, uuid, uuid) to service_role;

commit;

notify pgrst, 'reload schema';
