-- Cobrança Pix pela Upper (PG2, Task 1): o pedido de recarga de créditos
-- (`credit_topup_orders`), a cobrança no provedor (`payment_charges`,
-- genérica para `kind = 'credit_topup' | 'invoice'`, a segunda ainda não
-- implementada), os eventos de webhook crus (`payment_webhook_events`) e a
-- taxa vigente do Pix (`payment_fee_settings`).
--
-- Ordem de escrita (evita FK circular): o pedido é criado primeiro
-- (`charge_id` null), depois a cobrança (`payment_charges.ref_id` aponta
-- para o pedido, sem FK porque em PG4 também vai apontar para uma fatura) e
-- só então o pedido é atualizado com `charge_id`.
--
-- `billing_credit_paid_charge` é o único lugar que credita uma cobrança paga
-- na carteira (PG1, `wallet_mutation` de 20261022100100). Trava a linha de
-- `payment_charges` com FOR UPDATE antes de checar o estado, para que o
-- webhook e a conciliação (cron) nunca creditem a mesma cobrança em
-- paralelo: a segunda chamada só segue depois que a primeira grava
-- `credited_at` e libera o lock, então vê `credited_at` preenchido e
-- devolve `idempotent:true` sem passar pela chave de `wallet_mutation` de
-- novo (que também é uma segunda camada de proteção, por tenant_id +
-- idempotency_key `charge:<id>`). Chamado só por service_role (webhook e
-- cron rodam no backend, nunca no navegador da casa).

create table public.credit_topup_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  amount_cents bigint not null check (amount_cents >= 10000),
  package_code text null,
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'expired', 'cancelled', 'failed')),
  charge_id uuid null,
  created_by uuid null,
  created_at timestamptz not null default now(),
  paid_at timestamptz null
);

create index idx_credit_topup_orders_tenant on public.credit_topup_orders (tenant_id, created_at desc);

create table public.payment_charges (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null check (kind in ('credit_topup', 'invoice')),
  -- Sem FK: ref_id aponta para credit_topup_orders quando kind = 'credit_topup'
  -- e vai apontar para uma fatura (PG4) quando kind = 'invoice'.
  ref_id uuid not null,
  provider text not null default 'upper',
  external_id text not null unique,
  provider_charge_id text null,
  status text not null
    check (status in ('PENDING', 'ACTIVE', 'PAID', 'EXPIRED', 'CANCELLED', 'FAILED')),
  needs_review boolean not null default false,
  amount_cents bigint not null,
  paid_amount_cents bigint null,
  fee_cents bigint null,
  emv text null,
  qr_code_image text null,
  payment_url text null,
  expires_at timestamptz null,
  paid_at timestamptz null,
  payer_name text null,
  payer_document_masked text null,
  -- last_provider_payload é a resposta crua da Upper, só para diagnóstico do
  -- superadmin: NUNCA deve conter o documento completo do pagador (a Task 3
  -- sanitiza o payload antes de gravar aqui; payer_document_masked acima é
  -- quem guarda a versão mascarada, pensada para authenticated).
  last_provider_payload jsonb null,
  last_error text null,
  credited_at timestamptz null,
  created_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_payment_charges_tenant on public.payment_charges (tenant_id, created_at desc);
create index idx_payment_charges_ref on public.payment_charges (kind, ref_id);

-- Agora que payment_charges existe, liga o pedido à sua cobrança (preenchido
-- depois que a cobrança é criada, nunca antes: por isso é null por padrão
-- em vez de not null).
alter table public.credit_topup_orders
  add constraint credit_topup_orders_charge_id_fkey
  foreign key (charge_id) references public.payment_charges(id);

create table public.payment_webhook_events (
  event_id text primary key,
  event text null,
  delivery_id text null,
  signature_valid boolean null,
  raw_body text null,
  headers jsonb null,
  received_at timestamptz not null default now(),
  processed_at timestamptz null,
  -- What the route (Task 3) did with the event once processed: the
  -- confirmChargeFromUpper outcome for charge.* ('credited', 'not_paid',
  -- 'needs_review', 'already_credited', 'unknown_charge'), 'ping' for a
  -- ping, 'ignored' for payment.*. Null while unprocessed.
  outcome text null,
  error text null
);

create table public.payment_fee_settings (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'upper',
  fee_percent numeric(6,4) not null default 0 check (fee_percent >= 0),
  fee_fixed_cents bigint not null default 0 check (fee_fixed_cents >= 0),
  valid_from timestamptz not null default now(),
  updated_by uuid null
);

create index idx_payment_fee_settings_provider_valid_from
  on public.payment_fee_settings (provider, valid_from desc);

-- Credita uma cobrança paga na carteira (PG1). Idempotente: uma vez
-- creditada (credited_at preenchido), repetir a chamada só devolve
-- {ok:true, idempotent:true}. Chamado pelo webhook (Task 3) e pela
-- conciliação por cron (Task 3), que podem rodar ao mesmo tempo — o FOR
-- UPDATE na linha de payment_charges serializa as duas chamadas.
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
    raise exception 'invoice_not_supported';
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

-- RLS: a casa lê os próprios pedidos e cobranças; superadmin lê tudo;
-- payment_webhook_events e payment_fee_settings só o superadmin lê.
-- Nenhuma escrita por authenticated: tudo passa pela RPC acima ou por
-- service_role (criação de pedido/cobrança é Task 2/3, no backend).
alter table public.credit_topup_orders enable row level security;
create policy credit_topup_orders_select on public.credit_topup_orders
  for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = any ((select public.accessible_tenant_ids())::uuid[]));

alter table public.payment_charges enable row level security;
create policy payment_charges_select on public.payment_charges
  for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = any ((select public.accessible_tenant_ids())::uuid[]));

alter table public.payment_webhook_events enable row level security;
create policy payment_webhook_events_superadmin_select on public.payment_webhook_events
  for select to authenticated
  using ((select public.is_super_admin()));

alter table public.payment_fee_settings enable row level security;
create policy payment_fee_settings_superadmin_select on public.payment_fee_settings
  for select to authenticated
  using ((select public.is_super_admin()));

grant select on public.credit_topup_orders to authenticated;
grant all on public.credit_topup_orders to service_role;

-- fee_cents (custo/taxa do fornecedor, regra igual a billing_price_book) e
-- last_provider_payload/last_error (resposta crua da Upper e erro interno,
-- podem carregar detalhe que não é da casa) nunca vão para authenticated;
-- o superadmin lê tudo isso pelo backend (service_role), não pela RLS.
revoke select on public.payment_charges from anon, authenticated;
grant select (
  id, tenant_id, kind, ref_id, provider, external_id, provider_charge_id,
  status, needs_review, amount_cents, paid_amount_cents, emv, qr_code_image,
  payment_url, expires_at, paid_at, payer_name, payer_document_masked,
  credited_at, created_by, created_at, updated_at
) on public.payment_charges to authenticated;
grant all on public.payment_charges to service_role;

grant select on public.payment_webhook_events to authenticated;
grant all on public.payment_webhook_events to service_role;

grant select on public.payment_fee_settings to authenticated;
grant all on public.payment_fee_settings to service_role;

revoke execute on function public.billing_credit_paid_charge(uuid) from public, anon, authenticated;
grant execute on function public.billing_credit_paid_charge(uuid) to service_role;

notify pgrst, 'reload schema';
