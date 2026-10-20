-- Raw Short Brasil callbacks, exactly as received, to learn the real payload
-- format: no SMS was ever marked delivered because the parsed items had no
-- recognised field (logged shape: {"lote":[{"token":...}]}). The body is stored
-- unedited, so it may contain tokens: service_role only, short retention.

create table if not exists public.sms_callback_raw (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  method text not null,
  content_type text,
  user_agent text,
  -- Query string without our own auth parameter (token/secret/webhook_secret).
  query_string text,
  -- Request body byte for byte, as text. Empty for GET callbacks.
  body text not null default '',
  -- What the webhook made of it, filled after processing.
  processed integer,
  matched integer,
  unidentified integer
);

create index if not exists sms_callback_raw_received_at_idx
  on public.sms_callback_raw (received_at desc);

alter table public.sms_callback_raw enable row level security;
revoke all on public.sms_callback_raw from public, anon, authenticated;
grant select, insert, update, delete on public.sms_callback_raw to service_role;

-- Keep 7 days: enough to diagnose, bounded if the provider sends ~180k/day.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'betleads-sms-callback-raw-retention';
    perform cron.schedule(
      'betleads-sms-callback-raw-retention',
      '17 4 * * *',
      $job$delete from public.sms_callback_raw where received_at < now() - interval '7 days'$job$
    );
  end if;
end;
$$;
