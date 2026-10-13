-- P0.4: evidence of a Short.io click is enough to attribute a later
-- redeposit to the last eligible message for the same known player.
alter table public.link_dispatches
  add column if not exists shortio_first_clicked_at timestamptz,
  add column if not exists shortio_last_clicked_at timestamptz,
  add column if not exists shortio_click_count integer not null default 0
    check (shortio_click_count >= 0);

create index if not exists link_dispatches_last_click_attribution_idx
  on public.link_dispatches (tenant_id, recipient_player_id, shortio_last_clicked_at desc)
  where recipient_player_id is not null and shortio_last_clicked_at is not null;

comment on column public.link_dispatches.shortio_last_clicked_at is
  'Latest click evidenced by Short.io statistics; used for last-click redeposit attribution.';
