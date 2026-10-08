-- P2: every legacy automation can be converted once and remains traceable
-- while the old runners are retired. Converted journeys always start as drafts.
ALTER TABLE public.journeys
  ADD COLUMN IF NOT EXISTS legacy_source_type text,
  ADD COLUMN IF NOT EXISTS legacy_source_id uuid,
  ADD COLUMN IF NOT EXISTS legacy_migrated_at timestamptz;

ALTER TABLE public.journeys
  DROP CONSTRAINT IF EXISTS journeys_legacy_source_type_check;

ALTER TABLE public.journeys
  ADD CONSTRAINT journeys_legacy_source_type_check
  CHECK (legacy_source_type IS NULL OR legacy_source_type IN ('sms_flow', 'email_flow'));

CREATE UNIQUE INDEX IF NOT EXISTS journeys_legacy_source_unique
  ON public.journeys (tenant_id, legacy_source_type, legacy_source_id)
  WHERE legacy_source_type IS NOT NULL AND legacy_source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS journeys_legacy_migration_status
  ON public.journeys (tenant_id, legacy_source_type, legacy_migrated_at)
  WHERE legacy_source_type IS NOT NULL;

COMMENT ON COLUMN public.journeys.legacy_source_type IS
  'Legacy source converted into this draft: sms_flow or email_flow.';
COMMENT ON COLUMN public.journeys.legacy_source_id IS
  'Stable source identifier used to make legacy conversion idempotent.';
COMMENT ON COLUMN public.journeys.legacy_migrated_at IS
  'When the compatibility converter created this journey draft.';
