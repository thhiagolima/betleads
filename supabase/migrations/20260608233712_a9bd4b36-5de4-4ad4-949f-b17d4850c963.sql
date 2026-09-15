
DO $$
DECLARE
  v_src uuid := '00000000-0000-0000-0000-000000000001';
  v_tbl text;
  v_pol record;
  v_tables text[] := ARRAY[
    'call_providers','email_smtp_configs','email_senders','whatsapp_proxies',
    'ai_intents','ai_synonyms','ai_training_examples',
    'antiban_settings','send_window_settings'
  ];
BEGIN
  FOREACH v_tbl IN ARRAY v_tables LOOP
    -- Remove cópias de outros tenants; mantém apenas a config do tenant fonte
    EXECUTE format('DELETE FROM public.%I WHERE tenant_id <> %L', v_tbl, v_src);

    -- Garante default fixo no tenant global (não depende mais de current_tenant_id)
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN tenant_id SET DEFAULT %L::uuid',
      v_tbl, v_src
    );

    -- Apaga políticas antigas
    FOR v_pol IN
      SELECT policyname FROM pg_policies
       WHERE schemaname = 'public' AND tablename = v_tbl
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', v_pol.policyname, v_tbl);
    END LOOP;

    -- Nova RLS: qualquer autenticado lê; só super_admin escreve
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)',
      v_tbl || '_global_read', v_tbl
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.is_super_admin()) WITH CHECK (public.is_super_admin())',
      v_tbl || '_super_admin_write', v_tbl
    );
  END LOOP;
END $$;

-- A função clone_platform_infra deixa de ser necessária; remove para evitar uso futuro
DROP FUNCTION IF EXISTS public.clone_platform_infra(uuid);
