-- The superadmin directory must show one row per account, even when that
-- account belongs to multiple tenants. Usage is aggregated across memberships.
DROP FUNCTION IF EXISTS public.admin_list_users_with_usage(timestamptz, timestamptz);

CREATE FUNCTION public.admin_list_users_with_usage(
  _from timestamptz DEFAULT (now() - interval '30 days'),
  _to timestamptz DEFAULT now()
)
RETURNS TABLE (
  user_id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz,
  banned_until timestamptz, tenant_id uuid, tenant_nome text, role text,
  sms_count bigint, sms_cost numeric, call_minutes numeric, call_cost numeric,
  email_count bigint, email_cost numeric, total_cost numeric
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_sms numeric; v_call numeric; v_email numeric;
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT price_per_unit INTO v_sms FROM public.platform_pricing WHERE channel = 'sms';
  SELECT price_per_unit INTO v_call FROM public.platform_pricing WHERE channel = 'call';
  SELECT price_per_unit INTO v_email FROM public.platform_pricing WHERE channel = 'email';

  RETURN QUERY
  WITH memberships AS (
    SELECT DISTINCT ur.user_id, ur.tenant_id, ur.role::text AS role
    FROM public.user_roles ur
    WHERE ur.tenant_id IS NOT NULL AND ur.role IN ('admin', 'gestor', 'member')
  ), base AS (
    SELECT u.id AS user_id, u.email::text AS email, u.created_at, u.last_sign_in_at, u.banned_until,
      min(m.tenant_id) AS tenant_id,
      string_agg(DISTINCT t.nome::text, ', ' ORDER BY t.nome::text) AS tenant_nome,
      string_agg(DISTINCT m.role, ', ' ORDER BY m.role) AS role
    FROM auth.users u
    LEFT JOIN memberships m ON m.user_id = u.id
    LEFT JOIN public.tenants t ON t.id = m.tenant_id
    WHERE NOT public.is_super_admin(u.id)
    GROUP BY u.id, u.email, u.created_at, u.last_sign_in_at, u.banned_until
  ), sms AS (
    SELECT m.user_id, count(*)::bigint AS c
    FROM memberships m JOIN public.sms_send_logs l ON l.tenant_id = m.tenant_id
    WHERE l.created_at >= _from AND l.created_at < _to GROUP BY m.user_id
  ), calls AS (
    SELECT m.user_id, coalesce(sum(greatest(extract(epoch FROM (l.ended_at-l.started_at))/60.0, 0)),0)::numeric AS minutes
    FROM memberships m JOIN public.call_history l ON l.tenant_id = m.tenant_id
    WHERE l.created_at >= _from AND l.created_at < _to GROUP BY m.user_id
  ), emails AS (
    SELECT m.user_id, count(*)::bigint AS c
    FROM memberships m JOIN public.email_send_logs l ON l.tenant_id = m.tenant_id
    WHERE l.created_at >= _from AND l.created_at < _to GROUP BY m.user_id
  )
  SELECT b.user_id, b.email, b.created_at, b.last_sign_in_at, b.banned_until,
    b.tenant_id, b.tenant_nome, b.role,
    coalesce(s.c,0), (coalesce(s.c,0)*coalesce(v_sms,0))::numeric,
    coalesce(c.minutes,0), (coalesce(c.minutes,0)*coalesce(v_call,0))::numeric,
    coalesce(e.c,0), (coalesce(e.c,0)*coalesce(v_email,0))::numeric,
    (coalesce(s.c,0)*coalesce(v_sms,0)+coalesce(c.minutes,0)*coalesce(v_call,0)+coalesce(e.c,0)*coalesce(v_email,0))::numeric
  FROM base b LEFT JOIN sms s ON s.user_id=b.user_id
  LEFT JOIN calls c ON c.user_id=b.user_id LEFT JOIN emails e ON e.user_id=b.user_id
  ORDER BY b.email;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_users_with_usage(timestamptz, timestamptz) TO authenticated;
