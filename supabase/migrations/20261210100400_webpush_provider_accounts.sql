-- OneSignal accounts per house, same pattern as provider_accounts for
-- SMS/e-mail/voz (docs/ESCOPO_PROVEDORES_POR_CASA_2026-10-28.md,
-- supabase/migrations/20261108100000_provider_accounts.sql,
-- 20261113100000_provider_accounts_runtime.sql). Escopo:
-- .superpowers/sdd/webpush-provider-accounts/brief.md
--
-- O QUE ESTA MIGRAÇÃO FAZ (aditiva)
--   * provider_accounts.provider passa a aceitar 'onesignal';
--     provider_accounts.channels passa a aceitar 'webpush' (checks
--     recriadas com a lista completa, mesma forma de 20261108100000).
--   * tenant_channel_providers.channel passa a aceitar 'webpush' (o
--     trigger tenant_channel_providers_check_channel já valida a conta
--     pelo texto do canal; não muda).
--   * Semeia a conta OneSignal padrão da plataforma, id fixo
--     00000000-0000-4000-a000-00000000a003, credentials_source='env'
--     (lê ONESIGNAL_ORG_API_KEY/ONESIGNAL_ORG_ID em
--     src/lib/provider-accounts.server.ts), igual às contas padrão de
--     20261108100000.
--   * tenant_webpush_apps.provider_account_id (nullable): qual conta
--     OneSignal criou o app. NULL = app criado manualmente ou antes desta
--     migração (continua usando a conta padrão).
--
-- COMPATIBILIDADE / ORDEM DE DEPLOY
--   * Aplicar ANTES do app novo: o app passa a gravar provider_account_id
--     em tenant_webpush_apps na ativação via API.
--   * O app antigo ignora a coluna e a conta novas; continua lendo
--     ONESIGNAL_ORG_API_KEY/ONESIGNAL_ORG_ID do ambiente.
--   * Trocar a conta OneSignal de uma casa não move os apps já criados;
--     só as próximas ativações usam a conta nova (ver comentário em
--     src/lib/webpush/apps.server.ts, activateWebpushOrigin).
--
-- ROLLBACK
--   ALTER TABLE public.tenant_webpush_apps DROP COLUMN provider_account_id;
--   DELETE FROM public.provider_accounts WHERE id = '00000000-0000-4000-a000-00000000a003';
--   ALTER TABLE public.tenant_channel_providers DROP CONSTRAINT tenant_channel_providers_channel_check,
--     ADD CONSTRAINT tenant_channel_providers_channel_check CHECK (channel IN ('sms', 'email', 'voice'));
--   ALTER TABLE public.provider_accounts DROP CONSTRAINT provider_accounts_channels_check,
--     ADD CONSTRAINT provider_accounts_channels_check CHECK (
--       cardinality(channels) > 0 AND channels <@ ARRAY['sms', 'email', 'voice']::text[]
--     );
--   ALTER TABLE public.provider_accounts DROP CONSTRAINT provider_accounts_provider_check,
--     ADD CONSTRAINT provider_accounts_provider_check CHECK (provider IN ('infobip', 'short_brasil'));

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.provider_accounts
  DROP CONSTRAINT IF EXISTS provider_accounts_provider_check;
ALTER TABLE public.provider_accounts
  ADD CONSTRAINT provider_accounts_provider_check CHECK (
    provider IN ('infobip', 'short_brasil', 'onesignal')
  );

ALTER TABLE public.provider_accounts
  DROP CONSTRAINT IF EXISTS provider_accounts_channels_check;
ALTER TABLE public.provider_accounts
  ADD CONSTRAINT provider_accounts_channels_check CHECK (
    cardinality(channels) > 0 AND channels <@ ARRAY['sms', 'email', 'voice', 'webpush']::text[]
  );

ALTER TABLE public.tenant_channel_providers
  DROP CONSTRAINT IF EXISTS tenant_channel_providers_channel_check;
ALTER TABLE public.tenant_channel_providers
  ADD CONSTRAINT tenant_channel_providers_channel_check CHECK (
    channel IN ('sms', 'email', 'voice', 'webpush')
  );

-- Conta padrão: id fixo (src/lib/provider-accounts.server.ts,
-- DEFAULT_ONESIGNAL_ACCOUNT_ID).
INSERT INTO public.provider_accounts (id, provider, label, channels, credentials_source)
VALUES
  ('00000000-0000-4000-a000-00000000a003', 'onesignal', 'OneSignal (padrão)', ARRAY['webpush'], 'env')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.tenant_webpush_apps
  ADD COLUMN IF NOT EXISTS provider_account_id uuid REFERENCES public.provider_accounts(id);

COMMENT ON COLUMN public.tenant_webpush_apps.provider_account_id IS
  'Conta OneSignal que criou este app (via API). NULL = app manual ou criado antes desta coluna; usa a conta padrão da plataforma.';

RESET lock_timeout;

NOTIFY pgrst, 'reload schema';
