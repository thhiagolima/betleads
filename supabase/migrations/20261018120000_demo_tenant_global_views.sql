-- Task 10: exclude demo tenants from platform-wide totals.
--
-- `admin_platform_metrics` returns a single aggregated jsonb row (not
-- per-tenant rows), so it cannot be filtered after the fact in TS — the
-- demo tenant's cloned `sms_send_logs`/`call_history`/`email_send_logs`
-- rows (Task 12) and its `user_roles` membership must be excluded here, in
-- SQL, using the same `public.is_demo_tenant(uuid)` helper Task 9 already
-- uses for the worker queues. Identical to the latest definition
-- (20260608212916_9b5c0137-8da6-46b7-a609-15f343a877a7.sql) except for the
-- added demo-tenant filters below.
--
-- `active_users_30d` counts `auth.users` directly (no tenant_id on that
-- table), so it is filtered by the `is_demo_user` app_metadata flag instead
-- (the guard in 20261018100000_demo_tenant_flag.sql already confines demo
-- users to gestor/member roles inside the demo tenant, so this flag and
-- "member of only the demo tenant" are equivalent in practice).
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
      (SELECT COUNT(DISTINCT user_id) FROM public.user_roles
        WHERE role <> 'super_admin' AND NOT public.is_demo_tenant(tenant_id)),
    'active_users_30d',
      (SELECT COUNT(*) FROM auth.users
        WHERE last_sign_in_at >= now() - interval '30 days'
          AND coalesce(raw_app_meta_data ->> 'is_demo_user', 'false') <> 'true'),
    'sms_total',
      (SELECT COUNT(*) FROM public.sms_send_logs
        WHERE created_at >= _from AND created_at < _to
          AND NOT public.is_demo_tenant(tenant_id)),
    'sms_delivered',
      (SELECT COUNT(*) FROM public.sms_send_logs
        WHERE created_at >= _from AND created_at < _to
          AND status IN ('delivered','sent','enviado','entregue')
          AND NOT public.is_demo_tenant(tenant_id)),
    'call_total',
      (SELECT COUNT(*) FROM public.call_history
        WHERE created_at >= _from AND created_at < _to
          AND NOT public.is_demo_tenant(tenant_id)),
    'email_total',
      (SELECT COUNT(*) FROM public.email_send_logs
        WHERE created_at >= _from AND created_at < _to
          AND NOT public.is_demo_tenant(tenant_id)),
    'email_delivered',
      (SELECT COUNT(*) FROM public.email_send_logs
        WHERE created_at >= _from AND created_at < _to
          AND status IN ('sent','delivered','enviado','entregue')
          AND NOT public.is_demo_tenant(tenant_id))
  ) INTO v;

  RETURN v;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_platform_metrics(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_platform_metrics(timestamptz, timestamptz) TO authenticated, service_role;
