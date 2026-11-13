-- Edição de jornada ativa.
--
-- Antes: salvar uma jornada ativa/pausada sempre criava uma cópia "· revisão vN"
-- em rascunho, e ativar essa cópia só ligava uma segunda jornada ao lado da
-- original (ninguém lia revision_of). Na prática a casa não conseguia trocar o
-- texto de um SMS de uma jornada rodando.
--
-- Agora:
-- 1. save_journey_draft grava direto na jornada ativa/pausada quando a mudança
--    não mexe na estrutura (mesmas etapas, do mesmo tipo, na mesma ordem; mesmo
--    gatilho e objetivo). O motor busca a etapa de cada inscrito pela posição,
--    então quem está no meio recebe o texto novo no próximo envio. Os ids das
--    etapas ficam os mesmos (histórico de envios e cliques continua ligado).
--    A versão não sobe: o cursor do gatilho e as varreduras seguem como estão.
--    Mudança de estrutura continua criando a revisão em rascunho.
-- 2. promote_journey_revision: ativar uma revisão aplica o conteúdo dela na
--    jornada original (mesmo id, inscritos e histórico) e apaga o rascunho.

begin;

create or replace function public.save_journey_draft(
  p_tenant_id uuid,
  p_journey_id uuid,
  p_actor_user_id uuid,
  p_journey jsonb,
  p_steps jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_status public.journey_status;
  v_version integer;
  v_trigger_type text;
  v_trigger_config jsonb;
  v_objective_stored text;
  v_index integer := 0;
  v_step jsonb;
  v_objective text := coalesce(p_journey->>'conversion_objective', 'journey');
  v_live boolean := false;
begin
  if jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) = 0 then
    raise exception 'A jornada precisa ter ao menos uma etapa.';
  end if;
  if v_objective not in ('acquisition', 'conversion', 'reactivation', 'journey') then
    raise exception 'Objetivo de conversão inválido.';
  end if;

  if p_journey_id is null then
    insert into public.journeys (
      tenant_id, name, description, trigger_type, trigger_config, entry_rules,
      exit_rules, daily_limit, cooldown_hours, conversion_objective, status, created_by
    ) values (
      p_tenant_id, trim(p_journey->>'name'), nullif(trim(coalesce(p_journey->>'description', '')), ''),
      p_journey->>'trigger_type', coalesce(p_journey->'trigger_config', '{}'::jsonb),
      coalesce(p_journey->'entry_rules', '{}'::jsonb), coalesce(p_journey->'exit_rules', '{}'::jsonb),
      (p_journey->>'daily_limit')::integer, (p_journey->>'cooldown_hours')::integer,
      v_objective, 'draft', p_actor_user_id
    ) returning id into v_id;
  else
    select id, status, version, trigger_type, trigger_config, conversion_objective
      into v_id, v_status, v_version, v_trigger_type, v_trigger_config, v_objective_stored
    from public.journeys where id = p_journey_id and tenant_id = p_tenant_id for update;
    if not found then raise exception 'Jornada não encontrada.'; end if;

    if v_status in ('active', 'paused') then
      -- Mesma estrutura: etapas armazenadas nas posições 0..n-1 com os mesmos
      -- tipos, na mesma ordem, e mesmo gatilho/objetivo.
      v_live :=
        v_trigger_type = p_journey->>'trigger_type'
        and v_trigger_config = coalesce(p_journey->'trigger_config', '{}'::jsonb)
        and v_objective_stored = v_objective
        and (select count(*) from public.journey_steps where journey_id = v_id) = jsonb_array_length(p_steps)
        and not exists (
          select 1
          from jsonb_array_elements(p_steps) with ordinality as incoming(step, ord)
          left join public.journey_steps stored
            on stored.journey_id = v_id and stored.position = incoming.ord - 1
          where stored.id is null or stored.step_type::text <> incoming.step->>'step_type'
        );
    end if;

    if v_live then
      update public.journeys set
        name = trim(p_journey->>'name'), description = nullif(trim(coalesce(p_journey->>'description', '')), ''),
        entry_rules = coalesce(p_journey->'entry_rules', '{}'::jsonb), exit_rules = coalesce(p_journey->'exit_rules', '{}'::jsonb),
        daily_limit = (p_journey->>'daily_limit')::integer, cooldown_hours = (p_journey->>'cooldown_hours')::integer
      where id = v_id and tenant_id = p_tenant_id;
      update public.journey_steps stored set
        -- O editor não manda rótulo: sem rótulo novo, fica o salvo.
        label = coalesce(nullif(trim(coalesce(incoming.step->>'label', '')), ''), stored.label),
        config = coalesce(incoming.step->'config', '{}'::jsonb)
      from jsonb_array_elements(p_steps) with ordinality as incoming(step, ord)
      where stored.journey_id = v_id and stored.tenant_id = p_tenant_id and stored.position = incoming.ord - 1
        and stored.config is distinct from coalesce(incoming.step->'config', '{}'::jsonb);
      insert into public.journey_events (tenant_id, journey_id, event_type, detail, actor_user_id)
      values (p_tenant_id, v_id, 'live_edited', jsonb_build_object('version', v_version), p_actor_user_id);
      return v_id;
    end if;

    if v_status <> 'draft' then
      insert into public.journeys (
        tenant_id, name, description, trigger_type, trigger_config, entry_rules, exit_rules,
        daily_limit, cooldown_hours, conversion_objective, status, created_by, version, revision_of
      ) values (
        p_tenant_id, concat(trim(p_journey->>'name'), ' · revisão v', v_version + 1),
        nullif(trim(coalesce(p_journey->>'description', '')), ''), p_journey->>'trigger_type',
        coalesce(p_journey->'trigger_config', '{}'::jsonb), coalesce(p_journey->'entry_rules', '{}'::jsonb),
        coalesce(p_journey->'exit_rules', '{}'::jsonb), (p_journey->>'daily_limit')::integer,
        (p_journey->>'cooldown_hours')::integer, v_objective, 'draft', p_actor_user_id, v_version + 1, v_id
      ) returning id into v_id;
    else
      update public.journeys set
        name = trim(p_journey->>'name'), description = nullif(trim(coalesce(p_journey->>'description', '')), ''),
        trigger_type = p_journey->>'trigger_type', trigger_config = coalesce(p_journey->'trigger_config', '{}'::jsonb),
        entry_rules = coalesce(p_journey->'entry_rules', '{}'::jsonb), exit_rules = coalesce(p_journey->'exit_rules', '{}'::jsonb),
        daily_limit = (p_journey->>'daily_limit')::integer, cooldown_hours = (p_journey->>'cooldown_hours')::integer,
        conversion_objective = v_objective, version = version + 1
      where id = v_id and tenant_id = p_tenant_id;
      delete from public.journey_steps where journey_id = v_id and tenant_id = p_tenant_id;
    end if;
  end if;

  for v_step in select value from jsonb_array_elements(p_steps) loop
    insert into public.journey_steps (tenant_id, journey_id, position, step_type, label, config)
    values (p_tenant_id, v_id, v_index, (v_step->>'step_type')::public.journey_step_type,
      nullif(trim(coalesce(v_step->>'label', '')), ''), coalesce(v_step->'config', '{}'::jsonb));
    v_index := v_index + 1;
  end loop;
  insert into public.journey_events (tenant_id, journey_id, event_type, detail, actor_user_id)
  values (p_tenant_id, v_id, 'draft_saved', jsonb_build_object('version', case when p_journey_id is null then 1 else null end), p_actor_user_id);
  return v_id;
