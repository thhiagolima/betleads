CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Cron scheduling is intentionally not created by this historical migration.
-- The original version pointed to an old Lovable URL and embedded an old API key.
-- Create production cron jobs only after PUBLIC_APP_URL and CRON_SECRET are set.
