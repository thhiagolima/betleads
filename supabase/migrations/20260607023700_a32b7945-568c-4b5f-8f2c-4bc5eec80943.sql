
REVOKE EXECUTE ON FUNCTION public.claim_sms_flow_leads(integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_email_flow_leads(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_sms_flow_leads(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_email_flow_leads(integer) TO service_role;
