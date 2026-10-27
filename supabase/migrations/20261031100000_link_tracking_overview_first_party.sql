-- Links page clicks from first-party clicks instead of Short.io snapshots.
--
-- link_tracking_overview summed link_click_snapshots, which only exist for
-- houses the Short.io statistics sync reaches. The sync discovered houses from
-- a 10k-row sample of tracked_links, so only the two largest houses were ever
-- synced (bravabet365, 777: 0 snapshots; forrandobet and sorte-da-bet stalled)
-- and their Links page showed 0 clicks.
--
-- Every human click on our redirect (/api/public/click) already stamps
-- link_dispatches.first_party_first_clicked_at through a trigger, in real time
-- and in every house. On production, over 7 days, it saw more clicked sends
-- than Short.io in every house (pixpgf 2,860 vs 2,741). Clicks are now the
-- sends with a human click, so the click rate is clicked sends / sends.
--
-- Same signature and columns as 20261021121000.

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
  select ld.channel,
         ld.source_type,
         count(*)::bigint as sent,
         count(distinct ld.tracked_link_id)::bigint as links,
         count(*) filter (where ld.first_party_first_clicked_at is not null)::bigint as clicks
  from public.link_dispatches ld
  where ld.tenant_id = _tenant
    and ld.send_status = 'sent'
    and ld.sent_at >= _since
  group by 1, 2
  order by 3 desc;
end;
$function$;

revoke all on function public.link_tracking_overview(uuid, timestamptz) from public, anon;
grant execute on function public.link_tracking_overview(uuid, timestamptz) to authenticated, service_role;
