
REVOKE SELECT ON public.tenants FROM authenticated;
GRANT SELECT (id, nome, slug, status, plano, limits, metadata, legacy_webhook, created_at, updated_at)
  ON public.tenants TO authenticated;

DROP POLICY IF EXISTS ai_intents_global_read ON public.ai_intents;
CREATE POLICY ai_intents_tenant_read ON public.ai_intents
  FOR SELECT TO authenticated
  USING (is_super_admin() OR tenant_id = current_tenant_id());

DROP POLICY IF EXISTS ai_synonyms_global_read ON public.ai_synonyms;
CREATE POLICY ai_synonyms_tenant_read ON public.ai_synonyms
  FOR SELECT TO authenticated
  USING (is_super_admin() OR tenant_id = current_tenant_id());

DROP POLICY IF EXISTS ai_training_examples_global_read ON public.ai_training_examples;
CREATE POLICY ai_training_examples_tenant_read ON public.ai_training_examples
  FOR SELECT TO authenticated
  USING (is_super_admin() OR tenant_id = current_tenant_id());

ALTER PUBLICATION supabase_realtime DROP TABLE public.dispatcher_runs;
