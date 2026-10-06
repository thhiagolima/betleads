-- Expand the Sorte Alta Short.io pilot to email while keeping WhatsApp disabled.
update public.shortio_settings
set enabled = true,
    enabled_channels = array['sms', 'email']::text[],
    updated_at = now()
where tenant_id in (
  select id
  from public.tenants
  where lower(nome) = 'sorte alta'
);
