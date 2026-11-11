-- Contas extras de envio por casa: a casa escolhe, na campanha de SMS, por
-- qual conta enviar (a padrão da casa ou uma das contas que o super admin
-- vinculou a ela). Base: docs/superpowers/specs/
-- 2026-11-05-contas-padrao-canais-por-casa-design.md
--
-- O QUE ESTA MIGRAÇÃO CRIA (aditiva)
--   * public.tenant_channel_account_options: (casa, canal, conta) -> nome
--     que a casa vê (display_name, ex.: "Rota principal"). São opções
--     ADICIONAIS à padrão da casa (override em tenant_channel_providers ou
--     a padrão da plataforma), que continua sendo a opção "Padrão da casa".
--     O nome é único por casa/canal (sem diferenciar maiúsculas). O CHECK de
--     canal aceita os 4 canais, mas o app só usa 'sms' por ora.
--     Trigger próprio (tenant_channel_account_options_check): a conta
--     precisa atender o canal — mesma regra de
--     tenant_channel_providers_check_channel, sem o `NEW.updated_at` (esta
--     tabela não tem updated_at). Status ativo é conferido pelo app ao
--     vincular e na hora do envio (desativar uma conta não apaga opções).
--     provider_account_id sem ON DELETE: o app bloqueia excluir uma conta
--     que ainda é opção de alguma casa.
--     Só service_role acessa (RLS ligada sem políticas, igual às tabelas de
--     provider_accounts); a casa lê as opções por ação de servidor, que
--     nunca expõe o label interno nem o fornecedor.
--   * public.sms_campaigns.provider_account_id uuid NULL (sem FK, igual aos
--     logs): conta escolhida na campanha. NULL = padrão da casa no momento
--     do envio (comportamento de hoje). O worker confere, a cada lote, se a
--     conta ainda é opção da casa; se não for, a campanha é pausada.
--
-- COMPATIBILIDADE / ORDEM DE DEPLOY
--   * Aplicar ANTES do app novo: o app passa a ler a tabela nova no snapshot
--     de contas e a gravar/ler sms_campaigns.provider_account_id.
--   * O app antigo ignora a tabela e a coluna nova (NULL em todas as
--     campanhas existentes = padrão da casa, o que ele já faz).
--   * claim_due_sms_campaigns devolve SETOF public.sms_campaigns: a coluna
--     nova chega ao worker sem mudar a função.
--
-- ROLLBACK
--   ALTER TABLE public.sms_campaigns DROP COLUMN IF EXISTS provider_account_id;
--   DROP TABLE public.tenant_channel_account_options;
--   DROP FUNCTION public.tenant_channel_account_options_check();

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.tenant_channel_account_options (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('sms', 'email', 'voice', 'webpush')),
  provider_account_id uuid NOT NULL REFERENCES public.provider_accounts(id),
  display_name text NOT NULL CHECK (
    length(btrim(display_name)) > 0 AND length(display_name) <= 60
  ),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel, provider_account_id)
);

COMMENT ON TABLE public.tenant_channel_account_options IS
  'Contas extras que a casa pode escolher por canal (hoje só SMS, na campanha), além da padrão da casa. display_name é o que a casa vê; nunca expor label/fornecedor à casa.';

CREATE UNIQUE INDEX IF NOT EXISTS tenant_channel_account_options_name_key
  ON public.tenant_channel_account_options (tenant_id, channel, lower(display_name));

-- Índice para "quais casas têm esta conta como opção" (excluir/desativar conta).
CREATE INDEX IF NOT EXISTS tenant_channel_account_options_account_idx
  ON public.tenant_channel_account_options (provider_account_id);

-- A conta vinculada precisa atender o canal (mesma regra de
-- tenant_channel_providers_check_channel; função própria porque aquela
-- grava NEW.updated_at, coluna que esta tabela não tem).
CREATE OR REPLACE FUNCTION public.tenant_channel_account_options_check()
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
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenant_channel_account_options_check ON public.tenant_channel_account_options;
CREATE TRIGGER tenant_channel_account_options_check
  BEFORE INSERT OR UPDATE ON public.tenant_channel_account_options
  FOR EACH ROW EXECUTE FUNCTION public.tenant_channel_account_options_check();

ALTER TABLE public.tenant_channel_account_options ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tenant_channel_account_options FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenant_channel_account_options TO service_role;
REVOKE ALL ON FUNCTION public.tenant_channel_account_options_check() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.sms_campaigns ADD COLUMN IF NOT EXISTS provider_account_id uuid;

COMMENT ON COLUMN public.sms_campaigns.provider_account_id IS
  'Conta de envio escolhida na campanha (uma opção de tenant_channel_account_options da casa). NULL = padrão da casa no momento do envio.';

RESET lock_timeout;

NOTIFY pgrst, 'reload schema';
