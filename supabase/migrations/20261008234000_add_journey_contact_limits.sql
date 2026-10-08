-- Limites globais por pessoa para a operação de jornadas.
CREATE TABLE IF NOT EXISTS public.journey_contact_limits (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  max_messages_24h integer NULL CHECK (max_messages_24h BETWEEN 1 AND 1000),
  max_messages_7d integer NULL CHECK (max_messages_7d BETWEEN 1 AND 5000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CHECK (
    max_messages_24h IS NULL
    OR max_messages_7d IS NULL
    OR max_messages_7d >= max_messages_24h
  )
);

CREATE TRIGGER trg_journey_contact_limits_updated_at
BEFORE UPDATE ON public.journey_contact_limits
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.journey_contact_limits ENABLE ROW LEVEL SECURITY;
CREATE POLICY journey_contact_limits_tenant_isolation ON public.journey_contact_limits
  FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin())
  WITH CHECK (tenant_id = public.current_tenant_id() OR public.is_super_admin());
REVOKE ALL ON public.journey_contact_limits FROM authenticated;
GRANT ALL ON public.journey_contact_limits TO service_role;

-- A reserva é envolvida na mesma transação do envio, preservando a decisão sob
-- concorrência. SMS e e-mail usam seus logs compartilhados; voz é contabilizada
-- pelas execuções de jornada, que são a fonte de entrega desse canal.
CREATE OR REPLACE FUNCTION public.reserve_journey_delivery_with_contact_limits(
  p_tenant_id uuid, p_journey_id uuid, p_enrollment_id uuid, p_step_id uuid,
  p_step_position integer, p_player_id uuid, p_channel text,
  p_daily_limit integer, p_cooldown_hours integer
)
RETURNS TABLE (execution_id uuid, idempotency_key uuid, retry_at timestamptz, blocked_reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_max_24h integer;
  v_max_7d integer;
  v_count_24h integer;
  v_count_7d integer;
BEGIN
  IF p_player_id IS NULL THEN
    RAISE EXCEPTION 'invalid journey delivery reservation';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_tenant_id::text || ':' || p_player_id::text || ':journey-contact-limits', 0)
  );

  SELECT max_messages_24h, max_messages_7d
    INTO v_max_24h, v_max_7d
  FROM public.journey_contact_limits
  WHERE tenant_id = p_tenant_id;

  IF v_max_24h IS NOT NULL OR v_max_7d IS NOT NULL THEN
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
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, now() + interval '1 hour', 'global_limit_24h'::text;
      RETURN;
    END IF;
    IF v_max_7d IS NOT NULL AND v_count_7d >= v_max_7d THEN
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, now() + interval '1 hour', 'global_limit_7d'::text;
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
  SELECT * FROM public.reserve_journey_delivery(
    p_tenant_id, p_journey_id, p_enrollment_id, p_step_id, p_step_position,
    p_player_id, p_channel, p_daily_limit, p_cooldown_hours
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_journey_delivery_with_contact_limits(
  uuid, uuid, uuid, uuid, integer, uuid, text, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_journey_delivery_with_contact_limits(
  uuid, uuid, uuid, uuid, integer, uuid, text, integer, integer
) TO service_role;
