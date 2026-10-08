-- Claimed deliveries consume quota/cooldown while their provider call is in
-- flight. Retries reuse the first provider idempotency key for this step.
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
BEGIN
  IF p_player_id IS NULL OR p_channel NOT IN ('sms','email','voice') THEN RAISE EXCEPTION 'invalid journey delivery reservation'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_journey_id::text || ':' || p_channel, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_player_id::text || ':' || p_channel, 0));

  SELECT count(*) INTO v_reserved FROM public.journey_step_executions e
  WHERE e.tenant_id=p_tenant_id AND e.journey_id=p_journey_id AND e.channel=p_channel
    AND e.status IN ('claimed','sent','delivered')
    AND e.created_at >= (date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo');
  IF v_reserved >= p_daily_limit THEN
    RETURN QUERY SELECT NULL::uuid,NULL::uuid,((date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo')+interval '1 day') AT TIME ZONE 'America/Sao_Paulo'),'daily_limit'::text;
    RETURN;
  END IF;

  SELECT max(COALESCE(e.completed_at,e.created_at)) INTO v_last
  FROM public.journey_step_executions e JOIN public.journey_enrollments n ON n.id=e.enrollment_id
  WHERE e.tenant_id=p_tenant_id AND n.player_id=p_player_id AND e.channel=p_channel
    AND e.status IN ('claimed','sent','delivered');
  IF v_last IS NOT NULL AND p_cooldown_hours>0 AND v_last+make_interval(hours=>p_cooldown_hours)>now() THEN
    RETURN QUERY SELECT NULL::uuid,NULL::uuid,v_last+make_interval(hours=>p_cooldown_hours),'cooldown'::text;
    RETURN;
  END IF;

  SELECT COALESCE(max(e.attempt),0)+1,
         (array_agg(e.idempotency_key ORDER BY e.attempt))[1]
    INTO v_attempt,v_provider_key
  FROM public.journey_step_executions e
  WHERE e.enrollment_id=p_enrollment_id AND e.step_position=p_step_position;
  RETURN QUERY WITH inserted AS (
    INSERT INTO public.journey_step_executions(tenant_id,journey_id,enrollment_id,step_id,step_position,channel,attempt,status)
    VALUES(p_tenant_id,p_journey_id,p_enrollment_id,p_step_id,p_step_position,p_channel,v_attempt,'claimed')
    RETURNING id,journey_step_executions.idempotency_key
  ) SELECT inserted.id,COALESCE(v_provider_key,inserted.idempotency_key),NULL::timestamptz,NULL::text FROM inserted;
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_journey_delivery(uuid,uuid,uuid,uuid,integer,uuid,text,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_journey_delivery(uuid,uuid,uuid,uuid,integer,uuid,text,integer,integer) TO service_role;
