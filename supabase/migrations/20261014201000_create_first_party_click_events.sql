begin;

alter table public.link_dispatches
  add column if not exists first_party_click_count integer not null default 0
    check (first_party_click_count >= 0),
  add column if not exists first_party_first_clicked_at timestamptz,
  add column if not exists first_party_last_clicked_at timestamptz;

-- Existing legacy rows remain valid. Every new attributable dispatch must be
-- bound to a player before the provider is called.
alter table public.link_dispatches
  drop constraint if exists link_dispatches_attributable_player_required;
alter table public.link_dispatches
  add constraint link_dispatches_attributable_player_required
  check (source_type not in ('campaign', 'journey') or recipient_player_id is not null)
  not valid;

alter table public.conversion_attribution_issues
  drop constraint if exists conversion_attribution_issues_reason_check;
alter table public.conversion_attribution_issues
  add constraint conversion_attribution_issues_reason_check
  check (reason in (
    'missing_token', 'token_without_dispatch', 'invalid_origin_or_player',
    'dispatch_not_sent', 'no_confirmed_click'
  ));

create index if not exists link_dispatches_first_party_click_idx
  on public.link_dispatches (
    tenant_id, recipient_player_id, first_party_last_clicked_at desc
  )
  where recipient_player_id is not null and first_party_last_clicked_at is not null;

create table if not exists public.click_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  link_dispatch_id uuid not null references public.link_dispatches(id) on delete restrict,
  tracking_token uuid not null,
  occurred_at timestamptz not null default clock_timestamp(),
  received_at timestamptz not null default clock_timestamp(),
  request_id text,
  ip_hash text,
  user_agent_hash text,
  referer_host text,
  bot_classification text not null default 'unknown'
    check (bot_classification in ('human', 'suspected_bot', 'unknown')),
  is_human boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists click_events_dispatch_time_idx
  on public.click_events (link_dispatch_id, occurred_at desc);
create index if not exists click_events_tenant_time_idx
  on public.click_events (tenant_id, occurred_at desc);
create index if not exists click_events_attribution_idx
  on public.click_events (tenant_id, occurred_at desc, link_dispatch_id)
  where is_human;
create unique index if not exists click_events_request_id_uidx
  on public.click_events (tenant_id, request_id)
  where request_id is not null;

alter table public.click_events enable row level security;
grant select on public.click_events to authenticated;
grant all on public.click_events to service_role;

drop policy if exists click_events_tenant_select on public.click_events;
create policy click_events_tenant_select
  on public.click_events
  for select
  to authenticated
  using (public.has_tenant_access(tenant_id));

create or replace function public.apply_first_party_click_to_dispatch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_human then
    update public.link_dispatches
    set first_party_click_count = first_party_click_count + 1,
        first_party_first_clicked_at = case
          when first_party_first_clicked_at is null then new.occurred_at
          else least(first_party_first_clicked_at, new.occurred_at)
        end,
        first_party_last_clicked_at = case
          when first_party_last_clicked_at is null then new.occurred_at
          else greatest(first_party_last_clicked_at, new.occurred_at)
        end,
        landing_captured_at = case
          when landing_captured_at is null then new.occurred_at
          else least(landing_captured_at, new.occurred_at)
        end
    where id = new.link_dispatch_id
      and tenant_id = new.tenant_id
      and tracking_token = new.tracking_token;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_click_events_apply_dispatch on public.click_events;
create trigger trg_click_events_apply_dispatch
  after insert on public.click_events
  for each row execute function public.apply_first_party_click_to_dispatch();

create or replace function public.resolve_last_attributable_click(
  p_tenant_id uuid,
  p_player_id uuid,
  p_occurred_at timestamptz
)
returns table (
  click_event_id uuid,
  clicked_at timestamptz,
  link_dispatch_id uuid,
  tracking_token uuid,
  source_type text,
  source_id text,
  sent_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    click.id,
    click.occurred_at,
    dispatch.id,
    dispatch.tracking_token,
    dispatch.source_type,
    dispatch.source_id,
    dispatch.sent_at
  from public.click_events click
  join public.link_dispatches dispatch
    on dispatch.id = click.link_dispatch_id
   and dispatch.tenant_id = click.tenant_id
   and dispatch.tracking_token = click.tracking_token
  where click.tenant_id = p_tenant_id
    and dispatch.recipient_player_id = p_player_id
    and dispatch.source_type in ('campaign', 'journey')
    and dispatch.send_status = 'sent'
    and dispatch.sent_at is not null
    and click.is_human
    and click.occurred_at >= dispatch.sent_at
    and click.occurred_at <= p_occurred_at
    and click.occurred_at >= p_occurred_at - interval '14 days'
  order by click.occurred_at desc, click.id desc
  limit 1;
$$;

revoke all on function public.apply_first_party_click_to_dispatch() from public, anon, authenticated;
revoke all on function public.resolve_last_attributable_click(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.resolve_last_attributable_click(uuid, uuid, timestamptz)
  to service_role;

comment on table public.click_events is
  'First-party redirect events. Exact occurred_at is the attribution clock; Short.io snapshots remain aggregate analytics only.';
comment on constraint link_dispatches_attributable_player_required on public.link_dispatches is
  'New campaign and journey dispatches must resolve the known recipient player before sending.';

commit;
