-- SEC-01 — intentional fix of the RLS/privilege findings F1–F4 (+F6) of CON-08
-- (docs/CON-08_RLS_REVISAO_SEGURANCA.md), with the decisions approved on 2026-10-15.
-- Applied AFTER 20261015090000_consolidate_tenant_rls.sql (aborts otherwise).
-- NOT APPLIED automatically — see docs/SEC-01_CORRECAO_PERMISSOES.md (flows checked, access
-- matrix, communication, rollback). Idempotent: every DROP/CREATE/GRANT/REVOKE can be re-run.
--
-- This migration CHANGES access on purpose; every difference is checked by
-- supabase/tests/rls/sec01-matrix.mjs (CON-08 state × SEC-01 × rollback).
--
--   F1  read-only for tenant users (writes: super admin; real writes run as service_role or
--       in SECURITY DEFINER RPCs): tenant_sms_credit_balances, sms_credit_ledger, sms_credit_orders, tenant_sms_pricing, deposits, withdrawals, tenant_audit_logs.
--   F2  user_roles: SELECT own rows (or super admin); writes super admin only (team
--       management runs as service_role after server-side checks).
--   F3  service_role only: meta_connections, meta_oauth_states, email_unsubscribe_tokens.
--       super admin only: call_providers, email_senders, email_smtp_configs.
--       secret columns out of client SELECT: call_providers(api_key, api_secret, headers_config), webhook_configs(secret).
--   CFG config tables: INSERT/UPDATE/DELETE only super admin or admin/gestor of the tenant
--       (SELECT unchanged): automation_settings, dashboard_settings, webhook_configs, shortio_settings.
--       Config tables that a member-reachable screen writes with the user JWT are NOT restricted
--       (send_window_settings, marketing_integrations, gamification_settings, ai_intents,
--       ai_synonyms, ai_training_examples, dispatch_pause_state) — see the doc, section 3.4.
--   F4  anon loses INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER and authenticated loses
--       TRUNCATE on every public table EXCEPT WhatsApp tables (*whatsapp*, antiban_settings).
--   F6  EXECUTE revoked from PUBLIC/anon on 19 SECURITY DEFINER functions (authenticated
--       and service_role keep it), and from authenticated too on 2 service-only functions.
--   WhatsApp tables are untouched by decision (pending, see the doc).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regprocedure('public.accessible_tenant_ids()') IS NULL THEN
    RAISE EXCEPTION 'SEC-01 requires 20261015090000_consolidate_tenant_rls.sql to be applied first';
  END IF;
END $$;

-- ============================================================
-- 0) helper: tenants where the caller is admin or gestor
-- ============================================================
CREATE OR REPLACE FUNCTION public.managed_tenant_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(array_agg(DISTINCT ur.tenant_id), '{}'::uuid[])
  FROM public.user_roles ur
  WHERE ur.user_id = auth.uid()
    AND ur.tenant_id IS NOT NULL
    AND ur.role IN ('admin', 'gestor')
$$;
REVOKE ALL ON FUNCTION public.managed_tenant_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.managed_tenant_ids() TO authenticated, service_role;

-- ============================================================
-- F1) billing / financial tables: tenant users read, only super admin writes
-- ============================================================

DROP POLICY IF EXISTS tenant_sms_credit_balances_tenant_rls ON public.tenant_sms_credit_balances;
DROP POLICY IF EXISTS tenant_sms_credit_balances_tenant_select ON public.tenant_sms_credit_balances;
DROP POLICY IF EXISTS tenant_sms_credit_balances_super_admin_write ON public.tenant_sms_credit_balances;
CREATE POLICY tenant_sms_credit_balances_tenant_select ON public.tenant_sms_credit_balances
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));
CREATE POLICY tenant_sms_credit_balances_super_admin_write ON public.tenant_sms_credit_balances
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()))
  WITH CHECK ((select public.is_super_admin()));

DROP POLICY IF EXISTS sms_credit_ledger_tenant_rls ON public.sms_credit_ledger;
DROP POLICY IF EXISTS sms_credit_ledger_tenant_select ON public.sms_credit_ledger;
DROP POLICY IF EXISTS sms_credit_ledger_super_admin_write ON public.sms_credit_ledger;
CREATE POLICY sms_credit_ledger_tenant_select ON public.sms_credit_ledger
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));
CREATE POLICY sms_credit_ledger_super_admin_write ON public.sms_credit_ledger
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()))
  WITH CHECK ((select public.is_super_admin()));

