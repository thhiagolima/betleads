create table if not exists public.meta_sync_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  requested_by_user_id uuid,
  trigger_type text not null default 'manual'
    check (trigger_type in ('manual', 'scheduled', 'backfill')),
  days integer not null default 7 check (days between 1 and 90),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'partial', 'failed', 'canceled')),
  total_accounts integer not null default 0,
  processed_accounts integer not null default 0,
  successful_accounts integer not null default 0,
  failed_accounts integer not null default 0,
  rows_imported integer not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  error_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.meta_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.meta_sync_runs(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  account_id uuid not null references public.meta_ad_accounts(id) on delete cascade,
  days integer not null check (days between 1 and 90),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'retry', 'completed', 'failed', 'canceled')),
  attempt_count integer not null default 0,
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  worker_id text,
  rows_imported integer not null default 0,
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, account_id)
);

create index if not exists meta_sync_runs_tenant_created_idx
  on public.meta_sync_runs (tenant_id, created_at desc);

create unique index if not exists meta_sync_runs_one_active_tenant
  on public.meta_sync_runs (tenant_id)
  where status in ('queued', 'running');

create index if not exists meta_sync_jobs_claim_idx
  on public.meta_sync_jobs (status, next_attempt_at, created_at)
  where status in ('queued', 'retry', 'running');

alter table public.meta_sync_runs enable row level security;
alter table public.meta_sync_jobs enable row level security;

grant select on public.meta_sync_runs to authenticated;
grant select on public.meta_sync_jobs to authenticated;
grant all on public.meta_sync_runs to service_role;
grant all on public.meta_sync_jobs to service_role;

drop policy if exists meta_sync_runs_tenant_select on public.meta_sync_runs;
create policy meta_sync_runs_tenant_select
  on public.meta_sync_runs for select
  using (public.has_tenant_access(tenant_id));

drop policy if exists meta_sync_jobs_tenant_select on public.meta_sync_jobs;
create policy meta_sync_jobs_tenant_select
  on public.meta_sync_jobs for select
  using (public.has_tenant_access(tenant_id));

drop trigger if exists meta_sync_runs_set_updated_at on public.meta_sync_runs;
create trigger meta_sync_runs_set_updated_at
  before update on public.meta_sync_runs
  for each row execute function public.update_updated_at_column();

drop trigger if exists meta_sync_jobs_set_updated_at on public.meta_sync_jobs;
create trigger meta_sync_jobs_set_updated_at
  before update on public.meta_sync_jobs
  for each row execute function public.update_updated_at_column();

create or replace function public.claim_meta_sync_jobs(
  p_limit integer default 2,
  p_worker_id text default null
)
returns setof public.meta_sync_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidates as (
    select job.id
    from public.meta_sync_jobs job
    where (
      (job.status in ('queued', 'retry') and job.next_attempt_at <= now())
      or (job.status = 'running' and job.locked_at < now() - interval '10 minutes')
    )
      and job.attempt_count < job.max_attempts
    order by job.next_attempt_at, job.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 2), 10))
  )
  update public.meta_sync_jobs job
  set status = 'running',
      attempt_count = job.attempt_count + 1,
      locked_at = now(),
      worker_id = coalesce(p_worker_id, gen_random_uuid()::text),
      started_at = coalesce(job.started_at, now()),
      last_error = null
  from candidates
  where job.id = candidates.id
  returning job.*;
end;
$$;

revoke execute on function public.claim_meta_sync_jobs(integer, text) from public, anon, authenticated;
grant execute on function public.claim_meta_sync_jobs(integer, text) to service_role;

comment on table public.meta_sync_runs is
  'Tenant-scoped history and aggregate progress for Meta synchronization requests.';

comment on table public.meta_sync_jobs is
  'One retryable synchronization job per Meta ad account and run.';
