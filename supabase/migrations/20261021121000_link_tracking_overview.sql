-- Links page totals aggregated in the database.
--
-- The page summed link dispatches and click snapshots in the app server. With
-- ~226k dispatches in 30 days and ~1.1M snapshots (one per link per sync run),
-- reading them row by row either truncated at PostgREST's 1,000 rows or took
-- too long. This returns one row per channel/source with sent, distinct links
-- and clicks.
--
-- Clicks are cumulative per link, so a link's max snapshot equals its latest
-- (checked on production data: 0 mismatches in 411 links). Links never clicked
-- add zero, so only snapshots with clicks > 0 are read; the partial index below
-- keeps that small.

-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction. Apply this
-- statement on its own.
create index concurrently if not exists link_click_snapshots_clicked_idx
  on public.link_click_snapshots (tenant_id, snapshot_at)
  include (tracked_link_id, clicks)
  where clicks > 0;

create or replace function public.link_tracking_overview(_tenant uuid, _since timestamptz)
returns table (channel text, source_type text, sent bigint, links bigint, clicks bigint)
language plpgsql
stable security definer
set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  if _tenant is null
     or (
       not public.has_tenant_access(_tenant)
       and not public.is_super_admin()
       and auth.role() <> 'service_role'
     ) then
    raise exception 'forbidden';
  end if;

  return query
  with d as (
    select ld.channel, ld.source_type, ld.tracked_link_id
    from public.link_dispatches ld
    where ld.tenant_id = _tenant
      and ld.send_status = 'sent'
      and ld.sent_at >= _since
  ),
  clicked as (
    select sn.tracked_link_id, max(sn.clicks)::bigint as clicks
    from public.link_click_snapshots sn
    where sn.tenant_id = _tenant
      and sn.clicks > 0
      and sn.snapshot_at >= _since
    group by 1
  ),
  pairs as (
    select distinct d.channel, d.source_type, d.tracked_link_id
    from d
    where d.tracked_link_id is not null
  ),
  grouped as (
    select d.channel, d.source_type, count(*)::bigint as sent,
           count(distinct d.tracked_link_id)::bigint as links
    from d
    group by 1, 2
  ),
  click_sums as (
    select p.channel, p.source_type, sum(k.clicks)::bigint as clicks
    from pairs p
    join clicked k on k.tracked_link_id = p.tracked_link_id
    group by 1, 2
  )
  select g.channel, g.source_type, g.sent, g.links, coalesce(c.clicks, 0)::bigint
  from grouped g
  left join click_sums c on c.channel = g.channel and c.source_type = g.source_type
  order by g.sent desc;
end;
$function$;

revoke all on function public.link_tracking_overview(uuid, timestamptz) from public, anon;
grant execute on function public.link_tracking_overview(uuid, timestamptz) to authenticated, service_role;
