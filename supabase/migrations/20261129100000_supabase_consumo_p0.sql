-- Supabase consumption, P0 (docs/AUDITORIA_CONSUMO_SUPABASE_2026-11-04.md).
--
-- 1. refresh_crm_results_day joined journey_step_executions on
--    `x.idempotency_key::text = s.idempotency_key`. The cast on the uuid column
--    skips its index, so every call read the whole index (835k entries) twice.
--    It now compares as uuid (malformed keys never matched a uuid anyway).
--    Measured on prod, one house and one day: 386k -> 28k buffers.
-- 2. refresh_crm_results_recent skips the day rebuild of a house with no
--    activity that day and no rows to clear: the rebuild would write nothing.
-- 3. Cadence: today every 15 min; today + yesterday once at 00:10 BRT to close
--    the day's last minutes (was both every 10 min); the 8-day rebuild at
--    03:20 BRT stays and takes the late events. Measured on prod over 14 days:
--    attributions and clicks never arrive after the day; 47 deposits did, all
--    within 4 min of midnight; 2 (R$ 135) after 03:20. Short.io sync every
--    5 min (was every minute): first-party clicks are the source of truth.
-- 4. cron.job_run_details kept for 3 days (it had no cleanup: 385k rows, 525 MB).

-- Text key -> uuid, null when it is not a uuid (inlined by the planner).
create or replace function public.crm_try_uuid(_value text)
returns uuid
language sql
immutable
parallel safe
set search_path = public
as $$
  select case
    when _value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then _value::uuid
  end
$$;

