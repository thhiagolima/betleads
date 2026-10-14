-- Emergency pool recovery after the overloaded dispatcher. This terminates
-- only active client SQL sessions; it does not alter queues, rows or internal
-- PostgreSQL processes. New API requests establish clean connections.
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = current_database()
  AND pid <> pg_backend_pid()
  AND backend_type = 'client backend'
  AND usename = 'authenticator'
  AND state <> 'idle';
