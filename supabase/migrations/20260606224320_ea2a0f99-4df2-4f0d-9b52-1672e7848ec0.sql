
-- Índices parciais pra acelerar o claim (filtro por status + ordenação por next_run_at)
create index if not exists idx_sms_flow_leads_ready
  on public.sms_flow_leads (next_run_at)
  where status in ('pending','running');

create index if not exists idx_email_flow_leads_ready
  on public.email_flow_leads (next_run_at)
  where status in ('pending','running');

create index if not exists idx_call_flow_progress_ready
  on public.call_flow_progress (next_run_at)
  where status = 'active';

-- SMS: reserva leads por 5 min (lease) e devolve as linhas claimadas
create or replace function public.claim_sms_flow_leads(p_limit int)
returns setof public.sms_flow_leads
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.sms_flow_leads l
  set next_run_at = now() + interval '5 minutes',
      updated_at = now()
  from (
    select id from public.sms_flow_leads
    where status in ('pending','running')
      and next_run_at <= now()
    order by next_run_at asc
    limit p_limit
    for update skip locked
  ) picked
  where l.id = picked.id
  returning l.*;
end;
$$;

grant execute on function public.claim_sms_flow_leads(int) to service_role;

-- Email: idem
create or replace function public.claim_email_flow_leads(p_limit int)
returns setof public.email_flow_leads
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.email_flow_leads l
  set next_run_at = now() + interval '5 minutes',
      updated_at = now()
  from (
    select id from public.email_flow_leads
    where status in ('pending','running')
      and next_run_at <= now()
    order by next_run_at asc
    limit p_limit
    for update skip locked
  ) picked
  where l.id = picked.id
  returning l.*;
end;
$$;

grant execute on function public.claim_email_flow_leads(int) to service_role;

-- Ligação: idem para call_flow_progress (status = 'active')
create or replace function public.claim_call_flow_progress(p_limit int)
returns setof public.call_flow_progress
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.call_flow_progress p
  set next_run_at = now() + interval '5 minutes',
      updated_at = now()
  from (
    select id from public.call_flow_progress
    where status = 'active'
      and next_run_at <= now()
    order by next_run_at asc
    limit p_limit
    for update skip locked
  ) picked
  where p.id = picked.id
  returning p.*;
end;
$$;

grant execute on function public.claim_call_flow_progress(int) to service_role;
