-- Dedicated BetLeads click identity. Marketing UTMs remain free to describe
-- campaigns and creatives; bl_click_id is the deterministic machine key.
begin;

alter table public.players
  add column if not exists bl_click_id uuid,
  add column if not exists bl_click_captured_at timestamptz;

create index if not exists players_tenant_bl_click_id_idx
  on public.players (tenant_id, bl_click_id)
  where bl_click_id is not null;

alter table public.player_attributions
  add column if not exists bl_click_id uuid,
  add column if not exists bl_click_captured_at timestamptz;

create index if not exists player_attributions_tenant_bl_click_id_idx
  on public.player_attributions (tenant_id, bl_click_id)
  where bl_click_id is not null;

alter table public.link_dispatches
  add column if not exists landing_captured_at timestamptz;

alter table public.conversion_attributions
  add column if not exists window_started_at timestamptz,
  add column if not exists attribution_window_anchor text not null default 'sent_at'
    check (attribution_window_anchor in ('sent_at', 'click_captured_at'));

comment on column public.players.bl_click_id is
  'Dedicated BetLeads click token returned by the destination platform.';
comment on column public.players.bl_click_captured_at is
  'Time at which the destination platform captured bl_click_id on the landing page.';
comment on column public.link_dispatches.landing_captured_at is
  'Validated landing capture time returned by the destination platform.';
comment on column public.conversion_attributions.window_started_at is
  'Frozen start of the attribution window: landing capture when valid, otherwise dispatch sent_at.';
comment on column public.conversion_attributions.attribution_window_anchor is
  'Evidence used as the attribution-window anchor.';

commit;
