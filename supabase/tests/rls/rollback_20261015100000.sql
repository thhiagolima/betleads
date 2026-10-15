-- ROLLBACK of 20261015100000_fix_rls_privilege_escalation.sql (SEC-01).
-- Restores the state left by CON-08 (20261015090000) as captured read-only in production on
-- 2026-10-15 (supabase/tests/rls/prod_acl_2026-10-15.json) — i.e. it REOPENS F1–F4/F6.
-- Use only if a legitimate flow broke and cannot be fixed forward. Checked by
-- supabase/tests/rls/sec01-matrix.mjs (rollback × CON-08 = 0 differences).
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS tenant_sms_credit_balances_tenant_select ON public.tenant_sms_credit_balances;
DROP POLICY IF EXISTS tenant_sms_credit_balances_super_admin_write ON public.tenant_sms_credit_balances;
DROP POLICY IF EXISTS tenant_sms_credit_balances_tenant_rls ON public.tenant_sms_credit_balances;
CREATE POLICY tenant_sms_credit_balances_tenant_rls ON public.tenant_sms_credit_balances
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS sms_credit_ledger_tenant_select ON public.sms_credit_ledger;
DROP POLICY IF EXISTS sms_credit_ledger_super_admin_write ON public.sms_credit_ledger;
DROP POLICY IF EXISTS sms_credit_ledger_tenant_rls ON public.sms_credit_ledger;
CREATE POLICY sms_credit_ledger_tenant_rls ON public.sms_credit_ledger
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS sms_credit_orders_tenant_select ON public.sms_credit_orders;
DROP POLICY IF EXISTS sms_credit_orders_super_admin_write ON public.sms_credit_orders;
DROP POLICY IF EXISTS sms_credit_orders_tenant_rls ON public.sms_credit_orders;
CREATE POLICY sms_credit_orders_tenant_rls ON public.sms_credit_orders
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS tenant_sms_pricing_tenant_select ON public.tenant_sms_pricing;
DROP POLICY IF EXISTS tenant_sms_pricing_super_admin_write ON public.tenant_sms_pricing;
DROP POLICY IF EXISTS tenant_sms_pricing_tenant_rls ON public.tenant_sms_pricing;
CREATE POLICY tenant_sms_pricing_tenant_rls ON public.tenant_sms_pricing
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS deposits_tenant_select ON public.deposits;
DROP POLICY IF EXISTS deposits_super_admin_write ON public.deposits;
DROP POLICY IF EXISTS deposits_tenant_rls ON public.deposits;
CREATE POLICY deposits_tenant_rls ON public.deposits
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS withdrawals_tenant_select ON public.withdrawals;
DROP POLICY IF EXISTS withdrawals_super_admin_write ON public.withdrawals;
DROP POLICY IF EXISTS withdrawals_tenant_rls ON public.withdrawals;
CREATE POLICY withdrawals_tenant_rls ON public.withdrawals
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS tenant_audit_logs_tenant_select ON public.tenant_audit_logs;
DROP POLICY IF EXISTS tenant_audit_logs_super_admin_write ON public.tenant_audit_logs;
DROP POLICY IF EXISTS tenant_audit_logs_tenant_rls ON public.tenant_audit_logs;
CREATE POLICY tenant_audit_logs_tenant_rls ON public.tenant_audit_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS user_roles_select_own ON public.user_roles;
DROP POLICY IF EXISTS user_roles_super_admin_write ON public.user_roles;
DROP POLICY IF EXISTS user_roles_tenant_rls ON public.user_roles;
DROP POLICY IF EXISTS user_roles_block_super_admin_escalation ON public.user_roles;
DROP POLICY IF EXISTS user_roles_block_tenant_admin_escalation ON public.user_roles;
CREATE POLICY user_roles_tenant_rls ON public.user_roles
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));
CREATE POLICY user_roles_block_super_admin_escalation ON public.user_roles
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((role <> 'super_admin'::public.app_role) OR (select public.is_super_admin()))
  WITH CHECK ((role <> 'super_admin'::public.app_role) OR (select public.is_super_admin()));
CREATE POLICY user_roles_block_tenant_admin_escalation ON public.user_roles
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((role <> 'admin'::public.app_role) OR (select public.is_super_admin()))
  WITH CHECK ((role <> 'admin'::public.app_role) OR (select public.is_super_admin()));

