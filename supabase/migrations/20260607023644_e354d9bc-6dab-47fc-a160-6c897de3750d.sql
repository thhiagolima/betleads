
REVOKE EXECUTE ON FUNCTION public.consume_dispatch_budget(TEXT, INT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.register_provider_throttle(TEXT, INT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recover_stuck_sms_leads() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recover_stuck_email_leads() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recover_stuck_email_campaigns() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_due_email_campaigns(integer) FROM PUBLIC, anon, authenticated;
