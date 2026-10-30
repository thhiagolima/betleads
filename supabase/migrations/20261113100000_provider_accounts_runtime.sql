-- Provedores por casa — Fase 2 (runtime por conta). Escopo:
-- docs/ESCOPO_PROVEDORES_POR_CASA_2026-10-28.md
--
-- O QUE ESTA MIGRAÇÃO FAZ (aditiva)
--   * provider_circuit_breakers.channel passa a aceitar a chave de uma conta:
--     'sms' continua sendo o breaker da conta padrão da plataforma (a linha
--     existente, com o estado atual); 'sms:<provider_account_id>' é o breaker
--     de uma conta própria. As funções provider_breaker_* já recebem a chave
--     como texto e não mudam.
--   * tenant_domains.provider_account_id: em qual conta Infobip o domínio de
--     e-mail está cadastrado. NULL = conta padrão (todos os domínios atuais).
--
-- COMPATIBILIDADE / ORDEM DE DEPLOY
--   * Aplicar ANTES do app novo (o app grava as chaves novas e a coluna nova).
--   * O app atual só usa a chave 'sms' e ignora a coluna nova.
--
-- ROLLBACK
--   ALTER TABLE public.tenant_domains DROP COLUMN provider_account_id;
--   DELETE FROM public.provider_circuit_breakers WHERE channel LIKE '%:%';
--   ALTER TABLE public.provider_circuit_breakers
--     DROP CONSTRAINT provider_circuit_breakers_channel_check,
--     ADD CONSTRAINT provider_circuit_breakers_channel_check
--       CHECK (channel IN ('sms', 'email', 'voice'));

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.provider_circuit_breakers
  DROP CONSTRAINT IF EXISTS provider_circuit_breakers_channel_check;
ALTER TABLE public.provider_circuit_breakers
  ADD CONSTRAINT provider_circuit_breakers_channel_check CHECK (
    channel ~ '^(sms|email|voice)(:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$'
  );

COMMENT ON TABLE public.provider_circuit_breakers IS
  'Circuit breaker por conta de provedor. channel = canal (conta padrão) ou canal:provider_account_id (conta própria). Escrito só pelas funções provider_breaker_*.';

ALTER TABLE public.tenant_domains
  ADD COLUMN IF NOT EXISTS provider_account_id uuid REFERENCES public.provider_accounts(id);

COMMENT ON COLUMN public.tenant_domains.provider_account_id IS
  'Conta Infobip onde o domínio de e-mail está cadastrado. NULL = conta padrão da plataforma.';
