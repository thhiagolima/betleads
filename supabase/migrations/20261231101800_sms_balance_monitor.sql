-- Saldo da Short Brasil: a API não tem consulta de saldo, então a cada 15 min
-- a plataforma entra no painel (painelsms.businesscode.com.br) com o login da
-- conta padrão e lê o saldo de SMS shortcode. Com saldo em até `low_threshold`
-- SMS acende uma barra no topo para o super admin e para os usuários
-- escolhidos por ele (viewer_user_ids), mesmo que não sejam super admin.
--
-- O QUE ESTA MIGRAÇÃO CRIA (aditiva; pode ser aplicada antes do deploy)
--   * sms_balance_settings: uma linha só (id = true): limite do aviso e quem vê.
--   * sms_balance_checks: uma linha por leitura do painel (saldo ou erro).
--
-- Ambas: RLS ligada, sem policy — só service_role lê/escreve.
--
-- ROLLBACK (manual, aditivo):
--   drop table public.sms_balance_checks;
--   drop table public.sms_balance_settings;

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.sms_balance_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  low_threshold integer NOT NULL DEFAULT 1000 CHECK (low_threshold >= 0),
  viewer_user_ids uuid[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL
);

COMMENT ON TABLE public.sms_balance_settings IS
  'Aviso de saldo da Short Brasil (linha única): limite em SMS e usuários (além do super admin) que veem a barra.';

INSERT INTO public.sms_balance_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.sms_balance_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checked_at timestamptz NOT NULL DEFAULT now(),
  result text NOT NULL CHECK (result IN ('ok', 'login_failed', 'read_failed', 'error')),
  shortcode_sms integer NULL,
  error text NULL
);

COMMENT ON TABLE public.sms_balance_checks IS
  'Leituras do saldo no painel da Short Brasil. shortcode_sms = saldo lido (pode ser negativo); result <> ok = não deu para ler.';

CREATE INDEX IF NOT EXISTS sms_balance_checks_checked_at_idx
  ON public.sms_balance_checks (checked_at DESC);

ALTER TABLE public.sms_balance_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_balance_checks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.sms_balance_settings FROM anon, authenticated;
REVOKE ALL ON public.sms_balance_checks FROM anon, authenticated;

GRANT ALL ON public.sms_balance_settings TO service_role;
GRANT ALL ON public.sms_balance_checks TO service_role;

RESET lock_timeout;

NOTIFY pgrst, 'reload schema';
