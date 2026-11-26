-- Excluir jornada vira exclusão lógica.
--
-- Antes, "Excluir" fazia DELETE na jornada e falhava em prod sempre que ela
-- já tinha enviado SMS com link: link_dispatches.journey_step_id aponta para
-- journey_steps sem cascade (betgreen "Saque pago": 13.361 envios). Mesmo sem
-- links, o cascade em journey_events (2 GB, sem índice em journey_id) varria a
-- tabela inteira e estourava os 8 s do PostgREST.
--
-- Agora a jornada é arquivada (para de enviar; sweep_journey_exits encerra os
-- inscritos em até 5 min) e marcada com deleted_at, que a esconde das telas.
-- O histórico (envios, cliques, Recuperado pelo CRM, cobrança) continua.

alter table public.journeys
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid;

comment on column public.journeys.deleted_at is
  'Exclusão lógica: a jornada some das telas e fica arquivada; o histórico é mantido.';

-- O nome só precisa ser único entre as jornadas não excluídas: a casa pode
-- criar outra "Saque pago" depois de excluir a antiga.
alter table public.journeys drop constraint if exists journeys_tenant_id_name_key;
create unique index if not exists journeys_tenant_id_name_key
  on public.journeys (tenant_id, name)
  where deleted_at is null;
