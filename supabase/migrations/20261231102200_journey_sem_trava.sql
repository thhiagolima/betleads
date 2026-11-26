-- "Sem trava" / "Com prioridade" por jornada.
--
--   * Sem trava (conflict_policy 'coexist'): envia normalmente, não pausa
--     nenhuma jornada e não é pausada por nenhuma.
--   * Com prioridade ('pause_lower_priority'): como antes. Entre duas jornadas
--     "Com prioridade" que disputam o mesmo jogador e canal, a de número menor
--     envia e a outra fica pausada até a primeira terminar.
--
-- Antes a disputa acontecia quando QUALQUER UMA das duas era "pausar": uma
-- jornada "coexistir" (Segundo depósito) ou "família" (nível) era pausada pela
-- inatividade. Agora as DUAS precisam estar "Com prioridade".
--
-- 1. reserve_journey_delivery: corpo igual ao de produção (base
--    20261015122000), só a condição da disputa muda de OR para AND.
-- 2. resume_priority_paused_journeys: também libera a matrícula pausada quando
--    ela ou a jornada que a pausou não está mais "Com prioridade" (ou não está
--    ativa). Roda a cada ciclo do despachante em lotes de p_limit, então a
--    liberação após uma troca acontece aos poucos.
-- 3. Jornadas de nível ('exclusive') passam a "Sem trava" (decisão de
--    2026-11-26; o gestor ajusta jornada por jornada). O valor 'exclusive'
--    continua aceito pela constraint e tratado como Sem trava, para um app
--    antigo poder salvar sem erro. A família progressao_niveis (troca de nível
--    encerra a jornada anterior) não depende desta coluna.

