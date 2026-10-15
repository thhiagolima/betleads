-- Production policies (2026-10-14) of the 120 tables touched by CON-08. Generated.
CREATE POLICY activation_runs_tenant_isolation ON public.activation_runs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.activation_runs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.activation_runs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY admin_audit_logs_super_admin ON public.admin_audit_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY ai_feedback_tenant_isolation ON public.ai_feedback
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.ai_feedback
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.ai_feedback
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY ai_intents_super_admin_write ON public.ai_intents
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY ai_intents_tenant_read ON public.ai_intents
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_super_admin() OR (tenant_id = current_tenant_id())));
CREATE POLICY tenant_access_base ON public.ai_intents
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.ai_intents
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY ai_logs_tenant_isolation ON public.ai_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.ai_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.ai_logs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY ai_synonyms_super_admin_write ON public.ai_synonyms
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY ai_synonyms_tenant_read ON public.ai_synonyms
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_super_admin() OR (tenant_id = current_tenant_id())));
CREATE POLICY tenant_access_base ON public.ai_synonyms
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.ai_synonyms
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY ai_training_examples_super_admin_write ON public.ai_training_examples
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY ai_training_examples_tenant_read ON public.ai_training_examples
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_super_admin() OR (tenant_id = current_tenant_id())));
CREATE POLICY tenant_access_base ON public.ai_training_examples
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.ai_training_examples
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY antiban_settings_super_admin_read ON public.antiban_settings
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_super_admin());
CREATE POLICY antiban_settings_super_admin_write ON public.antiban_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY tenant_access_base ON public.antiban_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.antiban_settings
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY automation_settings_tenant_isolation ON public.automation_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.automation_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.automation_settings
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY call_audio_generations_tenant_isolation ON public.call_audio_generations
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_audio_generations
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_audio_generations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY call_flow_block_sms_tenant_isolation ON public.call_flow_block_sms
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_flow_block_sms
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_flow_block_sms
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY call_flow_blocks_tenant_isolation ON public.call_flow_blocks
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_flow_blocks
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_flow_blocks
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY call_flow_executions_tenant_isolation ON public.call_flow_executions
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_flow_executions
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_flow_executions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY call_flow_history_tenant_isolation ON public.call_flow_history
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_flow_history
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_flow_history
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY call_flow_post_action_tenant_isolation ON public.call_flow_post_action
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_flow_post_action
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_flow_post_action
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY call_flow_progress_tenant_isolation ON public.call_flow_progress
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_flow_progress
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_flow_progress
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY call_flow_scripts_tenant_isolation ON public.call_flow_scripts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_flow_scripts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_flow_scripts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY call_flows_tenant_isolation ON public.call_flows
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_flows
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_flows
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY call_history_tenant_isolation ON public.call_history
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_history
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_history
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY call_providers_super_admin_read ON public.call_providers
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_super_admin());
CREATE POLICY call_providers_super_admin_write ON public.call_providers
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY tenant_access_base ON public.call_providers
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_providers
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY call_queue_tenant_isolation ON public.call_queue
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_queue
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_queue
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY call_script_versions_tenant_select ON public.call_script_versions
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((tenant_id = current_tenant_id()));
CREATE POLICY call_scripts_tenant_isolation ON public.call_scripts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_scripts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_scripts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY campaign_drafts_tenant_delete ON public.campaign_drafts
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((has_tenant_access(tenant_id) AND (status = 'draft'::text)));
CREATE POLICY campaign_drafts_tenant_insert ON public.campaign_drafts
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((has_tenant_access(tenant_id) AND (created_by = auth.uid())));
CREATE POLICY campaign_drafts_tenant_select ON public.campaign_drafts
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));
CREATE POLICY campaign_drafts_tenant_update ON public.campaign_drafts
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((has_tenant_access(tenant_id) AND (status = 'draft'::text)))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY cashback_payments_block_client_delete ON public.cashback_payments
  AS RESTRICTIVE FOR DELETE TO anon, authenticated
  USING (false);
