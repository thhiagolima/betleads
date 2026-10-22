-- Mensalidade do plano (Task 2): faturas mensais, estado de cobrança por
-- casa, regras de baixa e de ciclo, o ramo `invoice` de
-- `billing_credit_paid_charge` (PG2) e as ações do superadmin em SQL.
--
-- Modelo:
-- - `tenant_billing` (uma linha por casa) guarda o ciclo (`next_due_date` =
--   vencimento da próxima fatura a emitir; enquanto há fatura aberta, é o
--   `cycle_due_date` dela), preço próprio, desconto contínuo, bloqueio
--   manual, congelamento e o estado calculado (`access_state`).
-- - `billing_invoices`: no máximo uma fatura `open` por casa (índice único
--   parcial). `due_date` é o vencimento efetivo (pode ser estendido) e manda
--   na faixa/bloqueio; `cycle_due_date` é o vencimento do ciclo e manda no
--   próximo ciclo.
-- - `billing_email_log`: um e-mail de cada tipo por fatura (Task 5).
--
-- Datas: sempre o dia de Brasília de `billing_now()` (PG1), que honra o
-- relógio de teste só com `app.allow_test_clock = 'on'`.
--
-- Concorrência: a geração, a baixa (webhook/cron/manual) e toda ação do
-- superadmin travam a linha de `tenant_billing` (FOR UPDATE) antes de ler ou
-- escrever as faturas da casa, então o job da hora, um webhook e uma ação do
-- superadmin sempre serializam. `billing_credit_paid_charge` trava antes a
-- cobrança e depois a casa (via `billing_settle_invoice`); nenhuma função
-- daqui trava cobranças, então a ordem é sempre cobrança → casa.
--
-- Erros: as ações lançam códigos estáveis como mensagem da exceção
-- ('forbidden', 'invoice_not_open', 'amount_below_pix_minimum',
-- 'invalid_days', 'invalid_discount', 'tenant_exempt', 'invoice_not_found',
-- e também 'tenant_not_found', 'invalid_amount', 'invalid_date'), que a
-- camada TS traduz. `amount_below_pix_minimum` leva o texto exato em pt-BR
-- no DETAIL. O motivo das ações é validado e auditado na TS (Task 8).

-- ---------------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------------

create table public.tenant_billing (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  plan_code text not null default 'crm_unico' references public.billing_plans(code),
  custom_price_cents bigint null check (custom_price_cents is null or custom_price_cents >= 10000),
  discount_kind text null check (discount_kind in ('percent', 'fixed')),
  discount_value numeric(12,2) null check (discount_value is null or discount_value >= 0),
  discount_starts_on date null,
  discount_ends_on date null,
  next_due_date date null,
  manual_block boolean not null default false,
  manual_block_reason text null,
  frozen boolean not null default false,
  access_state text not null default 'ok' check (
    access_state in (
      'exempt', 'frozen', 'locked_manual', 'awaiting_first_payment',
      'ok', 'due_soon', 'overdue', 'locked_unpaid'
    )
  ),
  access_state_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.billing_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  cycle_due_date date not null,
  due_date date not null,
  base_amount_cents bigint not null check (base_amount_cents >= 0),
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  one_off_discount_cents bigint not null default 0 check (one_off_discount_cents >= 0),
  amount_cents bigint not null check (amount_cents >= 0),
  status text not null default 'open' check (status in ('open', 'paid', 'canceled')),
  -- "Paga antes de usar": fatura emitida quando a casa vira pagante (gatilho
  -- do plano / carga inicial) ou é descongelada. Enquanto aberta, a casa fica
  -- em awaiting_first_payment, mesmo que já tenha pago faturas antes.
  upfront boolean not null default false,
  paid_at timestamptz null,
  paid_via text null check (paid_via in ('pix', 'manual', 'full_discount')),
  paid_amount_cents bigint null,
  payment_charge_id uuid null references public.payment_charges(id),
  manual_note text null,
  manual_receipt text null,
  canceled_reason text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end >= period_start)
);

create unique index billing_invoices_one_open_per_tenant
  on public.billing_invoices (tenant_id) where status = 'open';
create index idx_billing_invoices_tenant on public.billing_invoices (tenant_id, created_at desc);
create index idx_billing_invoices_status_due on public.billing_invoices (status, due_date);

create table public.billing_email_log (
  invoice_id uuid not null references public.billing_invoices(id) on delete cascade,
  kind text not null check (kind in ('issued', 'due_today', 'locked', 'paid')),
  sent_at timestamptz not null default now(),
  recipients integer not null default 0,
  primary key (invoice_id, kind)
);

-- ---------------------------------------------------------------------------
-- Datas e valores
-- ---------------------------------------------------------------------------

-- Dia de referência: o dia de Brasília do relógio de cobrança.
create or replace function public.billing_today()
returns date
language sql
stable
set search_path to 'public'
as $$
  select (public.billing_now() at time zone 'America/Sao_Paulo')::date
