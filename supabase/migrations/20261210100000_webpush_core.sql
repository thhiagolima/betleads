-- Web push (OneSignal) — Task 1: esquema base.
-- Escopo: .superpowers/sdd/2026-11-05-web-push-onesignal/
--
-- O QUE ESTA MIGRAÇÃO CRIA (aditiva)
--   * tenant_webpush_settings: configuração de prompt por casa (1:1 tenants).
--   * tenant_webpush_apps: apps OneSignal cadastrados por casa/origem.
--   * push_subscriptions: inscrições de navegador, ligadas (ou não) a um
--     jogador; click_key é a tag `blk` enviada à OneSignal.
--   * webpush_campaigns / webpush_send_logs: campanhas e log de envio, no
--     mesmo desenho de sms_campaigns / sms_send_logs.
--   * claim_due_webpush_campaigns, webpush_campaign_batch,
--     webpush_app_sent_last_15m, webpush_app_active_count: RPCs usadas pelos
--     workers (tasks seguintes), security definer, só service_role.
--   * link_dispatches.channel passa a aceitar 'webpush'.
--   * seed em channel_rate_limits para provider 'onesignal'/channel 'webpush'.
--   * cron betleads-dispatch-webpush (padrão de
--     20261003143000_enable_validated_automation_crons.sql), minuto a minuto.
--
-- Credenciais: tenant_webpush_apps.api_key_encrypted só guarda o texto
-- cifrado por encryptProviderCredentials (src/lib/secret-box.server.ts);
-- nunca é lido por anon/authenticated.
--
-- Todas as tabelas novas: RLS ligada, sem policy — só service_role (que
-- ignora RLS) lê/escreve; funções do servidor usam supabaseAdmin.
--
-- ROLLBACK (manual, aditivo):
--   select cron.unschedule('betleads-dispatch-webpush');
--   drop function public.webpush_app_active_count(uuid);
--   drop function public.webpush_app_sent_last_15m(uuid);
--   drop function public.webpush_campaign_batch(uuid, uuid, integer);
--   drop function public.claim_due_webpush_campaigns(integer);
--   drop table public.webpush_send_logs;
--   drop table public.webpush_campaigns;
--   drop table public.push_subscriptions;
--   drop table public.tenant_webpush_apps;
--   drop table public.tenant_webpush_settings;
--   alter table public.link_dispatches drop constraint link_dispatches_channel_check;
--   alter table public.link_dispatches add constraint link_dispatches_channel_check
--     check (channel in ('sms', 'whatsapp', 'email'));
--   delete from public.channel_rate_limits where provider = 'onesignal';

SET lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Configuração de prompt por casa
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_webpush_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  public_token text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  prompt_text text NOT NULL DEFAULT 'Quer receber promoções e avisos da casa?',
  accept_label text NOT NULL DEFAULT 'Permitir',
  cancel_label text NOT NULL DEFAULT 'Agora não',
  icon_url text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tenant_webpush_settings IS
  'Textos pt-BR e token público do prompt de push por casa. public_token identifica a casa no loader público (sem expor tenant_id).';

-- ---------------------------------------------------------------------------
-- 2. Apps OneSignal por casa/origem
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_webpush_apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  origin text NOT NULL,
  onesignal_app_id text NOT NULL UNIQUE,
  api_key_encrypted text NOT NULL,
  created_via text NOT NULL CHECK (created_via IN ('api', 'manual')),
  status text NOT NULL DEFAULT 'instalando'
    CHECK (status IN ('instalando', 'ativo', 'legado', 'desativado')),
  worker_verified_at timestamptz,
  script_seen_at timestamptz,
  player_linked_at timestamptz,
  test_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, origin)
);

COMMENT ON TABLE public.tenant_webpush_apps IS
  'Um app OneSignal por (casa, origem). api_key_encrypted só cifrada (encryptProviderCredentials); nunca volta ao navegador. status legado = app antigo, ainda recebe envios.';

-- ---------------------------------------------------------------------------
-- 3. Inscrições (push_subscriptions)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES public.tenant_webpush_apps(id) ON DELETE CASCADE,
  subscription_id text NOT NULL,
  player_id uuid REFERENCES public.players(id) ON DELETE CASCADE,
  click_key text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  status text NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa', 'inativa')),
  user_agent text,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  linked_at timestamptz,
  UNIQUE (app_id, subscription_id)
);

