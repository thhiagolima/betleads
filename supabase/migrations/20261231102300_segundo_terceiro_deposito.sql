-- Gatilhos "Fez o 2º depósito" e "Fez o 3º depósito" (2026-11-26).
--
-- Funcionam como "Primeiro depósito": o jogador entra na jornada no momento em
-- que o depósito é aprovado (webhook), com a varredura como rede de segurança.
-- Para isso o jogador ganha duas datas, como o ftd_em:
--   * players.segundo_deposito_em / terceiro_deposito_em: aprovação do 2º e do
--     3º depósito aprovado no razão (public.deposits).
--
-- 1. Colunas novas.
-- 2. record_financial_webhook_event: corpo igual ao de produção (base
--    20261001170000) mais o preenchimento das duas datas. Só preenche quando o
--    razão cobre o 1º depósito do jogador (ver comentário na função).
-- 3. Preenchimento do histórico pelo razão, com a mesma regra.
-- 4. journeys_default_start_after: os dois gatilhos são de evento ("só novos"
--    por padrão), como primeiro_deposito. Mesma lista de EVENT_TRIGGERS.

alter table public.players
  add column if not exists segundo_deposito_em timestamptz,
  add column if not exists terceiro_deposito_em timestamptz;

comment on column public.players.segundo_deposito_em is
  'Aprovação do 2º depósito aprovado no razão. Nulo quando o razão não cobre o 1º depósito.';
comment on column public.players.terceiro_deposito_em is
  'Aprovação do 3º depósito aprovado no razão. Nulo quando o razão não cobre o 1º depósito.';

