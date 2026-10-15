-- Jornadas expressas ("Envio imediato — fura fila").
--
-- PEDIDO DO PRODUTO
--   "Saque pago: o lead precisa receber o SMS ASSIM que sacar (grande chance de
--   redepósito). Coloque uma opção de jornada que fura fila no geral."
--
-- EVIDÊNCIA (produção, somente leitura, 2026-10-15)
--   A inscrição por webhook acontece em segundos (enrollPlayerOnEvent), mas 8
--   de 15 inscrições de "Saque pago" receberam `step_deferred` com motivo
--   `cooldown` e next_run_at 2–3 dias depois: o cooldown da RPC olha o último
--   envio de QUALQUER OUTRA jornada do mesmo player+canal (cooldown_hours = 72).
--
-- REGRAS DE UMA JORNADA EXPRESSA (journeys.express = true)
--   Ignora:
--   * `cooldown` entre jornadas (reserve_journey_delivery);
--   * limites globais de contato `global_limit_24h` / `global_limit_7d`
--     (journey_contact_limits, em reserve_journey_delivery_with_contact_limits);
--   * arbitragem de prioridade: uma inscrição expressa nunca é colocada em
--     `paused_by_priority`, nem pausa inscrições de outras jornadas. Jornadas
--     comuns não enxergam inscrições expressas como concorrentes.
--   Mantém:
--   * `already_sent` / `in_flight` (idempotência ENV-02);
--   * o `daily_limit` da própria jornada;
--   * regras de reentrada da própria jornada, consentimento/opt-out, política de
--     voz e JANELA DE ENVIO (aplicados no app, sem mudança). A janela de envio
--     NÃO é furada de propósito: é requisito de conformidade (horário de
--     contato), não de fila;
--   * orçamento por canal (channel budget / rate limit): sem bypass. A expressa
--     só chega antes porque é reivindicada antes (claim abaixo).
--   Envios expressos CONTAM para o cooldown e os limites globais das jornadas
--   comuns (o histórico é o mesmo), então furar fila não abre espaço extra
--   para as demais.
--
-- CLAIM (claim_journey_enrollments_leased, mesma assinatura/retorno)
--   Por tenant, primeiro os itens vencidos de jornadas expressas, depois os
--   demais em ordem de next_run_at. O round-robin entre tenants é mantido; no
--   mesmo "giro" (rn), item expresso vem antes de item comum de outro tenant.
--   Os itens expressos vêm de um LATERAL próprio, restrito às jornadas
--   expressas ativas do tenant (índice journey_enrollments_tenant_journey_idx):
--   o LATERAL comum continua usando journey_enrollments_tenant_ready_idx em
--   ordem de next_run_at, sem ordenar o backlog inteiro.
--
-- COMPATIBILIDADE
--   * ADD COLUMN boolean NOT NULL DEFAULT false: só catálogo (PG11+), ACCESS
--     EXCLUSIVE por milissegundos; lock_timeout falha rápido em vez de
--     enfileirar escritas.
--   * As funções mantêm assinatura e RETURNS TABLE: o app em produção continua
--     funcionando sem deploy. Com express = false em todas as jornadas (padrão)
--     o comportamento é idêntico ao de 20261015111000/20261015110000.
--   * ORDEM DE DEPLOY: aplicar esta migração ANTES do app novo (listJourneys
--     passa a selecionar `journeys.express`).
--   * requeue_express_journey_enrollments() é nova (usada pelo app novo ao
--     ligar o modo expresso).
--
-- ROLLBACK
--   Reaplicar reserve_journey_delivery e reserve_journey_delivery_with_contact_limits
--   de 20261015111000 e claim_journey_enrollments_leased de 20261015110000.
--   A coluna pode ficar (ignorada pelas funções antigas).

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.journeys
  ADD COLUMN IF NOT EXISTS express boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.journeys.express IS
  'Envio imediato (fura fila): ignora cooldown entre jornadas, limites globais de contato e arbitragem de prioridade; é reivindicada antes pelo dispatcher. Mantém idempotência, daily_limit, reentrada, consentimento, janela de envio e orçamento de canal.';

