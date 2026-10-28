-- Transactional RPC for "Trocar domínio nos links": applies the already
-- computed new values (produced by pure TS code in Tasks 1-2) to every
-- hand-written-link source of a tenant in a single all-or-nothing call, and
-- logs an audit row. Any id that does not belong to _tenant (or a journey
-- step whose parent journey is archived or belongs to another tenant) rolls
-- back the whole call.

begin;

create or replace function public.apply_link_domain_change(
  _tenant uuid,
  _actor uuid,
  _payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _row jsonb;
  _journey_steps_count integer := 0;
  _sms_templates_count integer := 0;
  _email_templates_count integer := 0;
  _quick_links_count integer := 0;
  _tracking_hosts_changed boolean := false;
  _result jsonb;
begin
  for _row in select * from jsonb_array_elements(coalesce(_payload -> 'journey_steps', '[]'::jsonb))
  loop
    update public.journey_steps
    set config = _row -> 'config',
        updated_at = now()
    where id = (_row ->> 'id')::uuid
      and tenant_id = _tenant
      and journey_id in (
        select id from public.journeys
        where tenant_id = _tenant and status <> 'archived'
      );
    if not found then
      raise exception 'link_domain_item_not_found';
    end if;
    _journey_steps_count := _journey_steps_count + 1;
  end loop;

  for _row in select * from jsonb_array_elements(coalesce(_payload -> 'sms_templates', '[]'::jsonb))
  loop
    update public.sms_templates
    set content = _row ->> 'content',
        updated_at = now()
    where id = (_row ->> 'id')::uuid and tenant_id = _tenant;
    if not found then
      raise exception 'link_domain_item_not_found';
    end if;
    _sms_templates_count := _sms_templates_count + 1;
  end loop;

  for _row in select * from jsonb_array_elements(coalesce(_payload -> 'email_templates', '[]'::jsonb))
  loop
    update public.email_templates
    set subject = _row ->> 'subject',
        preheader = _row ->> 'preheader',
        body_html = _row ->> 'body_html',
        body_text = _row ->> 'body_text',
        updated_at = now()
    where id = (_row ->> 'id')::uuid and tenant_id = _tenant;
    if not found then
      raise exception 'link_domain_item_not_found';
    end if;
    _email_templates_count := _email_templates_count + 1;
  end loop;

  for _row in select * from jsonb_array_elements(coalesce(_payload -> 'quick_links', '[]'::jsonb))
  loop
    update public.tenant_quick_links
    set path = _row ->> 'path',
        updated_at = now()
    where id = (_row ->> 'id')::uuid and tenant_id = _tenant;
    if not found then
      raise exception 'link_domain_item_not_found';
    end if;
    _quick_links_count := _quick_links_count + 1;
  end loop;

  if _payload -> 'tracking_hosts' is not null and jsonb_typeof(_payload -> 'tracking_hosts') <> 'null' then
    update public.shortio_settings
    set allowed_destination_hosts = (
          select coalesce(array_agg(value), '{}'::text[])
          from jsonb_array_elements_text(_payload -> 'tracking_hosts')
        ),
        updated_at = now()
    where tenant_id = _tenant;
    _tracking_hosts_changed := true;
  end if;

  _result := jsonb_build_object(
    'journey_steps', _journey_steps_count,
    'sms_templates', _sms_templates_count,
    'email_templates', _email_templates_count,
    'quick_links', _quick_links_count,
    'tracking_hosts', _tracking_hosts_changed
  );

  insert into public.tenant_audit_logs (
    tenant_id, actor_user_id, action, entity_type, entity_id,
    before_data, after_data, metadata
  ) values (
    _tenant,
    _actor,
    'house.link_domain_changed',
    'tenant',
    _tenant::text,
    _payload -> 'audit_before',
    _payload -> 'audit_after',
    jsonb_build_object(
      'from', _payload ->> 'from',
      'to', _payload ->> 'to',
      'counts', _result
    )
  );

  return _result;
end;
$$;

revoke all on function public.apply_link_domain_change(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.apply_link_domain_change(uuid, uuid, jsonb) to service_role;

commit;

notify pgrst, 'reload schema';