CREATE POLICY cashback_payments_block_client_insert ON public.cashback_payments
  AS RESTRICTIVE FOR INSERT TO anon, authenticated
  WITH CHECK (false);
CREATE POLICY cashback_payments_block_client_update ON public.cashback_payments
  AS RESTRICTIVE FOR UPDATE TO anon, authenticated
  USING (false)
  WITH CHECK (false);
CREATE POLICY "tenant members read cashback_payments" ON public.cashback_payments
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));
CREATE POLICY tenant_access_base ON public.cashback_payments
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.cashback_payments
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY channel_consent_audit_tenant_read ON public.channel_consent_audit
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));
CREATE POLICY channel_consents_tenant_access ON public.channel_consents
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY click_events_tenant_select ON public.click_events
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));
CREATE POLICY conversion_attribution_issues_admin_select ON public.conversion_attribution_issues
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_super_admin() OR (EXISTS ( SELECT 1
   FROM user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND (ur.tenant_id = conversion_attribution_issues.tenant_id) AND (ur.role = 'admin'::app_role))))));
CREATE POLICY conversion_attributions_tenant_select ON public.conversion_attributions
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));
CREATE POLICY conversion_experiment_assignments_tenant_select ON public.conversion_experiment_assignments
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_super_admin() OR (EXISTS ( SELECT 1
   FROM user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND (ur.tenant_id = conversion_experiment_assignments.tenant_id) AND (ur.role = 'admin'::app_role))))));
CREATE POLICY conversion_experiments_admin_delete ON public.conversion_experiments
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((is_super_admin() OR (EXISTS ( SELECT 1
   FROM user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND (ur.tenant_id = conversion_experiments.tenant_id) AND (ur.role = 'admin'::app_role))))));
CREATE POLICY conversion_experiments_admin_insert ON public.conversion_experiments
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((is_super_admin() OR (EXISTS ( SELECT 1
   FROM user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND (ur.tenant_id = conversion_experiments.tenant_id) AND (ur.role = 'admin'::app_role))))));
