-- Públicos dinâmicos: a campanha agendada guarda a regra do público salvo e o
-- worker recalcula os destinatários na primeira execução (no horário do envio),
-- em vez de usar a lista congelada no momento do agendamento.
alter table public.sms_campaigns
  add column if not exists audience_criteria jsonb,
  add column if not exists audience_resolved_at timestamptz;

comment on column public.sms_campaigns.audience_criteria is
  'Regra do público salvo; quando presente, recipients é recalculado no primeiro tick do worker.';
comment on column public.sms_campaigns.audience_resolved_at is
  'Momento em que a regra do público foi materializada em recipients (uma vez).';
