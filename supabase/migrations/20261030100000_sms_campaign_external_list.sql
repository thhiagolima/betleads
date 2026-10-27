-- SMS campaigns to an external phone list (numbers that are not players, e.g.
-- leads of another house). The numbers are never inserted into `players`: they
-- live in `sms_campaigns.recipients` (with `external: true`), in the send logs
-- and, hashed, in `link_dispatches.recipient_hash`. When one of them registers,
-- the signup webhook binds those dispatches to the new player and the regular
-- click attribution applies.
begin;

alter table public.sms_campaigns
  add column if not exists recipient_source text not null default 'players';

alter table public.sms_campaigns
  drop constraint if exists sms_campaigns_recipient_source_check;
alter table public.sms_campaigns
  add constraint sms_campaigns_recipient_source_check
  check (recipient_source in ('players', 'external_list'));

comment on column public.sms_campaigns.recipient_source is
  'players: recipients resolved to tenant players. external_list: phones that are not players (never saved as players).';

-- A campaign dispatch is attributable when bound to a player OR to an external
-- recipient hash (bound to the player on signup). Legacy rows stay valid.
alter table public.link_dispatches
  drop constraint if exists link_dispatches_attributable_player_required;
alter table public.link_dispatches
  add constraint link_dispatches_attributable_player_required
  check (
    source_type not in ('campaign', 'journey')
    or recipient_player_id is not null
    or (source_type = 'campaign' and recipient_hash is not null)
  )
  not valid;

-- Signup bind lookup: (tenant, hash) among dispatches not yet bound to a player.
create index if not exists link_dispatches_external_recipient_idx
  on public.link_dispatches (tenant_id, recipient_hash)
  where recipient_hash is not null and recipient_player_id is null;

commit;
