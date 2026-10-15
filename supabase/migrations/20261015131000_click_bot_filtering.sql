-- TRK-06 — bots, previews and abuse on the first-party click redirect.
--
-- NOT APPLIED automatically. Review, then apply in a low-traffic window.
--
-- Scope (database side only; classification, dedupe and the in-process
-- limiter live in src/lib/click-tracking.server.ts):
--   * The link_dispatches aggregate is written ONLY on the first human click
--     of a dispatch. Every later click used to UPDATE the same row (hot-row
--     contention under scanner bursts and repeated taps). click_events stays
--     the source of truth for counts and for resolve_last_attributable_click.
--   * No new index: the dedupe/repeat lookup filters by
--     (link_dispatch_id, occurred_at >= now() - 60 s), already served by
--     click_events_dispatch_time_idx (link_dispatch_id, occurred_at desc).
--     If an index is ever added here, click_events must use
--     CREATE INDEX CONCURRENTLY outside this transaction (the table grows
--     with every send; ~2.3k rows / 1.8 MB on 2026-10-15).
--   * No CHECK change: bot_classification keeps 'human' | 'suspected_bot' |
--     'unknown'; the reason goes to metadata->>'bot_reason', so the app can be
--     deployed before or after this migration.
--   * No backfill: existing rows are not reclassified (no production write).
--
-- Locks: CREATE OR REPLACE FUNCTION and COMMENT take no lock on click_events
-- rows; lock_timeout keeps the deploy from queueing behind live traffic.

begin;

set local lock_timeout = '3s';
set local statement_timeout = '30s';

create or replace function public.apply_first_party_click_to_dispatch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only the first human click touches link_dispatches. The predicate on
  -- first_party_first_clicked_at makes every later click a no-op that does
  -- not lock or rewrite the dispatch row.
  if new.is_human then
    update public.link_dispatches
    set first_party_click_count = greatest(first_party_click_count, 1),
        first_party_first_clicked_at = new.occurred_at,
        first_party_last_clicked_at = coalesce(first_party_last_clicked_at, new.occurred_at),
        landing_captured_at = case
          when landing_captured_at is null then new.occurred_at
          else least(landing_captured_at, new.occurred_at)
        end
    where id = new.link_dispatch_id
      and tenant_id = new.tenant_id
      and tracking_token = new.tracking_token
      and first_party_first_clicked_at is null;
  end if;
  return new;
end;
$$;

revoke all on function public.apply_first_party_click_to_dispatch() from public, anon, authenticated;

comment on function public.apply_first_party_click_to_dispatch() is
  'TRK-06: marks the first human first-party click on link_dispatches; later clicks do not update the row. Count clicks from click_events.';
comment on column public.link_dispatches.first_party_click_count is
  'Since TRK-06: 0 = no human first-party click, 1 = at least one. Exact counts come from click_events (is_human).';
comment on column public.link_dispatches.first_party_last_clicked_at is
  'Since TRK-06: frozen at the first human click. Use click_events for the latest click.';
comment on column public.click_events.request_id is
  'TRK-06: dedupe bucket key dd1:<hmac(dispatch, ip_hash, ua_hash, is_human, 10 s bucket)>; the unique (tenant_id, request_id) index absorbs concurrent duplicate clicks. Raw cf-ray/x-request-id goes to metadata.request_ref.';
comment on column public.click_events.metadata is
  'Non-PII context. TRK-06 adds classifier, bot_reason, accept_kind, accept_language, sec_fetch_mode, sec_fetch_site, request_ref.';

commit;
