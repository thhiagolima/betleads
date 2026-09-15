-- Restrict Realtime channel subscriptions to admins only when the managed
-- realtime schema allows policy changes in the target Supabase project.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY';

  EXECUTE 'DROP POLICY IF EXISTS "Admins can receive realtime broadcasts" ON realtime.messages';
  EXECUTE 'CREATE POLICY "Admins can receive realtime broadcasts"
    ON realtime.messages
    FOR SELECT
    TO authenticated
    USING (public.has_role(auth.uid(), ''admin''::public.app_role))';

  EXECUTE 'DROP POLICY IF EXISTS "Admins can send realtime broadcasts" ON realtime.messages';
  EXECUTE 'CREATE POLICY "Admins can send realtime broadcasts"
    ON realtime.messages
    FOR INSERT
    TO authenticated
    WITH CHECK (public.has_role(auth.uid(), ''admin''::public.app_role))';
EXCEPTION
  WHEN insufficient_privilege OR undefined_table OR undefined_function OR undefined_object THEN
    RAISE WARNING 'Skipping realtime.messages policy hardening: %', SQLERRM;
END $$;
