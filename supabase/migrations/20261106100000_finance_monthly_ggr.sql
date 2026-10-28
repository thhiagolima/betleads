-- GGR do mês: a house may type, per month, its accumulated "Perdas na casa"
-- (month to date, from the platform's GGR PAINEL) instead of a GGR per day.
-- The app spreads it over the month's days from the 1st to valid_through
-- (allocateMonthlyGgr in src/lib/finance/calc.ts); while a row exists, the
-- daily ggr of that month in tenant_finance_daily is ignored (not deleted).
-- Same access pattern as tenant_finance_daily: read via finance_can_view,
-- writes only through service_role.

create table if not exists public.tenant_finance_monthly_ggr (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  ggr numeric(14,2) not null,
  valid_through date not null,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, month),
  check (valid_through >= month and valid_through < month + interval '1 month')
);

comment on table public.tenant_finance_monthly_ggr is
  'Accumulated GGR ("Perdas na casa") of a house for a month, valid up to valid_through; replaces the month''s daily GGR while present.';

alter table public.tenant_finance_monthly_ggr enable row level security;

drop policy if exists tenant_finance_monthly_ggr_select on public.tenant_finance_monthly_ggr;
create policy tenant_finance_monthly_ggr_select
  on public.tenant_finance_monthly_ggr for select to authenticated
  using (public.finance_can_view(auth.uid(), tenant_id));

grant select on public.tenant_finance_monthly_ggr to authenticated;
grant all on public.tenant_finance_monthly_ggr to service_role;
