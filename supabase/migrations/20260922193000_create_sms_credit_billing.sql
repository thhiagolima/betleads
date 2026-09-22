-- SMS credits and billing ledger.
-- Security model:
-- - balances are never updated by the client directly;
-- - every balance mutation goes through SECURITY DEFINER RPCs;
-- - tenant users can read only their own balance/orders/ledger;
-- - super admins can configure pricing, packages and manual adjustments;
-- - ledger rows are append-only for authenticated users.

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.sms_credit_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id = true),
  provider_cost_per_sms numeric(10,4) NOT NULL DEFAULT 0.0500 CHECK (provider_cost_per_sms >= 0),
  default_sale_price_per_sms numeric(10,4) NOT NULL DEFAULT 0.1200 CHECK (default_sale_price_per_sms >= 0),
  min_checkout_credits integer NOT NULL DEFAULT 100 CHECK (min_checkout_credits > 0),
  low_balance_threshold integer NOT NULL DEFAULT 100 CHECK (low_balance_threshold >= 0),
  updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.sms_credit_settings(id)
VALUES (true)
ON CONFLICT (id) DO NOTHING;

CREATE TRIGGER trg_sms_credit_settings_updated_at
BEFORE UPDATE ON public.sms_credit_settings
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.tenant_sms_pricing (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  sale_price_per_sms numeric(10,4) NULL CHECK (sale_price_per_sms IS NULL OR sale_price_per_sms >= 0),
  provider_cost_per_sms numeric(10,4) NULL CHECK (provider_cost_per_sms IS NULL OR provider_cost_per_sms >= 0),
  updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_tenant_sms_pricing_updated_at
BEFORE UPDATE ON public.tenant_sms_pricing
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.sms_credit_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 2 AND 120),
  credits integer NOT NULL CHECK (credits > 0),
  bonus_credits integer NOT NULL DEFAULT 0 CHECK (bonus_credits >= 0),
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  currency text NOT NULL DEFAULT 'BRL' CHECK (currency = upper(currency) AND char_length(currency) = 3),
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_credit_packages_active_order
  ON public.sms_credit_packages(is_active, sort_order, credits);

