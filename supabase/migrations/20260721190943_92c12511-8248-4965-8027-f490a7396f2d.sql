
CREATE TABLE public.sms_campaigns (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  route TEXT NOT NULL DEFAULT 'iGaming',
  recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'agendada',
  scheduled_at TIMESTAMPTZ NOT NULL,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_error TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sms_campaigns_status_chk CHECK (status IN ('agendada','enviando','enviado','falhou','cancelada'))
);

CREATE INDEX idx_sms_campaigns_tenant ON public.sms_campaigns(tenant_id);
CREATE INDEX idx_sms_campaigns_due ON public.sms_campaigns(status, scheduled_at) WHERE status = 'agendada';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sms_campaigns TO authenticated;
GRANT ALL ON public.sms_campaigns TO service_role;

ALTER TABLE public.sms_campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members manage sms campaigns"
  ON public.sms_campaigns FOR ALL
  TO authenticated
  USING (public.has_tenant_access(tenant_id))
  WITH CHECK (public.has_tenant_access(tenant_id));

CREATE TRIGGER sms_campaigns_set_updated_at
  BEFORE UPDATE ON public.sms_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

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
       WHERE sc.status = 'agendada'
         AND sc.scheduled_at <= now()
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

CREATE OR REPLACE FUNCTION public.recover_stuck_sms_campaigns()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_n INT;
BEGIN
  WITH upd AS (
    UPDATE public.sms_campaigns
       SET locked_at = NULL,
           locked_by = NULL,
           status = 'agendada',
           updated_at = now()
     WHERE locked_at IS NOT NULL
       AND locked_at < now() - interval '15 minutes'
       AND status = 'enviando'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_n FROM upd;
  RETURN COALESCE(v_n, 0);
END;
$function$;