CREATE OR REPLACE FUNCTION public.reserve_journey_delivery(p_tenant_id uuid, p_journey_id uuid, p_enrollment_id uuid, p_step_id uuid, p_step_position integer, p_player_id uuid, p_channel text, p_daily_limit integer, p_cooldown_hours integer)
 RETURNS TABLE(execution_id uuid, idempotency_key uuid, retry_at timestamp with time zone, blocked_reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- Acima do p99,9 observado entre claim e sent (284 s; máx 418 s).
  c_in_flight_lease constant interval := interval '15 minutes';
  v_reserved integer;
  v_last timestamptz;
  v_attempt integer;
  v_provider_key uuid;
  v_loop_iteration integer;
  v_current_priority integer;
  v_current_policy text;
  v_express boolean;
  v_competitor record;
  v_sent_id uuid;
  v_in_flight_at timestamptz;
BEGIN
  IF p_player_id IS NULL OR p_channel NOT IN ('sms','email','voice') THEN
    RAISE EXCEPTION 'invalid journey delivery reservation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_journey_id::text || ':' || p_channel, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_player_id::text || ':' || p_channel, 0));

  SELECT journey_priority, conflict_policy, coalesce(express, false)
    INTO v_current_priority, v_current_policy, v_express
  FROM public.journeys
  WHERE id = p_journey_id AND tenant_id = p_tenant_id;
  IF v_current_priority IS NULL THEN
    RAISE EXCEPTION 'journey not found for reservation';
  END IF;

  SELECT loop_iteration INTO v_loop_iteration
  FROM public.journey_enrollments
  WHERE id = p_enrollment_id AND tenant_id = p_tenant_id AND journey_id = p_journey_id;
  IF v_loop_iteration IS NULL THEN
    RAISE EXCEPTION 'journey enrollment not found for reservation';
  END IF;

  -- ENV-02: o provedor já aceitou este passo nesta volta do loop. Nunca
  -- reenviar; avançar a inscrição (idempotente) e informar o chamador.
  SELECT e.id INTO v_sent_id
  FROM public.journey_step_executions e
  WHERE e.enrollment_id = p_enrollment_id
    AND e.step_position = p_step_position
    AND e.loop_iteration = v_loop_iteration
    AND e.status IN ('sent','delivered')
  ORDER BY e.attempt
  LIMIT 1;
  IF v_sent_id IS NOT NULL THEN
    UPDATE public.journey_enrollments
    SET current_position = p_step_position + 1, attempts = 0
    WHERE id = p_enrollment_id
      AND current_position = p_step_position
      AND loop_iteration = v_loop_iteration;
    RETURN QUERY SELECT v_sent_id, NULL::uuid, now(), 'already_sent'::text;
    RETURN;
  END IF;

  -- ENV-02: outra tentativa do mesmo passo ainda está com um worker.
  SELECT max(e.created_at) INTO v_in_flight_at
  FROM public.journey_step_executions e
  WHERE e.enrollment_id = p_enrollment_id
    AND e.step_position = p_step_position
    AND e.loop_iteration = v_loop_iteration
    AND e.status = 'claimed'
    AND e.created_at > now() - c_in_flight_lease;
  IF v_in_flight_at IS NOT NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid,
      least(v_in_flight_at + c_in_flight_lease, now() + interval '2 minutes'),
      'in_flight'::text;
    RETURN;
  END IF;

  -- Arbitragem de prioridade: só entre duas jornadas "Com prioridade".
  -- Expressas ficam fora dela nos dois sentidos:
  -- não são pausadas, não pausam ninguém e não contam como concorrentes.
  IF NOT v_express THEN
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
      AND NOT journey.express
      AND v_current_policy = 'pause_lower_priority'
      AND journey.conflict_policy = 'pause_lower_priority'
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
  END IF;

  -- Limite diário da PRÓPRIA jornada: vale também para expressas.
  SELECT count(*) INTO v_reserved
  FROM (
    SELECT 1 FROM public.journey_step_executions e
    WHERE e.tenant_id = p_tenant_id AND e.journey_id = p_journey_id AND e.channel = p_channel
      AND e.status IN ('claimed','sent','delivered')
      AND e.created_at >= (date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')
    LIMIT greatest(p_daily_limit, 0)
  ) today;
  IF v_reserved >= p_daily_limit THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid,
      ((date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo') + interval '1 day') AT TIME ZONE 'America/Sao_Paulo'),
      'daily_limit'::text;
    RETURN;
  END IF;

  -- Cooldown entre jornadas: expressas furam a fila.
  IF NOT v_express AND p_cooldown_hours > 0 THEN
    SELECT max(COALESCE(e.completed_at,e.created_at)) INTO v_last
    FROM public.journey_enrollments n
    JOIN public.journey_step_executions e ON e.enrollment_id = n.id
    WHERE n.tenant_id = p_tenant_id AND n.player_id = p_player_id
      AND n.id <> p_enrollment_id
      AND e.tenant_id = p_tenant_id AND e.channel = p_channel
      AND e.status IN ('claimed','sent','delivered');
    IF v_last IS NOT NULL AND v_last + make_interval(hours => p_cooldown_hours) > now() THEN
      RETURN QUERY SELECT NULL::uuid, NULL::uuid,
        v_last + make_interval(hours => p_cooldown_hours), 'cooldown'::text;
      RETURN;
    END IF;
  END IF;

  SELECT COALESCE(max(e.attempt),0) + 1,
         (array_agg(e.idempotency_key ORDER BY e.attempt))[1]
    INTO v_attempt, v_provider_key
  FROM public.journey_step_executions e
  WHERE e.enrollment_id = p_enrollment_id
    AND e.step_position = p_step_position
    AND e.loop_iteration = v_loop_iteration;

  RETURN QUERY WITH inserted AS (
    INSERT INTO public.journey_step_executions
      (tenant_id,journey_id,enrollment_id,step_id,step_position,loop_iteration,channel,attempt,status)
    VALUES
      (p_tenant_id,p_journey_id,p_enrollment_id,p_step_id,p_step_position,v_loop_iteration,p_channel,v_attempt,'claimed')
    RETURNING id, journey_step_executions.idempotency_key
  )
  SELECT inserted.id, COALESCE(v_provider_key,inserted.idempotency_key), NULL::timestamptz, NULL::text
  FROM inserted;
END;
$function$;

REVOKE ALL ON FUNCTION public.reserve_journey_delivery(uuid,uuid,uuid,uuid,integer,uuid,text,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_journey_delivery(uuid,uuid,uuid,uuid,integer,uuid,text,integer,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.resume_priority_paused_journeys(p_limit integer DEFAULT 100)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_resumed integer := 0;
BEGIN
  WITH candidates AS (
    SELECT paused.id
    FROM public.journey_enrollments paused
    JOIN public.journeys paused_journey ON paused_journey.id = paused.journey_id
    LEFT JOIN public.journeys winner_journey ON winner_journey.id = paused.priority_paused_by_journey_id
    WHERE paused.status::text = 'paused_by_priority'
      AND (
        -- A pausada ou a vencedora virou "Sem trava": a disputa não existe mais.
        paused_journey.conflict_policy <> 'pause_lower_priority'
        OR winner_journey.id IS NULL
        OR winner_journey.conflict_policy <> 'pause_lower_priority'
        OR winner_journey.status::text <> 'active'
        -- A vencedora terminou para este jogador.
        OR NOT EXISTS (
          SELECT 1
          FROM public.journey_enrollments winner
          WHERE winner.tenant_id = paused.tenant_id
            AND winner.player_id = paused.player_id
            AND winner.journey_id = paused.priority_paused_by_journey_id
            AND winner.status::text IN ('active', 'waiting')
        )
      )
      AND NOT public.is_demo_tenant(paused.tenant_id)
    ORDER BY paused.priority_paused_at ASC
    LIMIT GREATEST(1, LEAST(p_limit, 1000))
    FOR UPDATE OF paused SKIP LOCKED
  ), resumed AS (
    UPDATE public.journey_enrollments enrollment
    SET status = 'waiting',
        next_run_at = now(),
        priority_paused_at = NULL,
        priority_pause_reason = NULL,
        priority_paused_by_journey_id = NULL
    FROM candidates
    WHERE enrollment.id = candidates.id
    RETURNING enrollment.id, enrollment.tenant_id, enrollment.journey_id
  )
  INSERT INTO public.journey_events (tenant_id, journey_id, enrollment_id, event_type, detail)
  SELECT tenant_id, journey_id, id, 'priority_resumed', '{}'::jsonb
  FROM resumed;

  GET DIAGNOSTICS v_resumed = ROW_COUNT;
  RETURN v_resumed;
END;
$function$;

REVOKE ALL ON FUNCTION public.resume_priority_paused_journeys(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resume_priority_paused_journeys(integer) TO service_role;

UPDATE public.journeys
SET conflict_policy = 'coexist'
WHERE conflict_policy = 'exclusive';

COMMENT ON COLUMN public.journeys.conflict_policy IS
  'coexist = Sem trava; pause_lower_priority = Com prioridade (disputa só entre duas Com prioridade). exclusive é legado e vale como Sem trava.';