DROP POLICY IF EXISTS sms_credit_orders_tenant_rls ON public.sms_credit_orders;
DROP POLICY IF EXISTS sms_credit_orders_tenant_select ON public.sms_credit_orders;
DROP POLICY IF EXISTS sms_credit_orders_super_admin_write ON public.sms_credit_orders;
CREATE POLICY sms_credit_orders_tenant_select ON public.sms_credit_orders
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));
CREATE POLICY sms_credit_orders_super_admin_write ON public.sms_credit_orders
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()))
  WITH CHECK ((select public.is_super_admin()));

DROP POLICY IF EXISTS tenant_sms_pricing_tenant_rls ON public.tenant_sms_pricing;
DROP POLICY IF EXISTS tenant_sms_pricing_tenant_select ON public.tenant_sms_pricing;
DROP POLICY IF EXISTS tenant_sms_pricing_super_admin_write ON public.tenant_sms_pricing;
CREATE POLICY tenant_sms_pricing_tenant_select ON public.tenant_sms_pricing
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));
CREATE POLICY tenant_sms_pricing_super_admin_write ON public.tenant_sms_pricing
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()))
  WITH CHECK ((select public.is_super_admin()));

DROP POLICY IF EXISTS deposits_tenant_rls ON public.deposits;
DROP POLICY IF EXISTS deposits_tenant_select ON public.deposits;
DROP POLICY IF EXISTS deposits_super_admin_write ON public.deposits;
CREATE POLICY deposits_tenant_select ON public.deposits
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));
CREATE POLICY deposits_super_admin_write ON public.deposits
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()))
  WITH CHECK ((select public.is_super_admin()));

DROP POLICY IF EXISTS withdrawals_tenant_rls ON public.withdrawals;
DROP POLICY IF EXISTS withdrawals_tenant_select ON public.withdrawals;
DROP POLICY IF EXISTS withdrawals_super_admin_write ON public.withdrawals;
CREATE POLICY withdrawals_tenant_select ON public.withdrawals
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));
CREATE POLICY withdrawals_super_admin_write ON public.withdrawals
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()))
  WITH CHECK ((select public.is_super_admin()));

DROP POLICY IF EXISTS tenant_audit_logs_tenant_rls ON public.tenant_audit_logs;
DROP POLICY IF EXISTS tenant_audit_logs_tenant_select ON public.tenant_audit_logs;
DROP POLICY IF EXISTS tenant_audit_logs_super_admin_write ON public.tenant_audit_logs;
CREATE POLICY tenant_audit_logs_tenant_select ON public.tenant_audit_logs
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));
CREATE POLICY tenant_audit_logs_super_admin_write ON public.tenant_audit_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()))
  WITH CHECK ((select public.is_super_admin()));

-- ============================================================
-- F2) user_roles: read own memberships; only super admin writes
-- ============================================================
DROP POLICY IF EXISTS user_roles_tenant_rls ON public.user_roles;
DROP POLICY IF EXISTS user_roles_block_super_admin_escalation ON public.user_roles;
DROP POLICY IF EXISTS user_roles_block_tenant_admin_escalation ON public.user_roles;
DROP POLICY IF EXISTS user_roles_select_own ON public.user_roles;
DROP POLICY IF EXISTS user_roles_super_admin_write ON public.user_roles;
CREATE POLICY user_roles_select_own ON public.user_roles
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((select public.is_super_admin()) OR user_id = (select auth.uid()));
CREATE POLICY user_roles_super_admin_write ON public.user_roles
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()))
  WITH CHECK ((select public.is_super_admin()));

-- ============================================================
-- F3a) service-only tables (tokens, OAuth nonces): no client access
-- ============================================================
DROP POLICY IF EXISTS meta_connections_tenant_rls ON public.meta_connections;
REVOKE ALL ON public.meta_connections FROM anon, authenticated;
GRANT ALL ON public.meta_connections TO service_role;
DROP POLICY IF EXISTS meta_oauth_states_tenant_rls ON public.meta_oauth_states;
REVOKE ALL ON public.meta_oauth_states FROM anon, authenticated;
GRANT ALL ON public.meta_oauth_states TO service_role;
DROP POLICY IF EXISTS email_unsubscribe_tokens_tenant_rls ON public.email_unsubscribe_tokens;
REVOKE ALL ON public.email_unsubscribe_tokens FROM anon, authenticated;
GRANT ALL ON public.email_unsubscribe_tokens TO service_role;

