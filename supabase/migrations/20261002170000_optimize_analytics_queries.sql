-- Fast, tenant-scoped analytics. Closed days are read from this compact table;
-- triggers keep the current day correct as webhooks arrive.
create table if not exists public.tenant_daily_metrics (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  metric_date date not null,
  registrations integer not null default 0,
  ftds integer not null default 0,
  approved_deposit_count integer not null default 0,
  approved_depositor_count integer not null default 0,
  approved_deposit_amount numeric not null default 0,
  approved_withdrawal_count integer not null default 0,
  approved_withdrawal_amount numeric not null default 0,
  generated_pix_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, metric_date)
);

alter table public.tenant_daily_metrics enable row level security;

drop policy if exists "tenant daily metrics read" on public.tenant_daily_metrics;
create policy "tenant daily metrics read"
on public.tenant_daily_metrics for select to authenticated
using (public.has_tenant_access(tenant_id));

create or replace function public.refresh_tenant_daily_metric_day(
  _tenant uuid,
  _date date
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.tenant_daily_metrics (
    tenant_id,
    metric_date,
    registrations,
    ftds,
    approved_deposit_count,
    approved_depositor_count,
    approved_deposit_amount,
    approved_withdrawal_count,
    approved_withdrawal_amount,
    generated_pix_count,
    updated_at
  )
  select
    _tenant,
    _date,
    (select count(*)::int from public.players p
      where p.tenant_id = _tenant
        and (p.created_at at time zone 'America/Sao_Paulo')::date = _date),
    (select count(*)::int from public.players p
      where p.tenant_id = _tenant and p.ftd_em is not null
        and (p.ftd_em at time zone 'America/Sao_Paulo')::date = _date),
    (select count(*)::int from public.deposits d
      where d.tenant_id = _tenant and d.status = 'aprovado'
        and (d.created_at at time zone 'America/Sao_Paulo')::date = _date),
    (select count(distinct d.player_id)::int from public.deposits d
      where d.tenant_id = _tenant and d.status = 'aprovado' and d.player_id is not null
        and (d.created_at at time zone 'America/Sao_Paulo')::date = _date),
    (select coalesce(sum(d.valor), 0) from public.deposits d
      where d.tenant_id = _tenant and d.status = 'aprovado'
        and (d.created_at at time zone 'America/Sao_Paulo')::date = _date),
    (select count(*)::int from public.withdrawals w
      where w.tenant_id = _tenant and w.status = 'aprovado'
        and (w.created_at at time zone 'America/Sao_Paulo')::date = _date),
    (select coalesce(sum(w.valor), 0) from public.withdrawals w
      where w.tenant_id = _tenant and w.status = 'aprovado'
        and (w.created_at at time zone 'America/Sao_Paulo')::date = _date),
    (select count(*)::int from public.deposits d
      where d.tenant_id = _tenant
        and (d.created_at at time zone 'America/Sao_Paulo')::date = _date),
    now()
  on conflict (tenant_id, metric_date) do update set
    registrations = excluded.registrations,
    ftds = excluded.ftds,
    approved_deposit_count = excluded.approved_deposit_count,
    approved_depositor_count = excluded.approved_depositor_count,
    approved_deposit_amount = excluded.approved_deposit_amount,
    approved_withdrawal_count = excluded.approved_withdrawal_count,
    approved_withdrawal_amount = excluded.approved_withdrawal_amount,
    generated_pix_count = excluded.generated_pix_count,
    updated_at = now();
$$;

revoke all on function public.refresh_tenant_daily_metric_day(uuid, date) from public, anon, authenticated;
grant execute on function public.refresh_tenant_daily_metric_day(uuid, date) to service_role;

create or replace function public.refresh_daily_metric_from_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_tenant uuid;
  v_new_tenant uuid;
  v_old_date date;
  v_new_date date;
  v_old_ftd date;
  v_new_ftd date;
begin
  if tg_op <> 'INSERT' then
    v_old_tenant := old.tenant_id;
    v_old_date := (old.created_at at time zone 'America/Sao_Paulo')::date;
    perform public.refresh_tenant_daily_metric_day(v_old_tenant, v_old_date);
  end if;
  if tg_op <> 'DELETE' then
    v_new_tenant := new.tenant_id;
    v_new_date := (new.created_at at time zone 'America/Sao_Paulo')::date;
    if tg_op = 'INSERT' or v_new_tenant is distinct from v_old_tenant or v_new_date is distinct from v_old_date then
      perform public.refresh_tenant_daily_metric_day(v_new_tenant, v_new_date);
    else
      perform public.refresh_tenant_daily_metric_day(v_new_tenant, v_new_date);
    end if;
  end if;
  if tg_table_name = 'players' then
    if tg_op <> 'INSERT' and (to_jsonb(old)->>'ftd_em') is not null then
      v_old_ftd := ((to_jsonb(old)->>'ftd_em')::timestamptz at time zone 'America/Sao_Paulo')::date;
      perform public.refresh_tenant_daily_metric_day(v_old_tenant, v_old_ftd);
    end if;
    if tg_op <> 'DELETE' and (to_jsonb(new)->>'ftd_em') is not null then
      v_new_ftd := ((to_jsonb(new)->>'ftd_em')::timestamptz at time zone 'America/Sao_Paulo')::date;
      if v_new_ftd is distinct from v_old_ftd then
        perform public.refresh_tenant_daily_metric_day(v_new_tenant, v_new_ftd);
      end if;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trg_daily_metrics_players on public.players;
create trigger trg_daily_metrics_players
after insert or delete or update of tenant_id, created_at, ftd_em on public.players
for each row execute function public.refresh_daily_metric_from_row();

drop trigger if exists trg_daily_metrics_deposits on public.deposits;
create trigger trg_daily_metrics_deposits
after insert or delete or update of tenant_id, created_at, status, valor, player_id on public.deposits
for each row execute function public.refresh_daily_metric_from_row();

drop trigger if exists trg_daily_metrics_withdrawals on public.withdrawals;
create trigger trg_daily_metrics_withdrawals
after insert or delete or update of tenant_id, created_at, status, valor, player_id on public.withdrawals
for each row execute function public.refresh_daily_metric_from_row();

-- Initial compact snapshot. A union of active dates avoids generating empty rows.
with metric_keys as (
  select tenant_id, (created_at at time zone 'America/Sao_Paulo')::date metric_date from public.players
  union
  select tenant_id, (ftd_em at time zone 'America/Sao_Paulo')::date from public.players where ftd_em is not null
  union
  select tenant_id, (created_at at time zone 'America/Sao_Paulo')::date from public.deposits
  union
  select tenant_id, (created_at at time zone 'America/Sao_Paulo')::date from public.withdrawals
)
select public.refresh_tenant_daily_metric_day(tenant_id, metric_date)
from metric_keys
where tenant_id is not null and metric_date is not null;

create index if not exists tenant_daily_metrics_tenant_date_idx
  on public.tenant_daily_metrics (tenant_id, metric_date desc);

create index if not exists players_tenant_created_idx
  on public.players (tenant_id, created_at desc);
create index if not exists events_tenant_created_idx
  on public.events (tenant_id, created_at desc);
create index if not exists withdrawals_tenant_player_created_idx
  on public.withdrawals (tenant_id, player_id, created_at desc);
create index if not exists lead_followups_tenant_player_created_idx
  on public.lead_followups (tenant_id, player_id, created_at desc);

create or replace function public.dashboard_summary_v2(
  _tenant uuid,
  _from timestamptz,
  _to timestamptz,
  _prev_from timestamptz,
  _prev_to timestamptz,
  _reset_at timestamptz default '1970-01-01T00:00:00Z'
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with
guard as (
  select (public.has_tenant_access(_tenant) or auth.role() = 'service_role') ok
),
bounds as (
  select greatest(_from, _reset_at) cur_from, _to cur_to,
         greatest(_prev_from, _reset_at) prev_from, _prev_to prev_to
),
cur_daily as (
  select coalesce(sum(registrations),0)::int registrations,
         coalesce(sum(ftds),0)::int ftds,
         coalesce(sum(approved_deposit_count),0)::int deposit_count,
         coalesce(sum(approved_deposit_amount),0)::numeric deposit_amount,
         coalesce(sum(approved_withdrawal_amount),0)::numeric withdrawal_amount,
         coalesce(sum(generated_pix_count),0)::int pix_generated
  from public.tenant_daily_metrics, bounds
  where tenant_id = _tenant
    and metric_date between (cur_from at time zone 'America/Sao_Paulo')::date
                        and (cur_to at time zone 'America/Sao_Paulo')::date
),
prev_daily as (
  select coalesce(sum(registrations),0)::int registrations,
         coalesce(sum(ftds),0)::int ftds,
         coalesce(sum(approved_deposit_count),0)::int deposit_count,
         coalesce(sum(approved_deposit_amount),0)::numeric deposit_amount,
         coalesce(sum(generated_pix_count),0)::int pix_generated
  from public.tenant_daily_metrics, bounds
  where tenant_id = _tenant
    and metric_date between (prev_from at time zone 'America/Sao_Paulo')::date
                        and (prev_to at time zone 'America/Sao_Paulo')::date
),
cur_depositors as (
  select count(distinct d.player_id)::int value
  from public.deposits d, bounds
  where d.tenant_id = _tenant and d.status = 'aprovado' and d.player_id is not null
    and d.created_at between cur_from and cur_to
),
prev_depositors as (
  select count(distinct d.player_id)::int value
  from public.deposits d, bounds
  where d.tenant_id = _tenant and d.status = 'aprovado' and d.player_id is not null
    and d.created_at between prev_from and prev_to
),
cur_redeposits as (
  select coalesce(sum(d.valor),0)::numeric amount, count(*)::int count,
         count(distinct d.player_id)::int players
  from public.deposits d
  join public.players p on p.id = d.player_id and p.tenant_id = d.tenant_id
  cross join bounds
  where d.tenant_id = _tenant and d.status = 'aprovado'
    and d.created_at between cur_from and cur_to
    and p.ftd_em is not null and d.created_at > p.ftd_em + interval '1 minute'
),
prev_redeposits as (
  select coalesce(sum(d.valor),0)::numeric amount
  from public.deposits d
  join public.players p on p.id = d.player_id and p.tenant_id = d.tenant_id
  cross join bounds
  where d.tenant_id = _tenant and d.status = 'aprovado'
    and d.created_at between prev_from and prev_to
    and p.ftd_em is not null and d.created_at > p.ftd_em + interval '1 minute'
),
recovered as (
  select
    coalesce(sum(d.valor),0)::numeric amount,
    count(distinct d.player_id)::int players,
    coalesce(sum(d.valor) filter (where p.created_at >= b.cur_from),0)::numeric new_amount,
    coalesce(sum(d.valor) filter (where p.ftd_em is null),0)::numeric reactivated_amount
  from public.deposits d
  join public.players p on p.id = d.player_id and p.tenant_id = d.tenant_id
  cross join bounds b
  where d.tenant_id = _tenant and d.status = 'aprovado'
    and d.created_at between b.cur_from and b.cur_to
    and exists (
      select 1 from public.lead_followups f
      where f.tenant_id = _tenant and f.player_id = d.player_id
        and f.created_at <= d.created_at
        and f.created_at >= b.cur_from - interval '30 days'
    )
),
sms as (
  select count(*)::int sent from public.sms_send_logs s, bounds
  where s.tenant_id = _tenant and s.created_at between cur_from and cur_to
),
flow_counts as (
  select count(*)::int total, count(*) filter (where is_active)::int active
  from public.sms_flows where tenant_id = _tenant
),
series as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', to_char(day, 'YYYY-MM-DD'),
    'label', to_char(day, 'DD/MM'),
    'deposits', coalesce(m.approved_deposit_amount,0),
    'withdrawals', coalesce(m.approved_withdrawal_amount,0)
  ) order by day), '[]'::jsonb) value
  from bounds b
  cross join lateral generate_series(
    (b.cur_from at time zone 'America/Sao_Paulo')::date,
    (b.cur_to at time zone 'America/Sao_Paulo')::date,
    interval '1 day'
  ) day
  left join public.tenant_daily_metrics m
    on m.tenant_id = _tenant and m.metric_date = day::date
),
live as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', x.kind || '-' || x.id::text,
    'tone', x.tone,
    'player', coalesce(x.player_name, 'jogador'),
    'action', x.action,
    'amount', x.amount,
    'at', x.created_at
  ) order by x.created_at desc), '[]'::jsonb) value
  from (
    (select 'player' kind, p.id, 'blue' tone, p.nome player_name,
            'criou conta' action, null::numeric amount, p.created_at
     from public.players p where p.tenant_id = _tenant order by p.created_at desc limit 12)
    union all
    (select 'deposit', d.id, 'green', p.nome, 'depositou', d.valor, d.created_at
     from public.deposits d left join public.players p on p.id = d.player_id
     where d.tenant_id = _tenant and d.status = 'aprovado' order by d.created_at desc limit 12)
    union all
    (select 'withdrawal', w.id, 'purple', p.nome, 'sacou', w.valor, w.created_at
     from public.withdrawals w left join public.players p on p.id = w.player_id
     where w.tenant_id = _tenant and w.status = 'aprovado' order by w.created_at desc limit 12)
    union all
    (select 'event', e.id, 'orange', p.nome, 'gerou um PIX', e.valor, e.created_at
     from public.events e left join public.players p on p.id = e.player_id
     where e.tenant_id = _tenant
       and (lower(coalesce(e.tipo,'')) like '%pix%' or lower(coalesce(e.tipo,'')) like '%deposit%')
     order by e.created_at desc limit 8)
  ) x
  limit 8
),
other as (
  select
    (select count(*)::int from public.players p
      where p.tenant_id = _tenant and p.ultimo_login < now() - interval '7 days') reactivation_queue,
    coalesce((select balance_credits from public.tenant_sms_credit_balances where tenant_id = _tenant),0)::int sms_credits
)
select jsonb_build_object(
  'depositAmount', c.deposit_amount,
  'previousDepositAmount', p.deposit_amount,
  'depositCount', c.deposit_count,
  'previousDepositCount', p.deposit_count,
  'depositors', cd.value,
  'previousDepositors', pd.value,
  'newPlayers', c.registrations,
  'previousNewPlayers', p.registrations,
  'ftd', c.ftds,
  'previousFtd', p.ftds,
  'withdrawalAmount', c.withdrawal_amount,
  'redepositAmount', cr.amount,
  'previousRedepositAmount', pr.amount,
  'redepositCount', cr.count,
  'redepositPlayers', cr.players,
  'recoveredAmount', r.amount,
  'recoveredPlayers', r.players,
  'recoveredNew', r.new_amount,
  'recoveredReactivated', r.reactivated_amount,
  'smsSent', s.sent,
  'smsCredits', o.sms_credits,
  'pixGenerated', c.pix_generated,
  'previousPixGenerated', p.pix_generated,
  'reactivationQueue', o.reactivation_queue,
  'activeFlows', f.active,
  'totalFlows', f.total,
  'cashflowChart', se.value,
  'liveEvents', l.value
)
from guard, cur_daily c, prev_daily p, cur_depositors cd, prev_depositors pd,
     cur_redeposits cr, prev_redeposits pr, recovered r, sms s,
     flow_counts f, series se, live l, other o
where guard.ok;
$$;

revoke all on function public.dashboard_summary_v2(uuid,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz) from public, anon;
grant execute on function public.dashboard_summary_v2(uuid,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz) to authenticated, service_role;
