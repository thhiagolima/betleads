-- Per-message choice. Existing records retain the prior enabled behaviour.
alter table public.sms_campaigns
  add column if not exists track_links boolean not null default true;

alter table public.sms_flow_steps
  add column if not exists track_links boolean not null default true;

alter table public.email_campaigns
  add column if not exists track_links boolean not null default true;

alter table public.email_automations
  add column if not exists track_links boolean not null default true;

alter table public.email_templates
  add column if not exists track_links boolean not null default true;
