-- CON-01 — index the first-party click redirect lookup.
--
-- resolveAndRecordFirstPartyClick (src/lib/click-tracking.server.ts) and
-- conversion attribution resolve a dispatch by tracking_token alone; the only
-- index covering the column is unique (tenant_id, tracking_token), which the
-- planner cannot use without tenant_id. The 2026-10-14 baseline measured
-- 1,306 seq scans on link_dispatches (2,236 by the pre-check below).
--
-- Pre-check (read-only, production, 2026-10-14):
--   select count(*), count(distinct tracking_token) from link_dispatches;
--     -> 16,981 rows / 16,981 distinct tokens
--   select tracking_token, count(*) from link_dispatches group by 1 having count(*) > 1;
--     -> 0 rows
-- Tokens are globally unique by construction: the column default is
-- gen_random_uuid() and deterministicToken() (src/lib/shortio.server.ts)
-- hashes tenant_id into the token. UNIQUE therefore both serves the lookup and
-- documents the invariant the redirect already relies on (.maybeSingle()).
-- The legacy (tenant_id, tracking_token) constraint is kept: it is now
-- redundant but dropping it is a separate, optional cleanup.
--
-- Locking: migrations run inside a transaction, so CONCURRENTLY is not
-- available. CREATE INDEX takes a SHARE lock (blocks writes, not reads) for
-- the build; at ~17k rows this is well under a second. lock_timeout makes the
-- migration fail fast instead of queueing writers behind it. If this fails
-- with a unique violation, a duplicate appeared after the pre-check: rerun
-- the query above and investigate before retrying.

set lock_timeout = '5s';

create unique index if not exists link_dispatches_tracking_token_uidx
  on public.link_dispatches (tracking_token);

comment on index public.link_dispatches_tracking_token_uidx is
  'CON-01: tracking_token is globally unique; serves the first-party click redirect lookup by token.';

reset lock_timeout;
