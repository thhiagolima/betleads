-- Sonda da rota SMS (Short Brasil): a cada 30 min a plataforma manda um SMS de
-- controle, com texto variado e código único, para os números escolhidos pelo
-- super admin. Serve para saber se a conta tem saldo (o provedor recusa com
-- "saldo insuficiente") e se a rota está entregando (callback CONFIRMADO).
--
-- O QUE ESTA MIGRAÇÃO CRIA (aditiva; pode ser aplicada antes do deploy)
--   * sms_route_probe_settings: uma linha só (id = true): ligado/desligado e
--     a lista de números.
--   * sms_route_probes: um registro por SMS de controle enviado, com o
--     resultado no provedor e o status de entrega vindo do callback.
--
-- Ambas: RLS ligada, sem policy — só service_role lê/escreve.
--
-- ROLLBACK (manual, aditivo):
--   drop table public.sms_route_probes;
--   drop table public.sms_route_probe_settings;

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.sms_route_probe_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT false,
  phones text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL
);

COMMENT ON TABLE public.sms_route_probe_settings IS
  'Configuração da sonda da rota SMS (linha única): ligada/desligada e números que recebem o SMS de controle a cada 30 min.';

INSERT INTO public.sms_route_probe_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.sms_route_probes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id uuid NOT NULL,
  probe_code text NOT NULL UNIQUE,
  phone text NOT NULL,
  message text NOT NULL,
  provider_account_id text NULL,
  idempotency_key text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  result text NOT NULL CHECK (result IN ('accepted', 'no_balance', 'auth_error', 'error')),
  http_status integer NULL,
  error text NULL,
  provider_message_id text NULL,
  provider_response jsonb NULL,
  delivery_status text NULL,
  delivered_at timestamptz NULL,
  last_callback jsonb NULL,
  callback_at timestamptz NULL
);

COMMENT ON TABLE public.sms_route_probes IS
  'SMS de controle da sonda da rota (um por número por rodada). result = resposta do provedor no envio; delivery_status = callback da Short Brasil.';

CREATE INDEX IF NOT EXISTS sms_route_probes_sent_at_idx
  ON public.sms_route_probes (sent_at DESC);
CREATE INDEX IF NOT EXISTS sms_route_probes_provider_message_id_idx
  ON public.sms_route_probes (provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sms_route_probes_idempotency_key_idx
  ON public.sms_route_probes (idempotency_key);

ALTER TABLE public.sms_route_probe_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_route_probes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.sms_route_probe_settings FROM anon, authenticated;
REVOKE ALL ON public.sms_route_probes FROM anon, authenticated;

GRANT ALL ON public.sms_route_probe_settings TO service_role;
GRANT ALL ON public.sms_route_probes TO service_role;

RESET lock_timeout;

NOTIFY pgrst, 'reload schema';
