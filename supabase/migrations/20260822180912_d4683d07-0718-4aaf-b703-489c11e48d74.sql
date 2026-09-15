-- Lock down unsubscribe tokens: server-only access, no client (anon/authenticated) reach.
ALTER TABLE public.email_unsubscribe_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_unsubscribe_tokens FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.email_unsubscribe_tokens FROM anon;
REVOKE ALL ON public.email_unsubscribe_tokens FROM authenticated;
REVOKE ALL ON public.email_unsubscribe_tokens FROM PUBLIC;
GRANT ALL ON public.email_unsubscribe_tokens TO service_role;

-- Explicit tenant-scoped read policy for tenant members only (defense in depth if
-- table privileges are ever widened again). No anon/authenticated policy for tokens.
DROP POLICY IF EXISTS "unsub_tokens_no_client_access" ON public.email_unsubscribe_tokens;
CREATE POLICY "unsub_tokens_no_client_access"
ON public.email_unsubscribe_tokens
FOR SELECT
TO authenticated
USING (false);