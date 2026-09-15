
-- 1) Cursor de progresso para campanhas SMS grandes (processadas em chunks por tick)
ALTER TABLE public.sms_campaigns
  ADD COLUMN IF NOT EXISTS sent_cursor int NOT NULL DEFAULT 0;

-- 2) Claim agora também retoma campanhas 'enviando' com lock expirado (>5min)
--    Isso permite continuar campanhas grandes ao longo de vários ticks e
--    recuperar automaticamente quando um tick é interrompido.
CREATE OR REPLACE FUNCTION public.claim_due_sms_campaigns(p_limit integer)
 RETURNS SETOF public.sms_campaigns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lock TEXT := gen_random_uuid()::text;
BEGIN
  RETURN QUERY
  UPDATE public.sms_campaigns c
     SET status = 'enviando',
         locked_at = now(),
         locked_by = v_lock,
         updated_at = now()
    FROM (
      SELECT sc.id FROM public.sms_campaigns sc
       WHERE sc.scheduled_at <= now()
         AND (
           sc.status = 'agendada'
           OR (
             sc.status = 'enviando'
             AND (sc.locked_at IS NULL OR sc.locked_at < now() - interval '5 minutes')
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM public.dispatch_pause_state p
            WHERE p.channel = 'sms' AND p.paused = true AND p.tenant_id = sc.tenant_id
         )
       ORDER BY sc.scheduled_at ASC
       LIMIT p_limit
       FOR UPDATE SKIP LOCKED
    ) picked
   WHERE c.id = picked.id
  RETURNING c.*;
END;
$function$;
