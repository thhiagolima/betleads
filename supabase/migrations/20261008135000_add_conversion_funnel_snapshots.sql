-- P0 conversion funnel: retain the exact attribution contract used by each
-- source. Existing records deliberately remain NULL and are reported as legacy.
begin;

alter table public.sms_campaigns
  add column if not exists conversion_objective text not null default 'conversion'
    check (conversion_objective in ('acquisition', 'conversion', 'reactivation')),
  add column if not exists conversion_funnel_snapshot jsonb;

alter table public.email_campaigns
  add column if not exists conversion_objective text not null default 'conversion'
    check (conversion_objective in ('acquisition', 'conversion', 'reactivation')),
  add column if not exists conversion_funnel_snapshot jsonb;

alter table public.journeys
  add column if not exists conversion_objective text not null default 'journey'
    check (conversion_objective in ('acquisition', 'conversion', 'reactivation', 'journey')),
  add column if not exists conversion_funnel_snapshot jsonb;

create table if not exists public.conversion_attributions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  source_type text not null check (source_type in ('campaign', 'journey')),
  source_id uuid not null,
  link_dispatch_id uuid not null references public.link_dispatches(id) on delete restrict,
  tracking_token uuid not null,
  player_id uuid not null references public.players(id) on delete restrict,
  event_type text not null check (event_type in ('registered', 'login', 'game', 'deposit_approved')),
  event_id text not null,
  occurred_at timestamptz not null,
  monetary_value numeric(18,2),
  is_ftd boolean not null default false,
  attribution_model text not null default 'last_tracked_click',
  attribution_window_days integer not null default 7 check (attribution_window_days between 1 and 90),
  classification text not null default 'direct' check (classification in ('direct', 'assisted')),
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, event_type, event_id, attribution_model, classification)
);

create index if not exists conversion_attributions_source_time_idx
  on public.conversion_attributions (tenant_id, source_type, source_id, occurred_at desc);
create index if not exists conversion_attributions_player_time_idx
  on public.conversion_attributions (tenant_id, player_id, occurred_at desc);

alter table public.conversion_attributions enable row level security;
grant select on public.conversion_attributions to authenticated;
grant all on public.conversion_attributions to service_role;
create policy conversion_attributions_tenant_select on public.conversion_attributions
  for select to authenticated using (public.has_tenant_access(tenant_id));

create or replace function public.prevent_conversion_funnel_snapshot_rewrite()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.conversion_funnel_snapshot is not null
     and new.conversion_funnel_snapshot is distinct from old.conversion_funnel_snapshot then
    raise exception 'O snapshot do funil de conversão é imutável.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sms_campaigns_conversion_funnel_immutable on public.sms_campaigns;
create trigger trg_sms_campaigns_conversion_funnel_immutable
  before update on public.sms_campaigns
  for each row execute function public.prevent_conversion_funnel_snapshot_rewrite();

drop trigger if exists trg_email_campaigns_conversion_funnel_immutable on public.email_campaigns;
create trigger trg_email_campaigns_conversion_funnel_immutable
  before update on public.email_campaigns
  for each row execute function public.prevent_conversion_funnel_snapshot_rewrite();

drop trigger if exists trg_journeys_conversion_funnel_immutable on public.journeys;
create trigger trg_journeys_conversion_funnel_immutable
  before update on public.journeys
  for each row execute function public.prevent_conversion_funnel_snapshot_rewrite();

create or replace function public.save_journey_draft(
  p_tenant_id uuid,
  p_journey_id uuid,
  p_actor_user_id uuid,
  p_journey jsonb,
  p_steps jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_status public.journey_status;
  v_version integer;
  v_index integer := 0;
  v_step jsonb;
  v_objective text := coalesce(p_journey->>'conversion_objective', 'journey');
begin
  if jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) = 0 then
    raise exception 'A jornada precisa ter ao menos uma etapa.';
  end if;
  if v_objective not in ('acquisition', 'conversion', 'reactivation', 'journey') then
    raise exception 'Objetivo de conversão inválido.';
  end if;

  if p_journey_id is null then
    insert into public.journeys (
      tenant_id, name, description, trigger_type, trigger_config, entry_rules,
      exit_rules, daily_limit, cooldown_hours, conversion_objective, status, created_by
    ) values (
      p_tenant_id, trim(p_journey->>'name'), nullif(trim(coalesce(p_journey->>'description', '')), ''),
      p_journey->>'trigger_type', coalesce(p_journey->'trigger_config', '{}'::jsonb),
      coalesce(p_journey->'entry_rules', '{}'::jsonb), coalesce(p_journey->'exit_rules', '{}'::jsonb),
      (p_journey->>'daily_limit')::integer, (p_journey->>'cooldown_hours')::integer,
      v_objective, 'draft', p_actor_user_id
    ) returning id into v_id;
  else
    select id, status, version into v_id, v_status, v_version
    from public.journeys where id = p_journey_id and tenant_id = p_tenant_id for update;
    if not found then raise exception 'Jornada não encontrada.'; end if;
    if v_status <> 'draft' then
      insert into public.journeys (
        tenant_id, name, description, trigger_type, trigger_config, entry_rules, exit_rules,
        daily_limit, cooldown_hours, conversion_objective, status, created_by, version, revision_of
      ) values (
        p_tenant_id, concat(trim(p_journey->>'name'), ' · revisão v', v_version + 1),
        nullif(trim(coalesce(p_journey->>'description', '')), ''), p_journey->>'trigger_type',
        coalesce(p_journey->'trigger_config', '{}'::jsonb), coalesce(p_journey->'entry_rules', '{}'::jsonb),
        coalesce(p_journey->'exit_rules', '{}'::jsonb), (p_journey->>'daily_limit')::integer,
        (p_journey->>'cooldown_hours')::integer, v_objective, 'draft', p_actor_user_id, v_version + 1, v_id
      ) returning id into v_id;
    else
      update public.journeys set
        name = trim(p_journey->>'name'), description = nullif(trim(coalesce(p_journey->>'description', '')), ''),
        trigger_type = p_journey->>'trigger_type', trigger_config = coalesce(p_journey->'trigger_config', '{}'::jsonb),
        entry_rules = coalesce(p_journey->'entry_rules', '{}'::jsonb), exit_rules = coalesce(p_journey->'exit_rules', '{}'::jsonb),
        daily_limit = (p_journey->>'daily_limit')::integer, cooldown_hours = (p_journey->>'cooldown_hours')::integer,
        conversion_objective = v_objective, version = version + 1
      where id = v_id and tenant_id = p_tenant_id;
      delete from public.journey_steps where journey_id = v_id and tenant_id = p_tenant_id;
    end if;
  end if;

  for v_step in select value from jsonb_array_elements(p_steps) loop
    insert into public.journey_steps (tenant_id, journey_id, position, step_type, label, config)
    values (p_tenant_id, v_id, v_index, (v_step->>'step_type')::public.journey_step_type,
      nullif(trim(coalesce(v_step->>'label', '')), ''), coalesce(v_step->'config', '{}'::jsonb));
    v_index := v_index + 1;
  end loop;
  insert into public.journey_events (tenant_id, journey_id, event_type, detail, actor_user_id)
  values (p_tenant_id, v_id, 'draft_saved', jsonb_build_object('version', case when p_journey_id is null then 1 else null end), p_actor_user_id);
  return v_id;
end;
$$;

commit;
