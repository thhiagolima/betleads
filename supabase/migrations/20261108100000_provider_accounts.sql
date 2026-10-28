-- Provedores por casa — Fase 1 (fundação). Escopo:
-- docs/ESCOPO_PROVEDORES_POR_CASA_2026-10-28.md
--
-- O QUE ESTA MIGRAÇÃO CRIA (aditiva)
--   * public.provider_accounts: uma linha por conta de provedor (todas da
--     BetLeads). credentials_source='env' lê as variáveis de ambiente atuais;
--     'db' guarda as credenciais cifradas (AES-GCM, chave
--     PROVIDER_CREDENTIALS_ENCRYPTION_KEY) em credentials_encrypted.
--   * public.tenant_channel_providers: (casa, canal) -> conta. Sem linha, a
--     casa usa a conta padrão da plataforma (as duas contas 'env' semeadas
--     abaixo, com ids fixos conhecidos pelo app).
--   * provider_account_id (nullable) em sms_send_logs, email_send_logs e
--     call_history: a conta que fez o envio. NULL = envio anterior a esta
--     migração, feito pela conta padrão.
--   Só service_role acessa. RLS ligada sem políticas.
--
-- COMPATIBILIDADE / ORDEM DE DEPLOY
--   * Aplicar ANTES do app novo: o app passa a gravar provider_account_id nos
--     logs de envio.
--   * O app antigo ignora as tabelas e colunas novas.
--
-- ROLLBACK
--   ALTER TABLE public.call_history DROP COLUMN provider_account_id;
--   ALTER TABLE public.email_send_logs DROP COLUMN provider_account_id;
--   ALTER TABLE public.sms_send_logs DROP COLUMN provider_account_id;
--   DROP TABLE public.tenant_channel_providers;
--   DROP TABLE public.provider_accounts;
--   DROP FUNCTION public.tenant_channel_providers_check_channel();

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.provider_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('infobip', 'short_brasil')),
  label text NOT NULL CHECK (length(btrim(label)) > 0),
  channels text[] NOT NULL CHECK (
    cardinality(channels) > 0 AND channels <@ ARRAY['sms', 'email', 'voice']::text[]
  ),
  credentials_source text NOT NULL CHECK (credentials_source IN ('env', 'db')),
  credentials_encrypted text,
  -- Parâmetros não secretos: base_url, voice_from, URLs da Short Brasil.
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_accounts_db_has_credentials CHECK (
    credentials_source = 'env' OR credentials_encrypted IS NOT NULL
  )
);

COMMENT ON TABLE public.provider_accounts IS
  'Contas de provedor (SMS/e-mail/voz) da plataforma. Credenciais só cifradas; nunca expor a anon/authenticated.';

CREATE TABLE IF NOT EXISTS public.tenant_channel_providers (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('sms', 'email', 'voice')),
  provider_account_id uuid NOT NULL REFERENCES public.provider_accounts(id),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel)
);

COMMENT ON TABLE public.tenant_channel_providers IS
  'Conta de provedor de uma casa por canal. Sem linha = conta padrão da plataforma. Sem fallback: conta indisponível pausa só a casa.';

-- A conta escolhida precisa atender o canal.
CREATE OR REPLACE FUNCTION public.tenant_channel_providers_check_channel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.provider_accounts a
    WHERE a.id = NEW.provider_account_id AND NEW.channel = ANY (a.channels)
  ) THEN
    RAISE EXCEPTION 'A conta % não atende o canal %', NEW.provider_account_id, NEW.channel;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenant_channel_providers_check_channel ON public.tenant_channel_providers;
CREATE TRIGGER tenant_channel_providers_check_channel
  BEFORE INSERT OR UPDATE ON public.tenant_channel_providers
  FOR EACH ROW EXECUTE FUNCTION public.tenant_channel_providers_check_channel();

ALTER TABLE public.provider_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_channel_providers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.provider_accounts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.tenant_channel_providers FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.provider_accounts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenant_channel_providers TO service_role;
REVOKE ALL ON FUNCTION public.tenant_channel_providers_check_channel() FROM PUBLIC, anon, authenticated;

-- Contas padrão: ids fixos (src/lib/provider-accounts.server.ts).
INSERT INTO public.provider_accounts (id, provider, label, channels, credentials_source)
VALUES
  ('00000000-0000-4000-a000-00000000a001', 'short_brasil', 'Short Brasil (padrão)', ARRAY['sms'], 'env'),
  ('00000000-0000-4000-a000-00000000a002', 'infobip', 'Infobip (padrão)', ARRAY['email', 'voice'], 'env')
ON CONFLICT (id) DO NOTHING;

-- Sem FK de propósito: as tabelas de log são grandes (validar a FK varreria
-- cada uma) e o histórico não pode depender da conta continuar existindo.
ALTER TABLE public.sms_send_logs ADD COLUMN IF NOT EXISTS provider_account_id uuid;
ALTER TABLE public.email_send_logs ADD COLUMN IF NOT EXISTS provider_account_id uuid;
ALTER TABLE public.call_history ADD COLUMN IF NOT EXISTS provider_account_id uuid;
