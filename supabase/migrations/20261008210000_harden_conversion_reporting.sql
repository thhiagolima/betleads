begin;

alter table public.link_dispatches
  add column if not exists journey_step_id uuid references public.journey_steps(id) on delete set null,
  add column if not exists journey_step_position integer check (journey_step_position is null or journey_step_position >= 0);

create index if not exists link_dispatches_journey_step_idx
  on public.link_dispatches (tenant_id, source_id, journey_step_position)
  where source_type = 'journey';

create table if not exists public.conversion_attribution_issues (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  event_type text not null,
  event_id text not null,
  reason text not null check (reason in ('missing_token','token_without_dispatch','invalid_origin_or_player','dispatch_not_sent')),
  source_type text,
  source_id uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, event_type, event_id, reason)
);
create index if not exists conversion_attribution_issues_monitor_idx
  on public.conversion_attribution_issues (tenant_id, created_at desc, reason);
alter table public.conversion_attribution_issues enable row level security;
grant select on public.conversion_attribution_issues to authenticated;
grant all on public.conversion_attribution_issues to service_role;
create policy conversion_attribution_issues_admin_select on public.conversion_attribution_issues
  for select to authenticated using (
    public.is_super_admin() or exists (
      select 1 from public.user_roles ur where ur.user_id = auth.uid()
        and ur.tenant_id = conversion_attribution_issues.tenant_id and ur.role = 'admin'
    )
  );

alter table public.link_dispatches drop constraint if exists link_dispatches_conversion_source_uuid;
alter table public.link_dispatches add constraint link_dispatches_conversion_source_uuid
  check (source_type not in ('campaign', 'journey') or source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
  not valid;

create or replace function public.validate_conversion_dispatch_source()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.source_type = 'journey' and not exists (
    select 1 from public.journeys where id = new.source_id::uuid and tenant_id = new.tenant_id
  ) then raise exception 'journey source does not exist in tenant'; end if;
  if new.source_type = 'campaign' and not (
    exists (select 1 from public.sms_campaigns where id = new.source_id::uuid and tenant_id = new.tenant_id)
    or exists (select 1 from public.email_campaigns where id = new.source_id::uuid and tenant_id = new.tenant_id)
  ) then raise exception 'campaign source does not exist in tenant'; end if;
  return new;
end;
$$;
drop trigger if exists trg_validate_conversion_dispatch_source on public.link_dispatches;
create trigger trg_validate_conversion_dispatch_source
  before insert or update of tenant_id, source_type, source_id on public.link_dispatches
  for each row when (new.source_type in ('campaign', 'journey'))
  execute function public.validate_conversion_dispatch_source();

-- If the application already resolved an experiment, preserve that exact
-- assignment. This prevents the insert trigger from hashing another key.
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
  if new.experiment_id is not null and new.experiment_variant is not null then return new; end if;
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

commit;
