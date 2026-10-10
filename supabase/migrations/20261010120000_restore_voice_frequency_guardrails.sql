-- P0.2: migrations anteriores desligaram cooldown e limite móvel para todas
-- as tenants. Antes de qualquer aceite de voz, restaura-se uma linha de base
-- defensiva. O dispatcher global continua controlado por VOICE_DISPATCH_ENABLED.
alter table public.voice_contact_policies
  alter column enabled set default true,
  alter column cooldown_hours set default 24,
  alter column rolling_24h_limit set default 1;

insert into public.voice_contact_policies (
  tenant_id, enabled, cooldown_hours, rolling_24h_limit
)
select id, true, 24, 1
from public.tenants
on conflict (tenant_id) do update
set enabled = true,
    cooldown_hours = 24,
    rolling_24h_limit = 1,
    updated_at = now();
