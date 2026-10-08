-- Compatibilidade com a versão já publicada: ela só desliga a frequência
-- quando existe uma política explícita com enabled=false.
insert into public.voice_contact_policies (
  tenant_id, enabled, cooldown_hours, rolling_24h_limit
)
select id, false, 0, 100
from public.tenants
on conflict (tenant_id) do update
set enabled = false,
    cooldown_hours = 0,
    rolling_24h_limit = 100,
    updated_at = now();

update public.call_queue
set scheduled_at = now(),
    provider_status = null
where status = 'audio_ready'
  and provider_status in ('rolling_24h_limit', 'cooldown');