$$;

-- Soma de meses com fim de mês ajustado (31/01 + 1 mês = 28/02 ou 29/02):
-- é o comportamento nativo de date + interval no Postgres.
create or replace function public.billing_add_months(_d date, _n int)
returns date
language sql
immutable
as $$
  select (_d + make_interval(months => _n))::date
$$;

-- Lança o erro do mínimo do Pix quando o valor final fica entre 1 e 9999
-- centavos (0 é permitido: vira baixa por desconto integral).
create or replace function public.billing_assert_pix_minimum(_amount_cents bigint)
returns void
language plpgsql
immutable
as $$
begin
  if _amount_cents between 1 and 9999 then
    raise exception 'amount_below_pix_minimum'
      using detail = 'O valor da fatura não pode ficar abaixo de R$ 100,00 (mínimo do Pix)';
  end if;
end;
$$;

-- Desconto (centavos) de um tipo/valor sobre uma base, com arredondamento
-- meio para cima e nunca maior que a base.
create or replace function public.billing_discount_cents(_base bigint, _kind text, _value numeric)
returns bigint
language sql
immutable
as $$
  select case
    when _kind is null or _value is null then 0
    when _kind = 'percent' then least(_base, round(_base::numeric * _value / 100)::bigint)
    when _kind = 'fixed' then least(_base, round(_value)::bigint)
    else 0
  end
$$;

