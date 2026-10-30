-- Leads mortos (regra opcional por casa, desligada por padrão).
--
-- Se um lead recebe N (padrão 5) mensagens de jornada seguidas (SMS, e-mail ou
-- voz, somando todas as jornadas) sem nenhuma ação na casa desde então, ele é
-- marcado como "morto": sai de todas as jornadas abertas (exit_reason
-- 'dead_lead'), não entra mais em jornadas não-expressas e forma o público de
-- sistema `system:dead-leads`. Se voltar a agir, é reativado automaticamente
-- (a linha fica, com revived_at preenchido) e pode entrar em jornadas de novo.
-- Análise em produção: a resposta à 6ª+ mensagem seguida sem resposta é < 0,5%.
--
-- Mensagem = journey_step_executions com channel em (sms, email, voice) e
-- status em (sent, delivered), de matrícula fora do grupo de controle
-- (is_holdout). Hora do envio = completed_at (executed_at é nulo em produção).
--
-- Ação na casa (journey_player_last_action) = a mais recente entre:
--   players.ultimo_deposito ('deposito'), players.ftd_em ('ftd'),
--   players.ultimo_login ('login'), players.ultimo_jogo ('jogo'),
--   deposits.created_at ('pix_gerado': o jogador gerou um depósito/PIX,
--     inclusive pendente; índice deposits_tenant_player_created_idx),
--   withdrawals.created_at ('saque': pedido de saque; índice
--     withdrawals_tenant_player_created_idx),
--   link_dispatches.first_party_last_clicked_at ('clique': clique humano no
--     link próprio; índice link_dispatches_first_party_click_idx).
-- Fora de propósito:
--   * shortio_last_clicked_at: não filtra robôs (pré-visualização de link) e,
--     em produção, a data do último clique vem antes do envio do próprio
--     disparo (link reaproveitado); quase não muda o resultado (12.834 vs 12.767
--     marcados na pixpgf) e poderia reviver leads por robô.
--   * events tipo 'deposito-pendente': só há índice por player_id sem tipo/data;
--     a mesma ação já aparece, indexada, em deposits.created_at.
--
-- Contagem = mensagens com completed_at depois de greatest(última ação,
-- revived_at). Assim uma reativação manual zera a contagem sem exigir ação.

-- ============================================================
-- 1) Configuração por casa (journey_contact_limits: uma linha por casa;
--    sem linha = regra desligada)
-- ============================================================
ALTER TABLE public.journey_contact_limits
  ADD COLUMN IF NOT EXISTS dead_lead_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dead_lead_threshold integer NOT NULL DEFAULT 5;

DO $$ BEGIN
  ALTER TABLE public.journey_contact_limits
    ADD CONSTRAINT journey_contact_limits_dead_lead_threshold_check
    CHECK (dead_lead_threshold BETWEEN 2 AND 50);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.journey_contact_limits.dead_lead_enabled IS
  'Leads mortos: liga a regra (padrão desligada). Sem linha = desligada.';
COMMENT ON COLUMN public.journey_contact_limits.dead_lead_threshold IS
  'Leads mortos: mensagens de jornada seguidas sem ação na casa para marcar o lead (2..50, padrão 5).';

-- ============================================================
-- 2) Tabela
-- ============================================================
CREATE TABLE IF NOT EXISTS public.journey_dead_leads (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  marked_at timestamptz NOT NULL DEFAULT now(),
  messages_count integer NOT NULL,
  last_action_at timestamptz NULL,
  last_action_type text NULL,
  last_journey_id uuid NULL REFERENCES public.journeys(id) ON DELETE SET NULL,
  exited_enrollments integer NOT NULL DEFAULT 0,
  revived_at timestamptz NULL,
  revived_reason text NULL CHECK (revived_reason IS NULL OR revived_reason IN ('activity', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, player_id)
);

COMMENT ON TABLE public.journey_dead_leads IS
  'Leads mortos: N mensagens de jornada seguidas sem ação na casa. revived_at nulo = morto agora. Escrita só por RPC (service_role).';

-- Mortos agora, por casa, mais recentes primeiro (lista, público, trigger).
CREATE INDEX IF NOT EXISTS journey_dead_leads_active_idx
  ON public.journey_dead_leads (tenant_id, marked_at DESC)
  WHERE revived_at IS NULL;
-- Histórico (mortos e reativados) por casa.
CREATE INDEX IF NOT EXISTS journey_dead_leads_tenant_marked_idx
  ON public.journey_dead_leads (tenant_id, marked_at DESC);
CREATE INDEX IF NOT EXISTS journey_dead_leads_player_idx
  ON public.journey_dead_leads (player_id);
CREATE INDEX IF NOT EXISTS journey_dead_leads_last_journey_idx
  ON public.journey_dead_leads (last_journey_id)
  WHERE last_journey_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_journey_dead_leads_updated_at ON public.journey_dead_leads;
CREATE TRIGGER trg_journey_dead_leads_updated_at
BEFORE UPDATE ON public.journey_dead_leads
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Membros da casa leem (mesma regra SA_OR_ACC_SELECT de
-- 20261015090000_consolidate_tenant_rls.sql); escrita só via service_role /
-- RPCs security definer.
ALTER TABLE public.journey_dead_leads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS journey_dead_leads_tenant_rls ON public.journey_dead_leads;
CREATE POLICY journey_dead_leads_tenant_rls ON public.journey_dead_leads
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = any ((select public.accessible_tenant_ids())::uuid[]));
REVOKE ALL ON public.journey_dead_leads FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.journey_dead_leads TO authenticated;
GRANT ALL ON public.journey_dead_leads TO service_role;

