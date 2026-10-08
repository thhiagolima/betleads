-- O cooldown protege apenas contatos vindos de jornadas concorrentes. A cadência
-- configurada entre etapas da mesma matrícula continua sendo respeitada.

CREATE OR REPLACE FUNCTION public.reserve_journey_delivery(
  p_tenant_id uuid, p_journey_id uuid, p_enrollment_id uuid, p_step_id uuid,
  p_step_position integer, p_player_id uuid, p_channel text,
  p_daily_limit integer, p_cooldown_hours integer
)
RETURNS TABLE (execution_id uuid, idempotency_key uuid, retry_at timestamptz, blocked_reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_reserved integer;
  v_last timestamptz;
  v_attempt integer;
  v_provider_key uuid;
  v_current_priority integer;
  v_current_policy text;
  v_competitor record;
BEGIN
  IF p_player_id IS NULL OR p_channel NOT IN ('sms','email','voice') THEN
    RAISE EXCEPTION 'invalid journey delivery reservation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_journey_id::text || ':' || p_channel, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_player_id::text || ':' || p_channel, 0));

  SELECT journey_priority, conflict_policy
    INTO v_current_priority, v_current_policy
  FROM public.journeys
  WHERE id = p_journey_id AND tenant_id = p_tenant_id;
  IF v_current_priority IS NULL THEN
    RAISE EXCEPTION 'journey not found for reservation';
  END IF;

  SELECT competitor.id, competitor.journey_id, journey.journey_priority, journey.conflict_policy
    INTO v_competitor
  FROM public.journey_enrollments competitor
  JOIN public.journeys journey ON journey.id = competitor.journey_id
  JOIN public.journey_steps step
    ON step.journey_id = competitor.journey_id
   AND step.position = competitor.current_position
   AND step.is_enabled = true
  WHERE competitor.tenant_id = p_tenant_id
    AND competitor.player_id = p_player_id
    AND competitor.id <> p_enrollment_id
    AND competitor.status::text IN ('active', 'waiting')
    AND competitor.next_run_at <= now()
    AND step.step_type::text = p_channel
    AND journey.status = 'active'
    AND (v_current_policy = 'pause_lower_priority' OR journey.conflict_policy = 'pause_lower_priority')
  ORDER BY journey.journey_priority ASC, competitor.next_run_at ASC, competitor.id ASC
  LIMIT 1;

  IF v_competitor.id IS NOT NULL THEN
    IF v_competitor.journey_priority < v_current_priority
      OR (v_competitor.journey_priority = v_current_priority AND v_competitor.journey_id::text < p_journey_id::text) THEN
      UPDATE public.journey_enrollments
      SET status = 'paused_by_priority', priority_paused_at = now(),
          priority_pause_reason = 'lower_priority_due_message',
          priority_paused_by_journey_id = v_competitor.journey_id,
          claimed_at = null, claimed_by = null
      WHERE id = p_enrollment_id;
      INSERT INTO public.journey_events (tenant_id, journey_id, enrollment_id, event_type, detail)
      VALUES (p_tenant_id, p_journey_id, p_enrollment_id, 'priority_paused',
        jsonb_build_object('winner_journey_id', v_competitor.journey_id, 'channel', p_channel));
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::timestamptz, 'priority_paused'::text;
      RETURN;
    END IF;

    UPDATE public.journey_enrollments
    SET status = 'paused_by_priority', priority_paused_at = now(),
        priority_pause_reason = 'lower_priority_due_message',
        priority_paused_by_journey_id = p_journey_id,
        claimed_at = null, claimed_by = null
    WHERE id = v_competitor.id;
    INSERT INTO public.journey_events (tenant_id, journey_id, enrollment_id, event_type, detail)
    VALUES (p_tenant_id, v_competitor.journey_id, v_competitor.id, 'priority_paused',
      jsonb_build_object('winner_journey_id', p_journey_id, 'channel', p_channel));
  END IF;

  SELECT count(*) INTO v_reserved FROM public.journey_step_executions e
  WHERE e.tenant_id = p_tenant_id AND e.journey_id = p_journey_id AND e.channel = p_channel
    AND e.status IN ('claimed','sent','delivered')
    AND e.created_at >= (date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo');
  IF v_reserved >= p_daily_limit THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid,
      ((date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo') + interval '1 day') AT TIME ZONE 'America/Sao_Paulo'),
      'daily_limit'::text;
    RETURN;
  END IF;

  -- Excluir a própria matrícula mantém os intervalos internos da sequência.
  SELECT max(COALESCE(e.completed_at,e.created_at)) INTO v_last
  FROM public.journey_step_executions e
  JOIN public.journey_enrollments n ON n.id = e.enrollment_id
  WHERE e.tenant_id = p_tenant_id AND n.player_id = p_player_id AND e.channel = p_channel
    AND e.enrollment_id <> p_enrollment_id
    AND e.status IN ('claimed','sent','delivered');
  IF v_last IS NOT NULL AND p_cooldown_hours > 0 AND v_last + make_interval(hours => p_cooldown_hours) > now() THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid,
      v_last + make_interval(hours => p_cooldown_hours), 'cooldown'::text;
    RETURN;
  END IF;

  SELECT COALESCE(max(e.attempt),0) + 1,
         (array_agg(e.idempotency_key ORDER BY e.attempt))[1]
    INTO v_attempt, v_provider_key
  FROM public.journey_step_executions e
  WHERE e.enrollment_id = p_enrollment_id AND e.step_position = p_step_position;

  RETURN QUERY WITH inserted AS (
    INSERT INTO public.journey_step_executions
      (tenant_id,journey_id,enrollment_id,step_id,step_position,channel,attempt,status)
    VALUES
      (p_tenant_id,p_journey_id,p_enrollment_id,p_step_id,p_step_position,p_channel,v_attempt,'claimed')
    RETURNING id, journey_step_executions.idempotency_key
  )
  SELECT inserted.id, COALESCE(v_provider_key,inserted.idempotency_key), NULL::timestamptz, NULL::text
  FROM inserted;
END;
$$;