CREATE OR REPLACE FUNCTION public.record_financial_webhook_event(p_tenant_id uuid, p_player_id uuid, p_kind text, p_external_id text, p_event_id text, p_amount numeric, p_status text, p_provider_status text, p_method text, p_event_at timestamp with time zone, p_payload jsonb)
 RETURNS TABLE(row_id uuid, previous_status text, current_status text, became_approved boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid;
  v_previous text;
  v_current text;
  v_external_id text := nullif(trim(p_external_id), '');
  v_approved_count integer;
  v_ledger_first_at timestamptz;
begin
  if p_kind not in ('deposit', 'withdrawal') then
    raise exception 'Invalid financial transaction kind: %', p_kind;
  end if;
  if p_status not in ('pendente', 'aprovado', 'falhou') then
    raise exception 'Invalid financial transaction status: %', p_status;
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Financial transaction amount must be positive';
  end if;
  if not exists (
    select 1 from public.players
    where id = p_player_id and tenant_id = p_tenant_id
  ) then
    raise exception 'Player does not belong to tenant';
  end if;

  -- O subject.id do provedor é estável entre pendente e concluído e já é usado
  -- como fallback pelo processador. Sem alguma chave estável, não há como
  -- garantir idempotência e o evento é rejeitado.
  if v_external_id is null then
    raise exception 'Financial transaction external id is required';
  end if;

  -- Serializa eventos simultâneos da mesma transação (por exemplo, pendente e
  -- concluído chegando juntos) antes do SELECT/INSERT.
  perform pg_advisory_xact_lock(
    hashtextextended(p_tenant_id::text || ':' || p_kind || ':' || v_external_id, 0)
  );

  if p_kind = 'deposit' then
    select id, status into v_id, v_previous
    from public.deposits
    where tenant_id = p_tenant_id and external_id = v_external_id
    for update;

    if v_id is null then
      insert into public.deposits (
        tenant_id, player_id, valor, status, metodo, external_id,
        provider_status, event_id, raw_payload, created_at, completed_at, updated_at
      ) values (
        p_tenant_id, p_player_id, p_amount, p_status, p_method, v_external_id,
        p_provider_status, p_event_id, coalesce(p_payload, '{}'::jsonb), p_event_at,
        case when p_status = 'aprovado' then p_event_at else null end, now()
      ) returning id, status into v_id, v_current;
    else
      -- Nunca rebaixa uma transação aprovada. Falha é terminal, exceto quando
      -- o provedor posteriormente confirma a aprovação.
      v_current := case
        when v_previous = 'aprovado' then 'aprovado'
        when p_status = 'aprovado' then 'aprovado'
        when v_previous = 'falhou' then 'falhou'
        else p_status
      end;
      update public.deposits set
        player_id = p_player_id,
        valor = p_amount,
        status = v_current,
        metodo = coalesce(p_method, metodo),
        provider_status = coalesce(p_provider_status, provider_status),
        event_id = coalesce(p_event_id, event_id),
        raw_payload = coalesce(p_payload, raw_payload),
        completed_at = case when v_current = 'aprovado' then coalesce(completed_at, p_event_at) else completed_at end,
        updated_at = now()
      where id = v_id;
    end if;
  else
    select id, status into v_id, v_previous
    from public.withdrawals
    where tenant_id = p_tenant_id and external_id = v_external_id
    for update;

    if v_id is null then
      insert into public.withdrawals (
        tenant_id, player_id, valor, status, metodo, external_id,
        provider_status, event_id, raw_payload, created_at, completed_at, updated_at
      ) values (
        p_tenant_id, p_player_id, p_amount, p_status, p_method, v_external_id,
        p_provider_status, p_event_id, coalesce(p_payload, '{}'::jsonb), p_event_at,
        case when p_status = 'aprovado' then p_event_at else null end, now()
      ) returning id, status into v_id, v_current;
    else
      v_current := case
        when v_previous = 'aprovado' then 'aprovado'
        when p_status = 'aprovado' then 'aprovado'
        when v_previous = 'falhou' then 'falhou'
        else p_status
      end;
      update public.withdrawals set
        player_id = p_player_id,
        valor = p_amount,
        status = v_current,
        metodo = coalesce(p_method, metodo),
        provider_status = coalesce(p_provider_status, provider_status),
        event_id = coalesce(p_event_id, event_id),
        raw_payload = coalesce(p_payload, raw_payload),
        completed_at = case when v_current = 'aprovado' then coalesce(completed_at, p_event_at) else completed_at end,
        updated_at = now()
      where id = v_id;
    end if;
  end if;

  became_approved := v_current = 'aprovado' and coalesce(v_previous, '') <> 'aprovado';

  if became_approved and p_kind = 'deposit' then
    -- Posição deste depósito entre os aprovados do jogador (o próprio já conta).
    -- Só vale quando o razão cobre o 1º depósito: a linha do FTD é criada no PIX
    -- gerado, até ~1 h antes do ftd_em. Quem tem ftd_em de antes da integração
    -- não tem o histórico completo aqui e não ganha 2º/3º depósito.
    select count(*), min(d.created_at)
      into v_approved_count, v_ledger_first_at
    from public.deposits d
    where d.tenant_id = p_tenant_id and d.player_id = p_player_id and d.status = 'aprovado';

    update public.players set
      total_depositado = total_depositado + p_amount,
      ultimo_deposito = case
        when ultimo_deposito is null or ultimo_deposito < p_event_at then p_event_at
        else ultimo_deposito
      end,
      ftd_em = coalesce(ftd_em, p_event_at),
      segundo_deposito_em = case
        when segundo_deposito_em is null and v_approved_count = 2
             and coalesce(ftd_em, p_event_at) >= v_ledger_first_at - interval '1 minute'
          then p_event_at
        else segundo_deposito_em
      end,
      terceiro_deposito_em = case
        when terceiro_deposito_em is null and v_approved_count = 3
             and coalesce(ftd_em, p_event_at) >= v_ledger_first_at - interval '1 minute'
          then p_event_at
        else terceiro_deposito_em
      end,
      updated_at = now()
    where id = p_player_id and tenant_id = p_tenant_id;
  elsif became_approved and p_kind = 'withdrawal' then
    update public.players set
      total_sacado = total_sacado + p_amount,
      ultimo_saque = case
        when ultimo_saque is null or ultimo_saque < p_event_at then p_event_at
        else ultimo_saque
      end,
      updated_at = now()
    where id = p_player_id and tenant_id = p_tenant_id;
  end if;

  row_id := v_id;
  previous_status := v_previous;
  current_status := v_current;
  return next;
end;
$function$;

revoke all on function public.record_financial_webhook_event(uuid,uuid,text,text,text,numeric,text,text,text,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.record_financial_webhook_event(uuid,uuid,text,text,text,numeric,text,text,text,timestamptz,jsonb) to service_role;

-- 3. Histórico. A hora de cada depósito é a da aprovação (completed_at; linhas
--    antigas sem ela usam created_at).
with ranked as (
  select d.player_id,
         coalesce(d.completed_at, d.created_at) approved_at,
         row_number() over (
           partition by d.player_id
           order by coalesce(d.completed_at, d.created_at), d.id
         ) rn,
         min(d.created_at) over (partition by d.player_id) ledger_first_at
  from public.deposits d
  where d.status = 'aprovado' and d.player_id is not null
), nth as (
  select player_id,
         max(approved_at) filter (where rn = 2) second_at,
         max(approved_at) filter (where rn = 3) third_at,
         min(ledger_first_at) ledger_first_at
  from ranked
  where rn <= 3
  group by player_id
)
update public.players p set
  segundo_deposito_em = coalesce(p.segundo_deposito_em, nth.second_at),
  terceiro_deposito_em = coalesce(p.terceiro_deposito_em, nth.third_at)
from nth
where nth.player_id = p.id
  and p.ftd_em is not null
  and p.ftd_em >= nth.ledger_first_at - interval '1 minute'
  and nth.second_at is not null
  and (p.segundo_deposito_em is null or (nth.third_at is not null and p.terceiro_deposito_em is null));

-- 4. Gatilhos de evento: ativar sem start_after só pega eventos novos.
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
       'primeiro_deposito', 'segundo_deposito', 'terceiro_deposito',
       'cadastrados_sem_deposito', 'lead_cadastrado'
     )
     and coalesce(new.trigger_config->>'start_after', '') = '' then
    new.trigger_config := coalesce(new.trigger_config, '{}'::jsonb)
      || jsonb_build_object('start_after', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  end if;
  return new;
end;
$$;
