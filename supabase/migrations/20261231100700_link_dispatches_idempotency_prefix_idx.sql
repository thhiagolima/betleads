-- Callback de entrega de SMS (src/routes/api/public/sms-webhook.ts) atualiza
-- link_dispatches com `idempotency_key LIKE '<chave>:%'`. Com collation
-- en_US.UTF-8, o índice único (tenant_id, idempotency_key) não serve para
-- LIKE por prefixo: cada callback lia a tabela inteira (~1,2 mi linhas,
-- 0,5–1 s). Desde 2026-11-08 chegam até ~4 mil callbacks por minuto, o que
-- deixou a CPU do banco em 100% e a API com 15–45 s de resposta.
-- text_pattern_ops atende LIKE 'prefixo%'. CONCURRENTLY: não trava escrita
-- (rodar fora de transação).

create index concurrently if not exists link_dispatches_idempotency_key_prefix_idx
  on public.link_dispatches (idempotency_key text_pattern_ops);
