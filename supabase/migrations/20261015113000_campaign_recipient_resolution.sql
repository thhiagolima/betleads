-- ENV-06 / ENV-07 — campaign recipient resolution.
--
-- 1. Recipients that cannot be resolved to a player no longer block an SMS
--    campaign: they are stored with a reason on the campaign row and shown in
--    the report ("Não enviados") and as a badge in the campaign list.
-- 2. Resolution is done by normalized phone (`players.telefone`, kept in E.164
--    by trigger trg_players_normalize_phone) with `telefone = ANY(...)` in
--    chunks, instead of loading up to 50k players without ORDER. The index below
--    serves that lookup.
--
-- Production sizing (read-only check, 2026-10-15): public.players ≈ 32k rows,
-- 13 MB heap; the index build takes well under a second, so a plain CREATE INDEX
-- (SHARE lock: blocks player writes only for the build) is acceptable. If the
-- table has grown by orders of magnitude when this is applied, run instead,
-- outside a transaction and before this migration:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS players_tenant_telefone_idx
--     ON public.players (tenant_id, telefone) WHERE telefone IS NOT NULL;
-- (this file then becomes a no-op for the index thanks to IF NOT EXISTS).
--
-- Rollback:
--   DROP INDEX IF EXISTS public.players_tenant_telefone_idx;
--   ALTER TABLE public.sms_campaigns
--     DROP CONSTRAINT IF EXISTS sms_campaigns_unresolved_count_check,
--     DROP CONSTRAINT IF EXISTS sms_campaigns_unresolved_recipients_array_check,
--     DROP COLUMN IF EXISTS unresolved_recipients,
--     DROP COLUMN IF EXISTS unresolved_count;
-- The application tolerates the columns being absent (best-effort writes and a
-- fallback select), so rollback does not require a code rollback.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Constant defaults: metadata-only change on PostgreSQL 11+ (no table rewrite).
ALTER TABLE public.sms_campaigns
  ADD COLUMN IF NOT EXISTS unresolved_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unresolved_recipients jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sms_campaigns_unresolved_count_check'
      AND conrelid = 'public.sms_campaigns'::regclass
  ) THEN
    ALTER TABLE public.sms_campaigns
      ADD CONSTRAINT sms_campaigns_unresolved_count_check CHECK (unresolved_count >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sms_campaigns_unresolved_recipients_array_check'
      AND conrelid = 'public.sms_campaigns'::regclass
  ) THEN
    ALTER TABLE public.sms_campaigns
      ADD CONSTRAINT sms_campaigns_unresolved_recipients_array_check
      CHECK (jsonb_typeof(unresolved_recipients) = 'array');
  END IF;
END
$$;

COMMENT ON COLUMN public.sms_campaigns.unresolved_count IS
  'ENV-06: recipients not sent because they did not resolve to a player (or had no consent).';
COMMENT ON COLUMN public.sms_campaigns.unresolved_recipients IS
  'ENV-06: [{phone, reason}] with reason in sem_cadastro | telefone_invalido | sem_consentimento. Tenant-scoped by the table RLS.';

CREATE INDEX IF NOT EXISTS players_tenant_telefone_idx
  ON public.players (tenant_id, telefone)
  WHERE telefone IS NOT NULL;

RESET statement_timeout;
RESET lock_timeout;
