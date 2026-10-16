-- Independent saque budget (D-2, docs/ESCOPO_AUDITORIA_GATILHOS_JORNADAS_2026-10-15.md)
--
-- The standard per-player limit (journey_contact_limits, 2 SMS / 24 h) used to
-- count every SMS, so up to 4 "Saque pago" messages ate the 2 standard slots.
-- Express journeys have their own per-journey cap (max_per_player_day), so
-- their SMS no longer count toward the standard limit. A capped player is now
-- retried when the oldest counted message leaves the window, not every hour.
-- Base: 20261015122000_express_journeys.sql.

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
  v_express_triggers text[];
  v_oldest_24h timestamptz;
  v_oldest_7d timestamptz;
BEGIN
  IF p_player_id IS NULL THEN
    RAISE EXCEPTION 'invalid journey delivery reservation';
  END IF;

  -- Expressas: sem limites globais 24h/7d. As demais regras (idempotência,
  -- daily_limit) seguem na função interna.
  IF EXISTS (
    SELECT 1 FROM public.journeys
    WHERE id = p_journey_id AND tenant_id = p_tenant_id AND express
  ) THEN
    RETURN QUERY
    SELECT * FROM public.reserve_journey_delivery(
      p_tenant_id, p_journey_id, p_enrollment_id, p_step_id, p_step_position,
      p_player_id, p_channel, p_daily_limit, p_cooldown_hours
    );
    RETURN;
  END IF;

  -- ENV-02: um passo já aceito pelo provedor conta no próprio limite global;
  -- checar os limites antes faria o passo ser adiado e, vencida a janela,
  -- reenviado. A função interna devolve `already_sent` e avança a posição.
  IF EXISTS (
    SELECT 1
    FROM public.journey_enrollments n
    JOIN public.journey_step_executions e
      ON e.enrollment_id = n.id AND e.loop_iteration = n.loop_iteration
    WHERE n.id = p_enrollment_id AND n.tenant_id = p_tenant_id
      AND e.step_position = p_step_position
      AND e.status IN ('sent','delivered')
  ) THEN
    RETURN QUERY
    SELECT * FROM public.reserve_journey_delivery(
      p_tenant_id, p_journey_id, p_enrollment_id, p_step_id, p_step_position,
      p_player_id, p_channel, p_daily_limit, p_cooldown_hours
    );
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_tenant_id::text || ':' || p_player_id::text || ':journey-contact-limits', 0)
  );

  SELECT max_messages_24h, max_messages_7d
    INTO v_max_24h, v_max_7d
  FROM public.journey_contact_limits
  WHERE tenant_id = p_tenant_id;

  IF v_max_24h IS NOT NULL OR v_max_7d IS NOT NULL THEN
    -- D-2: express journeys (Saque pago) have their own per-player budget, so
    -- their SMS do not consume the standard daily slots.
    SELECT coalesce(array_agg('journey:' || id::text), '{}')
      INTO v_express_triggers
    FROM public.journeys
    WHERE tenant_id = p_tenant_id AND express;

    SELECT
      (SELECT count(*) FROM public.sms_send_logs
       WHERE tenant_id = p_tenant_id AND player_id = p_player_id
         AND status IN ('sent', 'delivered', 'enviado', 'entregue')
         AND NOT (coalesce(trigger_name, '') = ANY(v_express_triggers))
         AND created_at >= now() - interval '24 hours')
      +
      (SELECT count(*) FROM public.email_send_logs
       WHERE tenant_id = p_tenant_id AND player_id = p_player_id
         AND status IN ('sent', 'delivered', 'enviado', 'entregue')
         AND created_at >= now() - interval '24 hours')
      +
      (SELECT count(*) FROM public.journey_enrollments enrollment
       JOIN public.journey_step_executions execution ON execution.enrollment_id = enrollment.id
       WHERE enrollment.tenant_id = p_tenant_id AND enrollment.player_id = p_player_id
         AND execution.tenant_id = p_tenant_id
         AND execution.channel = 'voice' AND execution.status IN ('claimed', 'sent', 'delivered')
         AND execution.created_at >= now() - interval '24 hours'),
      (SELECT count(*) FROM public.sms_send_logs
       WHERE tenant_id = p_tenant_id AND player_id = p_player_id
         AND status IN ('sent', 'delivered', 'enviado', 'entregue')
         AND NOT (coalesce(trigger_name, '') = ANY(v_express_triggers))
         AND created_at >= now() - interval '7 days')
      +
      (SELECT count(*) FROM public.email_send_logs
       WHERE tenant_id = p_tenant_id AND player_id = p_player_id
         AND status IN ('sent', 'delivered', 'enviado', 'entregue')
         AND created_at >= now() - interval '7 days')
      +
      (SELECT count(*) FROM public.journey_enrollments enrollment
       JOIN public.journey_step_executions execution ON execution.enrollment_id = enrollment.id
       WHERE enrollment.tenant_id = p_tenant_id AND enrollment.player_id = p_player_id
         AND execution.tenant_id = p_tenant_id
         AND execution.channel = 'voice' AND execution.status IN ('claimed', 'sent', 'delivered')
         AND execution.created_at >= now() - interval '7 days')
    INTO v_count_24h, v_count_7d;

    -- Retry when the oldest counted message leaves the window, instead of
    -- every hour (thousands of capped players were re-claimed hourly).
    IF v_max_24h IS NOT NULL AND v_count_24h >= v_max_24h THEN
      SELECT min(created_at) INTO v_oldest_24h FROM (
        SELECT created_at FROM public.sms_send_logs
        WHERE tenant_id = p_tenant_id AND player_id = p_player_id
          AND status IN ('sent', 'delivered', 'enviado', 'entregue')
          AND NOT (coalesce(trigger_name, '') = ANY(v_express_triggers))
          AND created_at >= now() - interval '24 hours'
        UNION ALL
        SELECT created_at FROM public.email_send_logs
        WHERE tenant_id = p_tenant_id AND player_id = p_player_id
          AND status IN ('sent', 'delivered', 'enviado', 'entregue')
          AND created_at >= now() - interval '24 hours'
      ) counted;
      RETURN QUERY SELECT NULL::uuid, NULL::uuid,
        greatest(coalesce(v_oldest_24h + interval '24 hours', now() + interval '1 hour'),
                 now() + interval '1 minute'),
        'global_limit_24h'::text;
      RETURN;
    END IF;
    IF v_max_7d IS NOT NULL AND v_count_7d >= v_max_7d THEN
      SELECT min(created_at) INTO v_oldest_7d FROM (
        SELECT created_at FROM public.sms_send_logs
        WHERE tenant_id = p_tenant_id AND player_id = p_player_id
          AND status IN ('sent', 'delivered', 'enviado', 'entregue')
          AND NOT (coalesce(trigger_name, '') = ANY(v_express_triggers))
          AND created_at >= now() - interval '7 days'
        UNION ALL
        SELECT created_at FROM public.email_send_logs
        WHERE tenant_id = p_tenant_id AND player_id = p_player_id
          AND status IN ('sent', 'delivered', 'enviado', 'entregue')
          AND created_at >= now() - interval '7 days'
      ) counted;
      RETURN QUERY SELECT NULL::uuid, NULL::uuid,
        greatest(coalesce(v_oldest_7d + interval '7 days', now() + interval '1 hour'),
                 now() + interval '1 minute'),
        'global_limit_7d'::text;
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

