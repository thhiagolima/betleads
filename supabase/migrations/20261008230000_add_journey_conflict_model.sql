-- Base de dados para arbitragem entre jornadas. A execução será adicionada
-- em etapas posteriores; esta migration apenas preserva a configuração e a auditoria.

ALTER TABLE public.journeys
  ADD COLUMN IF NOT EXISTS conflict_family text,
  ADD COLUMN IF NOT EXISTS journey_priority integer NOT NULL DEFAULT 4
    CHECK (journey_priority BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS conflict_policy text NOT NULL DEFAULT 'coexist'
    CHECK (conflict_policy IN ('coexist', 'pause_lower_priority', 'exclusive'));

ALTER TABLE public.journey_enrollments
  ADD COLUMN IF NOT EXISTS priority_paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS priority_pause_reason text,
  ADD COLUMN IF NOT EXISTS priority_paused_by_journey_id uuid
    REFERENCES public.journeys(id) ON DELETE SET NULL;

ALTER TYPE public.journey_enrollment_status
  ADD VALUE IF NOT EXISTS 'paused_by_priority';

CREATE INDEX IF NOT EXISTS journey_enrollments_priority_pause_idx
  ON public.journey_enrollments (tenant_id, journey_id, priority_paused_at DESC)
  WHERE priority_paused_at IS NOT NULL;

COMMENT ON COLUMN public.journeys.conflict_family IS
  'Família de arbitragem. Jornadas da mesma família podem ser exclusivas, como progressao_niveis.';
COMMENT ON COLUMN public.journeys.journey_priority IS
  'Prioridade de entrega: 1 é a mais alta. Usada quando jornadas concorrentes disputam o mesmo contato.';
COMMENT ON COLUMN public.journeys.conflict_policy IS
  'coexist, pause_lower_priority ou exclusive.';
COMMENT ON COLUMN public.journey_enrollments.priority_paused_by_journey_id IS
  'Jornada vencedora que causou a pausa desta matrícula.';
