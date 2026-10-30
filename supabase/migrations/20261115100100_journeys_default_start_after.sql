-- Jornada de evento ativada sem `start_after` só pega eventos novos (P0.4,
-- docs/ESCOPO_AUDITORIA_JORNADAS_CUSTO_RECUPERACAO_2026-10-29.md).
--
-- Sem `start_after`, uma jornada de evento matricula todo o histórico. Em 26/10
-- as jornadas das casas novas foram ativadas por um script fora do app
-- (source copy_from_sorte_alta), sem o diálogo de escopo: "Cadastrou e não
-- depositou" e "Cashback" ficaram sem `start_after` e carregaram a base inteira.
--
-- O trigger vale para qualquer caminho (tela, API, revisão, script): ao passar
-- uma jornada de evento para 'active' sem `start_after`, grava a hora da
-- ativação. Carregar a base passa a exigir um `start_after` explícito, que o
-- app grava quando a casa escolhe "Incluir a base atual" (activationTriggerConfig).
--
-- Mesma lista de gatilhos de evento de EVENT_TRIGGERS (src/lib/journey-policy.ts).
-- Não mexe nas jornadas que já estão ativas.

create or replace function public.journeys_default_start_after()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if new.status = 'active'
     and (tg_op = 'INSERT' or old.status is distinct from 'active')
     and new.trigger_type in (
       'pix_gerado_nao_pago', 'saque_pago', 'cashback_pago',
       'primeiro_deposito', 'cadastrados_sem_deposito', 'lead_cadastrado'
     )
     and coalesce(new.trigger_config->>'start_after', '') = '' then
    new.trigger_config := coalesce(new.trigger_config, '{}'::jsonb)
      || jsonb_build_object('start_after', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  end if;
  return new;
end;
$$;

drop trigger if exists journeys_default_start_after on public.journeys;
create trigger journeys_default_start_after
  before insert or update of status on public.journeys
  for each row
  execute function public.journeys_default_start_after();
