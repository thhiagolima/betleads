
-- ===== Enums =====
DO $$ BEGIN
  CREATE TYPE public.call_flow_block_type AS ENUM ('call', 'delay');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE public.call_flow_sms_condition AS ENUM (
    'always',
    'answered',
    'not_answered',
    'listened_gte',
    'listened_lt',
    'hangup_before',
    'voicemail',
    'busy',
    'failed',
    'no_answer'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE public.call_flow_progress_status AS ENUM ('active', 'completed', 'exited', 'paused');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ===== call_flow_blocks =====
CREATE TABLE IF NOT EXISTS public.call_flow_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL,
  order_index integer NOT NULL DEFAULT 0,
  block_type public.call_flow_block_type NOT NULL,
  -- call
  name text,
  script_id uuid,
  voice_id text,
  max_call_seconds integer NOT NULL DEFAULT 60,
  max_attempts integer NOT NULL DEFAULT 1,
  delay_after_seconds integer NOT NULL DEFAULT 0,
  -- delay
  delay_seconds integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.call_flow_blocks TO authenticated;
GRANT ALL ON public.call_flow_blocks TO service_role;
ALTER TABLE public.call_flow_blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access call_flow_blocks" ON public.call_flow_blocks
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE INDEX IF NOT EXISTS idx_call_flow_blocks_flow ON public.call_flow_blocks(flow_id, order_index);

CREATE TRIGGER trg_call_flow_blocks_updated
  BEFORE UPDATE ON public.call_flow_blocks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ===== call_flow_block_sms =====
CREATE TABLE IF NOT EXISTS public.call_flow_block_sms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id uuid NOT NULL REFERENCES public.call_flow_blocks(id) ON DELETE CASCADE,
  priority integer NOT NULL DEFAULT 0,
  condition public.call_flow_sms_condition NOT NULL,
  threshold_seconds integer,
  template text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.call_flow_block_sms TO authenticated;
GRANT ALL ON public.call_flow_block_sms TO service_role;
ALTER TABLE public.call_flow_block_sms ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access call_flow_block_sms" ON public.call_flow_block_sms
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE INDEX IF NOT EXISTS idx_call_flow_block_sms_block ON public.call_flow_block_sms(block_id, priority);

-- ===== call_flow_progress =====
CREATE TABLE IF NOT EXISTS public.call_flow_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL,
  player_id uuid,
  lead_id uuid,
  phone_e164 text,
  current_block_index integer NOT NULL DEFAULT 0,
  status public.call_flow_progress_status NOT NULL DEFAULT 'active',
  exit_reason text,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_call_result text,
  last_call_duration integer,
  last_call_at timestamptz,
  attempts_on_block integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.call_flow_progress TO authenticated;
GRANT ALL ON public.call_flow_progress TO service_role;
ALTER TABLE public.call_flow_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access call_flow_progress" ON public.call_flow_progress
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE INDEX IF NOT EXISTS idx_call_flow_progress_flow ON public.call_flow_progress(flow_id);
CREATE INDEX IF NOT EXISTS idx_call_flow_progress_player ON public.call_flow_progress(player_id);
CREATE INDEX IF NOT EXISTS idx_call_flow_progress_next_run ON public.call_flow_progress(next_run_at) WHERE status = 'active';

CREATE TRIGGER trg_call_flow_progress_updated
  BEFORE UPDATE ON public.call_flow_progress
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ===== call_flow_history =====
CREATE TABLE IF NOT EXISTS public.call_flow_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  progress_id uuid REFERENCES public.call_flow_progress(id) ON DELETE CASCADE,
  flow_id uuid NOT NULL,
  player_id uuid,
  block_index integer,
  event_type text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.call_flow_history TO authenticated;
GRANT ALL ON public.call_flow_history TO service_role;
ALTER TABLE public.call_flow_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access call_flow_history" ON public.call_flow_history
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE INDEX IF NOT EXISTS idx_call_flow_history_player ON public.call_flow_history(player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_flow_history_flow ON public.call_flow_history(flow_id, created_at DESC);

-- ===== expand default exit_conditions =====
ALTER TABLE public.call_flows
  ALTER COLUMN exit_conditions SET DEFAULT '{
    "login": true,
    "deposit": true,
    "first_deposit": true,
    "voltou_jogar": false,
    "deposit_amount_gte": null,
    "bets_count_gte": null
  }'::jsonb;
