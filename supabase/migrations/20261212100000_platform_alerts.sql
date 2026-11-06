-- Console super-admin F3 — Task 1: tabelas de alertas da plataforma.
-- Escopo: .superpowers/sdd/2026-11-05-console-superadmin-f3-alertas/
--
-- O QUE ESTA MIGRAÇÃO CRIA (aditiva; só cria tabelas; pode ser aplicada antes
-- do deploy)
--   * platform_alerts: um alerta aberto por alert_key (índice único parcial
--     em resolved_at is null); guarda severidade, mensagem, casa opcional,
--     link, contagem de ocorrências e estado de reconhecimento/silêncio.
--   * platform_digest_log: um registro por dia de envio do resumo diário de
--     alertas (chave primária em digest_day).
--
-- Ambas: RLS ligada, sem policy — só service_role (que ignora RLS) lê/escreve;
-- anon/authenticated sem nenhum privilégio.
--
-- ROLLBACK (manual, aditivo):
--   drop table public.platform_digest_log;
--   drop table public.platform_alerts;

SET lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. platform_alerts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_key text NOT NULL,
  kind text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical', 'warning')),
  message text NOT NULL,
  tenant_id uuid NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  href text NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  seen_count integer NOT NULL DEFAULT 1,
  resolved_at timestamptz NULL,
  acknowledged_at timestamptz NULL,
  acknowledged_by uuid NULL,
  silenced_until timestamptz NULL,
  last_notified_at timestamptz NULL
);

COMMENT ON TABLE public.platform_alerts IS
  'Alertas operacionais da plataforma (não por casa). alert_key identifica a condição; só pode haver um registro aberto (resolved_at is null) por alert_key.';

CREATE UNIQUE INDEX platform_alerts_one_open_per_key
  ON public.platform_alerts (alert_key)
  WHERE resolved_at IS NULL;

CREATE INDEX platform_alerts_resolved_idx
  ON public.platform_alerts (resolved_at)
  WHERE resolved_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. platform_digest_log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_digest_log (
  digest_day date PRIMARY KEY,
  sent_at timestamptz NOT NULL DEFAULT now(),
  recipients integer NOT NULL DEFAULT 0
);

COMMENT ON TABLE public.platform_digest_log IS
  'Um registro por dia em que o resumo diário de alertas da plataforma foi enviado; a chave primária em digest_day evita reenvio no mesmo dia.';

-- ---------------------------------------------------------------------------
-- 3. Privilégios: RLS ligada, sem policy; só service_role.
-- ---------------------------------------------------------------------------
ALTER TABLE public.platform_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_digest_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.platform_alerts FROM anon, authenticated;
REVOKE ALL ON public.platform_digest_log FROM anon, authenticated;

GRANT ALL ON public.platform_alerts TO service_role;
GRANT ALL ON public.platform_digest_log TO service_role;

RESET lock_timeout;

NOTIFY pgrst, 'reload schema';
