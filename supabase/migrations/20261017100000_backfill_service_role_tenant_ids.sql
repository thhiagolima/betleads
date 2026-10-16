-- F0-04: rows written by service-role workers without tenant_id fell back to
-- the column default COALESCE(current_tenant_id(), main tenant). current_tenant_id()
-- is NULL for the service role, so every house's rows below were filed under
-- the main tenant: visible to it under RLS and invisible to their owner.
-- The code now writes tenant_id explicitly; this re-homes the existing rows
-- from the parent row that owns them. Idempotent: only mismatches change.
--
-- Run off-peak: flow_logs and call_flow_history can be large.

BEGIN;

-- Child of a flow: the flow's tenant is authoritative (flows are created
-- through RLS with the right tenant).
UPDATE public.flow_leads c
   SET tenant_id = f.tenant_id
  FROM public.flows f
 WHERE c.flow_id = f.id AND c.tenant_id IS DISTINCT FROM f.tenant_id;

UPDATE public.flow_logs c
   SET tenant_id = f.tenant_id
  FROM public.flows f
 WHERE c.flow_id = f.id AND c.tenant_id IS DISTINCT FROM f.tenant_id;

-- flow_logs without a flow (skipped_lower_priority) belong to the player's tenant.
UPDATE public.flow_logs c
   SET tenant_id = p.tenant_id
  FROM public.players p
 WHERE c.flow_id IS NULL AND c.player_id = p.id
   AND c.tenant_id IS DISTINCT FROM p.tenant_id;

UPDATE public.lead_alerts c
   SET tenant_id = p.tenant_id
  FROM public.players p
 WHERE c.player_id = p.id AND c.tenant_id IS DISTINCT FROM p.tenant_id;

UPDATE public.email_flow_logs c
   SET tenant_id = f.tenant_id
  FROM public.email_flows f
 WHERE c.flow_id = f.id AND c.tenant_id IS DISTINCT FROM f.tenant_id;

UPDATE public.call_flow_progress c
   SET tenant_id = f.tenant_id
  FROM public.call_flows f
 WHERE c.flow_id = f.id AND c.tenant_id IS DISTINCT FROM f.tenant_id;

UPDATE public.call_flow_history c
   SET tenant_id = f.tenant_id
  FROM public.call_flows f
 WHERE c.flow_id = f.id AND c.tenant_id IS DISTINCT FROM f.tenant_id;

-- A lead's WhatsApp assignment belongs to the tenant of its session.
UPDATE public.lead_whatsapp_assignments c
   SET tenant_id = s.tenant_id
  FROM public.whatsapp_sessions s
 WHERE c.session_id = s.id AND c.tenant_id IS DISTINCT FROM s.tenant_id;

COMMIT;
