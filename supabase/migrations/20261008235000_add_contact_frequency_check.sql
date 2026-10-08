-- Consulta reutilizável para despachantes de campanhas antes de chamar o provedor.
CREATE OR REPLACE FUNCTION public.check_contact_frequency_limit(
  p_tenant_id uuid,
  p_player_id uuid
)
RETURNS TABLE (allowed boolean, retry_at timestamptz, blocked_reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_max_24h integer;
  v_max_7d integer;
  v_count_24h integer;
  v_count_7d integer;
BEGIN
  IF p_player_id IS NULL THEN
    RETURN QUERY SELECT true, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;

  SELECT max_messages_24h, max_messages_7d
    INTO v_max_24h, v_max_7d
  FROM public.journey_contact_limits
  WHERE tenant_id = p_tenant_id;
  IF v_max_24h IS NULL AND v_max_7d IS NULL THEN
    RETURN QUERY SELECT true, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;

  SELECT
    (SELECT count(*) FROM public.sms_send_logs
     WHERE tenant_id = p_tenant_id AND player_id = p_player_id
       AND status IN ('sent', 'delivered', 'enviado', 'entregue')
       AND created_at >= now() - interval '24 hours')
    +
    (SELECT count(*) FROM public.email_send_logs
     WHERE tenant_id = p_tenant_id AND player_id = p_player_id
       AND status IN ('sent', 'delivered', 'enviado', 'entregue')
       AND created_at >= now() - interval '24 hours')
    +
    (SELECT count(*) FROM public.journey_step_executions execution
     JOIN public.journey_enrollments enrollment ON enrollment.id = execution.enrollment_id
     WHERE execution.tenant_id = p_tenant_id AND enrollment.player_id = p_player_id
       AND execution.channel = 'voice' AND execution.status IN ('claimed', 'sent', 'delivered')
       AND execution.created_at >= now() - interval '24 hours'),
    (SELECT count(*) FROM public.sms_send_logs
     WHERE tenant_id = p_tenant_id AND player_id = p_player_id
       AND status IN ('sent', 'delivered', 'enviado', 'entregue')
       AND created_at >= now() - interval '7 days')
    +
    (SELECT count(*) FROM public.email_send_logs
     WHERE tenant_id = p_tenant_id AND player_id = p_player_id
       AND status IN ('sent', 'delivered', 'enviado', 'entregue')
       AND created_at >= now() - interval '7 days')
    +
    (SELECT count(*) FROM public.journey_step_executions execution
     JOIN public.journey_enrollments enrollment ON enrollment.id = execution.enrollment_id
     WHERE execution.tenant_id = p_tenant_id AND enrollment.player_id = p_player_id
       AND execution.channel = 'voice' AND execution.status IN ('claimed', 'sent', 'delivered')
       AND execution.created_at >= now() - interval '7 days')
  INTO v_count_24h, v_count_7d;

  IF v_max_24h IS NOT NULL AND v_count_24h >= v_max_24h THEN
    RETURN QUERY SELECT false, now() + interval '1 hour', 'global_limit_24h'::text;
  ELSIF v_max_7d IS NOT NULL AND v_count_7d >= v_max_7d THEN
    RETURN QUERY SELECT false, now() + interval '1 hour', 'global_limit_7d'::text;
  ELSE
    RETURN QUERY SELECT true, NULL::timestamptz, NULL::text;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.check_contact_frequency_limit(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_contact_frequency_limit(uuid, uuid) TO service_role;
