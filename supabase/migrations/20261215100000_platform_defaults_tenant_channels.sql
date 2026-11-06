-- Conta padrão escolhível por canal, canais ativos por casa e aviso "Ciente"
-- de canal desabilitado. Escopo:
-- docs/superpowers/specs/2026-11-05-contas-padrao-canais-por-casa-design.md
--
-- O QUE ESTA MIGRAÇÃO CRIA (aditiva)
--   * public.platform_channel_defaults: qual conta é a padrão de cada canal
--     (sms, email, voice, webpush). Hoje a padrão é fixa no código
--     (DEFAULT_*_ACCOUNT_ID em src/lib/provider-accounts.server.ts); esta
--     tabela deixa o super admin escolher. Mesmo trigger de
--     tenant_channel_providers_check_channel (a conta precisa atender o
--     canal e estar ativa). Semeada com as contas de hoje.
--   * public.tenant_channels: (casa, canal) -> ligado/desligado. Sem linha
--     para uma casa/canal = padrão (sms/email/voice ligados, webpush
--     desligado) — vale para casas existentes e novas; por isso não é
--     semeada.
--   * public.tenant_channel_notice_acks: quem da casa já viu o aviso
--     "Ciente" de um desligamento (usuário x casa x canal x
--     disabled_at). Um desligamento novo (disabled_at novo) pede o aviso de
--     novo.
--   Só service_role acessa as três (RLS ligada sem políticas, igual às
--   tabelas de provider_accounts). A leitura pelo usuário da casa (o painel
--   precisa saber o que esconder e se o aviso "Ciente" já foi visto) é
--   responsabilidade de uma ação de servidor nesta primeira fase, não de
--   política de RLS — deixado para quem constrói a leitura (spec, seção 3).
--
-- BACKFILL
--   * tenant_domains.provider_account_id (email) e
--     tenant_webpush_apps.provider_account_id NULL hoje significam "conta
--     padrão do ambiente". Preenche com a conta env atual (a002/a003) para
--     que trocar a padrão não mude retroativamente o que essas linhas
--     antigas significam. O app antigo trata NULL e a002/a003 da mesma
--     forma (lê a padrão quando null), então o backfill não muda nada para
--     ele.
--
-- COMPATIBILIDADE / ORDEM DE DEPLOY
--   * Aplicar ANTES do app novo: o app passa a ler a padrão do canal de
--     platform_channel_defaults e os canais ligados de tenant_channels.
--   * O app antigo ignora as tabelas novas e continua usando os ids fixos
--     DEFAULT_*_ACCOUNT_ID; os backfills acima não mudam o comportamento
--     dele (NULL e a002/a003 já eram equivalentes para ele).
--
-- ROLLBACK
--   DROP TABLE public.tenant_channel_notice_acks;
--   DROP TABLE public.tenant_channels;
--   DROP TABLE public.platform_channel_defaults;
--   DROP FUNCTION public.platform_channel_defaults_check();
--   -- (o backfill de tenant_domains/tenant_webpush_apps não é desfeito:
--   -- preencher de volta para NULL reintroduziria a ambiguidade que o
--   -- backfill corrigiu.)

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.platform_channel_defaults (
  channel text PRIMARY KEY CHECK (channel IN ('sms', 'email', 'voice', 'webpush')),
  provider_account_id uuid NOT NULL REFERENCES public.provider_accounts(id),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.platform_channel_defaults IS
  'Conta padrão da plataforma por canal, escolhida pelo super admin. Casa sem conta própria no canal usa esta.';

-- A conta escolhida como padrão precisa atender o canal e estar ativa
-- (mesma regra de tenant_channel_providers_check_channel, mais o status).
CREATE OR REPLACE FUNCTION public.platform_channel_defaults_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.provider_accounts a
    WHERE a.id = NEW.provider_account_id
      AND NEW.channel = ANY (a.channels)
      AND a.status = 'active'
  ) THEN
    RAISE EXCEPTION 'A conta % não atende o canal % ou não está ativa', NEW.provider_account_id, NEW.channel;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS platform_channel_defaults_check ON public.platform_channel_defaults;
