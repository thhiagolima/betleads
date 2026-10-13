-- Replicate the current Sorte Alta journey definitions for PixReals and
-- ForrandoBet. Operational history and enrollments intentionally stay in the
-- source tenant; the new definitions start as drafts to prevent accidental
-- sends before each tenant reviews and publishes them.
do $$
declare
  source_tenant_id uuid;
  source_journey record;
  target record;
  new_journey_id uuid;
  source_count integer;
  target_count integer;
begin
  select id
    into source_tenant_id
  from public.tenants
  where slug = 'pixpgf'
    and lower(nome) = 'sorte alta';

  if source_tenant_id is null then
    raise exception 'Sorte Alta tenant (slug pixpgf) was not found';
  end if;

  select count(*)
    into source_count
  from public.journeys
  where tenant_id = source_tenant_id;

  if source_count = 0 then
    raise exception 'Sorte Alta does not have journeys to replicate';
  end if;

  select count(*)
    into target_count
  from public.tenants
  where slug in ('pixreals', 'forrandobet');

  if target_count <> 2 then
    raise exception 'Expected both PixReals and ForrandoBet tenants, found %', target_count;
  end if;

  for target in
    select
      tenants.id as tenant_id,
      tenants.slug,
      brands.brand_name,
      brands.host
    from (
      values
        ('pixreals', 'PixReals', 'www.pixreals.net'),
        ('forrandobet', 'ForrandoBet', 'www.forrandobet.io')
    ) as brands(slug, brand_name, host)
    join public.tenants on tenants.slug = brands.slug
  loop
    if exists (
      select 1
      from public.journeys target_existing
      join public.journeys source_existing
        on source_existing.tenant_id = source_tenant_id
       and source_existing.name = target_existing.name
      where target_existing.tenant_id = target.tenant_id
    ) then
      raise exception 'Tenant % already has one or more Sorte Alta journey names', target.slug;
    end if;

    for source_journey in
      select *
      from public.journeys
      where tenant_id = source_tenant_id
      order by created_at, id
    loop
      insert into public.journeys (
        tenant_id,
        name,
        description,
        status,
        trigger_type,
        trigger_config,
        entry_rules,
        exit_rules,
        timezone,
        daily_limit,
        cooldown_hours,
        version,
        published_version,
        activated_at,
        paused_at,
        archived_at,
        created_by,
        approved_by,
        revision_of,
        legacy_source_type,
        legacy_source_id,
        legacy_migrated_at,
        conversion_objective,
        conversion_funnel_snapshot,
        conflict_family,
        journey_priority,
        conflict_policy
      ) values (
        target.tenant_id,
        replace(replace(source_journey.name, 'SORTE ALTA', upper(target.brand_name)), 'Sorte Alta', target.brand_name),
        replace(replace(source_journey.description, 'SORTE ALTA', upper(target.brand_name)), 'Sorte Alta', target.brand_name),
        'draft',
        source_journey.trigger_type,
        (
          replace(
            replace(
              replace(source_journey.trigger_config::text, 'www.sortealta.io', target.host),
              'SORTE ALTA', upper(target.brand_name)
            ),
            'Sorte Alta', target.brand_name
          )::jsonb - 'start_after'
        ),
        replace(
          replace(
            replace(source_journey.entry_rules::text, 'www.sortealta.io', target.host),
            'SORTE ALTA', upper(target.brand_name)
          ),
          'Sorte Alta', target.brand_name
        )::jsonb,
        replace(
          replace(
            replace(source_journey.exit_rules::text, 'www.sortealta.io', target.host),
            'SORTE ALTA', upper(target.brand_name)
          ),
          'Sorte Alta', target.brand_name
        )::jsonb,
        source_journey.timezone,
        source_journey.daily_limit,
        source_journey.cooldown_hours,
        1,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        source_journey.conversion_objective,
        case
          when source_journey.conversion_funnel_snapshot is null then null
          else replace(
            replace(
              replace(source_journey.conversion_funnel_snapshot::text, 'www.sortealta.io', target.host),
              'SORTE ALTA', upper(target.brand_name)
            ),
            'Sorte Alta', target.brand_name
          )::jsonb
        end,
        source_journey.conflict_family,
        source_journey.journey_priority,
        source_journey.conflict_policy
      )
      returning id into new_journey_id;

      insert into public.journey_steps (
        tenant_id,
        journey_id,
        position,
        step_type,
        label,
        config,
        is_enabled
      )
      select
        target.tenant_id,
        new_journey_id,
        source_step.position,
        source_step.step_type,
        replace(replace(source_step.label, 'SORTE ALTA', upper(target.brand_name)), 'Sorte Alta', target.brand_name),
        replace(
          replace(
            replace(source_step.config::text, 'www.sortealta.io', target.host),
            'SORTE ALTA', upper(target.brand_name)
          ),
          'Sorte Alta', target.brand_name
        )::jsonb,
        source_step.is_enabled
      from public.journey_steps source_step
      where source_step.journey_id = source_journey.id
        and source_step.tenant_id = source_tenant_id
      order by source_step.position;
    end loop;
  end loop;
end
$$;
