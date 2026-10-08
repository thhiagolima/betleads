-- Transição atômica da família progressao_niveis após o total depositado aumentar.

CREATE OR REPLACE FUNCTION public.journey_level_for_total(
  p_tenant_id uuid,
  p_total numeric
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH thresholds AS (
    SELECT
      coalesce((level_thresholds->>'bronze')::numeric, 10) AS bronze,
      coalesce((level_thresholds->>'silver')::numeric, 200) AS silver,
      coalesce((level_thresholds->>'gold')::numeric, 500) AS gold,
      coalesce((level_thresholds->>'diamond')::numeric, 1000) AS diamond,
      coalesce((level_thresholds->>'black')::numeric, 3000) AS black
    FROM (SELECT 1) AS seed
    LEFT JOIN public.gamification_settings ON tenant_id = p_tenant_id
  )
  SELECT CASE
    WHEN coalesce(p_total, 0) >= black THEN 'black'
    WHEN coalesce(p_total, 0) >= diamond THEN 'diamond'
    WHEN coalesce(p_total, 0) >= gold THEN 'gold'
    WHEN coalesce(p_total, 0) >= silver THEN 'silver'
    WHEN coalesce(p_total, 0) >= bronze THEN 'bronze'
    ELSE 'novice'
  END
  FROM thresholds;
$$;

CREATE OR REPLACE FUNCTION public.transition_journey_level_on_deposit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_previous_level text;
  v_current_level text;
  v_target_journey record;
  v_deposit_id uuid;
  v_enrollment_id uuid;
BEGIN
  IF coalesce(NEW.total_depositado, 0) <= coalesce(OLD.total_depositado, 0) THEN
    RETURN NEW;
  END IF;

  v_previous_level := public.journey_level_for_total(OLD.tenant_id, OLD.total_depositado);
  v_current_level := public.journey_level_for_total(NEW.tenant_id, NEW.total_depositado);
  IF v_previous_level = v_current_level THEN
    RETURN NEW;
  END IF;

  -- Uma única jornada ativa representa cada nível. A prioridade permite uma
  -- escolha determinística se houver rascunhos/configurações duplicadas.
  SELECT id, version
    INTO v_target_journey
  FROM public.journeys
  WHERE tenant_id = NEW.tenant_id
    AND status = 'active'
    AND conflict_family = 'progressao_niveis'
    AND trigger_type = 'nivel_alterado'
    AND coalesce(trigger_config->>'level', '') = v_current_level
  ORDER BY journey_priority ASC, updated_at ASC, id ASC
  LIMIT 1;

  -- A jornada do nível anterior encerra mesmo quando ainda não há uma jornada
  -- configurada para o novo nível: nenhuma etapa antiga pode ser enviada.
  WITH exited AS (
    UPDATE public.journey_enrollments enrollment
    SET status = 'exited',
        exited_at = now(),
        exit_reason = 'level_changed',
        claimed_at = null,
        claimed_by = null
    FROM public.journeys journey
    WHERE enrollment.journey_id = journey.id
      AND enrollment.tenant_id = NEW.tenant_id
      AND enrollment.player_id = NEW.id
      AND journey.conflict_family = 'progressao_niveis'
      AND enrollment.status::text IN ('active', 'waiting', 'paused_by_priority')
    RETURNING enrollment.id, enrollment.journey_id
  )
  INSERT INTO public.journey_events (tenant_id, journey_id, enrollment_id, event_type, detail)
  SELECT NEW.tenant_id, id, journey_id, 'level_changed', jsonb_build_object(
    'from_level', v_previous_level,
    'to_level', v_current_level,
    'previous_total_deposited', OLD.total_depositado,
    'current_total_deposited', NEW.total_depositado
  )
  FROM exited;

  IF v_target_journey.id IS NULL OR v_current_level = 'novice' THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_deposit_id
  FROM public.deposits
  WHERE tenant_id = NEW.tenant_id
    AND player_id = NEW.id
    AND status = 'aprovado'
  ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC
  LIMIT 1;

  INSERT INTO public.journey_enrollments (
    tenant_id, journey_id, journey_version, player_id, entry_key, metadata
  ) VALUES (
    NEW.tenant_id,
    v_target_journey.id,
    v_target_journey.version,
    NEW.id,
    ('level:' || v_current_level)::text,
    jsonb_build_object(
      'trigger', 'nivel_alterado',
      'from_level', v_previous_level,
      'to_level', v_current_level,
      'previous_total_deposited', OLD.total_depositado,
      'current_total_deposited', NEW.total_depositado,
      'deposit_id', v_deposit_id
    )
  )
  ON CONFLICT (journey_id, player_id, entry_key) DO NOTHING
  RETURNING id INTO v_enrollment_id;

  IF v_enrollment_id IS NOT NULL THEN
    INSERT INTO public.journey_events (tenant_id, journey_id, enrollment_id, event_type, detail)
    VALUES (
      NEW.tenant_id,
      v_target_journey.id,
      v_enrollment_id,
      'level_entered',
      jsonb_build_object(
        'from_level', v_previous_level,
        'to_level', v_current_level,
        'previous_total_deposited', OLD.total_depositado,
        'current_total_deposited', NEW.total_depositado,
        'deposit_id', v_deposit_id
      )
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_players_journey_level_transition ON public.players;
CREATE TRIGGER trg_players_journey_level_transition
  AFTER UPDATE OF total_depositado ON public.players
  FOR EACH ROW
  WHEN (NEW.total_depositado IS DISTINCT FROM OLD.total_depositado)
  EXECUTE FUNCTION public.transition_journey_level_on_deposit();

REVOKE ALL ON FUNCTION public.journey_level_for_total(uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transition_journey_level_on_deposit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.journey_level_for_total(uuid, numeric) TO service_role;