CREATE TRIGGER platform_channel_defaults_check
  BEFORE INSERT OR UPDATE ON public.platform_channel_defaults
  FOR EACH ROW EXECUTE FUNCTION public.platform_channel_defaults_check();

CREATE TABLE IF NOT EXISTS public.tenant_channels (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('sms', 'email', 'voice', 'webpush')),
  enabled boolean NOT NULL,
  disabled_at timestamptz,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel),
  CONSTRAINT tenant_channels_disabled_at_set CHECK (enabled OR disabled_at IS NOT NULL)
);

COMMENT ON TABLE public.tenant_channels IS
  'Canal ligado/desligado por casa. Sem linha = padrão (sms/email/voice ligados, webpush desligado); por isso não é semeada. disabled_at marca o desligamento mais recente (dispara o aviso "Ciente" de novo se o canal for religado e desligado outra vez).';

CREATE TABLE IF NOT EXISTS public.tenant_channel_notice_acks (
  user_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  channel text NOT NULL,
  disabled_at timestamptz NOT NULL,
  acked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id, channel, disabled_at)
);

COMMENT ON TABLE public.tenant_channel_notice_acks IS
  'Confirmação ("Ciente") de um usuário para um desligamento de canal da casa (identificado por tenant_channels.disabled_at). Um novo desligamento tem um disabled_at novo, então pede o aviso de novo.';

ALTER TABLE public.platform_channel_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_channel_notice_acks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.platform_channel_defaults FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.tenant_channels FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.tenant_channel_notice_acks FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_channel_defaults TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenant_channels TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenant_channel_notice_acks TO service_role;

REVOKE ALL ON FUNCTION public.platform_channel_defaults_check() FROM PUBLIC, anon, authenticated;

-- Seed: contas padrão de hoje (ids fixos, src/lib/provider-accounts.server.ts).
INSERT INTO public.platform_channel_defaults (channel, provider_account_id)
VALUES
  ('sms', '00000000-0000-4000-a000-00000000a001'),
  ('email', '00000000-0000-4000-a000-00000000a002'),
  ('voice', '00000000-0000-4000-a000-00000000a002'),
  ('webpush', '00000000-0000-4000-a000-00000000a003')
ON CONFLICT (channel) DO NOTHING;

-- Backfill: provider_account_id NULL em tenant_domains (email) e
-- tenant_webpush_apps hoje significa "conta padrão do ambiente". O app
-- antigo e o novo tratam NULL e a002/a003 da mesma forma (resolvem a
-- padrão), então preencher não muda o comportamento — só fixa o
-- significado antes que a padrão possa mudar.
UPDATE public.tenant_domains
SET provider_account_id = '00000000-0000-4000-a000-00000000a002'
WHERE provider_account_id IS NULL AND kind = 'email';

UPDATE public.tenant_webpush_apps
SET provider_account_id = '00000000-0000-4000-a000-00000000a003'
WHERE provider_account_id IS NULL;

-- O rótulo fixo "(padrão)" sai do nome das contas env: a padrão agora é
-- escolhida (selo na tela), não fixa no nome. Só troca onde o rótulo ainda
-- é o original, para não sobrescrever um nome que o super admin já editou.
UPDATE public.provider_accounts SET label = 'Short Brasil (ambiente)'
  WHERE id = '00000000-0000-4000-a000-00000000a001' AND label = 'Short Brasil (padrão)';
UPDATE public.provider_accounts SET label = 'Infobip (ambiente)'
  WHERE id = '00000000-0000-4000-a000-00000000a002' AND label = 'Infobip (padrão)';
UPDATE public.provider_accounts SET label = 'OneSignal (ambiente)'
  WHERE id = '00000000-0000-4000-a000-00000000a003' AND label = 'OneSignal (padrão)';

RESET lock_timeout;

NOTIFY pgrst, 'reload schema';
