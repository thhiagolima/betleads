-- Dashboard resets are operational settings for one account, never a shared
-- switch. The original table used `id = global` as its sole key, so only one
-- account could have a setting at a time.

begin;

alter table public.dashboard_settings
  drop constraint if exists dashboard_settings_pkey;

alter table public.dashboard_settings
  alter column tenant_id set not null;

alter table public.dashboard_settings
  add constraint dashboard_settings_pkey primary key (tenant_id, id);

-- Preserve the previous global reset date as the initial value for every
-- existing account. This avoids unexpectedly showing historical data after
-- this migration. Each account can reset independently from now on.
insert into public.dashboard_settings (tenant_id, id, reset_at, updated_at, updated_by)
select
  tenants.id,
  'global',
  coalesce(
    (select settings.reset_at
       from public.dashboard_settings settings
      where settings.id = 'global'
      order by settings.updated_at desc
      limit 1),
    '1970-01-01T00:00:00Z'::timestamptz
  ),
  now(),
  null
from public.tenants tenants
on conflict (tenant_id, id) do nothing;

do $$
declare
  policy_row record;
begin
  for policy_row in
    select policyname
      from pg_policies
     where schemaname = 'public'
       and tablename = 'dashboard_settings'
  loop
    execute format('drop policy if exists %I on public.dashboard_settings', policy_row.policyname);
  end loop;
end
$$;

alter table public.dashboard_settings enable row level security;

create policy "dashboard settings tenant isolation"
  on public.dashboard_settings
  for all
  to authenticated
  using (tenant_id = public.current_tenant_id() or public.is_super_admin())
  with check (tenant_id = public.current_tenant_id() or public.is_super_admin());

commit;
