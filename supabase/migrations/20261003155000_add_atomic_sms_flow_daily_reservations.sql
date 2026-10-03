-- Reserva atômica de cota por fluxo/dia. Evita que workers paralelos ultrapassem
-- daily_limit entre a contagem e o envio.
create table if not exists public.sms_flow_daily_usage (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  flow_id uuid not null references public.sms_flows(id) on delete cascade,
  usage_date date not null,
  reserved_count integer not null default 0 check (reserved_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, flow_id, usage_date)
);

alter table public.sms_flow_daily_usage enable row level security;
grant all on public.sms_flow_daily_usage to service_role;

create or replace function public.reserve_sms_flow_daily_slot(
  _tenant uuid,
  _flow uuid,
  _daily_limit integer,
  _usage_date date default (now() at time zone 'America/Sao_Paulo')::date
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  reserved boolean := false;
begin
  if _daily_limit < 1 then return false; end if;

  insert into public.sms_flow_daily_usage as usage
    (tenant_id, flow_id, usage_date, reserved_count, updated_at)
  values (_tenant, _flow, _usage_date, 1, now())
  on conflict (tenant_id, flow_id, usage_date) do update
    set reserved_count = usage.reserved_count + 1,
        updated_at = now()
    where usage.reserved_count < _daily_limit
  returning true into reserved;

  return coalesce(reserved, false);
end;
$$;

revoke all on function public.reserve_sms_flow_daily_slot(uuid, uuid, integer, date) from public, anon, authenticated;
grant execute on function public.reserve_sms_flow_daily_slot(uuid, uuid, integer, date) to service_role;
