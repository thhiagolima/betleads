-- Tempo sem depositar só se aplica a quem já depositou. Sem essa condição,
-- cadastros sem FTD passavam a aparecer como "esfriando" ou "dormindo".
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
    $match$when 'cooling' then e.inactive_days>=e.cooling and e.inactive_days<e.sleeping
      when 'sleeping' then e.inactive_days>=e.sleeping
      when 'inactive30' then e.inactive_days>=30
      when 'inactive90' then e.inactive_days>=90
      when 'custom' then e.inactive_days>=p.custom_days$match$,
    $replacement$when 'cooling' then e.has_deposit and e.inactive_days>=e.cooling and e.inactive_days<e.sleeping
      when 'sleeping' then e.has_deposit and e.inactive_days>=e.sleeping
      when 'inactive30' then e.has_deposit and e.inactive_days>=30
      when 'inactive90' then e.has_deposit and e.inactive_days>=90
      when 'custom' then e.has_deposit and e.inactive_days>=p.custom_days$replacement$
  );

  if updated_definition = definition then
    raise exception 'Não foi possível atualizar as regras de tempo do público.';
  end if;

  execute updated_definition;
end;
$$;