CREATE TRIGGER trg_sms_credit_packages_updated_at
BEFORE UPDATE ON public.sms_credit_packages
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.sms_credit_packages(name, credits, bonus_credits, price_cents, sort_order)
VALUES
  ('Starter', 1000, 0, 12000, 10),
  ('Growth', 5000, 500, 60000, 20),
  ('Scale', 10000, 1500, 120000, 30)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.tenant_sms_credit_balances (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  balance_credits integer NOT NULL DEFAULT 0 CHECK (balance_credits >= 0),
  lifetime_purchased_credits integer NOT NULL DEFAULT 0 CHECK (lifetime_purchased_credits >= 0),
  lifetime_manual_credits integer NOT NULL DEFAULT 0,
  lifetime_used_credits integer NOT NULL DEFAULT 0 CHECK (lifetime_used_credits >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_tenant_sms_credit_balances_updated_at
BEFORE UPDATE ON public.tenant_sms_credit_balances
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.sms_credit_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  package_id uuid NULL REFERENCES public.sms_credit_packages(id) ON DELETE SET NULL,
  credits integer NOT NULL CHECK (credits > 0),
  unit_price numeric(10,4) NOT NULL CHECK (unit_price >= 0),
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  currency text NOT NULL DEFAULT 'BRL' CHECK (currency = upper(currency) AND char_length(currency) = 3),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','canceled','expired','failed')),
  checkout_provider text NOT NULL DEFAULT 'manual' CHECK (checkout_provider IN ('manual','stripe','mercadopago','asaas')),
  checkout_url text NULL,
  external_reference text NOT NULL DEFAULT gen_random_uuid()::text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  paid_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (external_reference)
);

CREATE INDEX IF NOT EXISTS idx_sms_credit_orders_tenant_created
  ON public.sms_credit_orders(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_credit_orders_status
  ON public.sms_credit_orders(status, created_at DESC);

CREATE TRIGGER trg_sms_credit_orders_updated_at
BEFORE UPDATE ON public.sms_credit_orders
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.sms_credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  delta_credits integer NOT NULL CHECK (delta_credits <> 0),
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  entry_type text NOT NULL CHECK (
    entry_type IN (
      'purchase',
      'manual_adjustment',
      'sms_reservation',
      'sms_refund',
      'order_reversal',
      'expiration'
    )
  ),
  reference_type text NULL,
  reference_id text NULL,
  idempotency_key text NULL,
  reason text NULL,
  unit_sale_price numeric(10,4) NULL CHECK (unit_sale_price IS NULL OR unit_sale_price >= 0),
  provider_cost_per_sms numeric(10,4) NULL CHECK (provider_cost_per_sms IS NULL OR provider_cost_per_sms >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_sms_credit_ledger_tenant_created
  ON public.sms_credit_ledger(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_credit_ledger_reference
  ON public.sms_credit_ledger(reference_type, reference_id);

ALTER TABLE public.sms_credit_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_sms_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_credit_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_sms_credit_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_credit_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_credit_ledger ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.sms_credit_settings TO authenticated;
GRANT SELECT ON public.sms_credit_packages TO authenticated;
GRANT SELECT ON public.tenant_sms_credit_balances TO authenticated;
GRANT SELECT ON public.sms_credit_orders TO authenticated;
GRANT SELECT ON public.sms_credit_ledger TO authenticated;

GRANT ALL ON public.sms_credit_settings TO service_role;
GRANT ALL ON public.tenant_sms_pricing TO service_role;
GRANT ALL ON public.sms_credit_packages TO service_role;
GRANT ALL ON public.tenant_sms_credit_balances TO service_role;
GRANT ALL ON public.sms_credit_orders TO service_role;
GRANT ALL ON public.sms_credit_ledger TO service_role;

DROP POLICY IF EXISTS sms_credit_settings_super_read ON public.sms_credit_settings;
CREATE POLICY sms_credit_settings_super_read
  ON public.sms_credit_settings FOR SELECT TO authenticated
  USING (public.is_super_admin());

DROP POLICY IF EXISTS sms_credit_settings_super_write ON public.sms_credit_settings;
CREATE POLICY sms_credit_settings_super_write
  ON public.sms_credit_settings FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS tenant_sms_pricing_super_read ON public.tenant_sms_pricing;
CREATE POLICY tenant_sms_pricing_super_read
  ON public.tenant_sms_pricing FOR SELECT TO authenticated
  USING (public.is_super_admin());

DROP POLICY IF EXISTS tenant_sms_pricing_super_write ON public.tenant_sms_pricing;
CREATE POLICY tenant_sms_pricing_super_write
  ON public.tenant_sms_pricing FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS sms_credit_packages_read_active ON public.sms_credit_packages;
CREATE POLICY sms_credit_packages_read_active
  ON public.sms_credit_packages FOR SELECT TO authenticated
  USING (is_active OR public.is_super_admin());

DROP POLICY IF EXISTS sms_credit_packages_super_write ON public.sms_credit_packages;
CREATE POLICY sms_credit_packages_super_write
  ON public.sms_credit_packages FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS sms_credit_balances_read_own ON public.tenant_sms_credit_balances;
CREATE POLICY sms_credit_balances_read_own
  ON public.tenant_sms_credit_balances FOR SELECT TO authenticated
  USING (public.has_tenant_access(tenant_id));

DROP POLICY IF EXISTS sms_credit_balances_super_write ON public.tenant_sms_credit_balances;
CREATE POLICY sms_credit_balances_super_write
  ON public.tenant_sms_credit_balances FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS sms_credit_orders_read_own ON public.sms_credit_orders;
CREATE POLICY sms_credit_orders_read_own
  ON public.sms_credit_orders FOR SELECT TO authenticated
  USING (public.has_tenant_access(tenant_id));

DROP POLICY IF EXISTS sms_credit_orders_super_write ON public.sms_credit_orders;
CREATE POLICY sms_credit_orders_super_write
  ON public.sms_credit_orders FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS sms_credit_ledger_read_own ON public.sms_credit_ledger;
CREATE POLICY sms_credit_ledger_read_own
  ON public.sms_credit_ledger FOR SELECT TO authenticated
  USING (public.has_tenant_access(tenant_id));

-- No INSERT/UPDATE/DELETE policies for regular authenticated users on the ledger.
-- Mutations go through SECURITY DEFINER RPCs below or service_role.

CREATE OR REPLACE FUNCTION public.sms_effective_pricing(_tenant uuid DEFAULT public.current_tenant_id())
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_settings public.sms_credit_settings%ROWTYPE;
  v_override public.tenant_sms_pricing%ROWTYPE;
BEGIN
  IF _tenant IS NULL
     OR (
       NOT public.has_tenant_access(_tenant)
       AND NOT public.is_super_admin()
       AND auth.role() <> 'service_role'
     ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_settings FROM public.sms_credit_settings WHERE id = true;
  SELECT * INTO v_override FROM public.tenant_sms_pricing WHERE tenant_id = _tenant;

  RETURN jsonb_build_object(
    'tenant_id', _tenant,
    'sale_price_per_sms', COALESCE(v_override.sale_price_per_sms, v_settings.default_sale_price_per_sms),
    'provider_cost_per_sms', COALESCE(v_override.provider_cost_per_sms, v_settings.provider_cost_per_sms),
    'min_checkout_credits', v_settings.min_checkout_credits,
    'low_balance_threshold', v_settings.low_balance_threshold,
    'has_tenant_override', v_override.tenant_id IS NOT NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.sms_credit_summary(_tenant uuid DEFAULT public.current_tenant_id())
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_balance public.tenant_sms_credit_balances%ROWTYPE;
  v_pricing jsonb;
BEGIN
  IF _tenant IS NULL
     OR (
       NOT public.has_tenant_access(_tenant)
       AND NOT public.is_super_admin()
       AND auth.role() <> 'service_role'
     ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_balance FROM public.tenant_sms_credit_balances WHERE tenant_id = _tenant;
  v_pricing := public.sms_effective_pricing(_tenant);

  RETURN jsonb_build_object(
    'tenant_id', _tenant,
    'balance_credits', COALESCE(v_balance.balance_credits, 0),
    'lifetime_purchased_credits', COALESCE(v_balance.lifetime_purchased_credits, 0),
    'lifetime_manual_credits', COALESCE(v_balance.lifetime_manual_credits, 0),
    'lifetime_used_credits', COALESCE(v_balance.lifetime_used_credits, 0),
    'updated_at', v_balance.updated_at,
    'pricing', v_pricing
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_sms_credit_overview()
RETURNS TABLE (
  tenant_id uuid,
  tenant_name text,
  balance_credits integer,
  lifetime_purchased_credits integer,
  lifetime_manual_credits integer,
  lifetime_used_credits integer,
  sale_price_per_sms numeric,
  provider_cost_per_sms numeric,
  has_custom_pricing boolean,
  last_ledger_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT
    t.id AS tenant_id,
    t.nome::text AS tenant_name,
    COALESCE(b.balance_credits, 0) AS balance_credits,
    COALESCE(b.lifetime_purchased_credits, 0) AS lifetime_purchased_credits,
    COALESCE(b.lifetime_manual_credits, 0) AS lifetime_manual_credits,
    COALESCE(b.lifetime_used_credits, 0) AS lifetime_used_credits,
    COALESCE(tp.sale_price_per_sms, s.default_sale_price_per_sms) AS sale_price_per_sms,
    COALESCE(tp.provider_cost_per_sms, s.provider_cost_per_sms) AS provider_cost_per_sms,
    tp.tenant_id IS NOT NULL AS has_custom_pricing,
    (
      SELECT MAX(l.created_at)
      FROM public.sms_credit_ledger l
      WHERE l.tenant_id = t.id
    ) AS last_ledger_at
  FROM public.tenants t
  CROSS JOIN public.sms_credit_settings s
  LEFT JOIN public.tenant_sms_credit_balances b ON b.tenant_id = t.id
  LEFT JOIN public.tenant_sms_pricing tp ON tp.tenant_id = t.id
  ORDER BY t.nome;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_sms_credit_settings(
  _provider_cost_per_sms numeric,
  _default_sale_price_per_sms numeric,
  _min_checkout_credits integer,
  _low_balance_threshold integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF _provider_cost_per_sms < 0 OR _default_sale_price_per_sms < 0 THEN
    RAISE EXCEPTION 'invalid_price';
  END IF;
  IF _min_checkout_credits <= 0 OR _low_balance_threshold < 0 THEN
    RAISE EXCEPTION 'invalid_threshold';
  END IF;

  UPDATE public.sms_credit_settings
     SET provider_cost_per_sms = _provider_cost_per_sms,
         default_sale_price_per_sms = _default_sale_price_per_sms,
         min_checkout_credits = _min_checkout_credits,
         low_balance_threshold = _low_balance_threshold,
         updated_by = auth.uid()
   WHERE id = true;

  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_tenant_sms_pricing(
  _tenant uuid,
  _sale_price_per_sms numeric DEFAULT NULL,
  _provider_cost_per_sms numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF _tenant IS NULL OR NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = _tenant) THEN
    RAISE EXCEPTION 'tenant_not_found';
  END IF;
  IF (_sale_price_per_sms IS NOT NULL AND _sale_price_per_sms < 0)
     OR (_provider_cost_per_sms IS NOT NULL AND _provider_cost_per_sms < 0) THEN
    RAISE EXCEPTION 'invalid_price';
  END IF;

  INSERT INTO public.tenant_sms_pricing(tenant_id, sale_price_per_sms, provider_cost_per_sms, updated_by)
  VALUES (_tenant, _sale_price_per_sms, _provider_cost_per_sms, auth.uid())
  ON CONFLICT (tenant_id) DO UPDATE
    SET sale_price_per_sms = EXCLUDED.sale_price_per_sms,
        provider_cost_per_sms = EXCLUDED.provider_cost_per_sms,
        updated_by = auth.uid(),
        updated_at = now();

  RETURN public.sms_effective_pricing(_tenant);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_clear_tenant_sms_pricing(_tenant uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  DELETE FROM public.tenant_sms_pricing WHERE tenant_id = _tenant;
  RETURN public.sms_effective_pricing(_tenant);
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_sms_credit_mutation(
  _tenant uuid,
  _delta integer,
  _entry_type text,
  _reference_type text DEFAULT NULL,
  _reference_id text DEFAULT NULL,
  _idempotency_key text DEFAULT NULL,
  _reason text DEFAULT NULL,
  _metadata jsonb DEFAULT '{}'::jsonb,
  _created_by uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_balance integer;
  v_after integer;
  v_existing public.sms_credit_ledger%ROWTYPE;
  v_pricing jsonb;
BEGIN
  IF _tenant IS NULL OR _delta = 0 THEN
    RAISE EXCEPTION 'invalid_credit_mutation';
  END IF;

  IF _entry_type IN ('sms_reservation', 'sms_refund') THEN
    IF auth.role() <> 'service_role' AND NOT public.is_super_admin() THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
  ELSE
    IF NOT public.is_super_admin() THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
  END IF;

  IF _idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing
    FROM public.sms_credit_ledger
    WHERE tenant_id = _tenant AND idempotency_key = _idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'ledger_id', v_existing.id,
        'balance_credits', v_existing.balance_after
      );
    END IF;
  END IF;

  INSERT INTO public.tenant_sms_credit_balances(tenant_id)
  VALUES (_tenant)
  ON CONFLICT (tenant_id) DO NOTHING;

  SELECT balance_credits INTO v_balance
  FROM public.tenant_sms_credit_balances
  WHERE tenant_id = _tenant
  FOR UPDATE;

  v_after := v_balance + _delta;
  IF v_after < 0 THEN
    RAISE EXCEPTION 'insufficient_sms_credits';
  END IF;

  UPDATE public.tenant_sms_credit_balances
     SET balance_credits = v_after,
         lifetime_purchased_credits = lifetime_purchased_credits + CASE WHEN _entry_type = 'purchase' AND _delta > 0 THEN _delta ELSE 0 END,
         lifetime_manual_credits = lifetime_manual_credits + CASE WHEN _entry_type = 'manual_adjustment' THEN _delta ELSE 0 END,
         lifetime_used_credits = lifetime_used_credits + CASE WHEN _entry_type = 'sms_reservation' AND _delta < 0 THEN ABS(_delta) ELSE 0 END,
         updated_at = now()
   WHERE tenant_id = _tenant;

  v_pricing := public.sms_effective_pricing(_tenant);

  INSERT INTO public.sms_credit_ledger(
    tenant_id,
    delta_credits,
    balance_after,
    entry_type,
    reference_type,
    reference_id,
    idempotency_key,
    reason,
    unit_sale_price,
    provider_cost_per_sms,
    metadata,
    created_by
  )
  VALUES (
    _tenant,
    _delta,
    v_after,
    _entry_type,
    _reference_type,
    _reference_id,
    _idempotency_key,
    _reason,
    (v_pricing->>'sale_price_per_sms')::numeric,
    (v_pricing->>'provider_cost_per_sms')::numeric,
    COALESCE(_metadata, '{}'::jsonb),
    _created_by
  );

  RETURN jsonb_build_object('ok', true, 'idempotent', false, 'balance_credits', v_after);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_adjust_sms_credits(
  _tenant uuid,
  _delta integer,
  _reason text,
  _idempotency_key text DEFAULT gen_random_uuid()::text
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.apply_sms_credit_mutation(
    _tenant,
    _delta,
    'manual_adjustment',
    'admin_adjustment',
    _idempotency_key,
    _idempotency_key,
    _reason,
    '{}'::jsonb,
    auth.uid()
  )
$$;

CREATE OR REPLACE FUNCTION public.reserve_sms_credits(
  _tenant uuid,
  _credits integer,
  _reference_type text,
  _reference_id text,
  _idempotency_key text
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.apply_sms_credit_mutation(
    _tenant,
    -ABS(_credits),
    'sms_reservation',
    _reference_type,
    _reference_id,
    _idempotency_key,
    'Reserva para envio de SMS',
    '{}'::jsonb,
    NULL
  )
$$;

CREATE OR REPLACE FUNCTION public.refund_sms_credits(
  _tenant uuid,
  _credits integer,
  _reference_type text,
  _reference_id text,
  _idempotency_key text,
  _reason text DEFAULT 'Estorno de SMS nao enviado'
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.apply_sms_credit_mutation(
    _tenant,
    ABS(_credits),
    'sms_refund',
    _reference_type,
    _reference_id,
    _idempotency_key,
    _reason,
    '{}'::jsonb,
    NULL
  )
$$;

CREATE OR REPLACE FUNCTION public.create_sms_credit_checkout(
  _tenant uuid DEFAULT public.current_tenant_id(),
  _package_id uuid DEFAULT NULL,
  _credits integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_package public.sms_credit_packages%ROWTYPE;
  v_pricing jsonb;
  v_settings public.sms_credit_settings%ROWTYPE;
  v_credits integer;
  v_unit_price numeric;
  v_amount_cents integer;
  v_order public.sms_credit_orders%ROWTYPE;
BEGIN
  IF _tenant IS NULL OR NOT public.has_tenant_access(_tenant) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_settings FROM public.sms_credit_settings WHERE id = true;
  v_pricing := public.sms_effective_pricing(_tenant);
  v_unit_price := (v_pricing->>'sale_price_per_sms')::numeric;

  IF _package_id IS NOT NULL THEN
    SELECT * INTO v_package
    FROM public.sms_credit_packages
    WHERE id = _package_id AND is_active = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'package_not_found';
    END IF;
    v_credits := v_package.credits + v_package.bonus_credits;
    v_amount_cents := v_package.price_cents;
  ELSE
    v_credits := COALESCE(_credits, 0);
    IF v_credits < v_settings.min_checkout_credits THEN
      RAISE EXCEPTION 'min_checkout_credits:%', v_settings.min_checkout_credits;
    END IF;
    v_amount_cents := CEIL(v_credits * v_unit_price * 100)::integer;
  END IF;

  INSERT INTO public.sms_credit_orders(
    tenant_id,
    package_id,
    credits,
    unit_price,
    amount_cents,
    currency,
    status,
    checkout_provider,
    created_by,
    metadata
  )
  VALUES (
    _tenant,
    _package_id,
    v_credits,
    v_unit_price,
    v_amount_cents,
    'BRL',
    'pending',
    'manual',
    auth.uid(),
    jsonb_build_object('checkout_mode', 'manual_pending')
  )
  RETURNING * INTO v_order;

  RETURN jsonb_build_object(
    'ok', true,
    'order_id', v_order.id,
    'status', v_order.status,
    'credits', v_order.credits,
    'amount_cents', v_order.amount_cents,
    'currency', v_order.currency,
    'checkout_provider', v_order.checkout_provider,
    'checkout_url', v_order.checkout_url,
    'external_reference', v_order.external_reference
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_mark_sms_credit_order_paid(
  _order_id uuid,
  _checkout_provider text DEFAULT 'manual',
  _external_reference text DEFAULT NULL,
  _metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_order public.sms_credit_orders%ROWTYPE;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_order
  FROM public.sms_credit_orders
  WHERE id = _order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found';
  END IF;

  IF v_order.status = 'paid' THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'order_id', v_order.id);
  END IF;

  IF v_order.status <> 'pending' THEN
    RAISE EXCEPTION 'order_not_pending';
  END IF;

  UPDATE public.sms_credit_orders
     SET status = 'paid',
         checkout_provider = _checkout_provider,
         external_reference = COALESCE(_external_reference, external_reference),
         metadata = metadata || COALESCE(_metadata, '{}'::jsonb),
         paid_at = now(),
         updated_at = now()
   WHERE id = v_order.id
   RETURNING * INTO v_order;

  PERFORM public.apply_sms_credit_mutation(
    v_order.tenant_id,
    v_order.credits,
    'purchase',
    'sms_credit_order',
    v_order.id::text,
    'order:' || v_order.id::text,
    'Compra de creditos SMS',
    jsonb_build_object(
      'amount_cents', v_order.amount_cents,
      'currency', v_order.currency,
      'checkout_provider', v_order.checkout_provider
    ),
    auth.uid()
  );

  RETURN jsonb_build_object('ok', true, 'idempotent', false, 'order_id', v_order.id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.sms_effective_pricing(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sms_credit_summary(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_sms_credit_overview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_sms_credit_settings(numeric, numeric, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_tenant_sms_pricing(uuid, numeric, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_clear_tenant_sms_pricing(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_sms_credit_mutation(uuid, integer, text, text, text, text, text, jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_adjust_sms_credits(uuid, integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_sms_credits(uuid, integer, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_sms_credits(uuid, integer, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_sms_credit_checkout(uuid, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_mark_sms_credit_order_paid(uuid, text, text, jsonb) TO authenticated;
