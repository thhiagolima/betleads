
DO $$
DECLARE
  t text;
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
    EXECUTE format(
      $f$ALTER TABLE public.%I ALTER COLUMN tenant_id SET DEFAULT COALESCE(public.current_tenant_id(), '00000000-0000-0000-0000-000000000001'::uuid)$f$,
      t
    );
  END LOOP;
END $$;
