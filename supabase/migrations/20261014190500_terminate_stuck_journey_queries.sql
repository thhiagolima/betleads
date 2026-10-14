-- Stop only requests created by the overloaded dispatcher/dashboard paths.
-- Queue rows and delivery history remain intact; orphaned claims are recovered
-- by the existing worker recovery routine when dispatch is re-enabled.
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = current_database()
  AND pid <> pg_backend_pid()
  AND state <> 'idle'
  AND (
    query ILIKE '%reserve_journey_delivery_with_contact_limits%'
    OR query ILIKE '%dashboard_summary_v2%'
  );