CREATE POLICY conversion_experiments_admin_update ON public.conversion_experiments
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((is_super_admin() OR (EXISTS ( SELECT 1
   FROM user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND (ur.tenant_id = conversion_experiments.tenant_id) AND (ur.role = 'admin'::app_role))))))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY conversion_experiments_tenant_select ON public.conversion_experiments
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));
CREATE POLICY "dashboard settings tenant isolation" ON public.dashboard_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY deposits_tenant_isolation ON public.deposits
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.deposits
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.deposits
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY pause_tenant_isolation ON public.dispatch_pause_state
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.dispatch_pause_state
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.dispatch_pause_state
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY dispatch_rate_state_super_admin ON public.dispatch_rate_state
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_super_admin());
CREATE POLICY dispatcher_runs_super_admin ON public.dispatcher_runs
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_super_admin());
CREATE POLICY email_automations_tenant_isolation ON public.email_automations
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.email_automations
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.email_automations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY email_campaigns_tenant_isolation ON public.email_campaigns
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.email_campaigns
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.email_campaigns
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY email_flow_blocks_tenant_isolation ON public.email_flow_blocks
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.email_flow_blocks
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.email_flow_blocks
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY email_flow_leads_tenant_isolation ON public.email_flow_leads
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.email_flow_leads
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.email_flow_leads
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY email_flow_logs_tenant_isolation ON public.email_flow_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.email_flow_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.email_flow_logs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY email_flows_tenant_isolation ON public.email_flows
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.email_flows
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.email_flows
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY email_send_logs_tenant_isolation ON public.email_send_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.email_send_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.email_send_logs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY email_senders_super_admin_mutate ON public.email_senders
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY email_senders_super_admin_select ON public.email_senders
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_super_admin());
CREATE POLICY tenant_access_base ON public.email_senders
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.email_senders
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY email_smtp_configs_super_admin_mutate ON public.email_smtp_configs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY email_smtp_configs_super_admin_select ON public.email_smtp_configs
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_super_admin());
CREATE POLICY tenant_access_base ON public.email_smtp_configs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.email_smtp_configs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY email_template_versions_tenant_select ON public.email_template_versions
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((tenant_id = current_tenant_id()));
CREATE POLICY email_templates_tenant_isolation ON public.email_templates
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.email_templates
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.email_templates
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.email_unsubscribe_tokens
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.email_unsubscribe_tokens
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY unsub_tokens_no_client_access ON public.email_unsubscribe_tokens
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (false);
CREATE POLICY events_tenant_isolation ON public.events
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.events
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.events
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY experts_tenant_isolation ON public.experts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.experts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.experts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY flow_blocks_tenant_isolation ON public.flow_blocks
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.flow_blocks
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.flow_blocks
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY flow_leads_tenant_isolation ON public.flow_leads
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.flow_leads
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.flow_leads
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY flow_logs_tenant_isolation ON public.flow_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.flow_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.flow_logs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY flow_templates_tenant_access ON public.flow_templates
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.flow_templates
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.flow_templates
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY flows_tenant_isolation ON public.flows
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.flows
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.flows
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY gamification_settings_tenant_isolation ON public.gamification_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.gamification_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.gamification_settings
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY journey_contact_limits_tenant_isolation ON public.journey_contact_limits
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY journey_enrollments_tenant_isolation ON public.journey_enrollments
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY journey_events_tenant_isolation ON public.journey_events
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY journey_scan_jobs_tenant_read ON public.journey_scan_jobs
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));
CREATE POLICY journey_step_executions_tenant_isolation ON public.journey_step_executions
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY journey_steps_tenant_isolation ON public.journey_steps
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY journey_voice_assets_tenant_access ON public.journey_voice_assets
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((tenant_id = current_tenant_id()))
  WITH CHECK ((tenant_id = current_tenant_id()));
CREATE POLICY journeys_tenant_isolation ON public.journeys
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY lead_alerts_tenant_isolation ON public.lead_alerts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.lead_alerts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.lead_alerts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY lead_followups_tenant_isolation ON public.lead_followups
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.lead_followups
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.lead_followups
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY lead_whatsapp_assignments_tenant_isolation ON public.lead_whatsapp_assignments
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.lead_whatsapp_assignments
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.lead_whatsapp_assignments
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.link_click_snapshots
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.link_click_snapshots
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_access_base ON public.link_dispatches
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.link_dispatches
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_access_base ON public.link_tracking_sync_runs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.link_tracking_sync_runs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY marketing_ad_metrics_daily_tenant_isolation ON public.marketing_ad_metrics_daily
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_access_base ON public.marketing_ad_metrics_daily
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.marketing_ad_metrics_daily
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY marketing_integrations_tenant_isolation ON public.marketing_integrations
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_access_base ON public.marketing_integrations
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.marketing_integrations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY meta_ad_accounts_tenant_select ON public.meta_ad_accounts
  AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (has_tenant_access(tenant_id));
CREATE POLICY meta_ad_accounts_tenant_update ON public.meta_ad_accounts
  AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_access_base ON public.meta_ad_accounts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.meta_ad_accounts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY meta_connections_service_only ON public.meta_connections
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING ((auth.role() = 'service_role'::text))
  WITH CHECK ((auth.role() = 'service_role'::text));
CREATE POLICY tenant_access_base ON public.meta_connections
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.meta_connections
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY meta_oauth_states_service_only ON public.meta_oauth_states
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING ((auth.role() = 'service_role'::text))
  WITH CHECK ((auth.role() = 'service_role'::text));
CREATE POLICY tenant_access_base ON public.meta_oauth_states
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.meta_oauth_states
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY meta_sync_jobs_tenant_select ON public.meta_sync_jobs
  AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (has_tenant_access(tenant_id));
