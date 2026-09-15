-- 1. Drop the temporary mapping table - no longer needed after Queiroz migration
DROP TABLE IF EXISTS public._queiroz_player_map;

-- 2. email_unsubscribe_tokens: revoke any direct grants from anon/authenticated.
-- Server uses service_role (supabaseAdmin) so app continues to work.
REVOKE ALL ON public.email_unsubscribe_tokens FROM anon, authenticated;
GRANT ALL ON public.email_unsubscribe_tokens TO service_role;

-- 3. cashback_payments: ensure no write access for authenticated users.
-- SELECT policy stays (tenant_access). Writes go through service_role only.
REVOKE INSERT, UPDATE, DELETE ON public.cashback_payments FROM anon, authenticated;
GRANT ALL ON public.cashback_payments TO service_role;
