-- PG6-03 (rodada de correções): revisão de cobranças e retenção do webhook.
--
-- 1) billing_credit_paid_charge: numa recarga de créditos (credit_topup),
--    `amount_mismatch` agora também marca `needs_review = true`, igual ao
--    ramo `invoice`. Antes a cobrança ficava PAID, sem crédito e sem revisão:
--    a conciliação tentava de novo a cada 5 min e o alerta
--    `charge_paid_not_credited` ficava ligado para sempre. Agora ela cai em
--    `charge_needs_review` e sai da fila da conciliação (que já filtra
--    needs_review = false). Cópia integral de 20261023100000; só os dois
--    retornos `amount_mismatch` fora do ramo `invoice` mudaram. Mesma
--    assinatura e mesmos grants (service_role).
--
-- 2) Resolução de revisão: colunas review_resolved_at/_by, review_outcome
--    ('creditado_manual' = o dinheiro já entrou por Ajustar saldo ou baixa
--    manual; 'devolvido' = devolvido fora do sistema) e review_note. A
--    função billing_resolve_charge_review grava a resolução e uma linha em
--    tenant_audit_logs, na mesma transação. Nunca preenche credited_at,
--    nunca credita, nunca apaga nada; needs_review continua true como marca
--    histórica. Só service_role: o backend confere o superadmin
--    (is_super_admin(_user_id)) antes de chamar e passa o ator.
--
-- 3) billing_health_snapshot: a contagem de `needs_review` ignora as
--    cobranças já resolvidas. Redefinida aqui porque depende das colunas
--    acima (mesma assinatura e grants de 20261024100400).
--
-- 4) Retenção (escopo §8): billing_purge_webhook_bodies apaga (null)
--    raw_body e headers de payment_webhook_events com mais de 90 dias, em
--    lotes. A linha fica (event_id, event, delivery_id, signature_valid,
--    received_at, processed_at, outcome, error). Nunca toca
--    payment_charges. Chamada pelo ciclo da hora (billing-cycle).
--
-- Aditiva. Não aplicada em nenhum ambiente ainda.

