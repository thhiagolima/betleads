
-- =====================================================================
-- 1) Limpa papéis duplicados do super admin (mantém só super_admin)
-- =====================================================================
DELETE FROM public.user_roles
 WHERE role IN ('admin','owner','member')
   AND user_id IN (SELECT user_id FROM public.user_roles WHERE role = 'super_admin');

-- Converte qualquer owner/admin/member restante em 'user', preservando tenant_id
UPDATE public.user_roles
   SET role = 'user'
 WHERE role IN ('owner','admin','member');

-- Remove duplicatas (mesmo user_id+tenant_id+role)
DELETE FROM public.user_roles a
 USING public.user_roles b
 WHERE a.ctid < b.ctid
   AND a.user_id = b.user_id
   AND a.role = b.role
   AND COALESCE(a.tenant_id::text,'') = COALESCE(b.tenant_id::text,'');

-- =====================================================================
-- 2) Atualiza funções de tenant para reconhecer o papel 'user'
--    (mantém compat com owner/admin/member caso surjam)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_claim text;
  v_tenant uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  -- Claim 'tenant_id' no JWT (usado quando super_admin impersona)
  BEGIN
    v_claim := current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id';
    IF v_claim IS NOT NULL AND v_claim <> '' THEN
      RETURN v_claim::uuid;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  SELECT tenant_id INTO v_tenant
  FROM public.user_roles
  WHERE user_id = v_uid
    AND tenant_id IS NOT NULL
    AND role IN ('user','owner','member','admin')
  ORDER BY tenant_id ASC
  LIMIT 1;

  RETURN v_tenant;
END;
$$;

CREATE OR REPLACE FUNCTION public.has_tenant_access(_tenant_id uuid, _user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    public.is_super_admin(_user_id)
    OR EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = _user_id
        AND tenant_id = _tenant_id
        AND role IN ('user','owner','member','admin')
    )
$$;

CREATE OR REPLACE FUNCTION public.is_tenant_owner(_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND tenant_id = _tenant
      AND role IN ('user','owner')
  )
$$;

CREATE OR REPLACE FUNCTION public.is_tenant_admin(_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = auth.uid()
          AND tenant_id = _tenant
          AND role IN ('user','owner','admin')
      )
$$;

-- =====================================================================
-- 3) Tabela de preços da plataforma
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.platform_pricing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL UNIQUE CHECK (channel IN ('sms','call','email')),
  price_per_unit numeric(10,4) NOT NULL DEFAULT 0,
  unit_label text NOT NULL DEFAULT 'envio',
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.platform_pricing TO authenticated;
GRANT ALL ON public.platform_pricing TO service_role;

ALTER TABLE public.platform_pricing ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anyone authed can read pricing" ON public.platform_pricing;
CREATE POLICY "anyone authed can read pricing"
  ON public.platform_pricing FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "super admin manages pricing" ON public.platform_pricing;
CREATE POLICY "super admin manages pricing"
  ON public.platform_pricing FOR ALL
  TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

INSERT INTO public.platform_pricing(channel, price_per_unit, unit_label) VALUES
  ('sms',   0.05,  'sms'),
  ('call',  0.20,  'minuto'),
  ('email', 0.001, 'email')
ON CONFLICT (channel) DO NOTHING;

