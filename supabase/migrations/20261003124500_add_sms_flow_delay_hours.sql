-- Mantem delay_days para as reguas legadas e permite esperas precisas em horas.
alter table public.sms_flow_steps
  add column if not exists delay_hours integer;

alter table public.sms_flow_steps
  drop constraint if exists sms_flow_steps_delay_hours_check;

alter table public.sms_flow_steps
  add constraint sms_flow_steps_delay_hours_check
  check (delay_hours is null or delay_hours between 1 and 8760);

comment on column public.sms_flow_steps.delay_hours is
  'Espera em horas. Quando preenchido, prevalece sobre delay_days; NULL preserva a regra legada em dias.';