-- ---------------------------------------------------------------------------
-- 1. Reserva (base: 20261015111000)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_journey_delivery(
  p_tenant_id uuid, p_journey_id uuid, p_enrollment_id uuid, p_step_id uuid,
  p_step_position integer, p_player_id uuid, p_channel text,
  p_daily_limit integer, p_cooldown_hours integer
)
RETURNS TABLE (execution_id uuid, idempotency_key uuid, retry_at timestamptz, blocked_reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
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

  -- Arbitragem de prioridade. Expressas ficam fora dela nos dois sentidos:
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
$$;

REVOKE ALL ON FUNCTION public.reserve_journey_delivery(uuid,uuid,uuid,uuid,integer,uuid,text,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_journey_delivery(uuid,uuid,uuid,uuid,integer,uuid,text,integer,integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Limites globais de contato (base: 20261015111000)
-- ---------------------------------------------------------------------------
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
      (SELECT count(*) FROM public.journey_enrollments enrollment
       JOIN public.journey_step_executions execution ON execution.enrollment_id = enrollment.id
       WHERE enrollment.tenant_id = p_tenant_id AND enrollment.player_id = p_player_id
         AND execution.tenant_id = p_tenant_id
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
      (SELECT count(*) FROM public.journey_enrollments enrollment
       JOIN public.journey_step_executions execution ON execution.enrollment_id = enrollment.id
       WHERE enrollment.tenant_id = p_tenant_id AND enrollment.player_id = p_player_id
         AND execution.tenant_id = p_tenant_id
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

-- ---------------------------------------------------------------------------
-- 3. Claim justo com expressas primeiro (base: 20261015110000)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_journey_enrollments_leased(
  p_limit integer,
  p_worker_id text,
  p_lease_seconds integer,
  p_tenant_ids uuid[],
  p_journey_ids uuid[],
  p_exclude text[] DEFAULT NULL
)
RETURNS TABLE (id uuid, tenant_id uuid, lease_expires_at timestamptz, step_type text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH params AS (
    SELECT
      greatest(1, least(coalesce(p_limit, 100), 1000)) AS max_items,
      coalesce(nullif(p_worker_id, ''), 'journey-dispatcher:' || gen_random_uuid()::text) AS worker,
      make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 120), 900))) AS lease
  ),
  tenant_scope AS (
    SELECT t.id AS tenant_id
    FROM public.tenants t
    WHERE coalesce(cardinality(p_tenant_ids), 0) = 0 OR t.id = ANY(p_tenant_ids)
  ),
  express_candidates AS (
    -- Per tenant: due, claimable items of ACTIVE EXPRESS journeys only. Uses
    -- journey_enrollments_tenant_journey_idx; empty (and cheap) when the
    -- tenant has no express journey.
    SELECT c.id, c.tenant_id, c.next_run_at, c.created_at, c.step_type, true AS express
    FROM tenant_scope ts
    CROSS JOIN params p
    CROSS JOIN LATERAL (
      SELECT e.id, e.tenant_id, e.next_run_at, e.created_at, s.step_type::text AS step_type
      FROM public.journey_enrollments e
      LEFT JOIN public.journey_steps s
        ON s.journey_id = e.journey_id
       AND s.position = e.current_position
       AND s.is_enabled
      WHERE e.tenant_id = ts.tenant_id
        AND e.journey_id IN (
          SELECT xj.id FROM public.journeys xj
          WHERE xj.tenant_id = ts.tenant_id AND xj.status = 'active' AND xj.express
        )
        AND e.status IN ('active', 'waiting')
        AND e.next_run_at <= now()
        AND (
          e.claimed_at IS NULL
          OR coalesce(e.lease_expires_at, e.claimed_at + interval '10 minutes') < now()
        )
        AND (coalesce(cardinality(p_journey_ids), 0) = 0 OR e.journey_id = ANY(p_journey_ids))
        AND (
          coalesce(cardinality(p_exclude), 0) = 0
          OR s.step_type IS NULL
          OR NOT ((e.tenant_id::text || ':' || s.step_type::text) = ANY(p_exclude))
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.dispatch_pause_state ps
          WHERE ps.tenant_id = e.tenant_id
            AND ps.paused
            AND ps.channel = CASE s.step_type::text
              WHEN 'sms' THEN 'sms'
              WHEN 'email' THEN 'email'
              WHEN 'voice' THEN 'call'
            END
        )
      ORDER BY e.next_run_at, e.created_at, e.id
      LIMIT p.max_items
      FOR UPDATE OF e SKIP LOCKED
    ) c
  ),
  regular_candidates AS (
    -- Per tenant: the oldest due, claimable items of non-express journeys.
    SELECT c.id, c.tenant_id, c.next_run_at, c.created_at, c.step_type, false AS express
    FROM tenant_scope ts
    CROSS JOIN params p
    CROSS JOIN LATERAL (
      SELECT e.id, e.tenant_id, e.next_run_at, e.created_at, s.step_type::text AS step_type
      FROM public.journey_enrollments e
      JOIN public.journeys j ON j.id = e.journey_id
      LEFT JOIN public.journey_steps s
        ON s.journey_id = e.journey_id
       AND s.position = e.current_position
       AND s.is_enabled
      WHERE e.tenant_id = ts.tenant_id
        AND e.status IN ('active', 'waiting')
        AND e.next_run_at <= now()
        AND j.status = 'active'
        AND NOT j.express
        AND (
          e.claimed_at IS NULL
          OR coalesce(e.lease_expires_at, e.claimed_at + interval '10 minutes') < now()
        )
        AND (coalesce(cardinality(p_journey_ids), 0) = 0 OR e.journey_id = ANY(p_journey_ids))
        AND (
          coalesce(cardinality(p_exclude), 0) = 0
          OR s.step_type IS NULL
          OR NOT ((e.tenant_id::text || ':' || s.step_type::text) = ANY(p_exclude))
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.dispatch_pause_state ps
          WHERE ps.tenant_id = e.tenant_id
            AND ps.paused
            AND ps.channel = CASE s.step_type::text
              WHEN 'sms' THEN 'sms'
              WHEN 'email' THEN 'email'
              WHEN 'voice' THEN 'call'
            END
        )
      ORDER BY e.next_run_at, e.created_at, e.id
      LIMIT p.max_items
      FOR UPDATE OF e SKIP LOCKED
    ) c
  ),
  candidates AS (
    SELECT * FROM express_candidates
    UNION ALL
    SELECT * FROM regular_candidates
  ),
  picked AS (
    -- Round-robin across tenants; inside each tenant express items come first.
    SELECT ranked.id, ranked.step_type
    FROM (
      SELECT
        candidates.id,
        candidates.step_type,
        candidates.express,
        candidates.next_run_at,
        row_number() OVER (
          PARTITION BY candidates.tenant_id
          ORDER BY candidates.express DESC, candidates.next_run_at, candidates.created_at, candidates.id
        ) AS rn
      FROM candidates
    ) ranked
    ORDER BY ranked.rn, ranked.express DESC, ranked.next_run_at, ranked.id
    LIMIT (SELECT max_items FROM params)
  )
  UPDATE public.journey_enrollments e
  SET claimed_at = now(),
      claimed_by = p.worker,
      lease_expires_at = now() + p.lease
  FROM picked, params p
  WHERE e.id = picked.id
  RETURNING e.id, e.tenant_id, e.lease_expires_at, picked.step_type;
$$;

REVOKE ALL ON FUNCTION public.claim_journey_enrollments_leased(integer, text, integer, uuid[], uuid[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_journey_enrollments_leased(integer, text, integer, uuid[], uuid[], text[]) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Ao ligar o modo expresso: trazer de volta o que foi adiado pelas regras
--    que a expressa agora ignora.
-- ---------------------------------------------------------------------------
-- * `waiting` com next_run_at no futuro cujo ÚLTIMO evento é `step_deferred`
--   por cooldown/global_limit_24h/global_limit_7d no passo atual → agora.
--   (Esperas da própria jornada, janela de envio, orçamento e consentimento
--   não são tocados: o último evento delas é outro ou o motivo é outro.)
-- * `paused_by_priority` desta jornada → `waiting` agora (expressas não
--   participam da arbitragem).
-- Itens já reivindicados por um worker (lease viva) não são alterados.
CREATE OR REPLACE FUNCTION public.requeue_express_journey_enrollments(
  p_tenant_id uuid,
  p_journey_id uuid
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  v_resumed integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.journeys
    WHERE id = p_journey_id AND tenant_id = p_tenant_id AND express
  ) THEN
    RETURN 0;
  END IF;

  WITH targets AS (
    SELECT n.id
    FROM public.journey_enrollments n
    CROSS JOIN LATERAL (
      SELECT ev.event_type, ev.detail
      FROM public.journey_events ev
      WHERE ev.enrollment_id = n.id
      ORDER BY ev.created_at DESC
      LIMIT 1
    ) last_event
    WHERE n.tenant_id = p_tenant_id
      AND n.journey_id = p_journey_id
      AND n.status = 'waiting'
      AND n.next_run_at > now()
      AND (n.claimed_at IS NULL
           OR coalesce(n.lease_expires_at, n.claimed_at + interval '10 minutes') < now())
      AND last_event.event_type = 'step_deferred'
      AND last_event.detail ->> 'reason' IN ('cooldown', 'global_limit_24h', 'global_limit_7d')
      AND coalesce((last_event.detail ->> 'step_position')::integer, n.current_position) = n.current_position
    FOR UPDATE OF n SKIP LOCKED
  ), moved AS (
    UPDATE public.journey_enrollments n
    SET next_run_at = now()
    FROM targets
    WHERE n.id = targets.id
    RETURNING n.id
  )
  INSERT INTO public.journey_events (tenant_id, journey_id, enrollment_id, event_type, detail)
  SELECT p_tenant_id, p_journey_id, moved.id, 'express_requeued', '{"from":"deferred"}'::jsonb
  FROM moved;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  WITH targets AS (
    SELECT n.id
    FROM public.journey_enrollments n
    WHERE n.tenant_id = p_tenant_id
      AND n.journey_id = p_journey_id
      AND n.status = 'paused_by_priority'
    FOR UPDATE SKIP LOCKED
  ), resumed AS (
    UPDATE public.journey_enrollments n
    SET status = 'waiting',
        next_run_at = now(),
        priority_paused_at = NULL,
        priority_pause_reason = NULL,
        priority_paused_by_journey_id = NULL
    FROM targets
    WHERE n.id = targets.id
    RETURNING n.id
  )
  INSERT INTO public.journey_events (tenant_id, journey_id, enrollment_id, event_type, detail)
  SELECT p_tenant_id, p_journey_id, resumed.id, 'priority_resumed', '{"reason":"express"}'::jsonb
  FROM resumed;
  GET DIAGNOSTICS v_resumed = ROW_COUNT;

  RETURN v_count + v_resumed;
END;
$$;

REVOKE ALL ON FUNCTION public.requeue_express_journey_enrollments(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.requeue_express_journey_enrollments(uuid, uuid) TO service_role;
