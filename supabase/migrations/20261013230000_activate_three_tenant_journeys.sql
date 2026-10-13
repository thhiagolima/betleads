-- Publish every journey for Sorte Alta, PixReals and ForrandoBet. Journeys
-- already active keep their original activation timestamp.
do $$
declare
  journey_row record;
  actor_id uuid;
  objective text;
  funnel_steps text[];
  funnel_snapshot jsonb;
  expected_tenants integer;
begin
  select count(*)
    into expected_tenants
  from public.tenants
  where slug in ('pixpgf', 'pixreals', 'forrandobet');

  if expected_tenants <> 3 then
    raise exception 'Expected Sorte Alta, PixReals and ForrandoBet tenants, found %', expected_tenants;
  end if;

  if exists (
    select 1
    from public.journeys journey
    join public.tenants tenant on tenant.id = journey.tenant_id
    where tenant.slug in ('pixpgf', 'pixreals', 'forrandobet')
      and not exists (
        select 1
        from public.journey_steps step
        where step.journey_id = journey.id
          and step.tenant_id = journey.tenant_id
          and step.is_enabled = true
          and step.step_type <> 'end'
      )
  ) then
    raise exception 'One or more journeys do not have an enabled actionable step';
  end if;

  if exists (
    select 1
    from public.journeys journey
    join public.tenants tenant on tenant.id = journey.tenant_id
    join public.journey_steps step
      on step.journey_id = journey.id
     and step.tenant_id = journey.tenant_id
    where tenant.slug in ('pixpgf', 'pixreals', 'forrandobet')
      and step.is_enabled = true
      and step.step_type = 'sms'
      and btrim(coalesce(step.config ->> 'content', '')) = ''
  ) then
    raise exception 'One or more journeys have an enabled SMS step without content';
  end if;

  select journey.approved_by
    into actor_id
  from public.journeys journey
  join public.tenants tenant on tenant.id = journey.tenant_id
  where tenant.slug = 'pixpgf'
    and journey.approved_by is not null
  order by journey.activated_at desc nulls last
  limit 1;

  for journey_row in
    select journey.*
    from public.journeys journey
    join public.tenants tenant on tenant.id = journey.tenant_id
    where tenant.slug in ('pixpgf', 'pixreals', 'forrandobet')
      and journey.status <> 'active'
    order by tenant.slug, journey.name
  loop
    objective := coalesce(journey_row.conversion_objective, 'journey');
    funnel_steps := case objective
      when 'acquisition' then array['sent', 'delivered', 'clicked', 'registered', 'first_deposit_approved']
      when 'conversion' then array['sent', 'delivered', 'clicked', 'registered', 'deposit_approved']
      when 'reactivation' then array['sent', 'delivered', 'clicked', 'login_or_game', 'deposit_approved']
      else array['entry', 'step_sent', 'clicked', 'conversion_event', 'deposit_approved']
    end;

    select jsonb_build_object(
      'version', 1,
      'objective', objective,
      'source_type', 'journey',
      'attribution', jsonb_build_object(
        'model', 'last_tracked_click',
        'classification', 'direct',
        'window_days', 7,
        'timezone', 'America/Sao_Paulo'
      ),
      'steps', jsonb_agg(
        jsonb_build_object('id', funnel_step.id, 'enabled', true)
        order by funnel_step.ordinality
      )
    )
      into funnel_snapshot
    from unnest(funnel_steps) with ordinality as funnel_step(id, ordinality);

    update public.journeys
    set
      status = 'active',
      trigger_config = trigger_config - 'start_after',
      activated_at = now(),
      paused_at = null,
      archived_at = null,
      published_version = version,
      approved_by = coalesce(approved_by, actor_id),
      conversion_funnel_snapshot = coalesce(conversion_funnel_snapshot, funnel_snapshot)
    where id = journey_row.id
      and tenant_id = journey_row.tenant_id;

    insert into public.journey_events (
      tenant_id,
      journey_id,
      event_type,
      actor_user_id,
      detail
    ) values (
      journey_row.tenant_id,
      journey_row.id,
      'status_changed',
      actor_id,
      jsonb_build_object(
        'from', journey_row.status,
        'to', 'active',
        'version', journey_row.version,
        'source', 'tenant_journey_activation_migration'
      )
    );
  end loop;

  -- Remove legacy eligibility cutoffs from the journey that was already active
  -- without changing its activation timestamp or emitting a false transition.
  update public.journeys journey
  set trigger_config = journey.trigger_config - 'start_after'
  from public.tenants tenant
  where tenant.id = journey.tenant_id
    and tenant.slug in ('pixpgf', 'pixreals', 'forrandobet')
    and journey.status = 'active'
    and journey.trigger_config ? 'start_after';
end
$$;
