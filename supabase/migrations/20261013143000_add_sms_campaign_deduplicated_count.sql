alter table public.sms_campaigns
  add column if not exists deduplicated_count integer not null default 0
  check (deduplicated_count >= 0);

comment on column public.sms_campaigns.deduplicated_count is
  'Recipients skipped because the same SMS content was already sent inside the deduplication window.';
