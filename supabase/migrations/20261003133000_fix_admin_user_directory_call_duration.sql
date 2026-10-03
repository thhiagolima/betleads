-- call_history registra duração em segundos, não timestamps de início/fim.
create or replace function public.admin_list_users_with_usage(
  _from timestamptz default (now() - interval '30 days'),
  _to timestamptz default now()
)
returns table (
  user_id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz,
  banned_until timestamptz, tenant_id uuid, tenant_nome text, role text,
  sms_count bigint, sms_cost numeric, call_minutes numeric, call_cost numeric,
  email_count bigint, email_cost numeric, total_cost numeric
)
language plpgsql security definer set search_path to 'public'
as $$
declare v_sms numeric; v_call numeric; v_email numeric;
begin
  if not public.is_super_admin() then raise exception 'forbidden'; end if;
  select price_per_unit into v_sms from public.platform_pricing where channel = 'sms';
  select price_per_unit into v_call from public.platform_pricing where channel = 'call';
  select price_per_unit into v_email from public.platform_pricing where channel = 'email';

  return query
  with memberships as (
    select distinct ur.user_id, ur.tenant_id, ur.role::text as role
    from public.user_roles ur
    where ur.tenant_id is not null and ur.role in ('admin', 'gestor', 'member')
  ), base as (
    select u.id as user_id, u.email::text as email, u.created_at, u.last_sign_in_at, u.banned_until,
      (array_agg(m.tenant_id order by m.tenant_id) filter (where m.tenant_id is not null))[1] as tenant_id,
      string_agg(distinct t.nome::text, ', ' order by t.nome::text) as tenant_nome,
      string_agg(distinct m.role, ', ' order by m.role) as role
    from auth.users u
    left join memberships m on m.user_id = u.id
    left join public.tenants t on t.id = m.tenant_id
    where not public.is_super_admin(u.id)
    group by u.id, u.email, u.created_at, u.last_sign_in_at, u.banned_until
  ), sms as (
    select m.user_id, count(*)::bigint as c
    from memberships m join public.sms_send_logs l on l.tenant_id = m.tenant_id
    where l.created_at >= _from and l.created_at < _to group by m.user_id
  ), calls as (
    select m.user_id, coalesce(sum(coalesce(l.duration_seconds, 0)::numeric / 60), 0)::numeric as minutes
    from memberships m join public.call_history l on l.tenant_id = m.tenant_id
    where l.created_at >= _from and l.created_at < _to group by m.user_id
  ), emails as (
    select m.user_id, count(*)::bigint as c
    from memberships m join public.email_send_logs l on l.tenant_id = m.tenant_id
    where l.created_at >= _from and l.created_at < _to group by m.user_id
  )
  select b.user_id, b.email, b.created_at, b.last_sign_in_at, b.banned_until,
    b.tenant_id, b.tenant_nome, b.role,
    coalesce(s.c,0), (coalesce(s.c,0)*coalesce(v_sms,0))::numeric,
    coalesce(c.minutes,0), (coalesce(c.minutes,0)*coalesce(v_call,0))::numeric,
    coalesce(e.c,0), (coalesce(e.c,0)*coalesce(v_email,0))::numeric,
    (coalesce(s.c,0)*coalesce(v_sms,0)+coalesce(c.minutes,0)*coalesce(v_call,0)+coalesce(e.c,0)*coalesce(v_email,0))::numeric
  from base b left join sms s on s.user_id=b.user_id
  left join calls c on c.user_id=b.user_id left join emails e on e.user_id=b.user_id
  order by b.email;
end;
$$;

grant execute on function public.admin_list_users_with_usage(timestamptz, timestamptz) to authenticated;
