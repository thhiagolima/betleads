
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    -- core data
    'players','deposits','withdrawals','sessions','events',
    'lead_alerts','lead_followups','lead_whatsapp_assignments',
    -- AI
    'ai_feedback','ai_intents','ai_logs','ai_synonyms','ai_training_examples',
    -- settings (per casa)
    'antiban_settings','automation_settings','dashboard_settings','send_window_settings',
    -- SMS
    'sms_flows','sms_flow_steps','sms_flow_leads','sms_send_logs',
    -- Email
    'email_automations','email_campaigns','email_flow_blocks','email_flow_leads',
    'email_flow_logs','email_flows','email_send_logs','email_senders',
    'email_smtp_configs','email_templates',
    -- Calls
    'call_audio_generations','call_flow_block_sms','call_flow_blocks',
    'call_flow_executions','call_flow_history','call_flow_post_action',
    'call_flow_progress','call_flow_scripts','call_flows','call_history',
    'call_providers','call_queue','call_scripts',
    -- WhatsApp
    'whatsapp_chats','whatsapp_messages','whatsapp_proxies',
    'whatsapp_proxy_logs','whatsapp_sessions',
    -- Generic flows
    'flow_blocks','flow_leads','flow_logs','flows','rules',
    -- Misc
    'activation_runs','experts','system_alerts','webhook_configs','webhook_logs'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- ADD COLUMN with DEFAULT + NOT NULL: backfills all existing rows atomically
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT %L',
      t, '00000000-0000-0000-0000-000000000001'
    );
    -- Drop default so future inserts MUST provide tenant_id explicitly
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN tenant_id DROP DEFAULT', t);
    -- Add FK constraint (named so it's stable)
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE',
      t, t || '_tenant_id_fkey'
    );
    -- Index for tenant-scoped queries
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (tenant_id)',
      t || '_tenant_id_idx', t
    );
  END LOOP;
END $$;
