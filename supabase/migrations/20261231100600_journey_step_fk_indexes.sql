-- Índices nas FKs que apontam para journey_steps. Sem eles, apagar uma etapa
-- (revisão que muda a estrutura de uma jornada) varre journey_step_executions
-- e link_dispatches inteiros (~1 mi linhas cada) para cada etapa apagada.
-- Parciais: só linhas com etapa preenchida. CONCURRENTLY: não trava escrita
-- (rodar fora de transação).

create index concurrently if not exists journey_step_executions_step_id_idx
  on public.journey_step_executions (step_id) where step_id is not null;

create index concurrently if not exists link_dispatches_journey_step_id_idx
  on public.link_dispatches (journey_step_id) where journey_step_id is not null;
