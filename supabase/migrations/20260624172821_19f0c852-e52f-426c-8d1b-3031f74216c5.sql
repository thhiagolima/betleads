
-- call_providers: revoke sensitive columns from client roles
REVOKE SELECT (api_key, api_secret) ON public.call_providers FROM authenticated, anon;

-- email_smtp_configs: revoke sensitive columns from client roles
REVOKE SELECT (password_encrypted, username) ON public.email_smtp_configs FROM authenticated, anon;

-- whatsapp_proxies: revoke sensitive columns from client roles
REVOKE SELECT (password_encrypted, username) ON public.whatsapp_proxies FROM authenticated, anon;

-- webhook_configs.secret: reaffirm column-level revoke (idempotent safety net)
REVOKE SELECT (secret) ON public.webhook_configs FROM authenticated, anon;

-- cashback_payments: add explicit restrictive policy blocking client writes,
-- so any future permissive policy cannot accidentally allow tenant users to
-- insert/update/delete cashback rows. service_role bypasses RLS.
DROP POLICY IF EXISTS cashback_payments_block_client_writes ON public.cashback_payments;
CREATE POLICY cashback_payments_block_client_writes
  ON public.cashback_payments
  AS RESTRICTIVE
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

-- Re-allow SELECT (the restrictive policy above blocks ALL; we still want tenant reads).
-- Restrictive policy applies to ALL actions, so we need a SELECT-only restrictive
-- instead. Replace with a write-only restrictive.
DROP POLICY IF EXISTS cashback_payments_block_client_writes ON public.cashback_payments;
CREATE POLICY cashback_payments_block_client_insert
  ON public.cashback_payments AS RESTRICTIVE FOR INSERT TO authenticated, anon WITH CHECK (false);
CREATE POLICY cashback_payments_block_client_update
  ON public.cashback_payments AS RESTRICTIVE FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY cashback_payments_block_client_delete
  ON public.cashback_payments AS RESTRICTIVE FOR DELETE TO authenticated, anon USING (false);

-- email_unsubscribe_tokens: ensure RLS is enabled and revoke any client privileges.
ALTER TABLE public.email_unsubscribe_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_unsubscribe_tokens FROM authenticated, anon;
GRANT ALL ON public.email_unsubscribe_tokens TO service_role;

COMMENT ON TABLE public.email_unsubscribe_tokens IS
  'Fail-closed: no client RLS policies. Access only via service_role from server functions / edge functions. Do not add permissive client policies.';
