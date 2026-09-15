
CREATE OR REPLACE FUNCTION public.recover_stuck_sms_leads()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_n INT;
BEGIN
  WITH upd AS (
    UPDATE public.sms_flow_leads
       SET locked_at = NULL,
           locked_by = NULL,
           -- Preserva o agendamento real (delays de horas/dias).
           -- Só puxa para agora se o next_run_at já estava no passado.
           next_run_at = CASE
             WHEN next_run_at IS NULL OR next_run_at <= now() THEN now()
             ELSE next_run_at
           END,
           attempts = COALESCE(attempts,0) + 1,
           exit_reason = COALESCE(exit_reason,'') || CASE WHEN exit_reason IS NULL THEN 'lock_expired_recovered' ELSE '' END,
           updated_at = now()
     WHERE locked_at IS NOT NULL
       AND locked_at < now() - interval '5 minutes'
       AND status IN ('pending','running')
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_n FROM upd;
  RETURN COALESCE(v_n, 0);
END;
$function$;

CREATE OR REPLACE FUNCTION public.recover_stuck_email_leads()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_n INT;
BEGIN
  WITH upd AS (
    UPDATE public.email_flow_leads
       SET locked_at = NULL,
           locked_by = NULL,
           next_run_at = CASE
             WHEN next_run_at IS NULL OR next_run_at <= now() THEN now()
             ELSE next_run_at
           END,
           attempts = COALESCE(attempts,0) + 1,
           exit_reason = COALESCE(exit_reason,'') || CASE WHEN exit_reason IS NULL THEN 'lock_expired_recovered' ELSE '' END,
           updated_at = now()
     WHERE locked_at IS NOT NULL
       AND locked_at < now() - interval '5 minutes'
       AND status IN ('pending','running')
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_n FROM upd;
  RETURN COALESCE(v_n, 0);
END;
$function$;
