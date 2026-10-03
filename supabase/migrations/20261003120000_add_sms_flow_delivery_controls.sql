alter table public.sms_flows
  add column if not exists daily_limit integer not null default 500,
  add column if not exists cooldown_hours integer not null default 24;

alter table public.sms_flows
  drop constraint if exists sms_flows_daily_limit_check,
  drop constraint if exists sms_flows_cooldown_hours_check;

alter table public.sms_flows
  add constraint sms_flows_daily_limit_check check (daily_limit between 1 and 10000),
  add constraint sms_flows_cooldown_hours_check check (cooldown_hours between 0 and 720);

create index if not exists sms_send_logs_tenant_flow_player_created_idx
  on public.sms_send_logs (tenant_id, flow_id, player_id, created_at desc)
  where flow_id is not null;
