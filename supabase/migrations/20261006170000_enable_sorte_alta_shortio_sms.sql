alter table public.shortio_settings
  add column if not exists enabled_channels text[] not null default '{}'::text[];

alter table public.shortio_settings
  drop constraint if exists shortio_settings_enabled_channels_check;
alter table public.shortio_settings
  add constraint shortio_settings_enabled_channels_check
  check (enabled_channels <@ array['sms','whatsapp','email']::text[]);

-- Pilot: Sorte Alta, SMS only. No destination allowlist is set yet so existing
-- destination URLs remain compatible during the controlled rollout.
insert into public.shortio_settings (
  tenant_id, enabled, domain, attribution_mode, fallback_mode, enabled_channels, updated_at
)
select id, true, 'bmkt.click', 'individual', 'block', array['sms']::text[], now()
from public.tenants
where lower(nome) = 'sorte alta'
on conflict (tenant_id) do update set
  enabled = true,
  domain = excluded.domain,
  attribution_mode = excluded.attribution_mode,
  fallback_mode = excluded.fallback_mode,
  enabled_channels = excluded.enabled_channels,
  updated_at = now();