-- ============================================================
-- 3) Última ação do jogador na casa
-- ============================================================
-- SQL puro, STABLE, sem SECURITY DEFINER nem SET: o planejador o expande
-- (inline) dentro das consultas em lote (backfill, reativação). Todos os nomes
-- são qualificados com o schema. Só é chamado pelas RPCs abaixo.
-- Jogador fora da casa -> nenhuma linha. Jogador que nunca agiu -> uma linha
-- com action_at nulo.
CREATE OR REPLACE FUNCTION public.journey_player_last_action(p_tenant_id uuid, p_player_id uuid)
RETURNS TABLE (action_at timestamptz, action_type text)
LANGUAGE sql
STABLE
AS $$
  SELECT a.action_at, a.action_type
  FROM public.players p
  CROSS JOIN LATERAL (
    SELECT v.action_at, v.action_type
    FROM (VALUES
      (p.ultimo_deposito, 'deposito'),
      (p.ftd_em, 'ftd'),
      (p.ultimo_login, 'login'),
      (p.ultimo_jogo, 'jogo'),
      ((SELECT d.created_at FROM public.deposits d
         WHERE d.tenant_id = p_tenant_id AND d.player_id = p.id
         ORDER BY d.created_at DESC LIMIT 1), 'pix_gerado'),
      ((SELECT w.created_at FROM public.withdrawals w
         WHERE w.tenant_id = p_tenant_id AND w.player_id = p.id
         ORDER BY w.created_at DESC LIMIT 1), 'saque'),
      ((SELECT l.first_party_last_clicked_at FROM public.link_dispatches l
         WHERE l.tenant_id = p_tenant_id AND l.recipient_player_id = p.id
           AND l.first_party_last_clicked_at IS NOT NULL
         ORDER BY l.first_party_last_clicked_at DESC LIMIT 1), 'clique')
    ) AS v(action_at, action_type)
    ORDER BY v.action_at DESC NULLS LAST
    LIMIT 1
  ) a
  WHERE p.id = p_player_id AND p.tenant_id = p_tenant_id
$$;