CREATE POLICY meta_sync_runs_tenant_select ON public.meta_sync_runs
  AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (has_tenant_access(tenant_id));
CREATE POLICY "anyone authed can read pricing" ON public.platform_pricing
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);
CREATE POLICY "super admin manages pricing" ON public.platform_pricing
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY player_attributions_tenant_isolation ON public.player_attributions
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_access_base ON public.player_attributions
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.player_attributions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY players_tenant_isolation ON public.players
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.players
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.players
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY precall_campaigns_tenant_isolation ON public.precall_campaigns
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.precall_campaigns
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.precall_campaigns
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY precall_leads_tenant_isolation ON public.precall_leads
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.precall_leads
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.precall_leads
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY precall_templates_tenant_isolation ON public.precall_templates
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.precall_templates
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.precall_templates
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY rules_tenant_isolation ON public.rules
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.rules
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.rules
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY send_window_settings_super_admin_read ON public.send_window_settings
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_super_admin());
CREATE POLICY send_window_settings_super_admin_write ON public.send_window_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY tenant_access_base ON public.send_window_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.send_window_settings
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY sessions_tenant_isolation ON public.sessions
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.sessions
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.sessions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.shortio_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.shortio_settings
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY "sms audiences tenant access" ON public.sms_audiences
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY "Tenant members manage sms campaigns" ON public.sms_campaigns
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_access_base ON public.sms_campaigns
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.sms_campaigns
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY sms_credit_ledger_read_own ON public.sms_credit_ledger
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));
CREATE POLICY tenant_access_base ON public.sms_credit_ledger
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.sms_credit_ledger
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY sms_credit_orders_read_own ON public.sms_credit_orders
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));
CREATE POLICY sms_credit_orders_super_write ON public.sms_credit_orders
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY tenant_access_base ON public.sms_credit_orders
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.sms_credit_orders
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY sms_credit_packages_read_active ON public.sms_credit_packages
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_active OR is_super_admin()));
CREATE POLICY sms_credit_packages_super_write ON public.sms_credit_packages
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY sms_credit_settings_super_read ON public.sms_credit_settings
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_super_admin());
CREATE POLICY sms_credit_settings_super_write ON public.sms_credit_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY sms_flow_leads_tenant_isolation ON public.sms_flow_leads
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.sms_flow_leads
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.sms_flow_leads
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY sms_flow_steps_tenant_isolation ON public.sms_flow_steps
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.sms_flow_steps
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.sms_flow_steps
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY sms_flows_tenant_isolation ON public.sms_flows
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.sms_flows
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.sms_flows
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY sms_send_logs_tenant_isolation ON public.sms_send_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.sms_send_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.sms_send_logs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY sms_template_versions_tenant_select ON public.sms_template_versions
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((tenant_id = current_tenant_id()));
CREATE POLICY "sms templates tenant access" ON public.sms_templates
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((tenant_id = current_tenant_id()))
  WITH CHECK ((tenant_id = current_tenant_id()));
CREATE POLICY suppressed_emails_tenant_delete ON public.suppressed_emails
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((is_super_admin() OR ((tenant_id IS NOT NULL) AND has_tenant_access(tenant_id))));
CREATE POLICY suppressed_emails_tenant_insert ON public.suppressed_emails
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((is_super_admin() OR ((tenant_id IS NOT NULL) AND has_tenant_access(tenant_id))));
CREATE POLICY suppressed_emails_tenant_update ON public.suppressed_emails
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((is_super_admin() OR ((tenant_id IS NOT NULL) AND has_tenant_access(tenant_id))))
  WITH CHECK ((is_super_admin() OR ((tenant_id IS NOT NULL) AND has_tenant_access(tenant_id))));