end;
$$;

REVOKE ALL ON FUNCTION public.save_journey_draft(uuid, uuid, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_journey_draft(uuid, uuid, uuid, jsonb, jsonb) TO service_role;

-- Aplica uma revisão em rascunho na jornada original e apaga o rascunho.
-- Devolve o id da jornada que deve ser ativada: a original, ou a própria
-- jornada quando ela não é revisão (ou a original foi excluída).
create or replace function public.promote_journey_revision(
  p_tenant_id uuid,
  p_revision_id uuid,
  p_actor_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.journeys%rowtype;
  o public.journeys%rowtype;
  v_steps jsonb;
  v_step jsonb;
begin
  select * into r from public.journeys
  where id = p_revision_id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'Jornada não encontrada.'; end if;
  if r.revision_of is null or r.status <> 'draft' then return r.id; end if;

  select * into o from public.journeys
  where id = r.revision_of and tenant_id = p_tenant_id for update;
  if not found then return r.id; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'position', position, 'step_type', step_type, 'label', label,
    'config', config, 'is_enabled', is_enabled) order by position), '[]'::jsonb)
  into v_steps
  from public.journey_steps where journey_id = r.id;

  -- O rascunho (e suas etapas, em cascata) sai antes do update para o nome,
  -- único por casa, ficar livre.
  delete from public.journeys where id = r.id;

  update public.journeys set
    name = regexp_replace(r.name, ' · revisão v[0-9]+$', ''),
    description = r.description,
    trigger_type = r.trigger_type,
    trigger_config = r.trigger_config,
    entry_rules = r.entry_rules,
    exit_rules = r.exit_rules,
    daily_limit = r.daily_limit,
    cooldown_hours = r.cooldown_hours,
    conversion_objective = r.conversion_objective,
    conflict_family = r.conflict_family,
    journey_priority = r.journey_priority,
    conflict_policy = r.conflict_policy,
    ends_at = r.ends_at,
    holdout_percent = r.holdout_percent,
    version = greatest(o.version + 1, r.version)
  where id = o.id;

  -- Etapa na mesma posição e do mesmo tipo é atualizada (mantém o id e o
  -- histórico de envios/cliques); as demais saem e entram de novo.
  delete from public.journey_steps stored
  where stored.journey_id = o.id
    and not exists (
      select 1 from jsonb_array_elements(v_steps) rev
      where (rev->>'position')::integer = stored.position
        and rev->>'step_type' = stored.step_type::text
    );
  for v_step in select value from jsonb_array_elements(v_steps) loop
    update public.journey_steps set
      label = v_step->>'label',
      config = coalesce(v_step->'config', '{}'::jsonb),
      is_enabled = coalesce((v_step->>'is_enabled')::boolean, true)
    where journey_id = o.id and position = (v_step->>'position')::integer;
    if not found then
      insert into public.journey_steps (tenant_id, journey_id, position, step_type, label, config, is_enabled)
      values (p_tenant_id, o.id, (v_step->>'position')::integer,
        (v_step->>'step_type')::public.journey_step_type, v_step->>'label',
        coalesce(v_step->'config', '{}'::jsonb), coalesce((v_step->>'is_enabled')::boolean, true));
    end if;
  end loop;

  insert into public.journey_events (tenant_id, journey_id, event_type, detail, actor_user_id)
  values (p_tenant_id, o.id, 'revision_applied',
    jsonb_build_object('from_version', o.version, 'revision_version', r.version), p_actor_user_id);
  return o.id;
end;
$$;

REVOKE ALL ON FUNCTION public.promote_journey_revision(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_journey_revision(uuid, uuid, uuid) TO service_role;

commit;
