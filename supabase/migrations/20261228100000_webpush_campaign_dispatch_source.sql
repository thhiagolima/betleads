-- Web push campaigns write link_dispatches with source_type = 'campaign' and
-- source_id = webpush_campaigns.id (src/lib/webpush/links.server.ts), but
-- validate_conversion_dispatch_source (20261008210000) only knew SMS and
-- e-mail campaigns, so every push campaign failed before reaching OneSignal
-- with "campaign source does not exist in tenant".
create or replace function public.validate_conversion_dispatch_source()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.source_type = 'journey' and not exists (
    select 1 from public.journeys where id = new.source_id::uuid and tenant_id = new.tenant_id
  ) then raise exception 'journey source does not exist in tenant'; end if;
  if new.source_type = 'campaign' and not (
    exists (select 1 from public.sms_campaigns where id = new.source_id::uuid and tenant_id = new.tenant_id)
    or exists (select 1 from public.email_campaigns where id = new.source_id::uuid and tenant_id = new.tenant_id)
    or exists (select 1 from public.webpush_campaigns where id = new.source_id::uuid and tenant_id = new.tenant_id)
  ) then raise exception 'campaign source does not exist in tenant'; end if;
  return new;
end;
$$;
