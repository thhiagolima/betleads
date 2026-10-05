-- Claim atômico para o dispatcher único de jornadas. O worker só recebe
-- matrículas prontas e libera o lock ao concluir/reagendar cada passo.
CREATE OR REPLACE FUNCTION public.claim_due_journey_enrollments(p_limit integer DEFAULT 100)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT e.id
    FROM public.journey_enrollments e
    JOIN public.journeys j ON j.id = e.journey_id
    WHERE e.status IN ('active', 'waiting')
      AND e.next_run_at <= now()
      AND j.status = 'active'
      AND (e.claimed_at IS NULL OR e.claimed_at < now() - interval '10 minutes')
    ORDER BY e.next_run_at, e.created_at
    FOR UPDATE OF e SKIP LOCKED
    LIMIT GREATEST(1, LEAST(p_limit, 1000))
  )
  UPDATE public.journey_enrollments e
  SET claimed_at = now(), claimed_by = 'journey-dispatcher'
  FROM candidates c
  WHERE e.id = c.id
  RETURNING e.id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_due_journey_enrollments(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_journey_enrollments(integer) TO service_role;