DROP POLICY IF EXISTS meta_connections_tenant_rls ON public.meta_connections;
CREATE POLICY meta_connections_tenant_rls ON public.meta_connections
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS meta_oauth_states_tenant_rls ON public.meta_oauth_states;
CREATE POLICY meta_oauth_states_tenant_rls ON public.meta_oauth_states
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS email_unsubscribe_tokens_tenant_rls ON public.email_unsubscribe_tokens;
CREATE POLICY email_unsubscribe_tokens_tenant_rls ON public.email_unsubscribe_tokens
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS call_providers_super_admin_all ON public.call_providers;
DROP POLICY IF EXISTS call_providers_tenant_rls ON public.call_providers;
CREATE POLICY call_providers_tenant_rls ON public.call_providers
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS email_senders_super_admin_all ON public.email_senders;
DROP POLICY IF EXISTS email_senders_tenant_rls ON public.email_senders;
CREATE POLICY email_senders_tenant_rls ON public.email_senders
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS email_smtp_configs_super_admin_all ON public.email_smtp_configs;
DROP POLICY IF EXISTS email_smtp_configs_tenant_rls ON public.email_smtp_configs;
CREATE POLICY email_smtp_configs_tenant_rls ON public.email_smtp_configs
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS automation_settings_tenant_select ON public.automation_settings;
DROP POLICY IF EXISTS automation_settings_manager_write ON public.automation_settings;
DROP POLICY IF EXISTS automation_settings_tenant_rls ON public.automation_settings;
CREATE POLICY automation_settings_tenant_rls ON public.automation_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS dashboard_settings_tenant_select ON public.dashboard_settings;
DROP POLICY IF EXISTS dashboard_settings_manager_write ON public.dashboard_settings;
DROP POLICY IF EXISTS dashboard_settings_tenant_rls ON public.dashboard_settings;
CREATE POLICY dashboard_settings_tenant_rls ON public.dashboard_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS webhook_configs_tenant_select ON public.webhook_configs;
DROP POLICY IF EXISTS webhook_configs_manager_write ON public.webhook_configs;
DROP POLICY IF EXISTS webhook_configs_tenant_rls ON public.webhook_configs;
CREATE POLICY webhook_configs_tenant_rls ON public.webhook_configs
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS shortio_settings_tenant_select ON public.shortio_settings;
DROP POLICY IF EXISTS shortio_settings_manager_write ON public.shortio_settings;
DROP POLICY IF EXISTS shortio_settings_tenant_rls ON public.shortio_settings;
CREATE POLICY shortio_settings_tenant_rls ON public.shortio_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = any ((select public.accessible_tenant_ids())::uuid[]))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = any ((select public.accessible_tenant_ids())::uuid[]));

-- managed_tenant_ids() is left in place (unused after rollback, harmless).

