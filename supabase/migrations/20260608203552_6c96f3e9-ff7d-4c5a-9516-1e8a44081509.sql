
-- 1) flow_templates: add tenant_id + tenant-scoped policy
ALTER TABLE public.flow_templates
  ADD COLUMN IF NOT EXISTS tenant_id uuid;

UPDATE public.flow_templates
  SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
  WHERE tenant_id IS NULL;

ALTER TABLE public.flow_templates
  ALTER COLUMN tenant_id SET NOT NULL,
  ALTER COLUMN tenant_id SET DEFAULT COALESCE(public.current_tenant_id(), '00000000-0000-0000-0000-000000000001'::uuid);

CREATE INDEX IF NOT EXISTS idx_flow_templates_tenant ON public.flow_templates(tenant_id);

DROP POLICY IF EXISTS "Admins full access flow_templates" ON public.flow_templates;

CREATE POLICY flow_templates_tenant_access
ON public.flow_templates
FOR ALL
TO authenticated
USING (tenant_id = public.current_tenant_id() OR public.is_super_admin())
WITH CHECK (tenant_id = public.current_tenant_id() OR public.is_super_admin());

-- 2) dispatch_rate_state + dispatcher_runs: super_admin only (system-wide tables)
DROP POLICY IF EXISTS "admins read dispatch_rate_state" ON public.dispatch_rate_state;
CREATE POLICY dispatch_rate_state_super_admin
ON public.dispatch_rate_state
FOR SELECT
TO authenticated
USING (public.is_super_admin());

DROP POLICY IF EXISTS "admins read dispatcher_runs" ON public.dispatcher_runs;
CREATE POLICY dispatcher_runs_super_admin
ON public.dispatcher_runs
FOR SELECT
TO authenticated
USING (public.is_super_admin());

-- 3) Realtime: restrict to super_admin only (no cross-tenant broadcasts)
DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "Admins can receive realtime broadcasts" ON realtime.messages';
  EXECUTE 'DROP POLICY IF EXISTS "Admins can send realtime broadcasts" ON realtime.messages';

  EXECUTE 'CREATE POLICY "Super admins receive realtime broadcasts"
    ON realtime.messages
    FOR SELECT
    TO authenticated
    USING (public.is_super_admin())';

  EXECUTE 'CREATE POLICY "Super admins send realtime broadcasts"
    ON realtime.messages
    FOR INSERT
    TO authenticated
    WITH CHECK (public.is_super_admin())';
EXCEPTION
  WHEN insufficient_privilege OR undefined_table OR undefined_function OR undefined_object THEN
    RAISE WARNING 'Skipping realtime.messages super_admin policy hardening: %', SQLERRM;
END $$;

-- 4) Storage: tenant-prefixed paths; super_admin keeps full access
-- Helper: filename should start with "<tenant_id>/..."
DROP POLICY IF EXISTS "Admins delete call-audios" ON storage.objects;
DROP POLICY IF EXISTS "Admins read call-audios" ON storage.objects;
DROP POLICY IF EXISTS "Admins update call-audios" ON storage.objects;
DROP POLICY IF EXISTS "Admins upload call-audios" ON storage.objects;
DROP POLICY IF EXISTS "Admins delete email images" ON storage.objects;
DROP POLICY IF EXISTS "Admins update email images" ON storage.objects;
DROP POLICY IF EXISTS "Admins upload email images" ON storage.objects;
DROP POLICY IF EXISTS "whatsapp-media admin delete" ON storage.objects;
DROP POLICY IF EXISTS "whatsapp-media admin read" ON storage.objects;
DROP POLICY IF EXISTS "whatsapp-media admin update" ON storage.objects;
DROP POLICY IF EXISTS "whatsapp-media admin write" ON storage.objects;
DROP POLICY IF EXISTS "whatsapp-media admins delete" ON storage.objects;
DROP POLICY IF EXISTS "whatsapp-media admins update" ON storage.objects;
DROP POLICY IF EXISTS "whatsapp-media admins write" ON storage.objects;

CREATE POLICY "tenant_read_call_audios"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'call-audios'
  AND (
    public.is_super_admin()
    OR ((storage.foldername(name))[1] = public.current_tenant_id()::text)
  )
);

CREATE POLICY "tenant_insert_call_audios"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'call-audios'
  AND (
    public.is_super_admin()
    OR ((storage.foldername(name))[1] = public.current_tenant_id()::text)
  )
);

CREATE POLICY "tenant_update_call_audios"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'call-audios'
  AND (
    public.is_super_admin()
    OR ((storage.foldername(name))[1] = public.current_tenant_id()::text)
  )
)
WITH CHECK (
  bucket_id = 'call-audios'
  AND (
    public.is_super_admin()
    OR ((storage.foldername(name))[1] = public.current_tenant_id()::text)
  )
);

CREATE POLICY "tenant_delete_call_audios"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'call-audios'
  AND (
    public.is_super_admin()
    OR ((storage.foldername(name))[1] = public.current_tenant_id()::text)
  )
);

CREATE POLICY "tenant_read_email_images"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'email-images'
  AND (
    public.is_super_admin()
    OR ((storage.foldername(name))[1] = public.current_tenant_id()::text)
  )
);

CREATE POLICY "tenant_insert_email_images"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'email-images'
  AND (
    public.is_super_admin()
    OR ((storage.foldername(name))[1] = public.current_tenant_id()::text)
  )
);

CREATE POLICY "tenant_update_email_images"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'email-images'
  AND (
    public.is_super_admin()
    OR ((storage.foldername(name))[1] = public.current_tenant_id()::text)
  )
)
WITH CHECK (
  bucket_id = 'email-images'
  AND (
    public.is_super_admin()
    OR ((storage.foldername(name))[1] = public.current_tenant_id()::text)
  )
);

CREATE POLICY "tenant_delete_email_images"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'email-images'
  AND (
    public.is_super_admin()
    OR ((storage.foldername(name))[1] = public.current_tenant_id()::text)
  )
);

CREATE POLICY "tenant_read_whatsapp_media"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'whatsapp-media'
  AND (
    public.is_super_admin()
    OR ((storage.foldername(name))[1] = public.current_tenant_id()::text)
  )
);

CREATE POLICY "tenant_insert_whatsapp_media"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'whatsapp-media'
  AND (
    public.is_super_admin()
    OR ((storage.foldername(name))[1] = public.current_tenant_id()::text)
  )
);

CREATE POLICY "tenant_update_whatsapp_media"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'whatsapp-media'
  AND (
    public.is_super_admin()
    OR ((storage.foldername(name))[1] = public.current_tenant_id()::text)
  )
)
WITH CHECK (
  bucket_id = 'whatsapp-media'
  AND (
    public.is_super_admin()
    OR ((storage.foldername(name))[1] = public.current_tenant_id()::text)
  )
);

CREATE POLICY "tenant_delete_whatsapp_media"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'whatsapp-media'
  AND (
    public.is_super_admin()
    OR ((storage.foldername(name))[1] = public.current_tenant_id()::text)
  )
);

-- 5) user_roles: remove cross-tenant "Admins manage roles" privilege-escalation policy
DROP POLICY IF EXISTS "Admins manage roles" ON public.user_roles;

-- 6) Revoke EXECUTE from anon on is_tenant_owner
REVOKE EXECUTE ON FUNCTION public.is_tenant_owner(uuid) FROM anon, PUBLIC;
