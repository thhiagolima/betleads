-- Voz sem limite de frequência: consentimento revogado e janela de contato
-- continuam obrigatórios no servidor; somente cooldown/volume móvel é desligado.
alter table public.voice_contact_policies
  alter column enabled set default false,
  alter column cooldown_hours set default 0,
  alter column rolling_24h_limit set default 100;

update public.voice_contact_policies
set enabled = false,
    cooldown_hours = 0,
    rolling_24h_limit = 100,
    updated_at = now();

-- Itens individuais que haviam sido adiados apenas pela frequência voltam a
-- ficar disponíveis para o worker imediatamente.
update public.call_queue
set scheduled_at = now(),
    provider_status = null
where status = 'audio_ready'
  and provider_status in ('rolling_24h_limit', 'cooldown');