COMMENT ON TABLE public.push_subscriptions IS
  'Inscrições de navegador na OneSignal. click_key é a tag `blk` enviada na inscrição; o clique usa ela para atribuir sem precisar de player_id. player_id null = anônima.';

CREATE INDEX IF NOT EXISTS push_subscriptions_tenant_status_idx
  ON public.push_subscriptions (tenant_id, status, id);

CREATE INDEX IF NOT EXISTS push_subscriptions_tenant_player_idx
  ON public.push_subscriptions (tenant_id, player_id)
  WHERE player_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Campanhas e log de envio
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.webpush_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  url text NOT NULL,
  image_url text,
  audience_kind text NOT NULL CHECK (audience_kind IN ('todos', 'filtro')),
  audience_criteria jsonb,
  target_player_ids uuid[],
  status text NOT NULL DEFAULT 'agendada'
    CHECK (status IN ('agendada', 'enviando', 'enviado', 'falhou', 'cancelada', 'pausada')),
  scheduled_at timestamptz NOT NULL,
  locked_at timestamptz,
  locked_by uuid,
  sent_cursor uuid,
  target_count integer NOT NULL DEFAULT 0,
  sent_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  last_error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.webpush_campaigns IS
  'Campanhas de web push, no mesmo desenho de sms_campaigns. audience_kind=filtro usa target_player_ids; sent_cursor pagina webpush_campaign_batch.';

CREATE TABLE IF NOT EXISTS public.webpush_send_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES public.webpush_campaigns(id) ON DELETE CASCADE,
  subscription_row_id uuid NOT NULL REFERENCES public.push_subscriptions(id) ON DELETE CASCADE,
  player_id uuid,
  app_id uuid,
  onesignal_notification_id text,
  status text NOT NULL CHECK (status IN ('enviado', 'recusado')),
  billing_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, subscription_row_id)
);

COMMENT ON TABLE public.webpush_send_logs IS
  'Um log por (campanha, inscrição): garante que a inscrição não é reenviada se a claim correr de novo (idempotência de envio).';

CREATE INDEX IF NOT EXISTS webpush_send_logs_app_created_idx
  ON public.webpush_send_logs (app_id, created_at);

-- ---------------------------------------------------------------------------
-- 5. RPCs — security definer, só service_role
-- ---------------------------------------------------------------------------
-- Mesmo contrato de claim_due_sms_campaigns
-- (20261018110000_demo_tenant_skip_workers.sql:155): agendada vencida ou
-- enviando com lock preso (> 5 min), pula casa demo, FOR UPDATE SKIP LOCKED.
CREATE OR REPLACE FUNCTION public.claim_due_webpush_campaigns(p_limit integer)
 RETURNS SETOF public.webpush_campaigns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lock uuid := gen_random_uuid();
