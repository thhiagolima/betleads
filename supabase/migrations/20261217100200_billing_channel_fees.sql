-- Conta própria de provedor por casa — Fase 3 (Task 3): taxa mensal na
-- fatura.
--
-- O QUE FAZ
--   * public.billing_invoices ganha channel_fees_cents (bigint, >= 0,
--     default 0) e channel_fees (jsonb, default '{}', ex.
--     {"sms": 50000}): a taxa mensal cobrada por canal com conta própria,
--     congelada no valor da emissão.
--   * public.billing_channel_fees(_tenant uuid) returns jsonb -> soma
--     monthly_fee_cents das concessões (tenant_own_provider_grants) com
--     allowed = true e monthly_fee_cents > 0 cuja conta ligada em
--     tenant_channel_providers (mesma casa, mesmo canal) pertence à própria
--     casa (provider_accounts.owner_tenant_id = _tenant) e está ativa
--     (status = 'active'). Sem concessão, sem conta ligada, conta de outro
--     dono, conta desativada ou taxa zero: não entra. Devolve
--     {"total_cents": n, "channels": {"sms": n, ...}} (canal com taxa > 0
--     cobrada só).
--   * billing_issue_invoice recriada (corpo de 20261023100000:394) para
--     gravar channel_fees_cents/channel_fees e
--     amount_cents = base - discount + channel_fees_cents. A regra do
--     mínimo do Pix (1..9999 centavos, não emite) e a baixa automática de
--     valor 0 (full_discount) passam a olhar esse valor final, já com a
--     taxa — o desconto do plano continua incidindo só sobre a base.
--   * billing_reprice_open_invoice recriada (corpo de 20261023100000:529)
--     para manter o channel_fees_cents já gravado na fatura (a taxa não é
--     recalculada no repreço: fica congelada desde a emissão) e somá-lo ao
--     final depois do desconto contínuo e do desconto pontual (que
--     continua limitado só à base, sem a taxa). A regra do mínimo do Pix e
--     a baixa automática de valor 0 olham esse valor final.
--   * billing_channel_fees: security definer, só service_role (mesmo padrão
--     de billing_monthly_amount: revoke de public/anon/authenticated, grant
--     só a service_role). Super admin acessa pelo backend (service_role),
--     nunca client-side direto.
--
-- COMPATIBILIDADE / ORDEM DE DEPLOY
--   * Aditiva: aplicar antes do app novo. O app antigo não lê
--     channel_fees_cents/channel_fees (fica 0/'{}' em toda fatura emitida
--     antes desta migração) e não chama billing_channel_fees.
--   * billing_monthly_amount não muda.
--
-- ROLLBACK
--   ALTER TABLE public.billing_invoices DROP COLUMN channel_fees_cents;
--   ALTER TABLE public.billing_invoices DROP COLUMN channel_fees;
--   DROP FUNCTION public.billing_channel_fees(uuid);
--   -- (billing_issue_invoice/billing_reprice_open_invoice voltam ao corpo
--   -- de 20261023100000 se essa migração for reaplicada, ou com um
--   -- CREATE OR REPLACE manual.)

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.billing_invoices
  ADD COLUMN IF NOT EXISTS channel_fees_cents bigint NOT NULL DEFAULT 0 CHECK (channel_fees_cents >= 0),
  ADD COLUMN IF NOT EXISTS channel_fees jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.billing_invoices.channel_fees_cents IS
  'Soma das taxas mensais de conta própria (billing_channel_fees) congelada na emissão da fatura.';
COMMENT ON COLUMN public.billing_invoices.channel_fees IS
  'Taxas mensais de conta própria por canal na emissão, ex. {"sms": 50000}. Vazio quando nenhum canal cobra.';

create or replace function public.billing_channel_fees(_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_channels jsonb := '{}'::jsonb;
  v_total bigint := 0;
begin
  select coalesce(jsonb_object_agg(g.channel, g.monthly_fee_cents), '{}'::jsonb),
         coalesce(sum(g.monthly_fee_cents), 0)
    into v_channels, v_total
  from public.tenant_own_provider_grants g
  join public.tenant_channel_providers tcp
    on tcp.tenant_id = g.tenant_id and tcp.channel = g.channel
  join public.provider_accounts pa
    on pa.id = tcp.provider_account_id
  where g.tenant_id = _tenant
    and g.allowed
    and g.monthly_fee_cents > 0
    and pa.owner_tenant_id = _tenant
    and pa.status = 'active';

  return jsonb_build_object('total_cents', v_total, 'channels', v_channels);
end;
$$;

-- Emissão: mesmo corpo de 20261023100000_billing_invoices.sql:394, somando
-- a taxa mensal de conta própria (congelada) ao valor final. A regra do
-- mínimo do Pix e a baixa automática de valor 0 passam a olhar esse valor
-- final (com a taxa), não só o da mensalidade.
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
  v_fees jsonb;
  v_fee_cents bigint;
  v_final bigint;
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

  v_fees := public.billing_channel_fees(_tenant);
  v_fee_cents := (v_fees ->> 'total_cents')::bigint;
  v_final := v_amount_cents + v_fee_cents;

  if v_final between 1 and 9999 then
    raise notice 'billing_issue_invoice: casa % com fatura de % centavos (abaixo do mínimo do Pix), não emitida',
      _tenant, v_final;
    return null;
  end if;

  insert into public.billing_invoices (
    tenant_id, period_start, period_end, cycle_due_date, due_date,
    base_amount_cents, discount_cents, one_off_discount_cents, amount_cents,
    channel_fees_cents, channel_fees, status, upfront
  ) values (
    _tenant,
    v_tb.next_due_date,
    public.billing_add_months(v_tb.next_due_date, 1) - 1,
    v_tb.next_due_date,
    v_tb.next_due_date,
    (v_amount ->> 'base_cents')::bigint,
    (v_amount ->> 'discount_cents')::bigint,
    0,
    v_final,
    v_fee_cents,
    (v_fees -> 'channels'),
    'open',
    coalesce(_upfront, false)
  )
  returning id into v_id;

  if v_final = 0 then
    perform public.billing_settle_invoice(v_id, 'full_discount', 0, null, null, null);
  end if;

  return v_id;
end;
$$;

-- Repreço: mesmo corpo de 20261023100000_billing_invoices.sql:529, mantendo
-- o channel_fees_cents já gravado na fatura (a taxa não é recalculada aqui,
-- fica congelada desde a emissão) e somando-o ao valor final, depois do
-- desconto contínuo e do pontual (que continuam limitados só à base). A
-- regra do mínimo do Pix e a baixa automática de valor 0 olham esse final.
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
  v_final := v_base - v_discount - v_one_off + v_inv.channel_fees_cents;

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

revoke execute on function public.billing_channel_fees(uuid) from public, anon, authenticated;
grant execute on function public.billing_channel_fees(uuid) to service_role;

-- billing_issue_invoice / billing_reprice_open_invoice mantêm os grants
-- originais (nenhum: só o dono, chamadas de dentro de outras funções
-- security definer). create or replace preserva, mas reafirmamos.
revoke execute on function public.billing_issue_invoice(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.billing_reprice_open_invoice(uuid) from public, anon, authenticated;

NOTIFY pgrst, 'reload schema';
