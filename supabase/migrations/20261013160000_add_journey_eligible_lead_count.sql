-- Read-only audience preview used by the journey list, including drafts.
-- It mirrors the automatic entry predicates without creating enrollments.
CREATE OR REPLACE FUNCTION public.journey_eligible_lead_count(
  p_tenant_id uuid,
  p_journey_id uuid
)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_journey record;
  v_count bigint := 0;
  v_audience text;
  v_start_after timestamptz;
  v_field text;
  v_hours numeric;
  v_level text;
BEGIN
  SELECT trigger_type, trigger_config, entry_rules
    INTO v_journey
  FROM public.journeys
  WHERE id = p_journey_id AND tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'journey not found';
  END IF;

  v_audience := coalesce(v_journey.entry_rules->>'audience', 'all_active');
  v_start_after := CASE
    WHEN coalesce(v_journey.trigger_config->>'start_after', '') = '' THEN NULL
    ELSE (v_journey.trigger_config->>'start_after')::timestamptz
  END;

  IF v_journey.trigger_type = 'manual' THEN
    RETURN 0;
  END IF;

  IF v_journey.trigger_type = 'cadastrados_sem_deposito' THEN
    SELECT count(*) INTO v_count
    FROM public.players player
    WHERE player.tenant_id = p_tenant_id
      AND player.ftd_em IS NULL
      AND (v_start_after IS NULL OR player.created_at >= v_start_after)
      AND (v_audience <> 'all_active' OR player.status = 'ativo')
      AND (v_audience <> 'vip' OR player.vip = true);

  ELSIF v_journey.trigger_type = 'inactivity' THEN
    v_field := coalesce(v_journey.trigger_config->>'field', 'ultimo_login');
    v_hours := greatest(1, coalesce((v_journey.trigger_config->>'hours')::numeric, 1));
    IF v_field NOT IN ('ultimo_login', 'ultimo_jogo', 'ultimo_deposito') THEN
      RETURN 0;
    END IF;
    SELECT count(*) INTO v_count
    FROM public.players player
    CROSS JOIN LATERAL (
      SELECT CASE v_field
        WHEN 'ultimo_login' THEN player.ultimo_login
        WHEN 'ultimo_jogo' THEN player.ultimo_jogo
        ELSE player.ultimo_deposito
      END AS activity_at
    ) activity
    WHERE player.tenant_id = p_tenant_id
      AND activity.activity_at IS NOT NULL
      AND activity.activity_at <= now() - make_interval(secs => (v_hours * 3600)::double precision)
      AND (v_start_after IS NULL OR activity.activity_at >= v_start_after)
      AND (v_audience <> 'all_active' OR player.status = 'ativo')
      AND (v_audience <> 'vip' OR player.vip = true);

  ELSIF v_journey.trigger_type = 'nivel_alterado' THEN
    v_level := coalesce(v_journey.trigger_config->>'level', '');
    SELECT count(*) INTO v_count
    FROM public.players player
    WHERE player.tenant_id = p_tenant_id
      AND public.journey_level_for_total(p_tenant_id, player.total_depositado) = v_level
      AND (v_audience <> 'all_active' OR player.status = 'ativo')
      AND (v_audience <> 'vip' OR player.vip = true);

  ELSIF v_journey.trigger_type = 'cashback_pago' THEN
    SELECT count(*) INTO v_count
    FROM public.players player
    WHERE player.tenant_id = p_tenant_id
      AND player.last_cashback_paid_at >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'
      AND (v_audience <> 'all_active' OR player.status = 'ativo')
      AND (v_audience <> 'vip' OR player.vip = true);

  ELSIF v_journey.trigger_type = 'primeiro_deposito' THEN
    SELECT count(*) INTO v_count
    FROM public.players player
    WHERE player.tenant_id = p_tenant_id
      AND player.ftd_em IS NOT NULL
      AND (v_start_after IS NULL OR player.ftd_em >= v_start_after)
      AND (v_audience <> 'all_active' OR player.status = 'ativo')
      AND (v_audience <> 'vip' OR player.vip = true);

  ELSIF v_journey.trigger_type = 'pix_gerado_nao_pago' THEN
    SELECT count(*) INTO v_count
    FROM public.players player
    WHERE player.tenant_id = p_tenant_id
      AND (v_audience <> 'all_active' OR player.status = 'ativo')
      AND (v_audience <> 'vip' OR player.vip = true)
      AND EXISTS (
        SELECT 1 FROM public.deposits deposit
        WHERE deposit.tenant_id = p_tenant_id
          AND deposit.player_id = player.id
          AND deposit.status = 'pendente'
          AND deposit.metodo ILIKE '%pix%'
          AND (v_start_after IS NULL OR deposit.created_at >= v_start_after)
      );

  ELSIF v_journey.trigger_type = 'saque_pago' THEN
    SELECT count(*) INTO v_count
    FROM public.players player
    WHERE player.tenant_id = p_tenant_id
      AND (v_audience <> 'all_active' OR player.status = 'ativo')
      AND (v_audience <> 'vip' OR player.vip = true)
      AND EXISTS (
        SELECT 1 FROM public.withdrawals withdrawal
        WHERE withdrawal.tenant_id = p_tenant_id
          AND withdrawal.player_id = player.id
          AND withdrawal.status = 'aprovado'
          AND (v_start_after IS NULL OR withdrawal.created_at >= v_start_after)
      );

  ELSE
    -- For alert-based legacy triggers, current open enrollments are the safest
    -- available preview until those predicates are moved into shared SQL.
    SELECT count(DISTINCT enrollment.player_id) INTO v_count
    FROM public.journey_enrollments enrollment
    WHERE enrollment.tenant_id = p_tenant_id
      AND enrollment.journey_id = p_journey_id
      AND enrollment.status::text IN ('active', 'waiting', 'paused_by_priority');
  END IF;

  RETURN coalesce(v_count, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.journey_eligible_lead_count(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.journey_eligible_lead_count(uuid, uuid)
  TO service_role;