BEGIN
  RETURN QUERY
  UPDATE public.webpush_campaigns c
     SET status = 'enviando',
         locked_at = now(),
         locked_by = v_lock,
         updated_at = now()
    FROM (
      SELECT wc.id FROM public.webpush_campaigns wc
       WHERE wc.scheduled_at <= now()
         AND (
           wc.status = 'agendada'
           OR (
             wc.status = 'enviando'
             AND (wc.locked_at IS NULL OR wc.locked_at < now() - interval '5 minutes')
           )
         )
         AND NOT public.is_demo_tenant(wc.tenant_id)
       ORDER BY wc.scheduled_at ASC
       LIMIT p_limit
       FOR UPDATE SKIP LOCKED
    ) picked
   WHERE c.id = picked.id
  RETURNING c.*;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.claim_due_webpush_campaigns(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_webpush_campaigns(integer) TO service_role;

-- Página de inscrições elegíveis de uma campanha: ativas, de apps
-- ativo/legado da casa da campanha, respeitando o filtro de audiência e
-- pulando quem já tem log de envio nesta campanha.
CREATE OR REPLACE FUNCTION public.webpush_campaign_batch(
  p_campaign uuid,
  p_after uuid,
  p_limit integer
)
RETURNS TABLE (
  subscription_row_id uuid,
  subscription_id text,
  player_id uuid,
  app_id uuid,
  onesignal_app_id text,
  click_key text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT s.id, s.subscription_id, s.player_id, s.app_id, a.onesignal_app_id, s.click_key
    FROM public.push_subscriptions s
    JOIN public.tenant_webpush_apps a ON a.id = s.app_id
    JOIN public.webpush_campaigns c ON c.id = p_campaign
   WHERE s.tenant_id = c.tenant_id
     AND s.status = 'ativa'
     AND a.status IN ('ativo', 'legado')
     AND s.id > coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
     AND (
       c.audience_kind <> 'filtro'
       OR s.player_id = ANY(c.target_player_ids)
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.webpush_send_logs l
        WHERE l.campaign_id = p_campaign AND l.subscription_row_id = s.id
     )
   ORDER BY s.id
   LIMIT p_limit;
$function$;

REVOKE EXECUTE ON FUNCTION public.webpush_campaign_batch(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.webpush_campaign_batch(uuid, uuid, integer) TO service_role;

-- Trava de rajada (regra global de produto): por app, (enviados nos últimos
-- 15 min + lote) <= 5 x inscrições ativas da app.
CREATE OR REPLACE FUNCTION public.webpush_app_sent_last_15m(p_app uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT count(*)::integer
    FROM public.webpush_send_logs l
   WHERE l.app_id = p_app
     AND l.status = 'enviado'
     AND l.created_at >= now() - interval '15 minutes';
$function$;

REVOKE EXECUTE ON FUNCTION public.webpush_app_sent_last_15m(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.webpush_app_sent_last_15m(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.webpush_app_active_count(p_app uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT count(*)::integer
    FROM public.push_subscriptions s
   WHERE s.app_id = p_app
     AND s.status = 'ativa';
$function$;

REVOKE EXECUTE ON FUNCTION public.webpush_app_active_count(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.webpush_app_active_count(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. link_dispatches: novo canal 'webpush' (clique rastreado via tag blk)
-- ---------------------------------------------------------------------------
ALTER TABLE public.link_dispatches
  DROP CONSTRAINT IF EXISTS link_dispatches_channel_check;
ALTER TABLE public.link_dispatches
  ADD CONSTRAINT link_dispatches_channel_check
  CHECK (channel IN ('sms', 'whatsapp', 'email', 'webpush'));

-- ---------------------------------------------------------------------------
-- 7. Rate limit (ENV-04, mesmas colunas do seed em
--    20261015110000_journey_dispatch_leases_fairness_rate_limits.sql:421-428)
-- ---------------------------------------------------------------------------
INSERT INTO public.channel_rate_limits (provider, channel, scope, per_second, burst, max_concurrency, concurrency_hold_seconds, notes)
VALUES
  ('onesignal', 'webpush', 'global',         10, 10, NULL, 120, 'Web push OneSignal: 10/s global'),
  ('onesignal', 'webpush', 'tenant_default', 5,  5,  NULL, 120, 'Web push OneSignal: 5/s por tenant')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 8. Cron do dispatcher (padrão de
--    20261003143000_enable_validated_automation_crons.sql:20); se o PGlite de
--    teste não tiver pg_cron/pg_net, isto é um no-op silencioso.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'betleads-dispatch-webpush';

  PERFORM cron.schedule('betleads-dispatch-webpush', '* * * * *', $job$
    select net.http_post(
      url := 'https://betleads.io/api/public/hooks/dispatch?channel=webpush',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
        'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'betleads_cron_secret' limit 1)),
      body := '{}'::jsonb
    );
  $job$);
EXCEPTION
  WHEN undefined_function OR invalid_schema_name OR undefined_table THEN
    NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. Privilégios: tabelas novas só para service_role; RLS ligada, sem policy.
-- ---------------------------------------------------------------------------
ALTER TABLE public.tenant_webpush_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_webpush_apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webpush_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webpush_send_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.tenant_webpush_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.tenant_webpush_apps FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.push_subscriptions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.webpush_campaigns FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.webpush_send_logs FROM PUBLIC, anon, authenticated;

GRANT ALL ON public.tenant_webpush_settings TO service_role;
GRANT ALL ON public.tenant_webpush_apps TO service_role;
GRANT ALL ON public.push_subscriptions TO service_role;
GRANT ALL ON public.webpush_campaigns TO service_role;
GRANT ALL ON public.webpush_send_logs TO service_role;

RESET lock_timeout;

NOTIFY pgrst, 'reload schema';
