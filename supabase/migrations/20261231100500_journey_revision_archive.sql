-- Aplicar uma revisão levava ~16 s e estourava o limite de 8 s da API:
-- apagar o rascunho (e as etapas dele) obriga o Postgres a varrer
-- journey_step_executions, journey_events e link_dispatches (1–2 mi linhas)
-- atrás de referências, porque essas FKs não têm índice. Agora o rascunho
-- aplicado é arquivado (com " · aplicada" no nome) em vez de apagado, e
-- listJourneys esconde revisões arquivadas. O objetivo de conversão da
-- original é mantido (o editor não edita objetivo; revisões antigas vinham
-- com o padrão "journey").

begin;

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

  -- O rascunho é arquivado (apagar custaria varrer tabelas grandes sem
  -- índice nas FKs). O nome muda antes do update da original para o nome,
  -- único por casa, ficar livre.
  update public.journeys set
    status = 'archived',
    archived_at = now(),
    name = left(concat(r.name, ' · aplicada ', to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI')), 120)
  where id = r.id;

  update public.journeys set
    name = regexp_replace(r.name, ' · revisão v[0-9]+$', ''),
    description = r.description,
    trigger_type = r.trigger_type,
    trigger_config = r.trigger_config,
    entry_rules = r.entry_rules,
    exit_rules = r.exit_rules,
    daily_limit = r.daily_limit,
    cooldown_hours = r.cooldown_hours,
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