-- ============================================================
-- F3b) platform configuration: super admin only
-- ============================================================

DROP POLICY IF EXISTS call_providers_tenant_rls ON public.call_providers;
DROP POLICY IF EXISTS call_providers_super_admin_all ON public.call_providers;
CREATE POLICY call_providers_super_admin_all ON public.call_providers
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()))
  WITH CHECK ((select public.is_super_admin()));

DROP POLICY IF EXISTS email_senders_tenant_rls ON public.email_senders;
DROP POLICY IF EXISTS email_senders_super_admin_all ON public.email_senders;
CREATE POLICY email_senders_super_admin_all ON public.email_senders
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()))
  WITH CHECK ((select public.is_super_admin()));

DROP POLICY IF EXISTS email_smtp_configs_tenant_rls ON public.email_smtp_configs;
DROP POLICY IF EXISTS email_smtp_configs_super_admin_all ON public.email_smtp_configs;
CREATE POLICY email_smtp_configs_super_admin_all ON public.email_smtp_configs
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()))
  WITH CHECK ((select public.is_super_admin()));

-- ============================================================
-- CFG) tenant configuration: everyone in the tenant reads, admin/gestor (or super admin) write
-- The write policy is FOR ALL; its USING is a subset of the select policy, so SELECT is unchanged.
-- ============================================================

DROP POLICY IF EXISTS automation_settings_tenant_rls ON public.automation_settings;
DROP POLICY IF EXISTS automation_settings_tenant_select ON public.automation_settings;
DROP POLICY IF EXISTS automation_settings_manager_write ON public.automation_settings;
CREATE POLICY automation_settings_tenant_select ON public.automation_settings
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));
CREATE POLICY automation_settings_manager_write ON public.automation_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR (tenant_id = (select public.current_tenant_id()) AND tenant_id = any ((select public.managed_tenant_ids())::uuid[])))
  WITH CHECK ((select public.is_super_admin()) OR (tenant_id = (select public.current_tenant_id()) AND tenant_id = any ((select public.managed_tenant_ids())::uuid[])));

DROP POLICY IF EXISTS dashboard_settings_tenant_rls ON public.dashboard_settings;
DROP POLICY IF EXISTS dashboard_settings_tenant_select ON public.dashboard_settings;
DROP POLICY IF EXISTS dashboard_settings_manager_write ON public.dashboard_settings;
CREATE POLICY dashboard_settings_tenant_select ON public.dashboard_settings
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));
CREATE POLICY dashboard_settings_manager_write ON public.dashboard_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR (tenant_id = (select public.current_tenant_id()) AND tenant_id = any ((select public.managed_tenant_ids())::uuid[])))
  WITH CHECK ((select public.is_super_admin()) OR (tenant_id = (select public.current_tenant_id()) AND tenant_id = any ((select public.managed_tenant_ids())::uuid[])));

DROP POLICY IF EXISTS webhook_configs_tenant_rls ON public.webhook_configs;
DROP POLICY IF EXISTS webhook_configs_tenant_select ON public.webhook_configs;
DROP POLICY IF EXISTS webhook_configs_manager_write ON public.webhook_configs;
CREATE POLICY webhook_configs_tenant_select ON public.webhook_configs
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));
CREATE POLICY webhook_configs_manager_write ON public.webhook_configs
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR (tenant_id = (select public.current_tenant_id()) AND tenant_id = any ((select public.managed_tenant_ids())::uuid[])))
  WITH CHECK ((select public.is_super_admin()) OR (tenant_id = (select public.current_tenant_id()) AND tenant_id = any ((select public.managed_tenant_ids())::uuid[])));

DROP POLICY IF EXISTS shortio_settings_tenant_rls ON public.shortio_settings;
DROP POLICY IF EXISTS shortio_settings_tenant_select ON public.shortio_settings;
DROP POLICY IF EXISTS shortio_settings_manager_write ON public.shortio_settings;
CREATE POLICY shortio_settings_tenant_select ON public.shortio_settings
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = any ((select public.accessible_tenant_ids())::uuid[]));
CREATE POLICY shortio_settings_manager_write ON public.shortio_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = any ((select public.managed_tenant_ids())::uuid[]))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = any ((select public.managed_tenant_ids())::uuid[]));

