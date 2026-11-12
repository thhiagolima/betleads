-- Credenciais dos gateways Pix (Upper, SpacePay) e o gateway ativo no banco,
-- editáveis pelo super admin. Escopo: docs/spacepay-gateway-scope.md.
--
-- O QUE ESTA MIGRAÇÃO CRIA (aditiva)
--   * public.payment_gateway_accounts: uma linha por gateway. As credenciais
--     ficam só cifradas (AES-GCM, chave PROVIDER_CREDENTIALS_ENCRYPTION_KEY,
--     src/lib/secret-box.server.ts) em credentials_encrypted; hints guarda
--     apenas prévias mascaradas para a tela de admin. Com linha, o banco vale
--     inteiro para aquele gateway; sem linha, o app lê as variáveis de
--     ambiente de hoje (UPPER_*, SPACEPAY_*).
--   * public.payment_gateway_settings: linha única (id = true) com o gateway
--     das cobranças novas. Sem linha, vale BILLING_PIX_PROVIDER e, na falta
--     dela, 'upper'.
--   Só service_role acessa. RLS ligada sem políticas. Sem linhas semeadas:
--   tabelas vazias = comportamento atual (tudo por env).
--
-- COMPATIBILIDADE / ORDEM DE DEPLOY
--   * Aplicar ANTES do app novo (o loader lê as duas tabelas).
--   * O app antigo ignora as tabelas novas.
--
-- ROLLBACK
--   DROP TABLE public.payment_gateway_settings;
--   DROP TABLE public.payment_gateway_accounts;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.payment_gateway_accounts (
  provider text PRIMARY KEY CHECK (provider IN ('upper', 'spacepay')),
  credentials_encrypted text NOT NULL CHECK (length(btrim(credentials_encrypted)) > 0),
  -- Só prévias mascaradas (ex.: {"gatewayToken":"eyJh…9f2c"}); nunca segredo.
  hints jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(hints) = 'object'),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payment_gateway_accounts IS
  'Credenciais cifradas dos gateways Pix (upper, spacepay). Linha presente vale inteira; sem linha, variáveis de ambiente. Nunca expor a anon/authenticated.';

CREATE TABLE IF NOT EXISTS public.payment_gateway_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  active_provider text NOT NULL CHECK (active_provider IN ('upper', 'spacepay')),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payment_gateway_settings IS
  'Linha única: gateway Pix das cobranças novas. Sem linha, BILLING_PIX_PROVIDER (padrão upper).';

ALTER TABLE public.payment_gateway_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_gateway_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payment_gateway_accounts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.payment_gateway_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payment_gateway_accounts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payment_gateway_settings TO service_role;
