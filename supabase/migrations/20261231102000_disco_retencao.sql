-- Disk growth (11-22: autoscale 27 → 40 GB, DB 9 → 23 GB in 17 days).
-- Shorter retention in purge_operational_history (cron 05:50 UTC):
--  * webhook_logs: 30 → 7 days. The screens read the last 24 h / 50 rows and
--    platform health the last 7 days plus the newest row of each house, so
--    the newest row of each house is always kept (a silent house keeps its
--    "último evento").
--  * financial_webhook_attempts.raw_payload: 30 days → 1 day (never read; the
--    app stops writing it, the purge clears what is already stored).
--  * journey_events: 90 → 30 days (only the express-mode switch reads the
--    latest event of waiting enrollments).
-- Freed space is reused by Postgres; the disk itself does not shrink.

create or replace function public.purge_operational_history(
  p_batch integer default 10000,
  p_max_seconds integer default 240
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deadline timestamptz :=
    clock_timestamp() + make_interval(secs => greatest(1, coalesce(p_max_seconds, 240)));
  v_batch integer := greatest(100, coalesce(p_batch, 10000));
  v_n integer;
  v_total integer;
  v_links uuid[];
  v_cursor uuid := '00000000-0000-0000-0000-000000000000';
  v_tenant uuid;
  v_newest timestamptz;
  v_out jsonb := '{}'::jsonb;
begin
  -- Short.io snapshots: the reports read only the latest per link. Walks the
  -- (tracked_link_id, snapshot_at) unique index a slice of links at a time.
  v_total := 0;
  loop
    exit when clock_timestamp() > v_deadline;
    select array_agg(x.tracked_link_id order by x.tracked_link_id) into v_links
    from (
      select distinct s.tracked_link_id
      from public.link_click_snapshots s
      where s.tracked_link_id > v_cursor
      order by s.tracked_link_id
      limit greatest(100, v_batch / 5)
    ) x;
    exit when v_links is null;
    v_cursor := v_links[array_length(v_links, 1)];
    delete from public.link_click_snapshots o
    where o.tracked_link_id = any (v_links)
      and o.snapshot_at < now() - interval '2 days'
      and exists (
        select 1 from public.link_click_snapshots n
        where n.tracked_link_id = o.tracked_link_id and n.snapshot_at > o.snapshot_at
      );
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
  end loop;
  v_out := v_out || jsonb_build_object('link_click_snapshots', v_total);

  -- webhook_logs, 7 days, house by house on (tenant_id, created_at); the
  -- newest row of each house is kept whatever its age.
  v_total := 0;
  for v_tenant in select t.id from public.tenants t order by t.id loop
    select max(l.created_at) into v_newest
    from public.webhook_logs l where l.tenant_id = v_tenant;
    continue when v_newest is null;
    loop
      exit when clock_timestamp() > v_deadline;
      delete from public.webhook_logs w
      where w.ctid = any (array(
        select l.ctid from public.webhook_logs l
        where l.tenant_id = v_tenant
          and l.created_at < least(now() - interval '7 days', v_newest)
        limit v_batch));
      get diagnostics v_n = row_count;
      v_total := v_total + v_n;
      exit when v_n < v_batch;
    end loop;
  end loop;
  v_out := v_out || jsonb_build_object('webhook_logs', v_total);

  -- financial_webhook_attempts.raw_payload, 1 day. pg_column_size reads the
  -- stored size, so cleared rows are skipped without fetching any payload.
  v_total := 0;
  loop
    exit when clock_timestamp() > v_deadline;
    update public.financial_webhook_attempts f
    set raw_payload = '{}'::jsonb
    where f.ctid = any (array(
      select a.ctid from public.financial_webhook_attempts a
      where a.created_at < now() - interval '1 day'
        and pg_column_size(a.raw_payload) > 8
      limit v_batch));
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
    exit when v_n < v_batch;
  end loop;
  v_out := v_out || jsonb_build_object('financial_webhook_attempts_payload', v_total);

  v_total := 0;
  loop
    exit when clock_timestamp() > v_deadline;
    delete from public.dispatcher_runs r
    where r.ctid = any (array(
      select d.ctid from public.dispatcher_runs d
      where d.started_at < now() - interval '14 days'
      limit v_batch));
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
    exit when v_n < v_batch;
  end loop;
  v_out := v_out || jsonb_build_object('dispatcher_runs', v_total);

  v_total := 0;
  loop
    exit when clock_timestamp() > v_deadline;
    delete from public.link_tracking_sync_runs r
    where r.ctid = any (array(
      select d.ctid from public.link_tracking_sync_runs d
      where d.started_at < now() - interval '7 days'
      limit v_batch));
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
    exit when v_n < v_batch;
  end loop;
  v_out := v_out || jsonb_build_object('link_tracking_sync_runs', v_total);

  v_total := 0;
  loop
    exit when clock_timestamp() > v_deadline;
    delete from public.journey_events e
    where e.ctid = any (array(
      select j.ctid from public.journey_events j
      where j.created_at < now() - interval '30 days'
      limit v_batch));
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
    exit when v_n < v_batch;
  end loop;
  v_out := v_out || jsonb_build_object('journey_events', v_total);

  return v_out || jsonb_build_object('finished', clock_timestamp() <= v_deadline);
end;
$$;

revoke all on function public.purge_operational_history(integer, integer)
  from public, anon, authenticated;
grant execute on function public.purge_operational_history(integer, integer) to service_role;

