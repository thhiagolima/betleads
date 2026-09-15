
-- whatsapp_proxies
CREATE TABLE public.whatsapp_proxies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  protocol text NOT NULL CHECK (protocol IN ('http','https','socks4','socks5')),
  host text NOT NULL,
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  username text,
  password_encrypted text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  provider text,
  notes text,
  last_tested_at timestamptz,
  last_test_ok boolean,
  last_test_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.whatsapp_proxies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins full access whatsapp_proxies"
ON public.whatsapp_proxies
FOR ALL TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER set_updated_at_whatsapp_proxies
BEFORE UPDATE ON public.whatsapp_proxies
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- vincular proxy à sessão
ALTER TABLE public.whatsapp_sessions
ADD COLUMN proxy_id uuid REFERENCES public.whatsapp_proxies(id) ON DELETE SET NULL;

CREATE INDEX idx_whatsapp_sessions_proxy_id ON public.whatsapp_sessions(proxy_id);

-- logs
CREATE TABLE public.whatsapp_proxy_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  proxy_id uuid,
  session_id uuid,
  event text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE public.whatsapp_proxy_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins full access whatsapp_proxy_logs"
ON public.whatsapp_proxy_logs
FOR ALL TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE INDEX idx_whatsapp_proxy_logs_proxy_id ON public.whatsapp_proxy_logs(proxy_id, created_at DESC);
CREATE INDEX idx_whatsapp_proxy_logs_session_id ON public.whatsapp_proxy_logs(session_id, created_at DESC);