create or replace function public.billing_credit_paid_charge(_charge_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_charge public.payment_charges%rowtype;
  v_order public.credit_topup_orders%rowtype;
  v_fee public.payment_fee_settings%rowtype;
  v_fee_cents bigint;
  v_wallet_result jsonb;
  v_invoice public.billing_invoices%rowtype;
  v_settle jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden';
  end if;

  select * into v_charge
  from public.payment_charges
  where id = _charge_id
  for update;

  if not found then
    raise exception 'charge_not_found';
  end if;

  if v_charge.credited_at is not null then
    return jsonb_build_object('ok', true, 'idempotent', true);
  end if;

  if v_charge.status <> 'PAID' then
    return jsonb_build_object('ok', false, 'reason', 'not_paid');
  end if;

  if v_charge.needs_review then
    return jsonb_build_object('ok', false, 'reason', 'needs_review');
  end if;

  if v_charge.paid_amount_cents is distinct from v_charge.amount_cents then
    -- PG6-03: valor pago diferente do cobrado vai para revisão (antes só
    -- respondia amount_mismatch e a conciliação tentava de novo para sempre).
    update public.payment_charges
       set needs_review = true, updated_at = now()
     where id = v_charge.id;
    return jsonb_build_object('ok', false, 'reason', 'amount_mismatch');
  end if;

  if v_charge.kind = 'invoice' then
    -- Ordem de trava: cobrança (acima) → tenant_billing → fatura, a mesma
    -- de billing_settle_invoice, para que uma baixa concorrente (manual,
    -- desconto, job) não troque o status da fatura no meio do caminho.
    perform 1 from public.tenant_billing where tenant_id = v_charge.tenant_id for update;

    select * into v_invoice
    from public.billing_invoices
    where id = v_charge.ref_id and tenant_id = v_charge.tenant_id
    for update;

    -- Pix pago sem fatura aberta correspondente (fatura inexistente, já paga
    -- ou cancelada) ou com valor diferente do da fatura: o dinheiro entrou,
    -- mas não há o que baixar. Marca a cobrança para revisão do superadmin
    -- (needs_review) em vez de deixá-la presa sendo reprocessada.
    if not found then
      update public.payment_charges
         set needs_review = true, updated_at = now()
       where id = v_charge.id;
      return jsonb_build_object('ok', false, 'reason', 'invoice_not_found');
    end if;

    if v_invoice.status <> 'open' then
      update public.payment_charges
         set needs_review = true, updated_at = now()
       where id = v_charge.id;
      return jsonb_build_object('ok', false, 'reason', 'invoice_not_open');
    end if;

    if v_invoice.amount_cents <> v_charge.amount_cents then
      update public.payment_charges
         set needs_review = true, updated_at = now()
       where id = v_charge.id;
      return jsonb_build_object('ok', false, 'reason', 'amount_mismatch');
    end if;

    select * into v_fee
    from public.payment_fee_settings
    where provider = v_charge.provider and valid_from <= now()
    order by valid_from desc
    limit 1;

    if found then
      v_fee_cents := round(v_charge.amount_cents * v_fee.fee_percent / 100) + v_fee.fee_fixed_cents;
    else
      v_fee_cents := null;
    end if;

    -- Mensalidade não credita saldo na carteira: só dá baixa na fatura.
    -- O ciclo usa a hora em que o Pix foi pago, não a hora do crédito.
    v_settle := public.billing_settle_invoice(
      v_invoice.id, 'pix', v_charge.paid_amount_cents, null, null, v_charge.id, v_charge.paid_at
    );

    update public.payment_charges
       set fee_cents = v_fee_cents,
           credited_at = now(),
           updated_at = now()
     where id = v_charge.id;

    return v_settle;
  end if;

  if v_charge.kind <> 'credit_topup' then
    raise exception 'unknown_charge_kind';
  end if;

  -- O pedido precisa existir e pertencer à mesma casa da cobrança: sem isso,
  -- um ref_id corrompido ou de outra casa creditaria a carteira errada ou
  -- marcaria um pedido estranho como pago.
  select * into v_order
  from public.credit_topup_orders
  where id = v_charge.ref_id and tenant_id = v_charge.tenant_id
  for update;

  if not found then
    raise exception 'topup_order_not_found';
  end if;

  -- O valor da cobrança tem que ser exatamente o valor do pedido: se não
  -- bater, algo divergiu entre a criação do pedido e da cobrança (Task 2) e
  -- não deve creditar nada.
  if v_order.amount_cents <> v_charge.amount_cents then
    -- PG6-03: mesmo tratamento do ramo `invoice`: marca para revisão do
    -- superadmin em vez de deixar a cobrança presa sendo reprocessada.
    update public.payment_charges
       set needs_review = true, updated_at = now()
     where id = v_charge.id;
    return jsonb_build_object('ok', false, 'reason', 'amount_mismatch');
  end if;

  -- Taxa vigente do provedor nesta cobrança (ou null se nenhuma estiver
  -- cadastrada ainda: payment_fee_settings começa vazia).
  select * into v_fee
  from public.payment_fee_settings
  where provider = v_charge.provider and valid_from <= now()
  order by valid_from desc
  limit 1;

  if found then
    v_fee_cents := round(v_charge.amount_cents * v_fee.fee_percent / 100) + v_fee.fee_fixed_cents;
  else
    v_fee_cents := null;
  end if;

  v_wallet_result := public.wallet_mutation(
    v_charge.tenant_id,
    v_charge.amount_cents / 100.0,
    'purchase',
    null, 0, 0, null, null, null,
    'payment_charge',
    v_charge.id::text,
    'charge:' || v_charge.id,
    'Compra de créditos por Pix',
    jsonb_build_object('external_id', v_charge.external_id),
    null
  );

  update public.payment_charges
     set fee_cents = v_fee_cents,
         credited_at = now(),
         updated_at = now()
   where id = v_charge.id;

  update public.credit_topup_orders
     set status = 'paid',
         paid_at = now()
   where id = v_order.id and tenant_id = v_charge.tenant_id;

  if not found then
    raise exception 'topup_order_not_found';
  end if;

  return v_wallet_result;
end;
$$;

revoke execute on function public.billing_credit_paid_charge(uuid) from public, anon, authenticated;
grant execute on function public.billing_credit_paid_charge(uuid) to service_role;

alter table public.payment_charges
  add column if not exists review_resolved_at timestamptz null,
  add column if not exists review_resolved_by uuid null,
  add column if not exists review_outcome text null,
  add column if not exists review_note text null;

do $$
begin
  alter table public.payment_charges
    add constraint payment_charges_review_outcome_check
    check (review_outcome is null or review_outcome in ('creditado_manual', 'devolvido'));
exception when duplicate_object then null;
end;
$$;

-- As colunas novas não entram no grant de colunas de authenticated
-- (20261022110000): o superadmin lê pelo backend (service_role).

create or replace function public.billing_resolve_charge_review(
  _charge_id uuid,
  _outcome text,
  _reason text,
  _actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_charge public.payment_charges%rowtype;
  v_reason text := btrim(coalesce(_reason, ''));
  v_now timestamptz := now();
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden';
  end if;

  if _outcome is null or _outcome not in ('creditado_manual', 'devolvido') then
    raise exception 'invalid_outcome';
  end if;

  if char_length(v_reason) < 5 then
    raise exception 'reason_required';
  end if;

  select * into v_charge
  from public.payment_charges
  where id = _charge_id
  for update;

  if not found then
    raise exception 'charge_not_found';
  end if;

  if v_charge.review_resolved_at is not null then
    raise exception 'review_already_resolved';
  end if;

  if not v_charge.needs_review or v_charge.credited_at is not null then
    raise exception 'charge_not_in_review';
  end if;

  update public.payment_charges
     set review_resolved_at = v_now,
         review_resolved_by = _actor,
         review_outcome = _outcome,
         review_note = left(v_reason, 1000),
         updated_at = v_now
   where id = v_charge.id;

  insert into public.tenant_audit_logs
    (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
  values (
    v_charge.tenant_id,
    _actor,
    'billing.resolve_charge_review',
    'payment_charge',
    v_charge.id::text,
    jsonb_build_object(
      'reason', left(v_reason, 1000),
      'outcome', _outcome,
      'kind', v_charge.kind,
      'external_id', v_charge.external_id,
      'amount_cents', v_charge.amount_cents,
      'paid_amount_cents', v_charge.paid_amount_cents
    )
  );

  return jsonb_build_object(
    'ok', true,
    'charge_id', v_charge.id,
    'tenant_id', v_charge.tenant_id,
    'outcome', _outcome,
    'resolved_at', v_now
  );
end;
$$;

revoke execute on function public.billing_resolve_charge_review(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.billing_resolve_charge_review(uuid, text, text, uuid) to service_role;

create or replace function public.billing_health_snapshot(
  _window_hours integer default 1,
  _now timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_since timestamptz;
  v_signals jsonb;
  v_paid_uncredited jsonb;
  v_needs_review jsonb;
  v_wallets jsonb;
  v_jobs jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden';
  end if;

  v_since := _now - make_interval(hours => greatest(1, least(coalesce(_window_hours, 1), 168)));

  -- Contadores do período. O bucket é por hora, então filtra por last_at
  -- (um bucket conta se teve evento dentro da janela).
  select coalesce(jsonb_object_agg(code, jsonb_build_object(
           'count', total, 'last_at', last_at, 'last_detail', last_detail)), '{}'::jsonb)
    into v_signals
  from (
    select s.code,
           sum(s.count) as total,
           max(s.last_at) as last_at,
           (array_agg(s.last_detail order by s.last_at desc))[1] as last_detail
    from public.billing_monitor_signals s
    where s.last_at >= v_since and s.last_at <= _now
    group by s.code
  ) agg;

  -- Pagas no provedor e não creditadas/baixadas há mais de 10 min, fora as
  -- que já estão em revisão (essas têm alerta próprio).
  select jsonb_build_object(
           'count', count(*),
           'oldest_paid_at', min(coalesce(c.paid_at, c.updated_at)))
    into v_paid_uncredited
  from public.payment_charges c
  where c.status = 'PAID'
    and c.credited_at is null
    and c.needs_review = false
    and coalesce(c.paid_at, c.updated_at) < _now - interval '10 minutes';

  select jsonb_build_object(
           'count', count(*),
           'oldest_at', min(coalesce(c.paid_at, c.updated_at)))
    into v_needs_review
  from public.payment_charges c
  where c.needs_review = true
    and c.credited_at is null
    and c.review_resolved_at is null;

  select jsonb_build_object(
           'count', count(*),
           'tenant_ids', coalesce(jsonb_agg(i.tenant_id order by i.tenant_id), '[]'::jsonb))
    into v_wallets
  from public.billing_wallet_integrity() i;

  -- Última execução concluída (succeeded/partial) de cada job de cobrança.
  -- Ordena por started_at para usar dispatcher_runs_job_started_idx.
  select jsonb_build_object(
           'billing-reconcile', (
             select r.finished_at from public.dispatcher_runs r
             where r.job = 'billing-reconcile'
               and r.status in ('succeeded', 'partial')
               and r.finished_at <= _now
             order by r.started_at desc
             limit 1),
           'billing-cycle', (
             select r.finished_at from public.dispatcher_runs r
             where r.job = 'billing-cycle'
               and r.status in ('succeeded', 'partial')
               and r.finished_at <= _now
             order by r.started_at desc
             limit 1))
    into v_jobs;

  return jsonb_build_object(
    'now', _now,
    'since', v_since,
    'signals', v_signals,
    'paid_uncredited', v_paid_uncredited,
    'needs_review', v_needs_review,
    'wallet_mismatch', v_wallets,
    'jobs_last_ok', v_jobs
  );
end;
$$;

revoke execute on function public.billing_health_snapshot(integer, timestamptz) from public, anon, authenticated;
grant execute on function public.billing_health_snapshot(integer, timestamptz) to service_role;

create index if not exists idx_payment_webhook_events_received_with_body
  on public.payment_webhook_events (received_at)
  where raw_body is not null or headers is not null;

-- Apaga (null) raw_body e headers de eventos com mais de `_older_than_days`
-- dias (mínimo 90), no máximo `_limit` linhas por chamada (1 a 5000).
-- Devolve quantas linhas mudaram; o chamador repete enquanto vier cheio.
create or replace function public.billing_purge_webhook_bodies(
  _older_than_days integer default 90,
  _limit integer default 1000
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_cutoff timestamptz;
  v_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden';
  end if;

  v_cutoff := now() - make_interval(days => greatest(90, coalesce(_older_than_days, 90)));

  with batch as (
    select e.event_id
    from public.payment_webhook_events e
    where e.received_at < v_cutoff
      and (e.raw_body is not null or e.headers is not null)
    order by e.received_at
    limit greatest(1, least(coalesce(_limit, 1000), 5000))
    for update skip locked
  )
  update public.payment_webhook_events e
     set raw_body = null,
         headers = null
    from batch
   where e.event_id = batch.event_id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.billing_purge_webhook_bodies(integer, integer) from public, anon, authenticated;
grant execute on function public.billing_purge_webhook_bodies(integer, integer) to service_role;

notify pgrst, 'reload schema';
