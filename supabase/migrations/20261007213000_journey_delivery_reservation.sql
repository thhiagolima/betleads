-- Atomic quota/cooldown enforcement and one immutable execution per attempt.
CREATE OR REPLACE FUNCTION public.reserve_journey_delivery(
  p_tenant_id uuid, p_journey_id uuid, p_enrollment_id uuid, p_step_id uuid,
  p_step_position integer, p_player_id uuid, p_channel text,
  p_daily_limit integer, p_cooldown_hours integer
)
RETURNS TABLE (execution_id uuid, idempotency_key uuid, retry_at timestamptz, blocked_reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_sent integer;
  v_last timestamptz;
  v_attempt integer;
BEGIN
  IF p_player_id IS NULL OR p_channel NOT IN ('sms','email','voice') THEN
    RAISE EXCEPTION 'invalid journey delivery reservation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_journey_id::text || ':' || p_channel, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_player_id::text || ':' || p_channel, 0));

  SELECT count(*) INTO v_sent
  FROM public.journey_step_executions e
  WHERE e.tenant_id = p_tenant_id AND e.journey_id = p_journey_id
    AND e.channel = p_channel AND e.status IN ('sent','delivered')
    AND e.completed_at >= (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo');
  IF v_sent >= p_daily_limit THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid,
      ((date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') + interval '1 day') AT TIME ZONE 'America/Sao_Paulo'),
      'daily_limit'::text;
    RETURN;
  END IF;

  SELECT max(e.completed_at) INTO v_last
  FROM public.journey_step_executions e
  JOIN public.journey_enrollments n ON n.id = e.enrollment_id
  WHERE e.tenant_id = p_tenant_id AND n.player_id = p_player_id
    AND e.channel = p_channel AND e.status IN ('sent','delivered');
  IF v_last IS NOT NULL AND p_cooldown_hours > 0
     AND v_last + make_interval(hours => p_cooldown_hours) > now() THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid,
      v_last + make_interval(hours => p_cooldown_hours), 'cooldown'::text;
    RETURN;
  END IF;

  SELECT COALESCE(max(e.attempt), 0) + 1 INTO v_attempt
  FROM public.journey_step_executions e
  WHERE e.enrollment_id = p_enrollment_id AND e.step_position = p_step_position;
  RETURN QUERY
    WITH inserted AS (
      INSERT INTO public.journey_step_executions
        (tenant_id,journey_id,enrollment_id,step_id,step_position,channel,attempt,status)
      VALUES
        (p_tenant_id,p_journey_id,p_enrollment_id,p_step_id,p_step_position,p_channel,v_attempt,'claimed')
      RETURNING id, journey_step_executions.idempotency_key
    )
    SELECT inserted.id, inserted.idempotency_key, NULL::timestamptz, NULL::text FROM inserted;
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_journey_delivery(uuid,uuid,uuid,uuid,integer,uuid,text,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_journey_delivery(uuid,uuid,uuid,uuid,integer,uuid,text,integer,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.recover_orphaned_journey_claims()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  UPDATE public.journey_step_executions
  SET status = 'retrying', error = COALESCE(error, 'worker_claim_timeout'), completed_at = now()
  WHERE status = 'claimed' AND updated_at < now() - interval '10 minutes';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE public.journey_enrollments
  SET claimed_at = NULL, claimed_by = NULL, status = 'waiting', next_run_at = LEAST(next_run_at, now())
  WHERE claimed_at < now() - interval '10 minutes' AND status IN ('active','waiting');
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.recover_orphaned_journey_claims() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_orphaned_journey_claims() TO service_role;

-- Aggregation stays in Postgres: detail pages never download all enrollments/executions.
CREATE OR REPLACE FUNCTION public.journey_metrics(p_tenant_id uuid, p_journey_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH enrollment AS (
    SELECT n.status::text status, n.exit_reason, n.current_position,
      GREATEST(0, COALESCE(p.total_depositado,0) - COALESCE((n.metadata->>'deposited_before_entry')::numeric, p.total_depositado, 0)) recovered
    FROM public.journey_enrollments n
    LEFT JOIN public.players p ON p.id = n.player_id AND p.tenant_id = n.tenant_id
    WHERE n.tenant_id = p_tenant_id AND n.journey_id = p_journey_id
  ), execution AS (
    SELECT COALESCE(channel,'other') channel, count(*)::integer amount
    FROM public.journey_step_executions
    WHERE tenant_id = p_tenant_id AND journey_id = p_journey_id AND status IN ('sent','delivered')
    GROUP BY channel
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM enrollment),
    'byStatus', COALESCE((SELECT jsonb_object_agg(status, amount) FROM (SELECT status,count(*) amount FROM enrollment GROUP BY status) s), '{}'::jsonb),
    'exits', COALESCE((SELECT jsonb_object_agg(exit_reason, amount) FROM (SELECT exit_reason,count(*) amount FROM enrollment WHERE exit_reason IS NOT NULL GROUP BY exit_reason) x), '{}'::jsonb),
    'positions', COALESCE((SELECT jsonb_object_agg(current_position::text, amount) FROM (SELECT current_position,count(*) amount FROM enrollment GROUP BY current_position) x), '{}'::jsonb),
    'recovered', COALESCE((SELECT sum(recovered) FROM enrollment),0),
    'sentByChannel', COALESCE((SELECT jsonb_object_agg(channel,amount) FROM execution),'{}'::jsonb)
  )
$$;
REVOKE ALL ON FUNCTION public.journey_metrics(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.journey_metrics(uuid,uuid) TO service_role;
