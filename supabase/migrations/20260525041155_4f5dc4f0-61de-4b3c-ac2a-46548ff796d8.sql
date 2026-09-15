
-- ============================================================
-- Enums
-- ============================================================
CREATE TYPE public.call_script_status AS ENUM ('active', 'inactive', 'draft');
CREATE TYPE public.call_audio_status AS ENUM ('pending', 'generating', 'ready', 'failed');
CREATE TYPE public.call_queue_status AS ENUM (
  'pending_audio', 'audio_ready', 'queued', 'waiting_provider',
  'calling', 'completed', 'failed', 'cancelled', 'paused'
);
CREATE TYPE public.call_history_status AS ENUM (
  'pending', 'calling', 'answered', 'not_answered', 'busy',
  'failed', 'completed', 'converted', 'cancelled'
);
CREATE TYPE public.call_provider_type AS ENUM (
  'zenvia', 'totalvoice', 'twilio', 'vonage', 'plivo',
  'custom_api', 'custom_webhook'
);
CREATE TYPE public.call_provider_mode AS ENUM ('api', 'webhook');
CREATE TYPE public.call_provider_auth AS ENUM (
  'none', 'bearer_token', 'api_key_header', 'basic_auth', 'custom_headers'
);

-- ============================================================
-- call_scripts
-- ============================================================
CREATE TABLE public.call_scripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  trigger_name TEXT,
  content TEXT NOT NULL,
  status public.call_script_status NOT NULL DEFAULT 'draft',
  default_voice_id TEXT,
  provider TEXT NOT NULL DEFAULT 'elevenlabs',
  voice_settings JSONB NOT NULL DEFAULT '{
    "stability": 0.5,
    "similarity_boost": 0.75,
    "style": 0.5,
    "speed": 1.0,
    "use_speaker_boost": true
  }'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.call_scripts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access call_scripts" ON public.call_scripts
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE TRIGGER trg_call_scripts_updated_at
  BEFORE UPDATE ON public.call_scripts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- call_audio_generations
-- ============================================================
CREATE TABLE public.call_audio_generations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID,
  script_id UUID REFERENCES public.call_scripts(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'elevenlabs',
  voice_id TEXT,
  original_text TEXT NOT NULL,
  rendered_text TEXT NOT NULL,
  audio_url TEXT,
  audio_path TEXT,
  audio_hash TEXT NOT NULL,
  duration_seconds NUMERIC,
  generation_status public.call_audio_status NOT NULL DEFAULT 'pending',
  error_message TEXT,
  voice_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_call_audio_hash ON public.call_audio_generations(audio_hash);
CREATE INDEX idx_call_audio_lead ON public.call_audio_generations(lead_id);
ALTER TABLE public.call_audio_generations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access call_audio_generations" ON public.call_audio_generations
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- ============================================================
-- call_queue
-- ============================================================
CREATE TABLE public.call_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID,
  script_id UUID REFERENCES public.call_scripts(id) ON DELETE SET NULL,
  audio_generation_id UUID REFERENCES public.call_audio_generations(id) ON DELETE SET NULL,
  trigger_name TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  status public.call_queue_status NOT NULL DEFAULT 'pending_audio',
  provider_status TEXT,
  phone_number TEXT,
  audio_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_call_queue_status ON public.call_queue(status, scheduled_at);
ALTER TABLE public.call_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access call_queue" ON public.call_queue
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE TRIGGER trg_call_queue_updated_at
  BEFORE UPDATE ON public.call_queue
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- call_history
-- ============================================================
CREATE TABLE public.call_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID,
  call_queue_id UUID REFERENCES public.call_queue(id) ON DELETE SET NULL,
  script_id UUID REFERENCES public.call_scripts(id) ON DELETE SET NULL,
  audio_url TEXT,
  rendered_text TEXT,
  status public.call_history_status NOT NULL DEFAULT 'pending',
  provider TEXT,
  provider_call_id TEXT,
  duration_seconds INTEGER,
  result TEXT,
  error_message TEXT,
  recording_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_call_history_lead ON public.call_history(lead_id);
CREATE INDEX idx_call_history_created ON public.call_history(created_at DESC);
ALTER TABLE public.call_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access call_history" ON public.call_history
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- ============================================================
-- call_providers
-- ============================================================
CREATE TABLE public.call_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_name TEXT NOT NULL,
  provider_type public.call_provider_type NOT NULL,
  integration_mode public.call_provider_mode NOT NULL DEFAULT 'api',
  base_url TEXT,
  webhook_url TEXT,
  api_key TEXT,
  api_secret TEXT,
  auth_type public.call_provider_auth NOT NULL DEFAULT 'none',
  headers_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_template JSONB NOT NULL DEFAULT '{}'::jsonb,
  phone_number TEXT,
  status TEXT NOT NULL DEFAULT 'inactive',
  is_default BOOLEAN NOT NULL DEFAULT false,
  daily_limit INTEGER NOT NULL DEFAULT 500,
  hourly_limit INTEGER NOT NULL DEFAULT 60,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.call_providers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access call_providers" ON public.call_providers
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE TRIGGER trg_call_providers_updated_at
  BEFORE UPDATE ON public.call_providers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- Storage bucket para áudios gerados
-- ============================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('call-audios', 'call-audios', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Admins read call-audios"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'call-audios' AND has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins upload call-audios"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'call-audios' AND has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins update call-audios"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'call-audios' AND has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins delete call-audios"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'call-audios' AND has_role(auth.uid(), 'admin'::app_role));
