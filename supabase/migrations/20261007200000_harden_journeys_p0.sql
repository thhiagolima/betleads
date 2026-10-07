-- P0 Jornadas: a escrita passa a acontecer apenas pelo servidor, em uma RPC
-- atômica e sempre no tenant informado. Isto impede que uma chamada direta do
-- cliente altere status, etapas ou dados de outra conta.

ALTER TABLE public.journeys
  ADD COLUMN IF NOT EXISTS revision_of uuid REFERENCES public.journeys(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.save_journey_draft(
  p_tenant_id uuid,
  p_journey_id uuid,
  p_actor_user_id uuid,
  p_journey jsonb,
  p_steps jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_status public.journey_status;
  v_version integer;
  v_index integer := 0;
  v_step jsonb;
BEGIN
  IF jsonb_typeof(p_steps) <> 'array' OR jsonb_array_length(p_steps) = 0 THEN
    RAISE EXCEPTION 'A jornada precisa ter ao menos uma etapa.';
  END IF;

  IF p_journey_id IS NULL THEN
    INSERT INTO public.journeys (
      tenant_id, name, description, trigger_type, trigger_config, entry_rules,
      exit_rules, daily_limit, cooldown_hours, status, created_by
    ) VALUES (
      p_tenant_id,
      trim(p_journey->>'name'),
      NULLIF(trim(COALESCE(p_journey->>'description', '')), ''),
      p_journey->>'trigger_type',
      COALESCE(p_journey->'trigger_config', '{}'::jsonb),
      COALESCE(p_journey->'entry_rules', '{}'::jsonb),
      COALESCE(p_journey->'exit_rules', '{}'::jsonb),
      (p_journey->>'daily_limit')::integer,
      (p_journey->>'cooldown_hours')::integer,
      'draft',
      p_actor_user_id
    ) RETURNING id INTO v_id;
  ELSE
    SELECT id, status, version INTO v_id, v_status, v_version
    FROM public.journeys
    WHERE id = p_journey_id AND tenant_id = p_tenant_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Jornada não encontrada.';
    END IF;
    IF v_status <> 'draft' THEN
      -- A versão publicada é imutável: a edição cria um novo rascunho ligado à
      -- origem. A publicação posterior é uma decisão explícita do admin.
      INSERT INTO public.journeys (
        tenant_id, name, description, trigger_type, trigger_config, entry_rules,
        exit_rules, daily_limit, cooldown_hours, status, created_by, version, revision_of
      ) VALUES (
        p_tenant_id,
        concat(trim(p_journey->>'name'), ' · revisão v', v_version + 1),
        NULLIF(trim(COALESCE(p_journey->>'description', '')), ''),
        p_journey->>'trigger_type',
        COALESCE(p_journey->'trigger_config', '{}'::jsonb),
        COALESCE(p_journey->'entry_rules', '{}'::jsonb),
        COALESCE(p_journey->'exit_rules', '{}'::jsonb),
        (p_journey->>'daily_limit')::integer,
        (p_journey->>'cooldown_hours')::integer,
        'draft', p_actor_user_id, v_version + 1, v_id
      ) RETURNING id INTO v_id;
    ELSE
      UPDATE public.journeys
      SET name = trim(p_journey->>'name'),
          description = NULLIF(trim(COALESCE(p_journey->>'description', '')), ''),
          trigger_type = p_journey->>'trigger_type',
          trigger_config = COALESCE(p_journey->'trigger_config', '{}'::jsonb),
          entry_rules = COALESCE(p_journey->'entry_rules', '{}'::jsonb),
          exit_rules = COALESCE(p_journey->'exit_rules', '{}'::jsonb),
          daily_limit = (p_journey->>'daily_limit')::integer,
          cooldown_hours = (p_journey->>'cooldown_hours')::integer,
          version = version + 1
      WHERE id = v_id AND tenant_id = p_tenant_id;

      DELETE FROM public.journey_steps
      WHERE journey_id = v_id AND tenant_id = p_tenant_id;
    END IF;
  END IF;

  FOR v_step IN SELECT value FROM jsonb_array_elements(p_steps)
  LOOP
    INSERT INTO public.journey_steps (tenant_id, journey_id, position, step_type, label, config)
    VALUES (
      p_tenant_id, v_id, v_index,
      (v_step->>'step_type')::public.journey_step_type,
      NULLIF(trim(COALESCE(v_step->>'label', '')), ''),
      COALESCE(v_step->'config', '{}'::jsonb)
    );
    v_index := v_index + 1;
  END LOOP;

  INSERT INTO public.journey_events (tenant_id, journey_id, event_type, detail, actor_user_id)
  VALUES (p_tenant_id, v_id, 'draft_saved', jsonb_build_object('version', CASE WHEN p_journey_id IS NULL THEN 1 ELSE NULL END), p_actor_user_id);

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_journey_draft(uuid, uuid, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_journey_draft(uuid, uuid, uuid, jsonb, jsonb) TO service_role;

-- Clientes autenticados podem consultar somente os próprios dados; toda mutação
-- é mediada por server functions que validam papel, tenant e estado.
REVOKE INSERT, UPDATE, DELETE ON public.journeys, public.journey_steps,
  public.journey_enrollments, public.journey_step_executions, public.journey_events FROM authenticated;