CREATE POLICY "tenant members can view suppression list" ON public.suppressed_emails
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_super_admin() OR ((tenant_id IS NOT NULL) AND has_tenant_access(tenant_id))));
CREATE POLICY tenant_access_base ON public.suppressed_emails
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.suppressed_emails
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY system_alerts_tenant_isolation ON public.system_alerts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.system_alerts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.system_alerts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.tenant_audit_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_audit_logs_read_own ON public.tenant_audit_logs
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.tenant_audit_logs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY "tenant daily metrics read" ON public.tenant_daily_metrics
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));
CREATE POLICY sms_credit_balances_read_own ON public.tenant_sms_credit_balances
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));
CREATE POLICY sms_credit_balances_super_write ON public.tenant_sms_credit_balances
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY tenant_access_base ON public.tenant_sms_credit_balances
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.tenant_sms_credit_balances
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.tenant_sms_pricing
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.tenant_sms_pricing
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_sms_pricing_super_read ON public.tenant_sms_pricing
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_super_admin());
CREATE POLICY tenant_sms_pricing_super_write ON public.tenant_sms_pricing
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY tenants_member_select_own ON public.tenants
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(id));
CREATE POLICY tenants_super_admin_all ON public.tenants
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY tenant_access_base ON public.tracked_links
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.tracked_links
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY "Users read own roles" ON public.user_roles
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((auth.uid() = user_id));
CREATE POLICY tenant_access_base ON public.user_roles
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.user_roles
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY user_roles_block_super_admin_escalation ON public.user_roles
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((role <> 'super_admin'::app_role) OR is_super_admin(auth.uid())))
  WITH CHECK (((role <> 'super_admin'::app_role) OR is_super_admin(auth.uid())));
CREATE POLICY user_roles_block_tenant_admin_escalation ON public.user_roles
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((role <> 'admin'::app_role) OR is_super_admin(auth.uid())))
  WITH CHECK (((role <> 'admin'::app_role) OR is_super_admin(auth.uid())));
CREATE POLICY user_roles_owner_manage_tenant ON public.user_roles
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id IS NOT NULL) AND is_tenant_owner(tenant_id)))
  WITH CHECK (((tenant_id IS NOT NULL) AND is_tenant_owner(tenant_id)));
CREATE POLICY user_roles_select_own ON public.user_roles
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((user_id = auth.uid()) OR is_super_admin()));
CREATE POLICY user_roles_super_admin_all ON public.user_roles
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY voice_contact_policies_tenant_access ON public.voice_contact_policies
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_access_base ON public.webhook_configs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.webhook_configs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY webhook_configs_tenant_isolation ON public.webhook_configs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.webhook_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.webhook_logs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY webhook_logs_tenant_isolation ON public.webhook_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.whatsapp_chats
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.whatsapp_chats
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY whatsapp_chats_tenant_isolation ON public.whatsapp_chats
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.whatsapp_external_events
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.whatsapp_external_events
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY wee_tenant_isolation ON public.whatsapp_external_events
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_access_base ON public.whatsapp_external_integrations
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.whatsapp_external_integrations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY wei_tenant_isolation ON public.whatsapp_external_integrations
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_access_base ON public.whatsapp_messages
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.whatsapp_messages
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY whatsapp_messages_tenant_isolation ON public.whatsapp_messages
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.whatsapp_proxies
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.whatsapp_proxies
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY whatsapp_proxies_super_admin_read ON public.whatsapp_proxies
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_super_admin());
CREATE POLICY whatsapp_proxies_super_admin_write ON public.whatsapp_proxies
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY tenant_access_base ON public.whatsapp_proxy_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.whatsapp_proxy_logs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY whatsapp_proxy_logs_tenant_isolation ON public.whatsapp_proxy_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.whatsapp_sessions
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.whatsapp_sessions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY whatsapp_sessions_tenant_isolation ON public.whatsapp_sessions
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.withdrawals
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.withdrawals
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY withdrawals_tenant_isolation ON public.withdrawals
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
