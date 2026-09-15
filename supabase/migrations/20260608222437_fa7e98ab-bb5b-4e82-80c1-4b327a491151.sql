CREATE OR REPLACE FUNCTION public.clone_platform_infra(p_target_tenant uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_src uuid := '00000000-0000-0000-0000-000000000001';
  v_tbl text;
  v_cols text;
  v_has int;
  v_tables text[] := ARRAY[
    'ai_intents','ai_synonyms','ai_training_examples',
    'email_senders','antiban_settings','send_window_settings','whatsapp_proxies'
  ];
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_target_tenant IS NULL OR p_target_tenant = v_src THEN
    RETURN;
  END IF;
  FOREACH v_tbl IN ARRAY v_tables LOOP
    EXECUTE format('SELECT COUNT(*) FROM public.%I WHERE tenant_id = $1', v_tbl)
      USING p_target_tenant INTO v_has;
    IF v_has > 0 THEN CONTINUE; END IF;
    SELECT string_agg(quote_ident(column_name), ', ')
      INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = v_tbl
       AND column_name NOT IN ('id','created_at','updated_at','tenant_id');
    EXECUTE format(
      'INSERT INTO public.%I (tenant_id, %s) SELECT $1, %s FROM public.%I WHERE tenant_id = $2',
      v_tbl, v_cols, v_cols, v_tbl
    ) USING p_target_tenant, v_src;
  END LOOP;
END $$;