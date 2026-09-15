DO $$
DECLARE
  v_tenant_id uuid;
  v_user_id uuid;
  v_email text := 'pixpgf@gmail.com';
BEGIN
  INSERT INTO public.tenants (nome, slug, status)
  VALUES ('PixPGF', 'pixpgf', 'active')
  ON CONFLICT (slug) DO UPDATE
    SET nome = EXCLUDED.nome,
        status = EXCLUDED.status,
        updated_at = now()
  RETURNING id INTO v_tenant_id;

  SELECT id INTO v_user_id FROM auth.users WHERE email = v_email LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE WARNING 'Skipping PixPGF owner role: auth user % not found', v_email;
    RETURN;
  END IF;

  INSERT INTO public.user_roles (user_id, role, tenant_id)
  VALUES (v_user_id, 'owner', v_tenant_id)
  ON CONFLICT DO NOTHING;
END $$;
