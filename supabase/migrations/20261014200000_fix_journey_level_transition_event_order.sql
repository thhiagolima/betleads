-- A CTE `exited` returns (enrollment.id, enrollment.journey_id).  The former
-- function inserted those values in the opposite columns, making a player
-- level transition abort the surrounding financial transaction with a
-- journey_events_journey_id_fkey violation.
create or replace function public.transition_journey_level_on_deposit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_previous_level text;
  v_current_level text;
  v_target_journey record;
  v_deposit_id uuid;
  v_enrollment_id uuid;
begin
  if coalesce(new.total_depositado, 0) <= coalesce(old.total_depositado, 0) then
    return new;
  end if;

  v_previous_level := public.journey_level_for_total(old.tenant_id, old.total_depositado);
  v_current_level := public.journey_level_for_total(new.tenant_id, new.total_depositado);
  if v_previous_level = v_current_level then
    return new;
  end if;

  select id, version
    into v_target_journey
  from public.journeys
  where tenant_id = new.tenant_id
    and status = 'active'
    and conflict_family = 'progressao_niveis'
    and trigger_type = 'nivel_alterado'
    and coalesce(trigger_config->>'level', '') = v_current_level
  order by journey_priority asc, updated_at asc, id asc
  limit 1;

  with exited as (
    update public.journey_enrollments enrollment
    set status = 'exited',
        exited_at = now(),
        exit_reason = 'level_changed',
        claimed_at = null,
        claimed_by = null
    from public.journeys journey
    where enrollment.journey_id = journey.id
      and enrollment.tenant_id = new.tenant_id
      and enrollment.player_id = new.id
      and journey.conflict_family = 'progressao_niveis'
      and enrollment.status::text in ('active', 'waiting', 'paused_by_priority')
    returning enrollment.id, enrollment.journey_id
  )
  insert into public.journey_events (
    tenant_id, journey_id, enrollment_id, event_type, detail
  )
  select new.tenant_id, journey_id, id, 'level_changed', jsonb_build_object(
    'from_level', v_previous_level,
    'to_level', v_current_level,
    'previous_total_deposited', old.total_depositado,
    'current_total_deposited', new.total_depositado
  )
  from exited;

  if v_target_journey.id is null or v_current_level = 'novice' then
    return new;
  end if;

  select id into v_deposit_id
  from public.deposits
  where tenant_id = new.tenant_id
    and player_id = new.id
    and status = 'aprovado'
  order by completed_at desc nulls last, created_at desc, id desc
  limit 1;

  insert into public.journey_enrollments (
    tenant_id, journey_id, journey_version, player_id, entry_key, metadata
  ) values (
    new.tenant_id,
    v_target_journey.id,
    v_target_journey.version,
    new.id,
    ('level:' || v_current_level)::text,
    jsonb_build_object(
      'trigger', 'nivel_alterado',
      'from_level', v_previous_level,
      'to_level', v_current_level,
      'previous_total_deposited', old.total_depositado,
      'current_total_deposited', new.total_depositado,
      'deposit_id', v_deposit_id
    )
  )
  on conflict (journey_id, player_id, entry_key) do nothing
  returning id into v_enrollment_id;

  if v_enrollment_id is not null then
    insert into public.journey_events (
      tenant_id, journey_id, enrollment_id, event_type, detail
    ) values (
      new.tenant_id,
      v_target_journey.id,
      v_enrollment_id,
      'level_entered',
      jsonb_build_object(
        'from_level', v_previous_level,
        'to_level', v_current_level,
        'previous_total_deposited', old.total_depositado,
        'current_total_deposited', new.total_depositado,
        'deposit_id', v_deposit_id
      )
    );
  end if;

  return new;
end;
$$;

revoke all on function public.transition_journey_level_on_deposit() from public, anon, authenticated;
grant execute on function public.transition_journey_level_on_deposit() to service_role;
