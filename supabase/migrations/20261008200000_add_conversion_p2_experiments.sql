begin;

create table if not exists public.conversion_experiments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  source_type text not null check (source_type in ('campaign', 'journey')),
  source_id uuid not null,
  name text not null check (char_length(trim(name)) between 1 and 120),
  dimension text not null check (dimension in ('template', 'cta', 'channel', 'journey_step')),
  variant_a jsonb not null default '{}'::jsonb,
  variant_b jsonb not null default '{}'::jsonb,
  split_a integer not null default 50 check (split_a = 50),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'completed')),
  started_at timestamptz,
  ended_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists conversion_experiments_one_active_source_idx
  on public.conversion_experiments (tenant_id, source_type, source_id)
  where status = 'active';

create table if not exists public.conversion_experiment_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  experiment_id uuid not null references public.conversion_experiments(id) on delete cascade,
  recipient_key text not null,
  player_id uuid references public.players(id) on delete set null,
  variant text not null check (variant in ('A', 'B')),
  assigned_at timestamptz not null default now(),
  unique (experiment_id, recipient_key)
);

alter table public.link_dispatches
  add column if not exists experiment_id uuid references public.conversion_experiments(id) on delete set null,
  add column if not exists experiment_variant text check (experiment_variant is null or experiment_variant in ('A', 'B'));

create or replace function public.assign_conversion_experiment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_experiment public.conversion_experiments%rowtype;
  v_recipient_key text;
  v_variant text;
begin
  if new.source_type not in ('campaign', 'journey') or new.source_id is null then return new; end if;
  select * into v_experiment from public.conversion_experiments
   where tenant_id = new.tenant_id and source_type = new.source_type
     and source_id::text = new.source_id and status = 'active'
   limit 1;
  if not found then return new; end if;
  v_recipient_key := coalesce(new.recipient_player_id::text, new.recipient_hash, new.tracking_token::text);
  v_variant := case when mod(abs(hashtextextended(v_experiment.id::text || ':' || v_recipient_key, 0)::numeric), 100) < 50 then 'A' else 'B' end;
  new.experiment_id := v_experiment.id;
  new.experiment_variant := v_variant;
  insert into public.conversion_experiment_assignments (tenant_id, experiment_id, recipient_key, player_id, variant)
  values (new.tenant_id, v_experiment.id, v_recipient_key, new.recipient_player_id, v_variant)
  on conflict (experiment_id, recipient_key) do nothing;
  return new;
end;
$$;

create or replace function public.resolve_conversion_experiment(
  p_tenant_id uuid,
  p_source_type text,
  p_source_id uuid,
  p_recipient_key text,
  p_player_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_experiment public.conversion_experiments%rowtype;
  v_variant text;
  v_payload jsonb;
begin
  select * into v_experiment from public.conversion_experiments
   where tenant_id = p_tenant_id and source_type = p_source_type
     and source_id = p_source_id and status = 'active' limit 1;
  if not found then return null; end if;
  v_variant := case when mod(abs(hashtextextended(v_experiment.id::text || ':' || p_recipient_key, 0)::numeric), 100) < 50 then 'A' else 'B' end;
  v_payload := case when v_variant = 'A' then v_experiment.variant_a else v_experiment.variant_b end;
  insert into public.conversion_experiment_assignments (tenant_id, experiment_id, recipient_key, player_id, variant)
  values (p_tenant_id, v_experiment.id, p_recipient_key, p_player_id, v_variant)
  on conflict (experiment_id, recipient_key) do update
    set player_id = coalesce(excluded.player_id, conversion_experiment_assignments.player_id);
  return jsonb_build_object('experiment_id', v_experiment.id, 'variant', v_variant, 'dimension', v_experiment.dimension, 'payload', v_payload);
end;
$$;

revoke all on function public.resolve_conversion_experiment(uuid,text,uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.resolve_conversion_experiment(uuid,text,uuid,text,uuid) to service_role;

drop trigger if exists trg_link_dispatch_experiment on public.link_dispatches;
create trigger trg_link_dispatch_experiment
  before insert on public.link_dispatches
  for each row execute function public.assign_conversion_experiment();

alter table public.conversion_experiments enable row level security;
alter table public.conversion_experiment_assignments enable row level security;
grant select, insert, update, delete on public.conversion_experiments to authenticated;
grant select on public.conversion_experiment_assignments to authenticated;
grant all on public.conversion_experiments, public.conversion_experiment_assignments to service_role;

create policy conversion_experiments_tenant_select on public.conversion_experiments
  for select to authenticated using (public.has_tenant_access(tenant_id));
create policy conversion_experiments_admin_insert on public.conversion_experiments
  for insert to authenticated with check (
    public.is_super_admin() or exists (
      select 1 from public.user_roles ur where ur.user_id = auth.uid()
        and ur.tenant_id = conversion_experiments.tenant_id and ur.role = 'admin'
    )
  );
create policy conversion_experiments_admin_update on public.conversion_experiments
  for update to authenticated using (
    public.is_super_admin() or exists (
      select 1 from public.user_roles ur where ur.user_id = auth.uid()
        and ur.tenant_id = conversion_experiments.tenant_id and ur.role = 'admin'
    )
  ) with check (public.has_tenant_access(tenant_id));
create policy conversion_experiments_admin_delete on public.conversion_experiments
  for delete to authenticated using (
    public.is_super_admin() or exists (
      select 1 from public.user_roles ur where ur.user_id = auth.uid()
        and ur.tenant_id = conversion_experiments.tenant_id and ur.role = 'admin'
    )
  );
create policy conversion_experiment_assignments_tenant_select on public.conversion_experiment_assignments
  for select to authenticated using (
    public.is_super_admin() or exists (
      select 1 from public.user_roles ur where ur.user_id = auth.uid()
        and ur.tenant_id = conversion_experiment_assignments.tenant_id and ur.role = 'admin'
    )
  );

create trigger trg_conversion_experiments_updated_at before update on public.conversion_experiments
  for each row execute function public.set_updated_at();

commit;