-- Table privileges of anon/authenticated exactly as before SEC-01 (production, 2026-10-15).
-- Tables that do not exist are skipped. Extra column-level SELECT grants left by SEC-01 on
-- call_providers/webhook_configs are covered by the table-level SELECT restored here.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('activation_runs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('activation_runs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('admin_audit_logs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('admin_audit_logs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('ai_feedback', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('ai_feedback', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('ai_intents', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('ai_intents', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('ai_logs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('ai_logs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('ai_synonyms', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('ai_synonyms', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('ai_training_examples', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('ai_training_examples', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('automation_settings', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('automation_settings', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_audio_generations', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_audio_generations', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_block_sms', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_block_sms', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_blocks', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_blocks', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_executions', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_executions', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_history', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_history', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_post_action', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_post_action', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_progress', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_progress', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_scripts', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_scripts', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flows', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flows', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_history', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_history', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_providers', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_providers', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_queue', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_queue', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_script_versions', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_script_versions', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_scripts', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_scripts', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('campaign_drafts', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('campaign_drafts', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('cashback_payments', 'anon', 'SELECT, TRUNCATE, REFERENCES, TRIGGER'),
      ('cashback_payments', 'authenticated', 'SELECT, TRUNCATE, REFERENCES, TRIGGER'),
      ('channel_consent_audit', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('channel_consent_audit', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('channel_consents', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('channel_consents', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('click_events', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('click_events', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('conversion_attribution_issues', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('conversion_attribution_issues', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('conversion_attributions', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('conversion_attributions', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('conversion_experiment_assignments', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('conversion_experiment_assignments', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('conversion_experiments', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('conversion_experiments', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('conversion_report_audit_events', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('conversion_report_audit_events', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('dashboard_settings', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('dashboard_settings', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('deposits', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('deposits', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('dispatch_pause_state', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('dispatch_pause_state', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('dispatch_rate_state', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('dispatch_rate_state', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('dispatcher_runs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('dispatcher_runs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_automations', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_automations', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_campaigns', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_campaigns', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_flow_blocks', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_flow_blocks', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_flow_leads', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_flow_leads', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_flow_logs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_flow_logs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_flows', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_flows', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_send_logs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_send_logs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_senders', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_senders', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_smtp_configs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_smtp_configs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_template_versions', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_template_versions', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_templates', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_templates', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('events', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('events', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('experts', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('experts', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('financial_webhook_attempts', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('financial_webhook_attempts', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('flow_blocks', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('flow_blocks', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('flow_leads', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('flow_leads', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('flow_logs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('flow_logs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('flow_templates', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('flow_templates', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('flows', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('flows', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('gamification_settings', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('gamification_settings', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_contact_limits', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_enrollments', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_enrollments', 'authenticated', 'SELECT, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_events', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_events', 'authenticated', 'SELECT, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_scan_jobs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_scan_jobs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_step_executions', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_step_executions', 'authenticated', 'SELECT, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_steps', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_steps', 'authenticated', 'SELECT, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_voice_assets', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_voice_assets', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('journeys', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('journeys', 'authenticated', 'SELECT, TRUNCATE, REFERENCES, TRIGGER'),
      ('lead_alerts', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('lead_alerts', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('lead_followups', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('lead_followups', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('link_click_snapshots', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('link_click_snapshots', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('link_dispatches', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('link_dispatches', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('link_tracking_sync_runs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('link_tracking_sync_runs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('marketing_ad_metrics_daily', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('marketing_ad_metrics_daily', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('marketing_integrations', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('marketing_integrations', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_ad_accounts', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_ad_accounts', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_connection_audit', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_connection_audit', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_connections', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_connections', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_oauth_states', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_oauth_states', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_sync_jobs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_sync_jobs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_sync_runs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_sync_runs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('platform_pricing', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('platform_pricing', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('player_attributions', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('player_attributions', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('players', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('players', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('precall_campaigns', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('precall_campaigns', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('precall_leads', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('precall_leads', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('precall_templates', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('precall_templates', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('rules', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('rules', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('send_window_settings', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('send_window_settings', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sessions', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sessions', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('shortio_settings', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('shortio_settings', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_audiences', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_audiences', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_campaigns', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_campaigns', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_credit_ledger', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_credit_ledger', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_credit_orders', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_credit_orders', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_credit_packages', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_credit_packages', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_credit_settings', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_credit_settings', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_flow_daily_usage', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_flow_daily_usage', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_flow_leads', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_flow_leads', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_flow_steps', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_flow_steps', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_flows', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_flows', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_send_logs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_send_logs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_template_versions', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_template_versions', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_templates', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_templates', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('suppressed_emails', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('suppressed_emails', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('system_alerts', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('system_alerts', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tenant_audit_logs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tenant_audit_logs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tenant_daily_metrics', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tenant_daily_metrics', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tenant_sms_credit_balances', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tenant_sms_credit_balances', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tenant_sms_pricing', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tenant_sms_pricing', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tenants', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tenants', 'authenticated', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tracked_links', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tracked_links', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('user_roles', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('user_roles', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('voice_contact_policies', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('voice_contact_policies', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('webhook_configs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('webhook_configs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('webhook_event_receipts', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('webhook_event_receipts', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('webhook_logs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('webhook_logs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('withdrawals', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('withdrawals', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    ) AS v(tbl, grantee, privs)
  LOOP
    IF to_regclass(format('public.%I', r.tbl)) IS NOT NULL THEN
      EXECUTE format('GRANT %s ON public.%I TO %I', r.privs, r.tbl, r.grantee);
    END IF;
  END LOOP;
END $$;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT TRUNCATE ON TABLES TO authenticated;

-- Function EXECUTE exactly as before SEC-01.
GRANT EXECUTE ON FUNCTION public.admin_adjust_sms_credits(uuid,integer,text,text) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_clear_tenant_sms_pricing(uuid) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_users_with_usage(timestamp with time zone,timestamp with time zone) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_mark_sms_credit_order_paid(uuid,text,text,jsonb) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_platform_metrics(timestamp with time zone,timestamp with time zone) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_sms_credit_settings(numeric,numeric,integer,integer) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_tenant_sms_pricing(uuid,numeric,numeric) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_sms_credit_overview() TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_sms_credit_mutation(uuid,integer,text,text,text,text,text,jsonb,uuid) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_sms_credit_checkout(uuid,uuid,integer) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_totals(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_webhook_token(uuid) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_tenant_webhook_token(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_webhook_config_secret(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_tenant_admin(uuid) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_sms_credits(uuid,integer,text,text,text,text) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_sms_credits(uuid,integer,text,text,text) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sms_credit_summary(uuid) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sms_effective_pricing(uuid) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_sms_campaigns(integer) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stuck_sms_campaigns() TO PUBLIC, anon, authenticated;
COMMIT;