-- =====================================================================
-- 4) RPC: lista de usuários com uso e custo estimado
-- =====================================================================
CREATE OR REPLACE FUNCTION public.admin_list_users_with_usage(
  _from timestamptz DEFAULT (now() - interval '30 days'),
  _to   timestamptz DEFAULT now()
)
RETURNS TABLE (
  user_id uuid,
  email text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  banned_until timestamptz,
  tenant_id uuid,
  tenant_nome text,
  role text,
  sms_count bigint,
  sms_cost numeric,
  call_minutes numeric,
  call_cost numeric,
  email_count bigint,
  email_cost numeric,
  total_cost numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_price_sms numeric;
  v_price_call numeric;
  v_price_email numeric;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT price_per_unit INTO v_price_sms   FROM public.platform_pricing WHERE channel = 'sms';
  SELECT price_per_unit INTO v_price_call  FROM public.platform_pricing WHERE channel = 'call';
  SELECT price_per_unit INTO v_price_email FROM public.platform_pricing WHERE channel = 'email';

  RETURN QUERY
  WITH base AS (
    SELECT u.id            AS user_id,
           u.email::text   AS email,
           u.created_at,
           u.last_sign_in_at,
           u.banned_until,
           ur.tenant_id,
           t.nome::text    AS tenant_nome,
           ur.role::text   AS role
    FROM auth.users u
    LEFT JOIN public.user_roles ur ON ur.user_id = u.id
    LEFT JOIN public.tenants t ON t.id = ur.tenant_id
    WHERE ur.role IS DISTINCT FROM 'super_admin' OR ur.role IS NULL
  ),
  sms AS (
    SELECT b.user_id, COUNT(*)::bigint AS c
    FROM base b
    JOIN public.sms_send_logs l ON l.tenant_id = b.tenant_id
    WHERE l.created_at >= _from AND l.created_at < _to
    GROUP BY b.user_id
  ),
  calls AS (
    SELECT b.user_id,
           COALESCE(SUM(GREATEST(EXTRACT(EPOCH FROM (l.ended_at - l.started_at))/60.0, 0)),0)::numeric AS minutes,
           COUNT(*)::bigint AS c
    FROM base b
    JOIN public.call_history l ON l.tenant_id = b.tenant_id
    WHERE l.created_at >= _from AND l.created_at < _to
    GROUP BY b.user_id
  ),
  emails AS (
    SELECT b.user_id, COUNT(*)::bigint AS c
    FROM base b
    JOIN public.email_send_logs l ON l.tenant_id = b.tenant_id
    WHERE l.created_at >= _from AND l.created_at < _to
    GROUP BY b.user_id
  )
  SELECT
    b.user_id,
    b.email,
    b.created_at,
    b.last_sign_in_at,
    b.banned_until,
    b.tenant_id,
    b.tenant_nome,
    b.role,
    COALESCE(s.c, 0)                       AS sms_count,
    (COALESCE(s.c, 0) * COALESCE(v_price_sms,0))::numeric AS sms_cost,
    COALESCE(c.minutes, 0)                 AS call_minutes,
    (COALESCE(c.minutes,0) * COALESCE(v_price_call,0))::numeric AS call_cost,
    COALESCE(e.c, 0)                       AS email_count,
    (COALESCE(e.c, 0) * COALESCE(v_price_email,0))::numeric AS email_cost,
    (COALESCE(s.c,0)*COALESCE(v_price_sms,0)
      + COALESCE(c.minutes,0)*COALESCE(v_price_call,0)
      + COALESCE(e.c,0)*COALESCE(v_price_email,0))::numeric AS total_cost
  FROM base b
  LEFT JOIN sms    s ON s.user_id = b.user_id
  LEFT JOIN calls  c ON c.user_id = b.user_id
  LEFT JOIN emails e ON e.user_id = b.user_id
  ORDER BY b.email;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_users_with_usage(timestamptz, timestamptz) TO authenticated;

-- =====================================================================
-- 5) RPC: métricas globais da plataforma
-- =====================================================================
CREATE OR REPLACE FUNCTION public.admin_platform_metrics(
  _from timestamptz DEFAULT (now() - interval '30 days'),
  _to   timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v jsonb;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT jsonb_build_object(
    'total_users',
      (SELECT COUNT(DISTINCT user_id) FROM public.user_roles WHERE role <> 'super_admin'),
    'active_users_30d',
      (SELECT COUNT(*) FROM auth.users WHERE last_sign_in_at >= now() - interval '30 days'),
    'sms_total',
      (SELECT COUNT(*) FROM public.sms_send_logs WHERE created_at >= _from AND created_at < _to),
    'sms_delivered',
      (SELECT COUNT(*) FROM public.sms_send_logs WHERE created_at >= _from AND created_at < _to AND status IN ('delivered','sent','enviado','entregue')),
    'call_total',
      (SELECT COUNT(*) FROM public.call_history WHERE created_at >= _from AND created_at < _to),
    'email_total',
      (SELECT COUNT(*) FROM public.email_send_logs WHERE created_at >= _from AND created_at < _to),
    'email_delivered',
      (SELECT COUNT(*) FROM public.email_send_logs WHERE created_at >= _from AND created_at < _to AND status IN ('sent','delivered','enviado','entregue'))
  ) INTO v;

  RETURN v;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_platform_metrics(timestamptz, timestamptz) TO authenticated;
