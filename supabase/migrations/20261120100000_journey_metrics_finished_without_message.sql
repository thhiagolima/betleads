-- Automações card: "Concluíram" counts people who left the journey, many of
-- whom never got a message (paid the PIX before the first send, daily cap,
-- entry no longer matching, holdout). Expose that count as
-- finishedWithoutMessage. The executions are now read once (execution CTE)
-- and feed both sentByChannel and the new count, so the read cost stays flat.
-- Body otherwise identical to 20261019120000_crm_click_conversion_incremental.

CREATE OR REPLACE FUNCTION public.list_journey_metrics(p_tenant_id uuid)
RETURNS TABLE (journey_id uuid, metrics jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH enrollment AS MATERIALIZED (
    SELECT id, journey_id, status::text AS status, exit_reason, current_position
    FROM public.journey_enrollments
    WHERE tenant_id = p_tenant_id
  ),
  totals AS (
    SELECT journey_id, count(*)::integer AS total FROM enrollment GROUP BY journey_id
  ),
  by_status AS (
    SELECT journey_id, jsonb_object_agg(status, amount) AS value
    FROM (SELECT journey_id, status, count(*)::integer AS amount FROM enrollment GROUP BY journey_id, status) grouped
    GROUP BY journey_id
  ),
  exits AS (
    SELECT journey_id, jsonb_object_agg(exit_reason, amount) AS value
    FROM (
      SELECT journey_id, exit_reason, count(*)::integer AS amount FROM enrollment
      WHERE exit_reason IS NOT NULL GROUP BY journey_id, exit_reason
    ) grouped GROUP BY journey_id
  ),
  positions AS (
    SELECT journey_id, jsonb_object_agg(current_position::text, amount) AS value
    FROM (
      SELECT journey_id, current_position, count(*)::integer AS amount FROM enrollment
      WHERE status IN ('active', 'waiting', 'paused_by_priority')
      GROUP BY journey_id, current_position
    ) grouped GROUP BY journey_id
  ),
  execution AS MATERIALIZED (
    SELECT journey_id, enrollment_id, COALESCE(channel, 'other') AS channel, count(*)::integer AS amount
    FROM public.journey_step_executions
    WHERE tenant_id = p_tenant_id AND status IN ('sent', 'delivered')
    GROUP BY journey_id, enrollment_id, COALESCE(channel, 'other')
  ),
  sent AS (
    SELECT journey_id, jsonb_object_agg(channel, amount) AS value
    FROM (
      SELECT journey_id, channel, sum(amount)::integer AS amount
      FROM execution GROUP BY journey_id, channel
    ) grouped GROUP BY journey_id
  ),
  messaged AS MATERIALIZED (
    SELECT DISTINCT enrollment_id FROM execution
    WHERE channel IN ('sms', 'email', 'voice')
  ),
  finished_silent AS (
    SELECT enrollment.journey_id, count(*)::integer AS amount
    FROM enrollment
    WHERE enrollment.status IN ('completed', 'exited')
      AND NOT EXISTS (SELECT 1 FROM messaged WHERE messaged.enrollment_id = enrollment.id)
    GROUP BY enrollment.journey_id
  ),
  attributed_recovery AS (
    SELECT source_id AS journey_id, COALESCE(sum(monetary_value), 0) AS recovered
    FROM public.crm_direct_deposits(p_tenant_id)
    WHERE source_type = 'journey' AND NOT was_active
    GROUP BY source_id
  )
  SELECT journey.id, jsonb_build_object(
    'total', COALESCE(totals.total, 0),
    'byStatus', COALESCE(by_status.value, '{}'::jsonb),
    'exits', COALESCE(exits.value, '{}'::jsonb),
    'positions', COALESCE(positions.value, '{}'::jsonb),
    'recovered', COALESCE(attributed_recovery.recovered, 0),
    'sentByChannel', COALESCE(sent.value, '{}'::jsonb),
    'finishedWithoutMessage', COALESCE(finished_silent.amount, 0)
  )
  FROM public.journeys journey
  LEFT JOIN totals ON totals.journey_id = journey.id
  LEFT JOIN by_status ON by_status.journey_id = journey.id
  LEFT JOIN exits ON exits.journey_id = journey.id
  LEFT JOIN positions ON positions.journey_id = journey.id
  LEFT JOIN sent ON sent.journey_id = journey.id
  LEFT JOIN finished_silent ON finished_silent.journey_id = journey.id
  LEFT JOIN attributed_recovery ON attributed_recovery.journey_id = journey.id
  WHERE journey.tenant_id = p_tenant_id;
$$;

REVOKE ALL ON FUNCTION public.list_journey_metrics(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_journey_metrics(uuid) TO service_role;
