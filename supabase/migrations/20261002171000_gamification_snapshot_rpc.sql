create or replace function public.gamification_snapshot_v2(
  _tenant uuid default public.current_tenant_id()
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
settings as (
  select
    coalesce((level_thresholds->>'bronze')::numeric, 10) bronze,
    coalesce((level_thresholds->>'silver')::numeric, 200) silver,
    coalesce((level_thresholds->>'gold')::numeric, 500) gold,
    coalesce((level_thresholds->>'diamond')::numeric, 1000) diamond,
    coalesce((level_thresholds->>'black')::numeric, 3000) black,
    coalesce(cooling_after_days, 2)::int cooling,
    coalesce(sleeping_after_days, 7)::int sleeping,
    coalesce(vip_min_level, 'diamond') vip_min_level
  from (select 1) seed
  left join public.gamification_settings gs on gs.tenant_id = _tenant
),
base as (
  select
    p.id,
    coalesce(p.nome, 'Novo player') nome,
    p.player_external_id,
    coalesce(p.total_depositado, 0)::numeric total_depositado,
    coalesce(p.total_sacado, 0)::numeric total_sacado,
    p.ultimo_deposito,
    p.ftd_em,
    p.telefone,
    p.email,
    case
      when coalesce(p.total_depositado,0) >= s.black then 'black'
      when coalesce(p.total_depositado,0) >= s.diamond then 'diamond'
      when coalesce(p.total_depositado,0) >= s.gold then 'gold'
      when coalesce(p.total_depositado,0) >= s.silver then 'silver'
      when coalesce(p.total_depositado,0) >= s.bronze then 'bronze'
      else 'novice'
    end level,
    case
      when coalesce(p.total_depositado,0) <= 0 and p.ftd_em is null then null
      when coalesce(p.ultimo_deposito, p.ftd_em) is null then null
      else greatest(0, floor(extract(epoch from (now() - coalesce(p.ultimo_deposito, p.ftd_em))) / 86400))::int
    end days_without_deposit,
    s.*
  from public.players p
  cross join settings s
  where p.tenant_id = _tenant
),
classified as (
  select b.*,
    case
      when b.ftd_em is null and b.total_depositado <= 0 then 'no_deposit'
      when b.days_without_deposit is null then 'no_deposit'
      when b.days_without_deposit >= b.sleeping then 'sleeping'
      when b.days_without_deposit >= b.cooling then 'cooling'
      else 'active'
    end status,
    case b.level when 'black' then 5 when 'diamond' then 4 when 'gold' then 3
      when 'silver' then 2 when 'bronze' then 1 else 0 end level_rank,
    case b.vip_min_level when 'black' then 5 when 'diamond' then 4 when 'gold' then 3
      when 'silver' then 2 when 'bronze' then 1 else 4 end vip_min_rank
  from base b
),
level_defs(slug,label,min_value,ord) as (
  select 'novice','Novato',0::numeric,0
  union all select 'bronze','Bronze',bronze,1 from settings
  union all select 'silver','Prata',silver,2 from settings
  union all select 'gold','Ouro',gold,3 from settings
  union all select 'diamond','Diamante',diamond,4 from settings
  union all select 'black','Black VIP',black,5 from settings
),
level_stats as (
  select d.slug,d.label,d.min_value,d.ord,
    count(c.id)::int count,
    case when (select count(*) from classified) = 0 then 0
      else round(count(c.id)::numeric * 100 / (select count(*) from classified))::int end percent,
    coalesce(sum(c.total_depositado),0) total_deposited,
    count(c.id) filter (where c.status <> 'active')::int stopped
  from level_defs d
  left join classified c on c.level = d.slug
  group by d.slug,d.label,d.min_value,d.ord
),
level_summary as (
  select jsonb_agg(jsonb_build_object(
    'slug', slug,
    'label', label,
    'min', min_value,
    'count', count,
    'percent', percent,
    'totalDeposited', total_deposited,
    'stopped', stopped
  ) order by ord) value
  from level_stats
),
totals as (
  select jsonb_build_object(
    'players', count(*),
    'depositors', count(*) filter (where total_depositado > 0 or ftd_em is not null),
    'deposited', coalesce(sum(total_depositado),0),
    'stoppedVipCount', count(*) filter (where level_rank >= vip_min_rank and status not in ('active','no_deposit')),
    'activeCount', count(*) filter (where status = 'active'),
    'coolingCount', count(*) filter (where status = 'cooling'),
    'sleepingCount', count(*) filter (where status = 'sleeping'),
    'noDepositCount', count(*) filter (where status = 'no_deposit')
  ) value from classified
),
segments as (
  select jsonb_object_agg(status_key, levels) value from (
    select status_key, jsonb_build_object(
      'novice', count(*) filter (where c.level = 'novice'),
      'bronze', count(*) filter (where c.level = 'bronze'),
      'silver', count(*) filter (where c.level = 'silver'),
      'gold', count(*) filter (where c.level = 'gold'),
      'diamond', count(*) filter (where c.level = 'diamond'),
      'black', count(*) filter (where c.level = 'black')
    ) levels
    from (values ('active'),('cooling'),('sleeping'),('no_deposit')) statuses(status_key)
    left join classified c on c.status = status_key
    group by status_key
  ) x
),
ranking as (
  select coalesce(jsonb_agg(to_jsonb(x) order by x.total_depositado desc), '[]'::jsonb) value
  from (
    select id,nome,player_external_id,total_depositado,total_sacado,ultimo_deposito,
      ftd_em,telefone,email,level,status,days_without_deposit as "daysWithoutDeposit"
    from classified order by total_depositado desc limit 200
  ) x
),
vip_stopped as (
  select coalesce(jsonb_agg(to_jsonb(x) order by x.total_depositado desc), '[]'::jsonb) value
  from (
    select id,nome,player_external_id,total_depositado,total_sacado,ultimo_deposito,
      ftd_em,telefone,email,level,status,days_without_deposit as "daysWithoutDeposit"
    from classified
    where level_rank >= vip_min_rank and status not in ('active','no_deposit')
    order by total_depositado desc limit 8
  ) x
)
select jsonb_build_object(
  'settings', jsonb_build_object(
    'thresholds', jsonb_build_object('bronze',s.bronze,'silver',s.silver,'gold',s.gold,'diamond',s.diamond,'black',s.black),
    'coolingAfterDays', s.cooling,
    'sleepingAfterDays', s.sleeping,
    'vipMinLevel', s.vip_min_level
  ),
  'levels', ls.value,
  'totals', t.value,
  'segmentCounts', sg.value,
  'vipStopped', vs.value,
  'ranking', r.value
)
from guard g, settings s, level_summary ls, totals t, segments sg, vip_stopped vs, ranking r
where g.ok;
$$;

revoke all on function public.gamification_snapshot_v2(uuid) from public, anon;
grant execute on function public.gamification_snapshot_v2(uuid) to authenticated, service_role;