-- Valor da mensalidade de um ciclo: preço do plano (ou preço próprio) menos
-- o desconto contínuo, se o vencimento do ciclo estiver na janela dele.
create or replace function public.billing_monthly_amount(_tenant uuid, _cycle_due date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_tb public.tenant_billing%rowtype;
  v_base bigint;
  v_discount bigint := 0;
begin
  select * into v_tb from public.tenant_billing where tenant_id = _tenant;

  v_base := coalesce(
    v_tb.custom_price_cents,
    (select price_cents from public.billing_plans where code = coalesce(v_tb.plan_code, 'crm_unico'))
  );

  if v_tb.discount_kind is not null
     and (v_tb.discount_starts_on is null or v_tb.discount_starts_on <= _cycle_due)
     and (v_tb.discount_ends_on is null or _cycle_due <= v_tb.discount_ends_on) then
    v_discount := public.billing_discount_cents(v_base, v_tb.discount_kind, v_tb.discount_value);
  end if;

  return jsonb_build_object(
    'base_cents', v_base,
    'discount_cents', v_discount,
    'amount_cents', v_base - v_discount
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Estado
-- ---------------------------------------------------------------------------

-- Fase da casa segundo a fatura aberta (sem olhar isenção, congelamento ou
-- bloqueio manual): awaiting_first_payment, due_soon, overdue,
-- locked_unpaid ou ok. Usada pelo estado e pela regra de ciclo da baixa.
-- `_on` é o dia de referência (padrão: hoje); a baixa por Pix passa o dia
-- em que o Pix foi pago. Fatura `upfront` aberta = awaiting_first_payment.
create or replace function public.billing_invoice_phase(_tenant uuid, _on date default null)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_open public.billing_invoices%rowtype;
  v_today date := coalesce(_on, public.billing_today());
begin
  select * into v_open
  from public.billing_invoices
  where tenant_id = _tenant and status = 'open';

  if not found then
    return 'ok';
  end if;

  if v_open.upfront or not exists (
    select 1 from public.billing_invoices where tenant_id = _tenant and status = 'paid'
  ) then
    return 'awaiting_first_payment';
  end if;

  if v_today > v_open.due_date + 3 then
    return 'locked_unpaid';
  elsif v_today >= v_open.due_date then
    return 'overdue';
  elsif v_today >= v_open.due_date - 5 then
    return 'due_soon';
  end if;

  return 'ok';
end;
$$;

-- Aplica a precedência (exempt > frozen > locked_manual > fase da fatura) e
-- grava access_state. Devolve o estado, ou null se a casa não tem linha.
create or replace function public.billing_refresh_access_state(_tenant uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tb public.tenant_billing%rowtype;
  v_state text;
begin
  select * into v_tb from public.tenant_billing where tenant_id = _tenant;
  if not found then
    return null;
  end if;

  v_state := case
    when public.billing_tenant_exempt(_tenant) then 'exempt'
    when v_tb.frozen then 'frozen'
    when v_tb.manual_block then 'locked_manual'
    else public.billing_invoice_phase(_tenant)
  end;

  if v_state is distinct from v_tb.access_state then
    update public.tenant_billing
       set access_state = v_state,
           access_state_at = now(),
           updated_at = now()
     where tenant_id = _tenant;
  end if;

  return v_state;
end;
$$;

-- ---------------------------------------------------------------------------
-- Baixa
-- ---------------------------------------------------------------------------

-- Dá baixa numa fatura aberta e move o ciclo. O dia de referência é o dia
-- do pagamento (`_paid_at` em Brasília; null = agora). A baixa por Pix passa
-- o paid_at da cobrança, para que um Pix pago às 23:59 do último dia e
-- creditado depois da meia-noite siga a regra normal.
-- - casa em locked_unpaid ou awaiting_first_payment (no dia do pagamento):
--   próximo vencimento = dia do pagamento + 1 mês;
-- - senão: cycle_due_date + 1 mês;
-- - exceção: se o superadmin já trocou o dia do ciclo com a fatura aberta
--   (`billing_admin_set_cycle_day`, next_due_date diferente do
--   cycle_due_date da fatura e ainda no futuro), esse dia é mantido.
create or replace function public.billing_settle_invoice(
  _invoice uuid,
  _via text,
  _paid_amount_cents bigint,
  _note text,
  _receipt text,
  _charge uuid,
  _paid_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant uuid;
  v_tb public.tenant_billing%rowtype;
  v_inv public.billing_invoices%rowtype;
  v_today date := public.billing_today();
  v_paid_at timestamptz := least(coalesce(_paid_at, public.billing_now()), public.billing_now());
  v_pay_day date;
  v_phase text;
  v_next date;
begin
  if _via is null or _via not in ('pix', 'manual', 'full_discount') then
    raise exception 'invalid_via';
  end if;

  v_pay_day := (v_paid_at at time zone 'America/Sao_Paulo')::date;

  select tenant_id into v_tenant from public.billing_invoices where id = _invoice;
  if not found then
    raise exception 'invoice_not_found';
  end if;

  select * into v_tb from public.tenant_billing where tenant_id = v_tenant for update;
  if not found then
    raise exception 'tenant_not_found';
  end if;

  select * into v_inv from public.billing_invoices where id = _invoice for update;
  if v_inv.status <> 'open' then
    raise exception 'invoice_not_open';
  end if;

  v_phase := public.billing_invoice_phase(v_tenant, v_pay_day);

  if v_tb.next_due_date is not null
     and v_tb.next_due_date is distinct from v_inv.cycle_due_date
     and v_tb.next_due_date > v_today then
    v_next := v_tb.next_due_date;
  elsif v_phase in ('locked_unpaid', 'awaiting_first_payment') then
    v_next := public.billing_add_months(v_pay_day, 1);
  else
    v_next := public.billing_add_months(v_inv.cycle_due_date, 1);
  end if;

  update public.billing_invoices
     set status = 'paid',
         paid_at = v_paid_at,
         paid_via = _via,
         paid_amount_cents = coalesce(_paid_amount_cents, v_inv.amount_cents),
         manual_note = _note,
         manual_receipt = _receipt,
         payment_charge_id = _charge,
         updated_at = now()
   where id = _invoice;

  update public.tenant_billing
     set next_due_date = v_next,
         updated_at = now()
   where tenant_id = v_tenant;

  perform public.billing_refresh_access_state(v_tenant);

  return jsonb_build_object(
    'ok', true,
    'tenant_id', v_tenant,
    'invoice_id', _invoice,
    'next_due_date', v_next
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Emissão
-- ---------------------------------------------------------------------------

-- Emite a fatura do ciclo `next_due_date` de uma casa, se cabível (pagante,
-- não congelada, sem fatura aberta, hoje >= vencimento - 5). Quem chama já
-- travou a linha de tenant_billing. Valor 0 recebe baixa `full_discount`;
-- valor entre 1 e 9999 centavos (abaixo do mínimo do Pix) não é emitido
-- (NOTICE no log). `_upfront` marca a fatura "paga antes de usar" (casa que
-- vira pagante ou é descongelada). Devolve o id da fatura criada ou null.
create or replace function public.billing_issue_invoice(_tenant uuid, _upfront boolean default false)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tb public.tenant_billing%rowtype;
  v_today date := public.billing_today();
  v_amount jsonb;
  v_amount_cents bigint;
  v_id uuid;
begin
  select * into v_tb from public.tenant_billing where tenant_id = _tenant;

  if not found
     or v_tb.frozen
     or v_tb.next_due_date is null
     or v_tb.next_due_date - 5 > v_today
     or public.billing_tenant_exempt(_tenant)
     or exists (
       select 1 from public.billing_invoices where tenant_id = _tenant and status = 'open'
     ) then
    return null;
  end if;

  v_amount := public.billing_monthly_amount(_tenant, v_tb.next_due_date);
  v_amount_cents := (v_amount ->> 'amount_cents')::bigint;

  if v_amount_cents between 1 and 9999 then
    raise notice 'billing_issue_invoice: casa % com fatura de % centavos (abaixo do mínimo do Pix), não emitida',
      _tenant, v_amount_cents;
    return null;
  end if;

  insert into public.billing_invoices (
    tenant_id, period_start, period_end, cycle_due_date, due_date,
    base_amount_cents, discount_cents, one_off_discount_cents, amount_cents, status, upfront
  ) values (
    _tenant,
    v_tb.next_due_date,
    public.billing_add_months(v_tb.next_due_date, 1) - 1,
    v_tb.next_due_date,
    v_tb.next_due_date,
    (v_amount ->> 'base_cents')::bigint,
    (v_amount ->> 'discount_cents')::bigint,
    0,
    v_amount_cents,
    'open',
    coalesce(_upfront, false)
  )
  returning id into v_id;

  if v_amount_cents = 0 then
    perform public.billing_settle_invoice(v_id, 'full_discount', 0, null, null, null);
  end if;

  return v_id;
end;
$$;

-- Job da hora: emite as faturas devidas de todas as casas pagantes. Trava
-- cada casa e confere tudo de novo antes de emitir (billing_issue_invoice),
-- então duas execuções simultâneas nunca emitem duas faturas. Cada casa roda
-- no seu próprio bloco com EXCEPTION (subtransação): a falha de uma casa vira
-- WARNING no log e nunca derruba a execução das outras.
create or replace function public.billing_generate_due_invoices()
returns setof uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant uuid;
  v_id uuid;
  v_today date := public.billing_today();
begin
  for v_tenant in
    select tb.tenant_id
    from public.tenant_billing tb
    where not tb.frozen
      and tb.next_due_date is not null
      and tb.next_due_date - 5 <= v_today
      and not exists (
        select 1 from public.billing_invoices i
        where i.tenant_id = tb.tenant_id and i.status = 'open'
      )
    order by tb.tenant_id
  loop
    v_id := null;
    begin
      perform 1 from public.tenant_billing where tenant_id = v_tenant for update;
      v_id := public.billing_issue_invoice(v_tenant);
      if v_id is not null then
        perform public.billing_refresh_access_state(v_tenant);
      end if;
    exception when others then
      raise warning 'billing_generate_due_invoices: casa % falhou: % (%)', v_tenant, sqlerrm, sqlstate;
      v_id := null;
    end;

    if v_id is not null then
      return next v_id;
    end if;
  end loop;

  return;
end;
$$;

-- Cancela a fatura aberta de uma casa (se houver). Quem chama já travou a
-- linha de tenant_billing.
create or replace function public.billing_cancel_open_invoice(_tenant uuid, _reason text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
begin
  update public.billing_invoices
     set status = 'canceled',
         canceled_reason = _reason,
         updated_at = now()
   where tenant_id = _tenant and status = 'open'
  returning id into v_id;

  return v_id;
end;
$$;

-- Recalcula a fatura aberta depois de mudar preço próprio ou desconto
-- contínuo (mantém o desconto pontual em centavos, limitado ao que sobra).
-- Aplica a regra do mínimo do Pix; valor 0 recebe baixa `full_discount`.
create or replace function public.billing_reprice_open_invoice(_tenant uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_inv public.billing_invoices%rowtype;
  v_amount jsonb;
  v_base bigint;
  v_discount bigint;
  v_one_off bigint;
  v_final bigint;
begin
  select * into v_inv
  from public.billing_invoices
  where tenant_id = _tenant and status = 'open'
  for update;

  if not found then
    return;
  end if;

  v_amount := public.billing_monthly_amount(_tenant, v_inv.cycle_due_date);
  v_base := (v_amount ->> 'base_cents')::bigint;
  v_discount := (v_amount ->> 'discount_cents')::bigint;
  v_one_off := least(v_inv.one_off_discount_cents, v_base - v_discount);
  v_final := v_base - v_discount - v_one_off;

  perform public.billing_assert_pix_minimum(v_final);

  update public.billing_invoices
     set base_amount_cents = v_base,
         discount_cents = v_discount,
         one_off_discount_cents = v_one_off,
         amount_cents = v_final,
         updated_at = now()
   where id = v_inv.id;

  if v_final = 0 then
    perform public.billing_settle_invoice(v_inv.id, 'full_discount', 0, null, null, null);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Gatilho do plano e carga inicial
-- ---------------------------------------------------------------------------

-- Casa nova ou que muda entre isenta e pagante:
-- - vira pagante (ou nasce pagante): garante a linha, o ciclo recomeça hoje
--   (mesmo que a casa já tenha pago antes) e emite uma fatura `upfront`
--   vencendo hoje ("paga antes de usar" → awaiting_first_payment);
-- - vira isenta (ou nasce isenta): garante a linha, cancela a fatura aberta
--   com 'Casa isenta' e limpa next_due_date (estado exempt).
-- Convive com o BEFORE `tenants_plan_guard` (PG1): este é AFTER e só roda
-- depois que a guarda aceitou a troca.
create or replace function public.billing_on_tenant_plano()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_new_exempt boolean := public.billing_tenant_exempt(new.id);
  v_old_exempt boolean;
  v_today date := public.billing_today();
begin
  if tg_op = 'UPDATE' then
    v_old_exempt := coalesce(
      (select exempt_all from public.billing_plans where code = old.plano),
      false
    );
    if v_old_exempt = v_new_exempt
       and exists (select 1 from public.tenant_billing where tenant_id = new.id) then
      return null;
    end if;
  end if;

  insert into public.tenant_billing (tenant_id, next_due_date)
  values (new.id, case when v_new_exempt then null else v_today end)
  on conflict (tenant_id) do nothing;

  perform 1 from public.tenant_billing where tenant_id = new.id for update;

  if v_new_exempt then
    perform public.billing_cancel_open_invoice(new.id, 'Casa isenta');
    update public.tenant_billing
       set next_due_date = null,
           updated_at = now()
     where tenant_id = new.id;
  else
    update public.tenant_billing
       set next_due_date = v_today,
           updated_at = now()
     where tenant_id = new.id
       and not exists (
         select 1 from public.billing_invoices
         where tenant_id = new.id and status = 'open'
       );
    perform public.billing_issue_invoice(new.id, true);
  end if;

  perform public.billing_refresh_access_state(new.id);
  return null;
end;
$$;

drop trigger if exists tenants_billing_plano on public.tenants;
create trigger tenants_billing_plano
  after insert or update of plano on public.tenants
  for each row
  execute function public.billing_on_tenant_plano();

-- Carga inicial (idempotente): cria tenant_billing para toda casa que ainda
-- não tem. Isentas ficam exempt; pagantes começam o ciclo hoje com a
-- primeira fatura vencendo hoje. Devolve quantas linhas criou.
create or replace function public.billing_backfill_tenant_billing()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant uuid;
  v_exempt boolean;
  v_rows integer;
  v_created integer := 0;
  v_today date := public.billing_today();
begin
  for v_tenant in select id from public.tenants order by id loop
    v_exempt := public.billing_tenant_exempt(v_tenant);

    insert into public.tenant_billing (tenant_id, next_due_date)
    values (v_tenant, case when v_exempt then null else v_today end)
    on conflict (tenant_id) do nothing;
    get diagnostics v_rows = row_count;

    if v_rows > 0 then
      perform 1 from public.tenant_billing where tenant_id = v_tenant for update;
      if not v_exempt then
        perform public.billing_issue_invoice(v_tenant, true);
      end if;
      perform public.billing_refresh_access_state(v_tenant);
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$$;

-- ---------------------------------------------------------------------------
-- Ramo `invoice` de billing_credit_paid_charge (cópia de 20261022110000;
-- só o ramo `invoice` mudou).
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- Ações do superadmin
-- ---------------------------------------------------------------------------

-- Confere superadmin e trava a casa. Recusa casa isenta, salvo
-- `_allow_exempt` (tirar um bloqueio manual que sobrou numa casa isenta).
create or replace function public.billing_admin_lock_tenant(_tenant uuid, _allow_exempt boolean default false)
returns public.tenant_billing
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tb public.tenant_billing%rowtype;
begin
  if not public.is_super_admin() then
    raise exception 'forbidden';
  end if;

  select * into v_tb from public.tenant_billing where tenant_id = _tenant for update;
  if not found then
    raise exception 'tenant_not_found';
  end if;

  if not coalesce(_allow_exempt, false) and public.billing_tenant_exempt(_tenant) then
    raise exception 'tenant_exempt';
  end if;

  return v_tb;
end;
$$;

-- Confere superadmin, trava a casa da fatura e a fatura, e exige `open`.
create or replace function public.billing_admin_lock_open_invoice(_invoice uuid)
returns public.billing_invoices
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant uuid;
  v_inv public.billing_invoices%rowtype;
begin
  if not public.is_super_admin() then
    raise exception 'forbidden';
  end if;

  select tenant_id into v_tenant from public.billing_invoices where id = _invoice;
  if not found then
    raise exception 'invoice_not_found';
  end if;

  perform 1 from public.tenant_billing where tenant_id = v_tenant for update;

  select * into v_inv from public.billing_invoices where id = _invoice for update;
  if v_inv.status <> 'open' then
    raise exception 'invoice_not_open';
  end if;

  return v_inv;
end;
$$;

create or replace function public.billing_admin_result(_tenant uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_state text := public.billing_refresh_access_state(_tenant);
begin
  return jsonb_build_object(
    'ok', true,
    'tenant_id', _tenant,
    'access_state', v_state,
    'next_due_date', (select next_due_date from public.tenant_billing where tenant_id = _tenant)
  );
end;
$$;

create or replace function public.billing_admin_set_block(_tenant uuid, _blocked boolean, _reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  -- Desbloquear é permitido em casa isenta (limpa um bloqueio que sobrou);
  -- bloquear não (isenta vence locked_manual, o bloqueio não teria efeito).
  perform public.billing_admin_lock_tenant(_tenant, not coalesce(_blocked, false));

  update public.tenant_billing
     set manual_block = coalesce(_blocked, false),
         manual_block_reason = case when coalesce(_blocked, false) then _reason else null end,
         updated_at = now()
   where tenant_id = _tenant;

  return public.billing_admin_result(_tenant);
end;
$$;

create or replace function public.billing_admin_extend_due(_invoice uuid, _days int)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_inv public.billing_invoices%rowtype;
begin
  if not public.is_super_admin() then
    raise exception 'forbidden';
  end if;
  if _days is null or _days < 1 or _days > 31 then
    raise exception 'invalid_days';
  end if;

  v_inv := public.billing_admin_lock_open_invoice(_invoice);

  update public.billing_invoices
     set due_date = due_date + _days,
         updated_at = now()
   where id = v_inv.id;

  return public.billing_admin_result(v_inv.tenant_id);
end;
$$;

create or replace function public.billing_admin_free_days(_tenant uuid, _days int)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not public.is_super_admin() then
    raise exception 'forbidden';
  end if;
  if _days is null or _days < 1 or _days > 365 then
    raise exception 'invalid_days';
  end if;

  perform public.billing_admin_lock_tenant(_tenant);

  update public.tenant_billing
     set next_due_date = coalesce(next_due_date, public.billing_today()) + _days,
         updated_at = now()
   where tenant_id = _tenant;

  update public.billing_invoices
     set due_date = due_date + _days,
         cycle_due_date = cycle_due_date + _days,
         period_end = period_end + _days,
         updated_at = now()
   where tenant_id = _tenant and status = 'open';

  return public.billing_admin_result(_tenant);
end;
$$;

create or replace function public.billing_admin_one_off_discount(_invoice uuid, _kind text, _value numeric)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_inv public.billing_invoices%rowtype;
  v_room bigint;
  v_one_off bigint;
  v_final bigint;
begin
  if not public.is_super_admin() then
    raise exception 'forbidden';
  end if;
  if _kind is not null and (
       _kind not in ('percent', 'fixed')
       or _value is null
       or _value < 0
       or (_kind = 'percent' and _value > 100)
     ) then
    raise exception 'invalid_discount';
  end if;

  v_inv := public.billing_admin_lock_open_invoice(_invoice);

  v_room := v_inv.base_amount_cents - v_inv.discount_cents;
  v_one_off := least(v_room, public.billing_discount_cents(v_inv.base_amount_cents, _kind, _value));
  v_final := v_room - v_one_off;

  perform public.billing_assert_pix_minimum(v_final);

  update public.billing_invoices
     set one_off_discount_cents = v_one_off,
         amount_cents = v_final,
         updated_at = now()
   where id = v_inv.id;

  if v_final = 0 then
    perform public.billing_settle_invoice(v_inv.id, 'full_discount', 0, null, null, null);
  end if;

  return public.billing_admin_result(v_inv.tenant_id);
end;
$$;

create or replace function public.billing_admin_set_continuous_discount(
  _tenant uuid,
  _kind text,
  _value numeric,
  _starts date,
  _ends date
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tb public.tenant_billing%rowtype;
  v_base bigint;
begin
  if not public.is_super_admin() then
    raise exception 'forbidden';
  end if;
  if _kind is not null and (
       _kind not in ('percent', 'fixed')
       or _value is null
       or _value < 0
       or (_kind = 'percent' and _value > 100)
       or (_starts is not null and _ends is not null and _ends < _starts)
     ) then
    raise exception 'invalid_discount';
  end if;

  v_tb := public.billing_admin_lock_tenant(_tenant);

  if _kind is not null then
    v_base := coalesce(
      v_tb.custom_price_cents,
      (select price_cents from public.billing_plans where code = v_tb.plan_code)
    );
    perform public.billing_assert_pix_minimum(
      v_base - public.billing_discount_cents(v_base, _kind, _value)
    );
  end if;

  update public.tenant_billing
     set discount_kind = _kind,
         discount_value = case when _kind is null then null else _value end,
         discount_starts_on = case when _kind is null then null else _starts end,
         discount_ends_on = case when _kind is null then null else _ends end,
         updated_at = now()
   where tenant_id = _tenant;

  perform public.billing_reprice_open_invoice(_tenant);

  return public.billing_admin_result(_tenant);
end;
$$;

create or replace function public.billing_admin_manual_settle(
  _invoice uuid,
  _paid_amount_cents bigint,
  _note text,
  _receipt text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_inv public.billing_invoices%rowtype;
  v_result jsonb;
begin
  v_inv := public.billing_admin_lock_open_invoice(_invoice);

  if _paid_amount_cents is not null and _paid_amount_cents < 0 then
    raise exception 'invalid_amount';
  end if;

  v_result := public.billing_settle_invoice(
    v_inv.id, 'manual', coalesce(_paid_amount_cents, v_inv.amount_cents), _note, _receipt, null
  );

  return public.billing_admin_result(v_inv.tenant_id) || jsonb_build_object('invoice_id', v_inv.id);
end;
$$;

create or replace function public.billing_admin_cancel_invoice(_invoice uuid, _reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_inv public.billing_invoices%rowtype;
begin
  v_inv := public.billing_admin_lock_open_invoice(_invoice);

  update public.billing_invoices
     set status = 'canceled',
         canceled_reason = _reason,
         updated_at = now()
   where id = v_inv.id;

  return public.billing_admin_result(v_inv.tenant_id);
end;
$$;

create or replace function public.billing_admin_set_cycle_day(_tenant uuid, _next_due date)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not public.is_super_admin() then
    raise exception 'forbidden';
  end if;
  if _next_due is null or _next_due < public.billing_today() then
    raise exception 'invalid_date';
  end if;

  perform public.billing_admin_lock_tenant(_tenant);

  update public.tenant_billing
     set next_due_date = _next_due,
         updated_at = now()
   where tenant_id = _tenant;

  return public.billing_admin_result(_tenant);
end;
$$;

-- Congelar cancela a fatura aberta ('Plano congelado') e para a emissão;
-- descongelar recomeça o ciclo hoje e emite na hora uma fatura `upfront`
-- ("paga antes de usar": awaiting_first_payment até pagar).
create or replace function public.billing_admin_set_frozen(_tenant uuid, _frozen boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tb public.tenant_billing%rowtype;
begin
  v_tb := public.billing_admin_lock_tenant(_tenant);

  if coalesce(_frozen, false) and not v_tb.frozen then
    update public.tenant_billing
       set frozen = true,
           updated_at = now()
     where tenant_id = _tenant;
    perform public.billing_cancel_open_invoice(_tenant, 'Plano congelado');
  elsif not coalesce(_frozen, false) and v_tb.frozen then
    update public.tenant_billing
       set frozen = false,
           next_due_date = public.billing_today(),
           updated_at = now()
     where tenant_id = _tenant;
    perform public.billing_issue_invoice(_tenant, true);
  end if;

  return public.billing_admin_result(_tenant);
end;
$$;

create or replace function public.billing_admin_set_custom_price(_tenant uuid, _price_cents bigint)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tb public.tenant_billing%rowtype;
  v_base bigint;
begin
  if not public.is_super_admin() then
    raise exception 'forbidden';
  end if;
  if _price_cents is not null and _price_cents < 10000 then
    perform public.billing_assert_pix_minimum(greatest(_price_cents, 1));
  end if;

  v_tb := public.billing_admin_lock_tenant(_tenant);

  v_base := coalesce(
    _price_cents,
    (select price_cents from public.billing_plans where code = v_tb.plan_code)
  );
  perform public.billing_assert_pix_minimum(
    v_base - public.billing_discount_cents(v_base, v_tb.discount_kind, v_tb.discount_value)
  );

  update public.tenant_billing
     set custom_price_cents = _price_cents,
         updated_at = now()
   where tenant_id = _tenant;

  perform public.billing_reprice_open_invoice(_tenant);

  return public.billing_admin_result(_tenant);
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS e grants
-- ---------------------------------------------------------------------------

alter table public.tenant_billing enable row level security;
create policy tenant_billing_select on public.tenant_billing
  for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = any ((select public.accessible_tenant_ids())::uuid[]));

alter table public.billing_invoices enable row level security;
create policy billing_invoices_select on public.billing_invoices
  for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = any ((select public.accessible_tenant_ids())::uuid[]));

alter table public.billing_email_log enable row level security;
create policy billing_email_log_select on public.billing_email_log
  for select to authenticated
  using (
    exists (
      select 1 from public.billing_invoices i
      where i.id = billing_email_log.invoice_id
        and ((select public.is_super_admin()) or i.tenant_id = any ((select public.accessible_tenant_ids())::uuid[]))
    )
  );

-- Escrita só por service_role ou pelas RPCs acima. Observações internas
-- (manual_note, manual_receipt, manual_block_reason) nunca vão para
-- authenticated; o superadmin lê pelo backend (service_role), como na PG2.
revoke all on public.tenant_billing from anon, authenticated;
grant select (
  tenant_id, plan_code, custom_price_cents, discount_kind, discount_value,
  discount_starts_on, discount_ends_on, next_due_date, manual_block, frozen,
  access_state, access_state_at, updated_at
) on public.tenant_billing to authenticated;
grant all on public.tenant_billing to service_role;

revoke all on public.billing_invoices from anon, authenticated;
grant select (
  id, tenant_id, period_start, period_end, cycle_due_date, due_date,
  base_amount_cents, discount_cents, one_off_discount_cents, amount_cents,
  status, paid_at, paid_via, paid_amount_cents, payment_charge_id,
  canceled_reason, created_at, updated_at
) on public.billing_invoices to authenticated;
grant all on public.billing_invoices to service_role;

revoke all on public.billing_email_log from anon, authenticated;
grant select on public.billing_email_log to authenticated;
grant all on public.billing_email_log to service_role;

-- Funções de service_role (job, webhook, backend).
revoke execute on function public.billing_today() from public, anon, authenticated;
grant execute on function public.billing_today() to service_role;
revoke execute on function public.billing_add_months(date, int) from public, anon, authenticated;
grant execute on function public.billing_add_months(date, int) to service_role;
revoke execute on function public.billing_monthly_amount(uuid, date) from public, anon, authenticated;
grant execute on function public.billing_monthly_amount(uuid, date) to service_role;
revoke execute on function public.billing_refresh_access_state(uuid) from public, anon, authenticated;
grant execute on function public.billing_refresh_access_state(uuid) to service_role;
revoke execute on function public.billing_generate_due_invoices() from public, anon, authenticated;
grant execute on function public.billing_generate_due_invoices() to service_role;
revoke execute on function public.billing_settle_invoice(uuid, text, bigint, text, text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.billing_settle_invoice(uuid, text, bigint, text, text, uuid, timestamptz) to service_role;
revoke execute on function public.billing_backfill_tenant_billing() from public, anon, authenticated;
grant execute on function public.billing_backfill_tenant_billing() to service_role;

-- Auxiliares internas: só o dono (chamadas de dentro das funções acima).
revoke execute on function public.billing_assert_pix_minimum(bigint) from public, anon, authenticated;
revoke execute on function public.billing_discount_cents(bigint, text, numeric) from public, anon, authenticated;
revoke execute on function public.billing_invoice_phase(uuid, date) from public, anon, authenticated;
revoke execute on function public.billing_issue_invoice(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.billing_cancel_open_invoice(uuid, text) from public, anon, authenticated;
revoke execute on function public.billing_reprice_open_invoice(uuid) from public, anon, authenticated;
revoke execute on function public.billing_on_tenant_plano() from public, anon, authenticated;
revoke execute on function public.billing_admin_lock_tenant(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.billing_admin_lock_open_invoice(uuid) from public, anon, authenticated;
revoke execute on function public.billing_admin_result(uuid) from public, anon, authenticated;

-- billing_credit_paid_charge: mesmos grants da PG2 (create or replace mantém,
-- mas reafirmamos).
revoke execute on function public.billing_credit_paid_charge(uuid) from public, anon, authenticated;
grant execute on function public.billing_credit_paid_charge(uuid) to service_role;

-- Ações do superadmin: chamadas pelo cliente do usuário (is_super_admin()
-- precisa de auth.uid()).
revoke execute on function public.billing_admin_set_block(uuid, boolean, text) from public, anon;
grant execute on function public.billing_admin_set_block(uuid, boolean, text) to authenticated, service_role;
revoke execute on function public.billing_admin_extend_due(uuid, int) from public, anon;
grant execute on function public.billing_admin_extend_due(uuid, int) to authenticated, service_role;
revoke execute on function public.billing_admin_free_days(uuid, int) from public, anon;
grant execute on function public.billing_admin_free_days(uuid, int) to authenticated, service_role;
revoke execute on function public.billing_admin_one_off_discount(uuid, text, numeric) from public, anon;
grant execute on function public.billing_admin_one_off_discount(uuid, text, numeric) to authenticated, service_role;
revoke execute on function public.billing_admin_set_continuous_discount(uuid, text, numeric, date, date) from public, anon;
grant execute on function public.billing_admin_set_continuous_discount(uuid, text, numeric, date, date) to authenticated, service_role;
revoke execute on function public.billing_admin_manual_settle(uuid, bigint, text, text) from public, anon;
grant execute on function public.billing_admin_manual_settle(uuid, bigint, text, text) to authenticated, service_role;
revoke execute on function public.billing_admin_cancel_invoice(uuid, text) from public, anon;
grant execute on function public.billing_admin_cancel_invoice(uuid, text) to authenticated, service_role;
revoke execute on function public.billing_admin_set_cycle_day(uuid, date) from public, anon;
grant execute on function public.billing_admin_set_cycle_day(uuid, date) to authenticated, service_role;
revoke execute on function public.billing_admin_set_frozen(uuid, boolean) from public, anon;
grant execute on function public.billing_admin_set_frozen(uuid, boolean) to authenticated, service_role;
revoke execute on function public.billing_admin_set_custom_price(uuid, bigint) from public, anon;
grant execute on function public.billing_admin_set_custom_price(uuid, bigint) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Carga inicial
-- ---------------------------------------------------------------------------

select public.billing_backfill_tenant_billing();

notify pgrst, 'reload schema';
