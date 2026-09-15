
-- 1) Colunas de cashback no player
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS last_cashback_paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_cashback_amount numeric,
  ADD COLUMN IF NOT EXISTS total_cashback_paid numeric NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_players_last_cashback_paid_at
  ON public.players (tenant_id, last_cashback_paid_at DESC)
  WHERE last_cashback_paid_at IS NOT NULL;

-- 2) Tabela de pagamentos de cashback
CREATE TABLE IF NOT EXISTS public.cashback_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  player_id uuid REFERENCES public.players(id) ON DELETE SET NULL,
  platform_user_id text,
  nome text,
  telefone text,
  email text,
  cashback_amount numeric NOT NULL,
  currency text NOT NULL DEFAULT 'BRL',
  paid_at timestamptz NOT NULL DEFAULT now(),
  campaign text,
  status text NOT NULL DEFAULT 'paid',
  event_id text,
  raw_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.cashback_payments TO authenticated;
GRANT ALL ON public.cashback_payments TO service_role;

ALTER TABLE public.cashback_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant members read cashback_payments"
  ON public.cashback_payments FOR SELECT
  TO authenticated
  USING (public.has_tenant_access(tenant_id));

-- Dedupe: mesmo event_id por tenant
CREATE UNIQUE INDEX IF NOT EXISTS uq_cashback_event_id
  ON public.cashback_payments (tenant_id, event_id)
  WHERE event_id IS NOT NULL;

-- Dedupe heurístico: mesmo player + valor + paid_at + campaign
CREATE UNIQUE INDEX IF NOT EXISTS uq_cashback_payment_natural
  ON public.cashback_payments (tenant_id, player_id, cashback_amount, paid_at, COALESCE(campaign, ''));

CREATE INDEX IF NOT EXISTS idx_cashback_payments_tenant_paidat
  ON public.cashback_payments (tenant_id, paid_at DESC);

CREATE TRIGGER trg_cashback_payments_updated_at
  BEFORE UPDATE ON public.cashback_payments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