-- ============================================================
-- F3c) secret columns: SELECT granted per column, secrets excluded.
-- A table-level REVOKE also drops existing column grants; the column list is read from the
-- catalog, so the block is idempotent and picks up new columns. INSERT/UPDATE stay.
-- ============================================================
DO $$
DECLARE
  r record;
  cols text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('call_providers'::text, ARRAY['api_key', 'api_secret', 'headers_config']::text[]),
      ('webhook_configs'::text, ARRAY['secret']::text[])
    ) AS v(tbl, secret)
  LOOP
    EXECUTE format('REVOKE SELECT ON public.%I FROM anon, authenticated', r.tbl);
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
      INTO cols
      FROM pg_attribute a
     WHERE a.attrelid = format('public.%I', r.tbl)::regclass
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND a.attname <> ALL (r.secret);
    EXECUTE format('GRANT SELECT (%s) ON public.%I TO authenticated', cols, r.tbl);
  END LOOP;
END $$;

-- email_smtp_configs is super-admin-only after F3b; anon never needs to read it.
REVOKE SELECT ON public.email_smtp_configs FROM anon;

-- ============================================================
-- F4) anon: no write privileges; nobody: TRUNCATE (ignores RLS). WhatsApp tables skipped.
-- ============================================================
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND NOT (c.relname LIKE '%whatsapp%' OR c.relname = 'antiban_settings')
  LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.%I FROM anon', r.relname);
    EXECUTE format('REVOKE TRUNCATE ON public.%I FROM authenticated', r.relname);
  END LOOP;
END $$;
-- Tables created later by role postgres (migrations) no longer grant these to anon.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE ON TABLES FROM authenticated;

-- ============================================================
-- F6) SECURITY DEFINER functions: no EXECUTE for PUBLIC/anon
-- (all verified to be called only by logged-in users or service_role; none is a trigger)
-- ============================================================
REVOKE EXECUTE ON FUNCTION public.admin_adjust_sms_credits(uuid,integer,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_adjust_sms_credits(uuid,integer,text,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_clear_tenant_sms_pricing(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_clear_tenant_sms_pricing(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_list_users_with_usage(timestamp with time zone,timestamp with time zone) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_users_with_usage(timestamp with time zone,timestamp with time zone) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_mark_sms_credit_order_paid(uuid,text,text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_mark_sms_credit_order_paid(uuid,text,text,jsonb) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_platform_metrics(timestamp with time zone,timestamp with time zone) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_platform_metrics(timestamp with time zone,timestamp with time zone) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_set_sms_credit_settings(numeric,numeric,integer,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_sms_credit_settings(numeric,numeric,integer,integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_set_tenant_sms_pricing(uuid,numeric,numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_tenant_sms_pricing(uuid,numeric,numeric) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_sms_credit_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_sms_credit_overview() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.apply_sms_credit_mutation(uuid,integer,text,text,text,text,text,jsonb,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_sms_credit_mutation(uuid,integer,text,text,text,text,text,jsonb,uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.create_sms_credit_checkout(uuid,uuid,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_sms_credit_checkout(uuid,uuid,integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.dashboard_totals(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_totals(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_my_webhook_token(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_webhook_token(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_tenant_webhook_token(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tenant_webhook_token(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_webhook_config_secret(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_webhook_config_secret(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.is_tenant_admin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_tenant_admin(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.refund_sms_credits(uuid,integer,text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refund_sms_credits(uuid,integer,text,text,text,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.reserve_sms_credits(uuid,integer,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reserve_sms_credits(uuid,integer,text,text,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.sms_credit_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sms_credit_summary(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.sms_effective_pricing(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sms_effective_pricing(uuid) TO authenticated, service_role;
-- service-only (no caller check inside; used by the SMS dispatcher with service_role / pg_cron)
REVOKE EXECUTE ON FUNCTION public.claim_due_sms_campaigns(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_sms_campaigns(integer) TO service_role;
REVOKE EXECUTE ON FUNCTION public.recover_stuck_sms_campaigns() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stuck_sms_campaigns() TO service_role;

COMMIT;
