-- A dispatch is one URL position of one intended delivery. This stable key
-- makes provider retries and concurrent workers return the original record.
begin;

alter table public.link_dispatches
  add column if not exists idempotency_key text;

-- Historical rows predate a delivery key and can legitimately contain the
-- same campaign/position. Keep all of them auditable with a legacy suffix;
-- only newly written rows use the deterministic delivery key.
update public.link_dispatches
set idempotency_key = concat_ws(':', coalesce(message_log_id, source_id, 'legacy'), url_position, id::text)
where idempotency_key is null;

alter table public.link_dispatches
  alter column idempotency_key set not null;

create unique index if not exists link_dispatches_tenant_idempotency_key_idx
  on public.link_dispatches (tenant_id, idempotency_key);

-- Aggregate attribution is deliberately unavailable until it has its own
-- implementation; every dispatch remains attributable to one recipient.
alter table public.shortio_settings
  drop constraint if exists shortio_settings_attribution_mode_check;
alter table public.shortio_settings
  add constraint shortio_settings_attribution_mode_check
  check (attribution_mode = 'individual');
update public.shortio_settings
set attribution_mode = 'individual',
    enabled_channels = array_remove(enabled_channels, 'whatsapp');

commit;