-- base: 20261109100000_crm_influenced_dormant_first_deposit.sql (only the two journey joins change)
create or replace function public.refresh_crm_results_day(_tenant uuid, _day date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from timestamptz := (_day::timestamp at time zone 'America/Sao_Paulo');
  v_to timestamptz := ((_day + 1)::timestamp at time zone 'America/Sao_Paulo');
  v_price numeric;
  v_rows integer;
begin
  v_price := public.crm_sms_report_price(_tenant, v_from);

  delete from public.crm_results_daily where tenant_id = _tenant and metric_date = _day;

  insert into public.crm_results_daily (
    tenant_id, metric_date, source_type, source_key, source_id, step_position, player_state,
    sent, failed, cost, recipients, human_clicks, converted_clicks,
    direct_conversions, direct_players, direct_revenue,
    direct_active_conversions, direct_active_players, direct_active_revenue,
    influenced_players, influenced_deposits, influenced_revenue, rule_version, updated_at
  )
  with
  sends as (
    select src.source_type,
           case when s.campaign_id is not null
                then coalesce((select c.name from public.sms_campaigns c where c.id = s.campaign_id), src.source_key)
                else src.source_key end source_key,
           coalesce(s.campaign_id, src.source_id) source_id,
           coalesce(x.step_position, -1) step_position,
           public.crm_player_state(_tenant, s.player_id, s.created_at) player_state,
           s.player_id,
           s.billed_units,
           s.status in ('sent', 'delivered', 'enviado', 'entregue') is_sent,
           s.status in ('error', 'erro', 'failed') is_failed
    from public.sms_send_logs s
    cross join lateral public.crm_source_of_trigger(_tenant, s.trigger_name) src
    left join public.journey_step_executions x
      on src.source_type = 'journey' and x.idempotency_key = public.crm_try_uuid(s.idempotency_key)
    where s.tenant_id = _tenant and s.created_at >= v_from and s.created_at < v_to
  ),
  sends_agg as (
    select s.source_type, s.source_key, max(s.source_id::text)::uuid source_id, s.step_position, s.player_state,
           count(*) filter (where s.is_sent) sent,
           count(*) filter (where s.is_failed) failed,
           coalesce(sum(coalesce(s.billed_units, 1)) filter (where s.is_sent), 0) * v_price cost,
           count(distinct s.player_id) filter (where s.is_sent) recipients,
           0 human_clicks, 0 converted_clicks,
           0 direct_conversions, 0 direct_players, 0::numeric direct_revenue,
           0 direct_active_conversions, 0 direct_active_players, 0::numeric direct_active_revenue,
           0 influenced_players, 0 influenced_deposits, 0::numeric influenced_revenue
    from sends s group by 1, 2, 4, 5
  ),
  -- Direct deposits of the dispatches that matter for the day (clicked on the
  -- day, or with a deposit on the day), flagged per dispatch.
  direct_deps as (
    select * from public.crm_direct_deposits(_tenant, v_from - interval '8 days')
  ),
  dispatch_origin as (
    select ld.id,
           ld.source_type,
           case when ld.source_type = 'campaign'
                then coalesce((select c.name from public.sms_campaigns c
                               where c.id::text = ld.source_id), ld.source_id)
                else lower(ld.source_id) end source_key,
           case when ld.source_id ~* '^[0-9a-f-]{36}$' then ld.source_id::uuid end source_id,
           coalesce(ld.journey_step_position, -1) step_position,
           ld.recipient_player_id player_id,
           public.crm_player_state(_tenant, ld.recipient_player_id, coalesce(ld.sent_at, ld.created_at)) player_state
    from public.link_dispatches ld
    where ld.tenant_id = _tenant
      and ld.source_type in ('campaign', 'journey')
      and ld.id in (
        select ce.link_dispatch_id from public.click_events ce
        where ce.tenant_id = _tenant and ce.is_human
          and ce.occurred_at >= v_from and ce.occurred_at < v_to
        union
        select a.link_dispatch_id from public.conversion_attributions a
        where a.tenant_id = _tenant and a.occurred_at >= v_from and a.occurred_at < v_to
      )
  ),
  -- Dispatches that brought a deposit of a player who was not active.
  converted_dispatches as (
    select distinct d.link_dispatch_id id from direct_deps d where not d.was_active
  ),
  clicks_agg as (
    select o.source_type, o.source_key, max(o.source_id::text)::uuid source_id, o.step_position, o.player_state,
           0 sent, 0 failed, 0::numeric cost, 0 recipients,
           count(distinct ce.link_dispatch_id) human_clicks,
           count(distinct ce.link_dispatch_id) filter (where cd.id is not null) converted_clicks,
           0 direct_conversions, 0 direct_players, 0::numeric direct_revenue,
           0 direct_active_conversions, 0 direct_active_players, 0::numeric direct_active_revenue,
           0 influenced_players, 0 influenced_deposits, 0::numeric influenced_revenue
    from public.click_events ce
    join dispatch_origin o on o.id = ce.link_dispatch_id
    left join converted_dispatches cd on cd.id = ce.link_dispatch_id
    where ce.tenant_id = _tenant and ce.is_human
      and ce.occurred_at >= v_from and ce.occurred_at < v_to
    group by 1, 2, 4, 5
  ),
  direct_agg as (
    select o.source_type, o.source_key, max(o.source_id::text)::uuid source_id, o.step_position, o.player_state,
           0 sent, 0 failed, 0::numeric cost, 0 recipients, 0 human_clicks, 0 converted_clicks,
           count(*) filter (where not d.was_active) direct_conversions,
           -- A player converted by one SMS counts once, on the day of the first deposit.
           count(distinct d.player_id) filter (where not d.was_active and d.is_first) direct_players,
           coalesce(sum(d.monetary_value) filter (where not d.was_active), 0) direct_revenue,
           count(*) filter (where d.was_active) direct_active_conversions,
           count(distinct d.player_id) filter (where d.was_active) direct_active_players,
           coalesce(sum(d.monetary_value) filter (where d.was_active), 0) direct_active_revenue,
           0 influenced_players, 0 influenced_deposits, 0::numeric influenced_revenue
    from direct_deps d
    join dispatch_origin o on o.id = d.link_dispatch_id
    where d.occurred_at >= v_from and d.occurred_at < v_to
    group by 1, 2, 4, 5
  ),
  deps as (
    select d.id, d.player_id, d.valor, d.created_at,
           (select max(p.created_at) from public.deposits p
            where p.tenant_id = _tenant and p.player_id = d.player_id
              and p.status = 'aprovado' and p.created_at < d.created_at) prev_at,
           (select pl.ftd_em from public.players pl where pl.id = d.player_id) ftd_em,
           (select pl.created_at from public.players pl where pl.id = d.player_id) registered_at
    from public.deposits d
    where d.tenant_id = _tenant and d.status = 'aprovado' and d.player_id is not null
      and d.created_at >= v_from and d.created_at < v_to
  ),
  -- Returning (>= 48 h without depositing) or a true first deposit; a first
  -- deposit in our history of an older depositor is not a recovery. A first
  -- deposit only counts after an SMS sent 48 h+ after sign-up (see credited).
  eligible as (
    select * from deps
    where (prev_at is not null and created_at - prev_at >= interval '48 hours')
       or (prev_at is null and (ftd_em is null or ftd_em >= created_at - interval '10 minutes'))
  ),
  credited as (
    select e.player_id, e.valor, ls.trigger_name, ls.idempotency_key, ls.sent_at, ls.campaign_id
    from eligible e
    cross join lateral (
      select s.trigger_name, s.idempotency_key, s.created_at sent_at, s.campaign_id
      from public.sms_send_logs s
      where s.tenant_id = _tenant and s.player_id = e.player_id
        and s.status in ('sent', 'delivered', 'enviado', 'entregue')
        and s.created_at < e.created_at
        and s.created_at >= e.created_at - interval '72 hours'
        and (e.prev_at is not null or s.created_at >= e.registered_at + interval '48 hours')
      order by s.created_at desc
      limit 1
    ) ls
  ),
  influenced_agg as (
    select src.source_type,
           case when c.campaign_id is not null
                then coalesce((select sc.name from public.sms_campaigns sc where sc.id = c.campaign_id), src.source_key)
                else src.source_key end source_key,
           max(coalesce(c.campaign_id, src.source_id)::text)::uuid source_id,
           coalesce(x.step_position, -1) step_position,
           public.crm_player_state(_tenant, c.player_id, c.sent_at) player_state,
           0 sent, 0 failed, 0::numeric cost, 0 recipients, 0 human_clicks, 0 converted_clicks,
           0 direct_conversions, 0 direct_players, 0::numeric direct_revenue,
           0 direct_active_conversions, 0 direct_active_players, 0::numeric direct_active_revenue,
           count(distinct c.player_id) influenced_players,
           count(*) influenced_deposits,
           coalesce(sum(c.valor), 0) influenced_revenue
    from credited c
    cross join lateral public.crm_source_of_trigger(_tenant, c.trigger_name) src
    left join public.journey_step_executions x
      on src.source_type = 'journey' and x.idempotency_key = public.crm_try_uuid(c.idempotency_key)
    group by 1, 2, 4, 5
  ),
  all_parts as (
    select * from sends_agg
    union all select * from clicks_agg
    union all select * from direct_agg
    union all select * from influenced_agg
  )
  select _tenant, _day, source_type, source_key, max(source_id::text)::uuid, step_position, player_state,
         sum(sent), sum(failed), sum(cost), sum(recipients), sum(human_clicks), sum(converted_clicks),
         sum(direct_conversions), sum(direct_players), sum(direct_revenue),
         sum(direct_active_conversions), sum(direct_active_players), sum(direct_active_revenue),
         sum(influenced_players), sum(influenced_deposits), sum(influenced_revenue),
         4, now()
  from all_parts
  group by source_type, source_key, step_position, player_state;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.refresh_crm_results_day(uuid, date) from public, anon, authenticated;
grant execute on function public.refresh_crm_results_day(uuid, date) to service_role;

-- base: 20261018110000_demo_tenant_skip_workers.sql
create or replace function public.refresh_crm_results_recent(_days integer default 2)
returns integer -- tenants that failed (-1 = skipped, another run holds the lock)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_tenant uuid;
  v_day date;
  v_from timestamptz;
  v_to timestamptz;
  v_failed integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('betleads.refresh_crm_results')::bigint) then
    return -1;
  end if;
  for v_tenant in select id from public.tenants where not is_demo order by id loop
    begin
      for v_day in
        select generate_series(v_today - greatest(1, _days) + 1, v_today, interval '1 day')::date
      loop
        v_from := (v_day::timestamp at time zone 'America/Sao_Paulo');
        v_to := ((v_day + 1)::timestamp at time zone 'America/Sao_Paulo');
        -- Every part of the day rebuild starts from one of these four; with
        -- none of them and nothing stored, the rebuild would write nothing.
        if exists (select 1 from public.sms_send_logs s
                   where s.tenant_id = v_tenant and s.created_at >= v_from and s.created_at < v_to)
           or exists (select 1 from public.click_events ce
                      where ce.tenant_id = v_tenant and ce.is_human
                        and ce.occurred_at >= v_from and ce.occurred_at < v_to)
           or exists (select 1 from public.conversion_attributions a
                      where a.tenant_id = v_tenant
                        and a.occurred_at >= v_from and a.occurred_at < v_to)
           or exists (select 1 from public.deposits d
                      where d.tenant_id = v_tenant and d.status = 'aprovado'
                        and d.created_at >= v_from and d.created_at < v_to)
           or exists (select 1 from public.crm_results_daily r
                      where r.tenant_id = v_tenant and r.metric_date = v_day)
        then
          perform public.refresh_crm_results_day(v_tenant, v_day);
        end if;
        perform public.refresh_player_lifecycle_day(v_tenant, v_day);
      end loop;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'refresh_crm_results: tenant % failed: % %', v_tenant, sqlstate, left(sqlerrm, 200);
    end;
  end loop;
  return v_failed;
