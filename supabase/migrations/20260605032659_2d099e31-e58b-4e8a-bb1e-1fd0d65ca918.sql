-- Enable realtime publication for dashboard tables
DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'email_send_logs',
    'email_campaigns',
    'sms_send_logs',
    'call_history',
    'call_queue'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- ensure REPLICA IDENTITY FULL so UPDATE/DELETE realtime payloads work
    EXECUTE format('ALTER TABLE public.%I REPLICA IDENTITY FULL', t);
    -- add to publication if not already
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;