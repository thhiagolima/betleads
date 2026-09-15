ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS crm_model TEXT NOT NULL DEFAULT 'CRM_PLATAFORMA'
  CHECK (crm_model IN ('CRM_PLATAFORMA','CRM_EXPERT'));

UPDATE public.tenants SET crm_model = 'CRM_PLATAFORMA'
 WHERE id = '00000000-0000-0000-0000-000000000001';

DO $$
DECLARE
  v_tenant_id UUID := 'b1e75a01-9b40-4e30-9d4a-7c5f6f3d1a01';
  v_user_id UUID;
  v_email TEXT := 'alissonkevinqueiroz@gmail.com';
BEGIN
  INSERT INTO public.tenants (id, nome, slug, status, plano, webhook_token, metadata, crm_model)
  VALUES (
    v_tenant_id,
    'CRM Expert - Alisson Kevin Queiroz',
    'crm-expert-queiroz',
    'active',
    'interno',
    encode(gen_random_bytes(24), 'hex'),
    jsonb_build_object(
      'expert_name', 'Alisson Kevin Queiroz',
      'expert_display_name', 'Queiroz',
      'expert_affiliate_ids', jsonb_build_array(
        '69ad88a944290ad64e25c737',
        '69cde3d75779177c6fed3c7c'
      )
    ),
    'CRM_EXPERT'
  )
  ON CONFLICT (id) DO UPDATE
    SET nome = EXCLUDED.nome,
        metadata = EXCLUDED.metadata,
        crm_model = EXCLUDED.crm_model,
        updated_at = now();

  SELECT id INTO v_user_id FROM auth.users WHERE email = v_email LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE WARNING 'Skipping CRM Expert owner role: auth user % not found', v_email;
    RETURN;
  END IF;

  INSERT INTO public.user_roles (user_id, role, tenant_id)
  VALUES (v_user_id, 'owner', v_tenant_id)
  ON CONFLICT DO NOTHING;
END $$;
