-- Os contadores exibidos nos chips de Público devem seguir a mesma regra da
-- seleção: somente jogadores que já depositaram entram em tempo sem depósito.
do $$
declare
  definition text;
  updated_definition text;
begin
  select pg_get_functiondef(p.oid)
    into definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'resolve_sms_audience_v2'
    and pg_get_function_identity_arguments(p.oid) = '_tenant uuid, _criteria jsonb';

  if definition is null then
    raise exception 'Função resolve_sms_audience_v2(uuid,jsonb) não encontrada.';
  end if;

  updated_definition := replace(
    definition,
    $match$count(*) filter (where activity_ok and level_ok and extra_ok and inactive_days>=cooling and inactive_days<sleeping) cooling_count,
    count(*) filter (where activity_ok and level_ok and extra_ok and inactive_days>=sleeping) sleeping_count,
    count(*) filter (where activity_ok and level_ok and extra_ok and inactive_days>=30) inactive30_count,
    count(*) filter (where activity_ok and level_ok and extra_ok and inactive_days>=90) inactive90_count$match$,
    $replacement$count(*) filter (where activity_ok and level_ok and extra_ok and has_deposit and inactive_days>=cooling and inactive_days<sleeping) cooling_count,
    count(*) filter (where activity_ok and level_ok and extra_ok and has_deposit and inactive_days>=sleeping) sleeping_count,
    count(*) filter (where activity_ok and level_ok and extra_ok and has_deposit and inactive_days>=30) inactive30_count,
    count(*) filter (where activity_ok and level_ok and extra_ok and has_deposit and inactive_days>=90) inactive90_count$replacement$
  );

  if updated_definition = definition then
    raise exception 'Não foi possível atualizar os contadores de tempo do público.';
  end if;

  execute updated_definition;
end;
$$;
