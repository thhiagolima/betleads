-- Jornadas multicanal: nova fundação isolada dos fluxos legados de SMS,
-- e-mail e voz. Nenhum dispatcher passa a usar estas tabelas nesta migration.

DO $$ BEGIN
  CREATE TYPE public.journey_status AS ENUM ('draft', 'active', 'paused', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.journey_step_type AS ENUM (
    'wait', 'sms', 'email', 'voice', 'condition', 'split', 'update_player', 'end'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.journey_enrollment_status AS ENUM (
    'active', 'waiting', 'paused', 'completed', 'exited', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.journey_execution_status AS ENUM (
    'pending', 'claimed', 'sent', 'delivered', 'skipped', 'retrying', 'failed', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.journeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
  description text,
  status public.journey_status NOT NULL DEFAULT 'draft',
  trigger_type text NOT NULL DEFAULT 'manual',
  trigger_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  entry_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  exit_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  daily_limit integer NOT NULL DEFAULT 1000 CHECK (daily_limit BETWEEN 1 AND 100000),
  cooldown_hours integer NOT NULL DEFAULT 72 CHECK (cooldown_hours BETWEEN 0 AND 720),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  published_version integer,
  activated_at timestamptz,
  paused_at timestamptz,
  archived_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS public.journey_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  journey_id uuid NOT NULL REFERENCES public.journeys(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  step_type public.journey_step_type NOT NULL,
  label text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (journey_id, position)
);

CREATE TABLE IF NOT EXISTS public.journey_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  journey_id uuid NOT NULL REFERENCES public.journeys(id) ON DELETE CASCADE,
  journey_version integer NOT NULL CHECK (journey_version > 0),
  player_id uuid REFERENCES public.players(id) ON DELETE SET NULL,
  entry_key text NOT NULL DEFAULT 'default' CHECK (char_length(entry_key) <= 160),
  status public.journey_enrollment_status NOT NULL DEFAULT 'active',
  current_position integer NOT NULL DEFAULT 0 CHECK (current_position >= 0),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  entered_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  exited_at timestamptz,
  exit_reason text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claimed_at timestamptz,
  claimed_by text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (journey_id, player_id, entry_key)
);

CREATE TABLE IF NOT EXISTS public.journey_step_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  journey_id uuid NOT NULL REFERENCES public.journeys(id) ON DELETE CASCADE,
  enrollment_id uuid NOT NULL REFERENCES public.journey_enrollments(id) ON DELETE CASCADE,
  step_id uuid REFERENCES public.journey_steps(id) ON DELETE SET NULL,
  step_position integer NOT NULL CHECK (step_position >= 0),
  channel text,
  status public.journey_execution_status NOT NULL DEFAULT 'pending',
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  idempotency_key uuid NOT NULL DEFAULT gen_random_uuid(),
  provider text,
  provider_message_id text,
  provider_response jsonb,
  error text,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  executed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enrollment_id, step_position, attempt),
  UNIQUE (idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.journey_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  journey_id uuid NOT NULL REFERENCES public.journeys(id) ON DELETE CASCADE,
  enrollment_id uuid REFERENCES public.journey_enrollments(id) ON DELETE SET NULL,
  execution_id uuid REFERENCES public.journey_step_executions(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (char_length(event_type) <= 100),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS journeys_tenant_status_idx
  ON public.journeys(tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS journey_steps_journey_position_idx
  ON public.journey_steps(journey_id, position);
CREATE INDEX IF NOT EXISTS journey_enrollments_ready_idx
  ON public.journey_enrollments(status, next_run_at)
  WHERE status IN ('active', 'waiting');
CREATE INDEX IF NOT EXISTS journey_enrollments_tenant_journey_idx
  ON public.journey_enrollments(tenant_id, journey_id, status);
CREATE INDEX IF NOT EXISTS journey_step_executions_provider_idx
  ON public.journey_step_executions(provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS journey_events_enrollment_created_idx
  ON public.journey_events(enrollment_id, created_at DESC);

CREATE TRIGGER trg_journeys_updated_at BEFORE UPDATE ON public.journeys
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_journey_steps_updated_at BEFORE UPDATE ON public.journey_steps
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_journey_enrollments_updated_at BEFORE UPDATE ON public.journey_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_journey_step_executions_updated_at BEFORE UPDATE ON public.journey_step_executions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.journeys, public.journey_steps,
  public.journey_enrollments, public.journey_step_executions, public.journey_events TO authenticated;
GRANT ALL ON public.journeys, public.journey_steps, public.journey_enrollments,
  public.journey_step_executions, public.journey_events TO service_role;

ALTER TABLE public.journeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_step_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY journeys_tenant_isolation ON public.journeys FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin())
  WITH CHECK (tenant_id = public.current_tenant_id() OR public.is_super_admin());
CREATE POLICY journey_steps_tenant_isolation ON public.journey_steps FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin())
  WITH CHECK (tenant_id = public.current_tenant_id() OR public.is_super_admin());
CREATE POLICY journey_enrollments_tenant_isolation ON public.journey_enrollments FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin())
  WITH CHECK (tenant_id = public.current_tenant_id() OR public.is_super_admin());
CREATE POLICY journey_step_executions_tenant_isolation ON public.journey_step_executions FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin())
  WITH CHECK (tenant_id = public.current_tenant_id() OR public.is_super_admin());
CREATE POLICY journey_events_tenant_isolation ON public.journey_events FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin())
  WITH CHECK (tenant_id = public.current_tenant_id() OR public.is_super_admin());

COMMENT ON TABLE public.journeys IS 'Jornadas multicanal versionadas. Fluxos legados permanecem independentes durante a migração.';
COMMENT ON TABLE public.journey_step_executions IS 'Uma linha por tentativa de passo; a chave de idempotência evita reenvio por workers/webhooks concorrentes.';
