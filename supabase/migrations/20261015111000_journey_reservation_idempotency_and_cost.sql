-- ENV-02 — reserva de jornada idempotente (`already_sent` / `in_flight`).
-- ENV-03 — reserva com custo constante (cooldown e limites por player indexados).
--
-- EVIDÊNCIA (produção, somente leitura, 2026-10-15)
-- * 1.147 grupos (enrollment, step_position, loop_iteration) com DUAS ou mais
--   execuções `sent` (1.569 envios extras), quase todos em 2026-10-14. No
--   exemplo inspecionado a tentativa 2 foi criada 39 s depois da 1, enquanto a 1
--   ainda estava `claimed` (provedor lento: p99 claim→sent = 223 s, máx 418 s).
--   1.204 chaves de entrega aparecem em mais de um `sms_send_logs` `sent`: o
--   provedor NÃO deduplica por `external_id`.
-- * Cooldown: `journey_enrollments` é varrido pelo índice único
--   (journey_id, player_id, entry_key) usando só `player_id` (coluna não
--   líder): 3.163 buffers / 29 ms por chamada, crescendo com o nº de inscrições.
-- * `count(*)` diário: Index Only Scan no índice parcial
--   journey_step_executions_daily_reservation_idx, ~100 buffers / 0,15 ms com
--   1.000 linhas (teto atual do daily_limit). Só lê as linhas de HOJE: não
--   cresce com o histórico.
-- * Contagens 24h/7d: nenhum tenant tem journey_contact_limits configurado (o
--   bloco nem roda). sms_send_logs: só 11 mil de 800 mil linhas têm player_id,
--   máx 11 linhas por player; idx_sms_send_logs_player já resolve (3 buffers).
--
-- CONTRATO DA RPC (assinatura e RETURNS TABLE inalterados)
--   blocked_reason NULL            → reservado (execution_id + idempotency_key).
--   'priority_paused' | 'daily_limit' | 'cooldown' | 'global_limit_24h' |
--   'global_limit_7d'              → inalterados.
--   'already_sent' (NOVO)          → já existe execução `sent`/`delivered` para
--       (enrollment, step_position, loop_iteration atual). execution_id = essa
--       execução, idempotency_key = NULL, retry_at = now(). A RPC também avança
--       current_position para step_position + 1 (attempts = 0), de forma
--       idempotente (só se a inscrição ainda estiver nesse passo/loop).
--   'in_flight' (NOVO)             → outra tentativa do mesmo passo está
--       `claimed` há menos de 15 min (outro worker no meio do envio).
--       execution_id/idempotency_key NULL; retry_at = least(claim + 15 min,
--       now() + 2 min).
--   App antigo: idempotency_key NULL cai no ramo "adiar" (release waiting em
--   retry_at + evento step_deferred). Como a RPC já avançou a posição, o próximo
--   tick executa o passo seguinte: nenhum reenvio, nenhuma inscrição presa.
--
-- ENV-03 — DECISÃO: manter o count(*) diário (já indexado, index-only, limitado
-- por LIMIT p_daily_limit) em vez de tabela-contador. Um contador exato exigiria
-- trigger em toda transição de status (claimed→failed/skipped/retrying
-- decrementa), uma linha quente por (journey, canal, dia) disputada por cada
-- finishExecution e backfill no deploy; o ganho medido seria < 0,2 ms. O custo
-- real era o cooldown (acima), corrigido com índice (tenant_id, player_id).
--
-- OPERAÇÃO (ler antes de aplicar)
-- * journey_enrollments: ~49 mil linhas / 19 MB de heap. O CREATE INDEX abaixo
--   (não CONCURRENTLY: a migração roda em transação) segura SHARE lock por uma
--   estimativa de 0,1–0,5 s, bloqueando INSERT/UPDATE de inscrições (scanner e
--   dispatcher). Sem bloqueio: rodar ANTES, manualmente, fora de transação:
--
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS journey_enrollments_tenant_player_idx
--       ON public.journey_enrollments (tenant_id, player_id);
--
--   (se falhar, `DROP INDEX CONCURRENTLY journey_enrollments_tenant_player_idx;`
--   e repetir — um índice INVALID não é recriado pelo IF NOT EXISTS.)
-- * email_send_logs (3 linhas) e call_history (8 linhas): índices instantâneos.
-- * sms_send_logs: NENHUM índice novo aqui (444 MB; um CREATE INDEX em
--   transação bloquearia a inserção de SMS por segundos). Se um tenant ativar
--   limites globais E o histórico por player crescer muito, criar manualmente:
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS sms_send_logs_tenant_player_created_idx
--       ON public.sms_send_logs (tenant_id, player_id, created_at DESC)
--       WHERE player_id IS NOT NULL;
-- * CREATE OR REPLACE FUNCTION pega lock só no catálogo; lock_timeout evita
--   fila atrás de reservas em andamento (se estourar, basta reaplicar).
-- * Rollback: reaplicar as definições de 20261013150000 (reserve_journey_delivery)
--   e 20261008234000 (wrapper); os índices podem ficar.

set lock_timeout = '5s';
set statement_timeout = '120s';

-- Cooldown e contagem de voz: inscrições do player no tenant (ENV-03).
create index if not exists journey_enrollments_tenant_player_idx
  on public.journey_enrollments (tenant_id, player_id);

-- Limites 24h/7d por player em e-mail (tabela ainda vazia; evita crescer sem índice).
create index if not exists email_send_logs_tenant_player_created_idx
  on public.email_send_logs (tenant_id, player_id, created_at desc)
  where player_id is not null;

-- "Já enviado?" por chave de entrega (ENV-02: e-mail e voz).
create index if not exists email_send_logs_tenant_idempotency_key_idx
  on public.email_send_logs (tenant_id, (provider_response ->> 'idempotency_key'))
  where (provider_response ->> 'idempotency_key') is not null;

create index if not exists call_history_tenant_correlation_idx
  on public.call_history (tenant_id, (provider_response ->> 'correlation_id'))
  where (provider_response ->> 'correlation_id') is not null;

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
  v_competitor record;
  v_sent_id uuid;
  v_in_flight_at timestamptz;
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

  -- ENV-02: outra tentativa do mesmo passo ainda está com um worker. Os locks
  -- acima serializam reservas concorrentes, então a segunda enxerga o claim
  -- já confirmado da primeira.
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

  -- ENV-03: index-only scan em journey_step_executions_daily_reservation_idx,
  -- só sobre as linhas de hoje (America/Sao_Paulo) e nunca além do limite.
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

  -- ENV-03: parte das inscrições do player (journey_enrollments_tenant_player_idx)
  -- e desce por inscrição em journey_step_executions_enrollment_channel_recent_idx.
  SELECT max(COALESCE(e.completed_at,e.created_at)) INTO v_last
  FROM public.journey_enrollments n
  JOIN public.journey_step_executions e ON e.enrollment_id = n.id
  WHERE n.tenant_id = p_tenant_id AND n.player_id = p_player_id
    AND n.id <> p_enrollment_id
    AND e.tenant_id = p_tenant_id AND e.channel = p_channel
    AND e.status IN ('claimed','sent','delivered');
  IF v_last IS NOT NULL AND p_cooldown_hours > 0 AND v_last + make_interval(hours => p_cooldown_hours) > now() THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid,
      v_last + make_interval(hours => p_cooldown_hours), 'cooldown'::text;
    RETURN;
  END IF;

  -- Todas as tentativas do passo reutilizam a chave da primeira: é a chave de
  -- entrega/idempotência repassada a SMS, cobrança, e-mail e voz.
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
