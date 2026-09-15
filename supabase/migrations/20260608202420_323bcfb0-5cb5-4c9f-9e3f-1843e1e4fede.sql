
DO $$
DECLARE
  t text;
  pol record;
  tables text[] := ARRAY[
    'players','deposits','withdrawals','sessions','events',
    'lead_alerts','lead_followups','lead_whatsapp_assignments',
    'ai_feedback','ai_intents','ai_logs','ai_synonyms','ai_training_examples',
    'antiban_settings','automation_settings','dashboard_settings','send_window_settings',
    'sms_flows','sms_flow_steps','sms_flow_leads','sms_send_logs',
    'email_automations','email_campaigns','email_flow_blocks','email_flow_leads',
    'email_flow_logs','email_flows','email_send_logs','email_senders',
    'email_smtp_configs','email_templates',
    'call_audio_generations','call_flow_block_sms','call_flow_blocks',
    'call_flow_executions','call_flow_history','call_flow_post_action',
    'call_flow_progress','call_flow_scripts','call_flows','call_history',
    'call_providers','call_queue','call_scripts',
    'whatsapp_chats','whatsapp_messages','whatsapp_proxies',
    'whatsapp_proxy_logs','whatsapp_sessions',
    'flow_blocks','flow_leads','flow_logs','flows','rules',
    'activation_runs','experts','system_alerts','webhook_configs','webhook_logs'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- Drop ALL existing policies on this table
    FOR pol IN
      SELECT policyname FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, t);
    END LOOP;

    -- Ensure RLS is enabled
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    -- Single consolidated policy: tenant-scoped + super_admin escape hatch
    EXECUTE format(
      $f$CREATE POLICY %I ON public.%I
          FOR ALL TO authenticated
          USING (tenant_id = public.current_tenant_id() OR public.is_super_admin())
          WITH CHECK (tenant_id = public.current_tenant_id() OR public.is_super_admin())$f$,
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;
