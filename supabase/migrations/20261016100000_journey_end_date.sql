-- Journey end date (D-4, docs/ESCOPO_AUDITORIA_GATILHOS_JORNADAS_2026-10-15.md)
--
-- Optional journeys.ends_at, set on create/edit. From that moment the journey
-- takes no new entries and its open enrollments exit as `journey_ended` on the
-- next exit sweep. Loops keep running by default when no end date is set.

ALTER TABLE public.journeys ADD COLUMN IF NOT EXISTS ends_at timestamptz;

COMMENT ON COLUMN public.journeys.ends_at IS
  'Optional end of the journey (D-4): no new entries after it, open enrollments exit as journey_ended.';

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

CREATE OR REPLACE FUNCTION public.sweep_journey_exits(p_limit integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH phone_journeys AS (
    SELECT j.id FROM public.journeys j WHERE public.journey_requires_phone(j.id)
  ),
  evaluated AS (
    SELECT e.id,
      CASE
        WHEN j.status::text = 'archived' THEN 'journey_archived'
        WHEN j.ends_at IS NOT NULL AND j.ends_at <= now() THEN 'journey_ended'
        WHEN coalesce(j.exit_rules->>'deposit', '') = 'true'
             AND p.ultimo_deposito > e.entered_at THEN 'deposit'
        WHEN coalesce(j.exit_rules->>'first_deposit', '') = 'true'
             AND p.ftd_em > e.entered_at THEN 'first_deposit'
        WHEN coalesce(j.exit_rules->>'login', '') = 'true'
             AND greatest(p.ultimo_login, p.ultimo_jogo) > e.entered_at THEN 'login'
        WHEN coalesce(j.exit_rules->>'voltou_jogar', '') = 'true'
             AND p.ultimo_jogo > e.entered_at THEN 'voltou_jogar'
        WHEN coalesce(j.exit_rules->>'inactivity_over_hours', '') ~ '^[0-9]+(\.[0-9]+)?$'
             AND (CASE coalesce(j.trigger_config->>'field', 'ultimo_deposito')
                    WHEN 'ultimo_login' THEN p.ultimo_login
                    WHEN 'ultimo_jogo' THEN p.ultimo_jogo
                    ELSE p.ultimo_deposito
                  END) <= now() - make_interval(
                    secs => ((j.exit_rules->>'inactivity_over_hours')::numeric * 3600)::double precision)
          THEN 'inactivity_threshold'
        WHEN e.journey_id IN (SELECT id FROM phone_journeys)
             AND coalesce(regexp_replace(p.telefone, '\D', '', 'g'), '') = '' THEN 'no_contact'
      END AS reason
    FROM public.journey_enrollments e
    JOIN public.journeys j ON j.id = e.journey_id
    LEFT JOIN public.players p ON p.id = e.player_id
    WHERE e.status IN ('active', 'waiting', 'paused_by_priority')
      -- Never race a worker that holds the item.
      AND (e.claimed_at IS NULL
           OR coalesce(e.lease_expires_at, e.claimed_at + interval '10 minutes') < now())
  ),
  picked AS (
    SELECT ev.id, ev.reason
    FROM evaluated ev
    JOIN public.journey_enrollments e ON e.id = ev.id
    WHERE ev.reason IS NOT NULL
    LIMIT greatest(1, coalesce(p_limit, 1000))
    FOR UPDATE OF e SKIP LOCKED
  ),
  exited AS (
    UPDATE public.journey_enrollments e
    SET status = 'exited', exited_at = now(), exit_reason = picked.reason,
        claimed_at = NULL, claimed_by = NULL,
        -- A player without contact may enter again once a phone arrives.
        entry_key = CASE WHEN picked.reason = 'no_contact'
                         THEN left(e.entry_key || ':no_contact:' || e.id::text, 160)
                         ELSE e.entry_key END
    FROM picked
    WHERE e.id = picked.id AND e.status IN ('active', 'waiting', 'paused_by_priority')
    RETURNING e.id, e.tenant_id, e.journey_id, picked.reason
  ),
  logged AS (
    INSERT INTO public.journey_events (tenant_id, journey_id, enrollment_id, event_type, detail)
    SELECT tenant_id, journey_id, id, 'exited',
           jsonb_build_object('reason', reason, 'source', 'exit_sweep')
    FROM exited
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM logged;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.sweep_journey_exits(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_journey_exits(integer) TO service_role;
