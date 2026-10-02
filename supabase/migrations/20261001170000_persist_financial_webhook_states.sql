alter table public.deposits
  add column if not exists provider_status text,
  add column if not exists event_id text,
  add column if not exists raw_payload jsonb not null default '{}'::jsonb,
  add column if not exists completed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table public.withdrawals
  add column if not exists provider_status text,
  add column if not exists event_id text,
  add column if not exists raw_payload jsonb not null default '{}'::jsonb,
  add column if not exists completed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists deposits_tenant_status_idx
  on public.deposits (tenant_id, status, created_at desc);
create index if not exists withdrawals_tenant_status_idx
  on public.withdrawals (tenant_id, status, created_at desc);

create or replace function public.record_financial_webhook_event(
  p_tenant_id uuid,
  p_player_id uuid,
  p_kind text,
  p_external_id text,
  p_event_id text,
  p_amount numeric,
  p_status text,
  p_provider_status text,
  p_method text,
  p_event_at timestamptz,
  p_payload jsonb
)
returns table(row_id uuid, previous_status text, current_status text, became_approved boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_previous text;
  v_current text;
  v_external_id text := nullif(trim(p_external_id), '');
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
    update public.players set
      total_depositado = total_depositado + p_amount,
      ultimo_deposito = case
        when ultimo_deposito is null or ultimo_deposito < p_event_at then p_event_at
        else ultimo_deposito
      end,
      ftd_em = coalesce(ftd_em, p_event_at),
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
$$;

revoke all on function public.record_financial_webhook_event(
  uuid, uuid, text, text, text, numeric, text, text, text, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.record_financial_webhook_event(
  uuid, uuid, text, text, text, numeric, text, text, text, timestamptz, jsonb
) to service_role;