REVOKE ALL ON FUNCTION public.journey_player_last_action(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.journey_player_last_action(uuid, uuid) TO service_role;

-- ============================================================
-- 4) Saída das matrículas abertas de um lead morto (interna)
-- ============================================================
-- Status abertos = os mesmos de sweep_journey_exits e do trigger de entrada
-- ('active', 'waiting', 'paused_by_priority'). 'paused' (jornada pausada) fica
-- de fora como no sweep: não é reivindicado pelo dispatcher e só volta por
-- decisão do operador.
-- Jornadas expressas (PIX gerado, Saque pago) ficam de fora: nascem de uma
-- ação do próprio jogador e por isso também não são bloqueadas na entrada.
-- Trava do worker: como em sweep_journey_exits, matrícula com lease vigente de
-- outro worker não é tocada. A exceção é p_enrollment_id, a matrícula que o
-- worker chamador acabou de enviar e cujo lease ele mesmo segura: ela sai
-- aqui, mas claimed_at/claimed_by ficam, para que o release do worker
-- (cercado por claimed_by) grave o mesmo estado final e solte o lease. As
-- matrículas de outros workers saem na checagem pós-envio delas (o lead já
-- está morto -> journey_dead_lead_check fecha o que ainda estiver aberto).
CREATE OR REPLACE FUNCTION public.journey_dead_lead_exit_enrollments(
  p_tenant_id uuid,
  p_player_id uuid,
  p_enrollment_id uuid DEFAULT NULL,
  p_source text DEFAULT 'dead_lead_check'
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH exited AS (
    UPDATE public.journey_enrollments e
    SET status = 'exited', exited_at = now(), exit_reason = 'dead_lead',
        claimed_at = CASE WHEN e.id = p_enrollment_id THEN e.claimed_at END,
        claimed_by = CASE WHEN e.id = p_enrollment_id THEN e.claimed_by END
    WHERE e.tenant_id = p_tenant_id
      AND e.player_id = p_player_id
      AND e.status IN ('active', 'waiting', 'paused_by_priority')
      AND NOT EXISTS (
        SELECT 1 FROM public.journeys j
        WHERE j.id = e.journey_id AND coalesce(j.express, false)
      )
      AND (e.id = p_enrollment_id
           OR e.claimed_at IS NULL
           OR coalesce(e.lease_expires_at, e.claimed_at + interval '10 minutes') < now())
    RETURNING e.id, e.tenant_id, e.journey_id
  ),
  logged AS (
    INSERT INTO public.journey_events (tenant_id, journey_id, enrollment_id, event_type, detail)
    SELECT tenant_id, journey_id, id, 'exited',
           jsonb_build_object('reason', 'dead_lead', 'source', p_source)
    FROM exited
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM logged;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.journey_dead_lead_exit_enrollments(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.journey_dead_lead_exit_enrollments(uuid, uuid, uuid, text) TO service_role;

-- ============================================================
-- 5) Checagem pós-envio
-- ============================================================
-- Chamada pelo dispatcher logo depois de cada envio de SMS/e-mail/voz marcado
-- como sent. Devolve true quando o lead está morto ao fim da chamada (marcado
-- agora ou já estava): o dispatcher então não avança a matrícula atual
-- (p_enrollment_id), que já saiu aqui (salvo se for de jornada expressa).
--   * regra desligada ou jogador fora da casa -> false, nada muda;
--   * já morto e agiu depois de marked_at -> reativado ('activity') e
--     reavaliado a partir da ação;
--   * já morto sem ação nova -> fecha o que ainda estiver aberto (matrículas
--     que estavam com outro worker na hora da marcação) e devolve true;
--   * vivo com >= limite mensagens desde a última ação -> marca (ou remarca:
--     revived_at/revived_reason voltam a nulo), sai das jornadas, true.
CREATE OR REPLACE FUNCTION public.journey_dead_lead_check(
  p_tenant_id uuid,
  p_player_id uuid,
  p_enrollment_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_enabled boolean;
  v_threshold integer;
  v_action_at timestamptz;
  v_action_type text;
  v_marked_at timestamptz;
  v_revived_at timestamptz;
  v_is_dead boolean := false;
  v_since timestamptz;
  v_count integer;
  v_last_journey uuid;
  v_exited integer;
BEGIN
  IF p_tenant_id IS NULL OR p_player_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT l.dead_lead_enabled, l.dead_lead_threshold
    INTO v_enabled, v_threshold
  FROM public.journey_contact_limits l
  WHERE l.tenant_id = p_tenant_id;
  IF NOT coalesce(v_enabled, false) THEN
    RETURN false;
  END IF;

  -- Uma checagem por jogador por vez (envios simultâneos de jornadas diferentes).
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_tenant_id::text || ':' || p_player_id::text || ':dead-lead', 0)
  );

  SELECT a.action_at, a.action_type
    INTO v_action_at, v_action_type
  FROM public.journey_player_last_action(p_tenant_id, p_player_id) a;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT d.marked_at, d.revived_at, d.revived_at IS NULL
    INTO v_marked_at, v_revived_at, v_is_dead
  FROM public.journey_dead_leads d
  WHERE d.tenant_id = p_tenant_id AND d.player_id = p_player_id;

  IF coalesce(v_is_dead, false) THEN
    IF v_action_at IS NOT NULL AND v_action_at > v_marked_at THEN
      UPDATE public.journey_dead_leads
      SET revived_at = now(), revived_reason = 'activity'
      WHERE tenant_id = p_tenant_id AND player_id = p_player_id AND revived_at IS NULL;
      v_revived_at := now();
    ELSE
      v_exited := public.journey_dead_lead_exit_enrollments(
        p_tenant_id, p_player_id, p_enrollment_id, 'dead_lead_check');
      IF v_exited > 0 THEN
        UPDATE public.journey_dead_leads
        SET exited_enrollments = exited_enrollments + v_exited
        WHERE tenant_id = p_tenant_id AND player_id = p_player_id;
      END IF;
      RETURN true;
    END IF;
  END IF;

  -- greatest() ignora nulos: sem ação e sem reativação conta tudo.
  v_since := greatest(v_action_at, v_revived_at);
  SELECT count(*)::integer INTO v_count
  FROM public.journey_enrollments e
  JOIN public.journey_step_executions x ON x.enrollment_id = e.id
  WHERE e.tenant_id = p_tenant_id
    AND e.player_id = p_player_id
    AND NOT e.is_holdout
    AND x.channel IN ('sms', 'email', 'voice')
    AND x.status IN ('sent', 'delivered')
    AND x.completed_at > coalesce(v_since, '-infinity'::timestamptz);

  IF v_count < v_threshold THEN
    RETURN false;
  END IF;

  SELECT x.journey_id INTO v_last_journey
  FROM public.journey_enrollments e
  JOIN public.journey_step_executions x ON x.enrollment_id = e.id
  WHERE e.tenant_id = p_tenant_id
    AND e.player_id = p_player_id
    AND NOT e.is_holdout
    AND x.channel IN ('sms', 'email', 'voice')
    AND x.status IN ('sent', 'delivered')
    AND x.completed_at IS NOT NULL
  ORDER BY x.completed_at DESC
  LIMIT 1;

  v_exited := public.journey_dead_lead_exit_enrollments(
    p_tenant_id, p_player_id, p_enrollment_id, 'dead_lead_check');

  INSERT INTO public.journey_dead_leads AS d (
    tenant_id, player_id, marked_at, messages_count, last_action_at, last_action_type,
    last_journey_id, exited_enrollments, revived_at, revived_reason
  )
  VALUES (
    p_tenant_id, p_player_id, now(), v_count, v_action_at,
    CASE WHEN v_action_at IS NULL THEN NULL ELSE v_action_type END,
    v_last_journey, v_exited, NULL, NULL
  )
  ON CONFLICT (tenant_id, player_id) DO UPDATE
  SET marked_at = now(),
      messages_count = EXCLUDED.messages_count,
      last_action_at = EXCLUDED.last_action_at,
      last_action_type = EXCLUDED.last_action_type,
      last_journey_id = EXCLUDED.last_journey_id,
      exited_enrollments = EXCLUDED.exited_enrollments,
      revived_at = NULL,
      revived_reason = NULL;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.journey_dead_lead_check(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.journey_dead_lead_check(uuid, uuid, uuid) TO service_role;

-- ============================================================
-- 6) Reativação automática (ciclo do dispatcher)
-- ============================================================
-- Reativa quem agiu depois de marked_at. Roda mesmo com a regra desligada, para
-- o público Leads mortos não ficar com quem já voltou. Casas demo ficam de fora
-- como nos outros sweeps. Custo medido (pixpgf, ~30 mil jogadores): ~0,3 s.
CREATE OR REPLACE FUNCTION public.sweep_dead_lead_revivals(p_tenant_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH revived AS (
    UPDATE public.journey_dead_leads d
    SET revived_at = now(), revived_reason = 'activity'
    WHERE d.revived_at IS NULL
      AND (p_tenant_id IS NULL OR d.tenant_id = p_tenant_id)
      AND NOT public.is_demo_tenant(d.tenant_id)
      AND EXISTS (
        SELECT 1
        FROM public.journey_player_last_action(d.tenant_id, d.player_id) a
        WHERE a.action_at > d.marked_at
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM revived;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.sweep_dead_lead_revivals(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_dead_lead_revivals(uuid) TO service_role;

-- ============================================================
-- 7) Carga inicial (backfill) em lotes
-- ============================================================
-- Avalia, de uma vez e por SQL de conjunto, os jogadores da casa com matrícula
-- aberta ou movimentada nos últimos 30 dias (updated_at da matrícula muda a
-- cada envio) que não estão mortos, e marca até p_limit dos que passaram do
-- limite (ordem por player_id). Sem cursor: cada chamada reavalia o conjunto
-- (~2,5 s na pixpgf, ~22 mil jogadores) e quem foi marcado deixa de ser
-- candidato, então chamar de novo enquanto remaining = true termina.
-- `evaluated` = candidatos avaliados nesta chamada (repete entre chamadas).
-- Matrículas com lease vigente de um worker não são tocadas (saem na checagem
-- pós-envio dele). Regra desligada -> nada é feito.
CREATE OR REPLACE FUNCTION public.backfill_dead_leads(p_tenant_id uuid, p_limit integer DEFAULT 2000)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_enabled boolean;
  v_threshold integer;
  v_limit integer := least(greatest(coalesce(p_limit, 2000), 1), 10000);
  v_evaluated integer := 0;
  v_over integer := 0;
  v_marked integer := 0;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'backfill_dead_leads: casa obrigatória';
  END IF;

  SELECT l.dead_lead_enabled, l.dead_lead_threshold
    INTO v_enabled, v_threshold
  FROM public.journey_contact_limits l
  WHERE l.tenant_id = p_tenant_id;
  IF NOT coalesce(v_enabled, false) THEN
    RETURN jsonb_build_object('evaluated', 0, 'marked', 0, 'remaining', false);
  END IF;

  WITH cand AS (
    SELECT DISTINCT e.player_id
    FROM public.journey_enrollments e
    WHERE e.tenant_id = p_tenant_id
      AND e.player_id IS NOT NULL
      AND (e.status IN ('active', 'waiting', 'paused_by_priority')
           OR e.updated_at >= now() - interval '30 days')
      AND NOT EXISTS (
        SELECT 1 FROM public.journey_dead_leads dl
        WHERE dl.tenant_id = p_tenant_id AND dl.player_id = e.player_id
          AND dl.revived_at IS NULL
      )
  ),
  scored AS (
    SELECT c.player_id, a.action_at, a.action_type,
      (SELECT count(*)::integer
       FROM public.journey_enrollments e
       JOIN public.journey_step_executions x ON x.enrollment_id = e.id
       WHERE e.tenant_id = p_tenant_id
         AND e.player_id = c.player_id
         AND NOT e.is_holdout
         AND x.channel IN ('sms', 'email', 'voice')
         AND x.status IN ('sent', 'delivered')
         AND x.completed_at > coalesce(greatest(a.action_at, prev.revived_at), '-infinity'::timestamptz)
      ) AS n
    FROM cand c
    JOIN LATERAL public.journey_player_last_action(p_tenant_id, c.player_id) a ON true
    LEFT JOIN public.journey_dead_leads prev
      ON prev.tenant_id = p_tenant_id AND prev.player_id = c.player_id
  ),
  overdue AS (
    SELECT s.player_id, s.action_at, s.action_type, s.n
    FROM scored s
    WHERE s.n >= v_threshold
    ORDER BY s.player_id
    LIMIT v_limit
  ),
  exited AS (
    UPDATE public.journey_enrollments e
    SET status = 'exited', exited_at = now(), exit_reason = 'dead_lead',
        claimed_at = NULL, claimed_by = NULL
    FROM overdue o
    WHERE e.tenant_id = p_tenant_id
      AND e.player_id = o.player_id
      AND e.status IN ('active', 'waiting', 'paused_by_priority')
      AND NOT EXISTS (
        SELECT 1 FROM public.journeys j
        WHERE j.id = e.journey_id AND coalesce(j.express, false)
      )
      AND (e.claimed_at IS NULL
           OR coalesce(e.lease_expires_at, e.claimed_at + interval '10 minutes') < now())
    RETURNING e.id, e.journey_id, e.player_id
  ),
  logged AS (
    INSERT INTO public.journey_events (tenant_id, journey_id, enrollment_id, event_type, detail)
    SELECT p_tenant_id, ex.journey_id, ex.id, 'exited',
           jsonb_build_object('reason', 'dead_lead', 'source', 'dead_lead_backfill')
    FROM exited ex
    RETURNING 1
  ),
  marked AS (
    INSERT INTO public.journey_dead_leads AS d (
      tenant_id, player_id, marked_at, messages_count, last_action_at, last_action_type,
      last_journey_id, exited_enrollments, revived_at, revived_reason
    )
    SELECT p_tenant_id, o.player_id, now(), o.n, o.action_at,
      CASE WHEN o.action_at IS NULL THEN NULL ELSE o.action_type END,
      (SELECT x.journey_id
       FROM public.journey_enrollments e
       JOIN public.journey_step_executions x ON x.enrollment_id = e.id
       WHERE e.tenant_id = p_tenant_id
         AND e.player_id = o.player_id
         AND NOT e.is_holdout
         AND x.channel IN ('sms', 'email', 'voice')
         AND x.status IN ('sent', 'delivered')
         AND x.completed_at IS NOT NULL
       ORDER BY x.completed_at DESC
       LIMIT 1),
      (SELECT count(*)::integer FROM exited ex WHERE ex.player_id = o.player_id),
      NULL, NULL
    FROM overdue o
    ON CONFLICT (tenant_id, player_id) DO UPDATE
    SET marked_at = now(),
        messages_count = EXCLUDED.messages_count,
        last_action_at = EXCLUDED.last_action_at,
        last_action_type = EXCLUDED.last_action_type,
        last_journey_id = EXCLUDED.last_journey_id,
        exited_enrollments = EXCLUDED.exited_enrollments,
        revived_at = NULL,
        revived_reason = NULL
    -- Já morto por uma checagem concorrente: mantém a linha dela.
    WHERE d.revived_at IS NOT NULL
    RETURNING 1
  )
  SELECT
    (SELECT count(*)::integer FROM scored),
    (SELECT count(*)::integer FROM scored WHERE n >= v_threshold),
    (SELECT count(*)::integer FROM marked)
    INTO v_evaluated, v_over, v_marked;

  RETURN jsonb_build_object(
    'evaluated', v_evaluated,
    'marked', v_marked,
    'remaining', v_over > v_limit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_dead_leads(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_dead_leads(uuid, integer) TO service_role;

-- ============================================================
-- 8) Reativação manual
-- ============================================================
-- A contagem seguinte parte de revived_at, então o lead reativado só morre de
-- novo depois de outras N mensagens sem ação.
CREATE OR REPLACE FUNCTION public.revive_dead_lead(
  p_tenant_id uuid,
  p_player_id uuid,
  p_reason text DEFAULT 'manual'
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF coalesce(p_reason, '') NOT IN ('manual', 'activity') THEN
    RAISE EXCEPTION 'revive_dead_lead: motivo inválido %', p_reason;
  END IF;
  UPDATE public.journey_dead_leads
  SET revived_at = now(), revived_reason = p_reason
  WHERE tenant_id = p_tenant_id AND player_id = p_player_id AND revived_at IS NULL;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.revive_dead_lead(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revive_dead_lead(uuid, uuid, text) TO service_role;

-- ============================================================
-- 9) Bloqueio de entrada (trigger BEFORE INSERT em journey_enrollments)
-- ============================================================
-- base: 20261016100000_journey_end_date.sql (idêntica à definição em produção).
-- Novo: lead morto (regra ligada) não entra em jornada não-expressa. Expressas
-- (PIX gerado, Saque pago) nascem de uma ação do próprio jogador e seguem
-- liberadas.
CREATE OR REPLACE FUNCTION public.enforce_single_open_journey_enrollment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.player_id IS NULL
     OR NEW.status::text NOT IN ('active', 'waiting', 'paused_by_priority') THEN
    RETURN NEW;
  END IF;
  -- Journey past its end date (D-4): no new entries.
  IF EXISTS (
    SELECT 1 FROM public.journeys
    WHERE id = NEW.journey_id AND ends_at IS NOT NULL AND ends_at <= now()
  ) THEN
    RETURN NULL;
  END IF;
  -- Unreachable player: never enter an SMS-only journey without a phone.
  IF public.journey_requires_phone(NEW.journey_id) AND NOT EXISTS (
    SELECT 1 FROM public.players p
    WHERE p.id = NEW.player_id
      AND coalesce(regexp_replace(p.telefone, '\D', '', 'g'), '') <> ''
  ) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.journeys
    WHERE id = NEW.journey_id AND coalesce(express, false)
  ) THEN
    RETURN NEW;
  END IF;
  -- Dead lead (rule on for the house): no new non-express entries until revived.
  IF EXISTS (
    SELECT 1
    FROM public.journey_dead_leads d
    JOIN public.journey_contact_limits l
      ON l.tenant_id = d.tenant_id AND l.dead_lead_enabled
    WHERE d.tenant_id = NEW.tenant_id
      AND d.player_id = NEW.player_id
      AND d.revived_at IS NULL
  ) THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.journey_id::text || ':' || NEW.player_id::text || ':single-open', 0)
  );
  IF EXISTS (
    SELECT 1 FROM public.journey_enrollments e
    WHERE e.journey_id = NEW.journey_id
      AND e.player_id = NEW.player_id
      AND e.status::text IN ('active', 'waiting', 'paused_by_priority')
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================
-- 10) Público de sistema `system:dead-leads`
-- ============================================================
-- base: definição em produção de resolve_sms_audience_v2 (20261002172000 +
-- remendos 20261002174000/20261002210000/20261002211000). Novo critério
-- `deadLeads` (boolean): só jogadores com linha ativa em journey_dead_leads.
-- Entra em extra_ok, então vale para a lista e para todas as contagens. A
-- resposta traz `deadLeadsFilter` para o servidor recusar (falhar fechado) uma
-- resolução feita por uma versão do RPC que ainda não conhece o critério.
CREATE OR REPLACE FUNCTION public.resolve_sms_audience_v2(_tenant uuid, _criteria jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
with
guard as (
  select (public.has_tenant_access(_tenant) or auth.role() = 'service_role') ok
),
settings as (
  select
    coalesce((level_thresholds->>'bronze')::numeric,10) bronze,
    coalesce((level_thresholds->>'silver')::numeric,200) silver,
    coalesce((level_thresholds->>'gold')::numeric,500) gold,
    coalesce((level_thresholds->>'diamond')::numeric,1000) diamond,
    coalesce((level_thresholds->>'black')::numeric,3000) black,
    coalesce(cooling_after_days,2)::int cooling,
    coalesce(sleeping_after_days,7)::int sleeping
  from (select 1) seed
  left join public.gamification_settings gs on gs.tenant_id = _tenant
),
params as (
  select
    coalesce(_criteria #>> '{activity,deposit}','any') deposit_rule,
    coalesce((_criteria #>> '{activity,pixUnpaid}')::boolean,false) pix_rule,
    coalesce((_criteria #>> '{activity,cashback}')::boolean,false) cashback_rule,
    coalesce(_criteria #>> '{activity,withdrawal}','any') withdrawal_rule,
    coalesce((_criteria #>> '{activity,withdrawalPending}')::boolean,false) withdrawal_pending_rule,
    nullif(_criteria->>'level','') level_rule,
    coalesce(_criteria->>'timing','any') timing_rule,
    greatest(1,coalesce((_criteria->>'customDays')::int,2)) custom_days,
    nullif(_criteria->>'daysWithoutLogin','')::int days_without_login,
    nullif(_criteria->>'daysSinceRegistration','')::int days_since_registration,
    coalesce((_criteria->>'deadLeads')::boolean,false) dead_rule
),
pending_deposits as (
  select player_id, bool_or(metodo is null or lower(metodo) like '%pix%') has_pending_pix
  from public.deposits
  where tenant_id=_tenant and status='pendente' and player_id is not null
  group by player_id
),
withdrawal_flags as (
  select player_id,
    bool_or(status='aprovado') has_approved_withdrawal,
    bool_or(status='pendente') has_pending_withdrawal
  from public.withdrawals
  where tenant_id=_tenant and status in ('aprovado','pendente') and player_id is not null
  group by player_id
),
dead_players as (
  select player_id
  from public.journey_dead_leads
  where tenant_id=_tenant and revived_at is null
),
enriched as (
  select p.id,p.email,
    regexp_replace(coalesce(p.telefone,''),'\D','','g') phone,
    (coalesce(p.total_depositado,0)>0 or p.ftd_em is not null) has_deposit,
    coalesce(pd.has_pending_pix,false) has_pending_pix,
    (coalesce(p.total_sacado,0)>0 or coalesce(wf.has_approved_withdrawal,false)) has_withdrawal,
    coalesce(wf.has_pending_withdrawal,false) has_pending_withdrawal,
    p.last_cashback_paid_at is not null has_cashback,
    (dp.player_id is not null) is_dead,
    case
      when coalesce(p.total_depositado,0)>=s.black then 'black'
      when coalesce(p.total_depositado,0)>=s.diamond then 'diamond'
      when coalesce(p.total_depositado,0)>=s.gold then 'gold'
      when coalesce(p.total_depositado,0)>=s.silver then 'silver'
      when coalesce(p.total_depositado,0)>=s.bronze then 'bronze'
      else 'novice'
    end level,
    greatest(0,floor(extract(epoch from (now()-coalesce(p.ultimo_deposito,p.ftd_em,p.created_at)))/86400))::int inactive_days,
    greatest(0,floor(extract(epoch from (now()-coalesce(p.ultimo_login,p.created_at)))/86400))::int login_days,
    greatest(0,floor(extract(epoch from (now()-p.created_at))/86400))::int registration_days,
    p.created_at >= (date_trunc('week',now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo') registered_week,
    s.*
  from public.players p
  cross join settings s
  left join pending_deposits pd on pd.player_id=p.id
  left join withdrawal_flags wf on wf.player_id=p.id
  left join dead_players dp on dp.player_id=p.id
  where p.tenant_id=_tenant
),
flags as (
  select e.*,p.*,
    (p.deposit_rule='any' or (p.deposit_rule='yes' and e.has_deposit) or (p.deposit_rule='never' and not e.has_deposit)) deposit_ok,
    (not p.pix_rule or e.has_pending_pix) pix_ok,
    (not p.cashback_rule or e.has_cashback) cashback_ok,
    (p.withdrawal_rule='any' or (p.withdrawal_rule='yes' and e.has_withdrawal) or (p.withdrawal_rule='never' and not e.has_withdrawal)) withdrawal_ok,
    (not p.withdrawal_pending_rule or e.has_pending_withdrawal) withdrawal_pending_ok,
    (p.level_rule is null or p.level_rule='null' or e.level=p.level_rule) level_ok,
    (case p.timing_rule
      when 'cooling' then e.has_deposit and e.inactive_days>=e.cooling and e.inactive_days<e.sleeping
      when 'sleeping' then e.has_deposit and e.inactive_days>=e.sleeping
      when 'inactive30' then e.has_deposit and e.inactive_days>=30
      when 'inactive90' then e.has_deposit and e.inactive_days>=90
      when 'custom' then e.has_deposit and e.inactive_days>=p.custom_days
      when 'registered_week' then e.registered_week
      else true end) timing_ok,
    (p.days_without_login is null or e.login_days>=p.days_without_login)
      and (p.days_since_registration is null or e.registration_days>=p.days_since_registration)
      and (not p.dead_rule or e.is_dead) extra_ok
  from enriched e cross join params p
),
matched as (
  select * from flags
  where deposit_ok and pix_ok and cashback_ok and withdrawal_ok and withdrawal_pending_ok
    and level_ok and timing_ok and extra_ok
),
counts as (
  select
    count(*) filter (where not has_deposit and pix_ok and cashback_ok and withdrawal_ok and withdrawal_pending_ok and extra_ok) deposit_never,
    count(*) filter (where has_deposit and pix_ok and cashback_ok and withdrawal_ok and withdrawal_pending_ok and level_ok and timing_ok and extra_ok) deposit_yes,
    count(*) filter (where deposit_ok and has_pending_pix and cashback_ok and withdrawal_ok and withdrawal_pending_ok and level_ok and timing_ok and extra_ok) pix_unpaid,
    count(*) filter (where deposit_ok and pix_ok and cashback_ok and has_withdrawal and withdrawal_pending_ok and level_ok and timing_ok and extra_ok) withdrawal_yes,
    count(*) filter (where deposit_ok and pix_ok and cashback_ok and not has_withdrawal and withdrawal_pending_ok and level_ok and timing_ok and extra_ok) withdrawal_never,
    count(*) filter (where deposit_ok and pix_ok and cashback_ok and withdrawal_ok and has_pending_withdrawal and level_ok and timing_ok and extra_ok) withdrawal_pending,
    count(*) filter (where deposit_ok and pix_ok and has_cashback and withdrawal_ok and withdrawal_pending_ok and level_ok and timing_ok and extra_ok) cashback,
    count(*) filter (where activity_ok and timing_ok and extra_ok and level='bronze') bronze,
    count(*) filter (where activity_ok and timing_ok and extra_ok and level='silver') silver,
    count(*) filter (where activity_ok and timing_ok and extra_ok and level='gold') gold,
    count(*) filter (where activity_ok and timing_ok and extra_ok and level='diamond') diamond,
    count(*) filter (where activity_ok and timing_ok and extra_ok and level='black') black,
    count(*) filter (where activity_ok and level_ok and extra_ok and has_deposit and inactive_days>=cooling and inactive_days<sleeping) cooling_count,
    count(*) filter (where activity_ok and level_ok and extra_ok and has_deposit and inactive_days>=sleeping) sleeping_count,
    count(*) filter (where activity_ok and level_ok and extra_ok and has_deposit and inactive_days>=30) inactive30_count,
    count(*) filter (where activity_ok and level_ok and extra_ok and has_deposit and inactive_days>=90) inactive90_count
  from (
    select f.*,(deposit_ok and pix_ok and cashback_ok and withdrawal_ok and withdrawal_pending_ok) activity_ok
    from flags f
  ) x
),
phone_list as (
  select coalesce(jsonb_agg(phone order by phone),'[]'::jsonb) value,count(*)::int count
  from (select distinct phone from matched where length(phone)>=10) p
),
email_list as (
  select coalesce(jsonb_agg(id),'[]'::jsonb) value,count(*)::int count
  from matched where nullif(trim(email),'') is not null
),
matched_count as (select count(*)::int value from matched)
select jsonb_build_object(
  'phones',pl.value,
  'total',mc.value,
  'recipientTotal',pl.count,
  'emailPlayerIds',el.value,
  'emailRecipientTotal',el.count,
  'deadLeadsFilter',pr.dead_rule,
  'facets',jsonb_build_object(
    'activity',jsonb_build_object(
      'depositNever',c.deposit_never,'depositYes',c.deposit_yes,'pixUnpaid',c.pix_unpaid,
      'withdrawalYes',c.withdrawal_yes,'withdrawalNever',c.withdrawal_never,
      'withdrawalPending',c.withdrawal_pending,'cashback',c.cashback),
    'levels',jsonb_build_object('bronze',c.bronze,'silver',c.silver,'gold',c.gold,'diamond',c.diamond,'black',c.black),
    'timings',jsonb_build_object('cooling',c.cooling_count,'sleeping',c.sleeping_count,'inactive30',c.inactive30_count,'inactive90',c.inactive90_count)
  ),
  'settings',jsonb_build_object(
    'thresholds',jsonb_build_object('bronze',s.bronze,'silver',s.silver,'gold',s.gold,'diamond',s.diamond,'black',s.black),
    'cooling',s.cooling,'sleeping',s.sleeping)
)
from guard g cross join settings s cross join params pr cross join counts c cross join phone_list pl cross join email_list el cross join matched_count mc
where g.ok;
$function$;
