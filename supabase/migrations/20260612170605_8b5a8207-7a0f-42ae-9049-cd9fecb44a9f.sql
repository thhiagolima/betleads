
-- 1. Pause state table (per channel, per tenant)
CREATE TABLE IF NOT EXISTS public.dispatch_pause_state (
  channel    text NOT NULL CHECK (channel IN ('sms','email','call')),
  tenant_id  uuid NOT NULL DEFAULT COALESCE(current_tenant_id(), '00000000-0000-0000-0000-000000000001'::uuid),
  paused     boolean NOT NULL DEFAULT false,
  paused_at  timestamptz,
  reason     text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, tenant_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dispatch_pause_state TO authenticated;
GRANT ALL ON public.dispatch_pause_state TO service_role;
ALTER TABLE public.dispatch_pause_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pause_tenant_isolation" ON public.dispatch_pause_state;
CREATE POLICY "pause_tenant_isolation" ON public.dispatch_pause_state
  FOR ALL TO authenticated
  USING (tenant_id = current_tenant_id() OR is_super_admin())
  WITH CHECK (tenant_id = current_tenant_id() OR is_super_admin());

DROP TRIGGER IF EXISTS trg_dispatch_pause_state_updated_at ON public.dispatch_pause_state;
CREATE TRIGGER trg_dispatch_pause_state_updated_at
  BEFORE UPDATE ON public.dispatch_pause_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 2. Patch claim_* RPCs to skip work when paused for that lead's tenant
CREATE OR REPLACE FUNCTION public.claim_sms_flow_leads(p_limit integer)
 RETURNS SETOF sms_flow_leads
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lock TEXT := gen_random_uuid()::text;
BEGIN
  RETURN QUERY
  UPDATE public.sms_flow_leads l
     SET next_run_at = now() + interval '5 minutes',
         locked_at = now(),
         locked_by = v_lock,
         updated_at = now()
    FROM (
      SELECT sl.id FROM public.sms_flow_leads sl
       WHERE sl.status IN ('pending','running')
         AND sl.next_run_at <= now()
         AND NOT EXISTS (
           SELECT 1 FROM public.dispatch_pause_state p
            WHERE p.channel = 'sms' AND p.paused = true AND p.tenant_id = sl.tenant_id
         )
       ORDER BY sl.next_run_at ASC
       LIMIT p_limit
       FOR UPDATE SKIP LOCKED
    ) picked
   WHERE l.id = picked.id
  RETURNING l.*;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_email_flow_leads(p_limit integer)
 RETURNS SETOF email_flow_leads
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lock TEXT := gen_random_uuid()::text;
BEGIN
  RETURN QUERY
  UPDATE public.email_flow_leads l
     SET next_run_at = now() + interval '5 minutes',
         locked_at = now(),
         locked_by = v_lock,
         updated_at = now()
    FROM (
      SELECT el.id FROM public.email_flow_leads el
       WHERE el.status IN ('pending','running')
         AND el.next_run_at <= now()
         AND NOT EXISTS (
           SELECT 1 FROM public.dispatch_pause_state p
            WHERE p.channel = 'email' AND p.paused = true AND p.tenant_id = el.tenant_id
         )
       ORDER BY el.next_run_at ASC
       LIMIT p_limit
       FOR UPDATE SKIP LOCKED
    ) picked
   WHERE l.id = picked.id
  RETURNING l.*;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_due_email_campaigns(p_limit integer)
 RETURNS SETOF email_campaigns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lock TEXT := gen_random_uuid()::text;
BEGIN
  RETURN QUERY
  UPDATE public.email_campaigns c
     SET status = 'enviando',
         locked_at = now(),
         locked_by = v_lock,
         updated_at = now()
    FROM (
      SELECT ec.id FROM public.email_campaigns ec
       WHERE ec.status = 'agendada'
         AND ec.scheduled_at <= now()
         AND NOT EXISTS (
           SELECT 1 FROM public.dispatch_pause_state p
            WHERE p.channel = 'email' AND p.paused = true AND p.tenant_id = ec.tenant_id
         )
       ORDER BY ec.scheduled_at ASC
       LIMIT p_limit
       FOR UPDATE SKIP LOCKED
    ) picked
   WHERE c.id = picked.id
  RETURNING c.*;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_call_flow_progress(p_limit integer)
 RETURNS SETOF call_flow_progress
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  UPDATE public.call_flow_progress p
     SET next_run_at = now() + interval '5 minutes',
         updated_at = now()
    FROM (
      SELECT cp.id FROM public.call_flow_progress cp
       WHERE cp.status = 'active'
         AND cp.next_run_at <= now()
         AND NOT EXISTS (
           SELECT 1 FROM public.dispatch_pause_state ps
            WHERE ps.channel = 'call' AND ps.paused = true AND ps.tenant_id = cp.tenant_id
         )
       ORDER BY cp.next_run_at ASC
       LIMIT p_limit
       FOR UPDATE SKIP LOCKED
    ) picked
   WHERE p.id = picked.id
  RETURNING p.*;
END;
$function$;
