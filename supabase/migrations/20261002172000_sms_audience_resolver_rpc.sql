create or replace function public.sms_audience_player_matches(
  _total_deposited numeric,
  _ftd_at timestamptz,
  _last_deposit_at timestamptz,
  _created_at timestamptz,
  _last_login_at timestamptz,
  _cashback_at timestamptz,
  _has_pending_pix boolean,
  _has_withdrawal boolean,
  _has_pending_withdrawal boolean,
  _criteria jsonb,
  _thresholds jsonb,
  _cooling integer,
  _sleeping integer
)
returns boolean
language plpgsql
stable
set search_path = public
as $$
declare
  v_deposit text := coalesce(_criteria #>> '{activity,deposit}', 'any');
  v_withdrawal text := coalesce(_criteria #>> '{activity,withdrawal}', 'any');
  v_level text := nullif(_criteria->>'level', '');
  v_timing text := coalesce(_criteria->>'timing', 'any');
  v_has_deposit boolean := coalesce(_total_deposited,0) > 0 or _ftd_at is not null;
  v_days integer;
  v_login_days integer;
  v_registration_days integer;
  v_min numeric;
  v_next numeric;
  v_custom integer := greatest(1, coalesce((_criteria->>'customDays')::int, 2));
  v_without_login integer := nullif(_criteria->>'daysWithoutLogin','')::int;
  v_since_registration integer := nullif(_criteria->>'daysSinceRegistration','')::int;
begin
  if v_deposit = 'never' and v_has_deposit then return false; end if;
  if v_deposit = 'yes' and not v_has_deposit then return false; end if;
  if coalesce((_criteria #>> '{activity,pixUnpaid}')::boolean, false) and not _has_pending_pix then return false; end if;
  if v_withdrawal = 'yes' and not _has_withdrawal then return false; end if;
  if v_withdrawal = 'never' and _has_withdrawal then return false; end if;
  if coalesce((_criteria #>> '{activity,withdrawalPending}')::boolean, false) and not _has_pending_withdrawal then return false; end if;
  if coalesce((_criteria #>> '{activity,cashback}')::boolean, false) and _cashback_at is null then return false; end if;

  if v_level is not null and v_level <> 'null' then
    v_min := coalesce((_thresholds->>v_level)::numeric, 0);
    v_next := case v_level
      when 'bronze' then (_thresholds->>'silver')::numeric
      when 'silver' then (_thresholds->>'gold')::numeric
      when 'gold' then (_thresholds->>'diamond')::numeric
      when 'diamond' then (_thresholds->>'black')::numeric
      else null
    end;
    if coalesce(_total_deposited,0) < v_min or (v_next is not null and coalesce(_total_deposited,0) >= v_next) then
      return false;
    end if;
  end if;

  v_days := greatest(0, floor(extract(epoch from (now() - coalesce(_last_deposit_at, _ftd_at, _created_at))) / 86400))::int;
  if v_timing = 'registered_week' and _created_at < date_trunc('week', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo' then return false; end if;
  if v_timing = 'cooling' and not (v_days >= _cooling and v_days < _sleeping) then return false; end if;
  if v_timing = 'sleeping' and not (v_days >= _sleeping) then return false; end if;
  if v_timing = 'inactive30' and not (v_days >= 30) then return false; end if;
  if v_timing = 'inactive90' and not (v_days >= 90) then return false; end if;
  if v_timing = 'custom' and not (v_days >= v_custom) then return false; end if;

  v_login_days := greatest(0, floor(extract(epoch from (now() - coalesce(_last_login_at, _created_at))) / 86400))::int;
  if v_without_login is not null and v_login_days < v_without_login then return false; end if;
  v_registration_days := greatest(0, floor(extract(epoch from (now() - _created_at)) / 86400))::int;
  if v_since_registration is not null and v_registration_days < v_since_registration then return false; end if;
  return true;
end;
$$;

revoke all on function public.sms_audience_player_matches(numeric,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz,boolean,boolean,boolean,jsonb,jsonb,integer,integer) from public, anon, authenticated;

create or replace function public.resolve_sms_audience_v2(
  _tenant uuid,
  _criteria jsonb
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
    jsonb_build_object(
      'bronze', coalesce((level_thresholds->>'bronze')::numeric,10),
      'silver', coalesce((level_thresholds->>'silver')::numeric,200),
      'gold', coalesce((level_thresholds->>'gold')::numeric,500),
      'diamond', coalesce((level_thresholds->>'diamond')::numeric,1000),
      'black', coalesce((level_thresholds->>'black')::numeric,3000)
    ) thresholds,
    coalesce(cooling_after_days,2)::int cooling,
    coalesce(sleeping_after_days,7)::int sleeping
  from (select 1) seed
  left join public.gamification_settings gs on gs.tenant_id = _tenant
),
players_base as (
  select
    p.id,p.telefone,p.email,coalesce(p.total_depositado,0)::numeric total_depositado,
    p.ftd_em,p.ultimo_deposito,p.created_at,p.ultimo_login,p.last_cashback_paid_at,
    exists(select 1 from public.deposits d where d.tenant_id=_tenant and d.player_id=p.id
      and d.status='pendente' and (d.metodo is null or lower(d.metodo) like '%pix%')) has_pending_pix,
    (coalesce(p.total_sacado,0)>0 or exists(select 1 from public.withdrawals w
      where w.tenant_id=_tenant and w.player_id=p.id and w.status='aprovado')) has_withdrawal,
    exists(select 1 from public.withdrawals w where w.tenant_id=_tenant and w.player_id=p.id
      and w.status='pendente') has_pending_withdrawal
  from public.players p
  where p.tenant_id = _tenant
),
evaluated as (
  select p.*, s.*,
    public.sms_audience_player_matches(
      p.total_depositado,p.ftd_em,p.ultimo_deposito,p.created_at,p.ultimo_login,
      p.last_cashback_paid_at,p.has_pending_pix,p.has_withdrawal,p.has_pending_withdrawal,
      _criteria,s.thresholds,s.cooling,s.sleeping
    ) matches
  from players_base p cross join settings s
),
matched as (select * from evaluated where matches),
result as (
  select jsonb_build_object(
    'phones', coalesce((select jsonb_agg(phone order by phone) from (
      select distinct regexp_replace(telefone,'\D','','g') phone from matched
      where length(regexp_replace(coalesce(telefone,''),'\D','','g')) >= 10
    ) phones), '[]'::jsonb),
    'total', (select count(*) from matched),
    'recipientTotal', (select count(distinct regexp_replace(telefone,'\D','','g')) from matched
      where length(regexp_replace(coalesce(telefone,''),'\D','','g')) >= 10),
    'emailPlayerIds', coalesce((select jsonb_agg(id) from matched where nullif(trim(email),'') is not null), '[]'::jsonb),
    'emailRecipientTotal', (select count(*) from matched where nullif(trim(email),'') is not null),
    'facets', jsonb_build_object(
      'activity', jsonb_build_object(
        'depositNever', (select count(*) from evaluated e where public.sms_audience_player_matches(e.total_depositado,e.ftd_em,e.ultimo_deposito,e.created_at,e.ultimo_login,e.last_cashback_paid_at,e.has_pending_pix,e.has_withdrawal,e.has_pending_withdrawal,jsonb_set(jsonb_set(jsonb_set(_criteria,'{activity,deposit}','"never"'),'{level}','null'),'{timing}','"any"'),e.thresholds,e.cooling,e.sleeping)),
        'depositYes', (select count(*) from evaluated e where public.sms_audience_player_matches(e.total_depositado,e.ftd_em,e.ultimo_deposito,e.created_at,e.ultimo_login,e.last_cashback_paid_at,e.has_pending_pix,e.has_withdrawal,e.has_pending_withdrawal,jsonb_set(_criteria,'{activity,deposit}','"yes"'),e.thresholds,e.cooling,e.sleeping)),
        'pixUnpaid', (select count(*) from evaluated e where public.sms_audience_player_matches(e.total_depositado,e.ftd_em,e.ultimo_deposito,e.created_at,e.ultimo_login,e.last_cashback_paid_at,e.has_pending_pix,e.has_withdrawal,e.has_pending_withdrawal,jsonb_set(_criteria,'{activity,pixUnpaid}','true'),e.thresholds,e.cooling,e.sleeping)),
        'withdrawalYes', (select count(*) from evaluated e where public.sms_audience_player_matches(e.total_depositado,e.ftd_em,e.ultimo_deposito,e.created_at,e.ultimo_login,e.last_cashback_paid_at,e.has_pending_pix,e.has_withdrawal,e.has_pending_withdrawal,jsonb_set(_criteria,'{activity,withdrawal}','"yes"'),e.thresholds,e.cooling,e.sleeping)),
        'withdrawalNever', (select count(*) from evaluated e where public.sms_audience_player_matches(e.total_depositado,e.ftd_em,e.ultimo_deposito,e.created_at,e.ultimo_login,e.last_cashback_paid_at,e.has_pending_pix,e.has_withdrawal,e.has_pending_withdrawal,jsonb_set(_criteria,'{activity,withdrawal}','"never"'),e.thresholds,e.cooling,e.sleeping)),
        'withdrawalPending', (select count(*) from evaluated e where public.sms_audience_player_matches(e.total_depositado,e.ftd_em,e.ultimo_deposito,e.created_at,e.ultimo_login,e.last_cashback_paid_at,e.has_pending_pix,e.has_withdrawal,e.has_pending_withdrawal,jsonb_set(_criteria,'{activity,withdrawalPending}','true'),e.thresholds,e.cooling,e.sleeping)),
        'cashback', (select count(*) from evaluated e where public.sms_audience_player_matches(e.total_depositado,e.ftd_em,e.ultimo_deposito,e.created_at,e.ultimo_login,e.last_cashback_paid_at,e.has_pending_pix,e.has_withdrawal,e.has_pending_withdrawal,jsonb_set(_criteria,'{activity,cashback}','true'),e.thresholds,e.cooling,e.sleeping))
      ),
      'levels', (select jsonb_object_agg(level_key, count_value) from (
        select level_key, (select count(*) from evaluated e where public.sms_audience_player_matches(e.total_depositado,e.ftd_em,e.ultimo_deposito,e.created_at,e.ultimo_login,e.last_cashback_paid_at,e.has_pending_pix,e.has_withdrawal,e.has_pending_withdrawal,jsonb_set(_criteria,'{level}',to_jsonb(level_key)),e.thresholds,e.cooling,e.sleeping)) count_value
        from (values ('bronze'),('silver'),('gold'),('diamond'),('black')) levels(level_key)
      ) level_counts),
      'timings', (select jsonb_object_agg(timing_key, count_value) from (
        select timing_key, (select count(*) from evaluated e where public.sms_audience_player_matches(e.total_depositado,e.ftd_em,e.ultimo_deposito,e.created_at,e.ultimo_login,e.last_cashback_paid_at,e.has_pending_pix,e.has_withdrawal,e.has_pending_withdrawal,jsonb_set(_criteria,'{timing}',to_jsonb(timing_key)),e.thresholds,e.cooling,e.sleeping)) count_value
        from (values ('cooling'),('sleeping'),('inactive30'),('inactive90')) timings(timing_key)
      ) timing_counts)
    ),
    'settings', jsonb_build_object('thresholds',s.thresholds,'cooling',s.cooling,'sleeping',s.sleeping)
  ) value
  from settings s
)
select r.value from guard g cross join result r where g.ok;
$$;

revoke all on function public.resolve_sms_audience_v2(uuid,jsonb) from public, anon;
grant execute on function public.resolve_sms_audience_v2(uuid,jsonb) to authenticated, service_role;
