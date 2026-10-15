-- REP-05 / NOVO-B — remove high-write tables from the Realtime publication.
--
-- Evidence (docs/BASELINE_BANCO_2026-10-14.md, NOVO-B): realtime.list_changes
-- was ~22% of the measured DB time, plus logical-decoding CPU that does not
-- show up in pg_stat_statements. Every change on a published table is decoded
-- and matched against subscriptions, even when nobody needs it. Writes measured
-- on 2026-10-15 (2 min window, read-only): sms_send_logs ~50/min (bursts much
-- higher during campaigns), webhook_logs ~8/min, players ~6/min, events ~4/min,
-- deposits ~4/min, sessions sporadic.
--
-- The app no longer subscribes to these tables (history/SMS/alertas/eventos/
-- players screens moved to TanStack Query polling). webhook_logs had no
-- subscriber at all.
--
-- Tables that STAY in the publication (low write, UX needs instant updates):
--   lead_followups, whatsapp_chats, whatsapp_messages,
--   lead_whatsapp_assignments, call_queue, call_history, email_campaigns,
--   email_send_logs, email_flow_leads, sms_flow_leads, dispatch_rate_state.
--
-- DEPLOY ORDER: deploy the app first (so no open screen depends on these
-- events), then apply this migration. Applying it before the app deploy is
-- harmless for data, but screens still running the old bundle would stop
-- auto-refreshing on those tables until reloaded (alertas/history/SMS still
-- had a 10–60 s refetchInterval; eventos would need a manual reload).
--
-- Idempotent: each table is dropped only if it is currently in the
-- publication; the whole migration is a no-op if the publication is missing.
-- ALTER PUBLICATION takes a short ShareUpdateExclusive lock on each table;
-- lock_timeout keeps it from queueing behind long writers on a live system.
--
-- Rollback (per table, if a screen ever needs Realtime again):
--   ALTER PUBLICATION supabase_realtime ADD TABLE public.<table>;

SET lock_timeout = '5s';

DO $$
DECLARE
  v_table text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE 'publication supabase_realtime not found; nothing to do';
    RETURN;
  END IF;

  FOREACH v_table IN ARRAY ARRAY[
    'sms_send_logs',
    'webhook_logs',
    'events',
    'players',
    'deposits',
    'sessions'
  ]
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = v_table
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', v_table);
      RAISE NOTICE 'dropped public.% from supabase_realtime', v_table;
    ELSE
      RAISE NOTICE 'public.% not in supabase_realtime; skipped', v_table;
    END IF;
  END LOOP;
END;
$$;

RESET lock_timeout;