end;
$$;

revoke all on function public.refresh_crm_results_recent(integer) from public, anon, authenticated;
grant execute on function public.refresh_crm_results_recent(integer) to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- Today only, every 15 minutes.
    perform cron.unschedule(jobid) from cron.job
      where jobname in ('betleads-crm-results-recent', 'betleads-crm-results-yesterday');
    perform cron.schedule(
      'betleads-crm-results-recent',
      '*/15 * * * *',
      $cron$set statement_timeout = '300s'; select public.refresh_crm_results_recent(1);$cron$
    );
    -- Today and yesterday once, 00:10 BRT (03:10 UTC): the day's last minutes.
    -- Off the quarter-hours so it does not lose the lock to the run above.
    perform cron.schedule(
      'betleads-crm-results-yesterday',
      '10 3 * * *',
      $cron$set statement_timeout = '300s'; select public.refresh_crm_results_recent(2);$cron$
    );

    -- Keeps the command (and its vault secret) as is; only the schedule changes.
    perform cron.alter_job(jobid, schedule => '*/5 * * * *')
      from cron.job where jobname = 'betleads-shortio-sync';

    perform cron.unschedule(jobid) from cron.job
      where jobname = 'betleads-cron-history-retention';
    perform cron.schedule(
      'betleads-cron-history-retention',
      '41 4 * * *',
      $cron$delete from cron.job_run_details where start_time < now() - interval '3 days'$cron$
    );
  end if;
end $$;
