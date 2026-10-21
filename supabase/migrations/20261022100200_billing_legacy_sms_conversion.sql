-- Conversão dos créditos SMS antigos (PG1, Task 4).
--
-- Esta migration SÓ cria a função; ela não roda sozinha. A Task 9 (runbook
-- de virada) decide quando rodar `billing_convert_legacy_sms_credits` em
-- produção (primeiro com `_apply = false` para revisar, depois `_apply =
-- true`), depois do deploy das migrations de preço/carteira (Tasks 2 e 3).
--
-- Decisão do usuário (21/10): 1 crédito antigo de `tenant_sms_credit_balances`
-- (20260922193000_create_sms_credit_billing.sql) vale 1 SMS no preço NOVO da
-- casa (`billing_effective_price(tenant,'sms').unit_price`, R$ 0,08 padrão),
-- nunca o preço legado de R$ 0,12 gravado em `tenant_sms_pricing`/
-- `sms_credit_settings`.
--
-- Re-executável: cada chamada lê o saldo legado atual e soma quanto já foi
-- convertido antes (`already_converted`, a soma de `legacy_credits` nas
-- linhas `migration` já gravadas para a casa) e só lança a diferença
-- (`delta_credits`). Isso cobre o envio de SMS pelo código antigo entre a
-- conversão e o deploy (Review Focus #2 do global-constraints): o saldo
-- legado cai, a próxima rodada já lança só a diferença negativa.
--
-- Casa isenta (`billing_tenant_exempt`, plano = 'interno') nunca é
-- convertida: skipped_reason = 'interno', amount = 0 (mesmo padrão de
-- "consumo registrado, não debitado" das outras RPCs de carteira).
--
-- Clamp: se um delta negativo levaria o saldo abaixo de zero, a função lança
-- só o que leva o saldo a 0 (amount = -saldo) e marca skipped_reason =
-- 'clamped'. A metadata `legacy_credits` grava o delta CHEIO mesmo quando
-- clampado, não o valor clampado: como already_converted soma
-- `legacy_credits`, a próxima rodada já vê o delta todo como "já
-- convertido" e não tenta lançar a diferença não coberta pelo clamp de
-- novo (ela fica perdida de propósito — o saldo da casa não pode ficar
-- negativo por uma conversão).
--
-- Permissão: só superadmin ou service_role podem chamar (o EXECUTE da
-- function só é concedido a service_role — quem roda isso é o superadmin via
-- SQL/service role, nunca o navegador de uma casa; o check interno aceita os
-- dois porque é o mesmo padrão das outras RPCs internas de carteira).

create or replace function public.billing_convert_legacy_sms_credits(_apply boolean default false)
returns table (
  tenant_id uuid,
  slug text,
  legacy_balance integer,
  already_converted integer,
  delta_credits integer,
  unit_price numeric,
  amount numeric,
  skipped_reason text
)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row record;
  v_already_converted integer;
  v_delta integer;
  v_unit_price numeric(12,4);
  v_exempt boolean;
  v_amount numeric(14,4);
  v_balance numeric(14,4);
  v_skip text;
  v_key text;
begin
  if auth.role() <> 'service_role' and not public.is_super_admin() then
    raise exception 'forbidden';
  end if;

  for v_row in
    select b.tenant_id as t_id, t.slug as t_slug, b.balance_credits as t_balance
    from public.tenant_sms_credit_balances b
    join public.tenants t on t.id = b.tenant_id
    order by t.slug
  loop
    select coalesce(sum((l.metadata ->> 'legacy_credits')::int), 0)
      into v_already_converted
    from public.wallet_ledger l
    where l.tenant_id = v_row.t_id
      and l.entry_type = 'migration'
      and l.reference_type = 'legacy_sms_conversion';

    v_delta := v_row.t_balance - v_already_converted;
    v_unit_price := (public.billing_effective_price(v_row.t_id, 'sms') ->> 'unit_price')::numeric;
    v_exempt := public.billing_tenant_exempt(v_row.t_id);
    v_skip := null;
    v_amount := v_delta * v_unit_price;

    if v_exempt then
      v_skip := 'interno';
      v_amount := 0;
    elsif v_delta <> 0 then
      -- Lê o saldo atual (sem travar: só precisamos prever o clamp também
      -- no modo preview). No modo apply, wallet_mutation trava a linha de
      -- verdade antes de gravar.
      select balance into v_balance
        from public.tenant_wallets
       where public.tenant_wallets.tenant_id = v_row.t_id;
      v_balance := coalesce(v_balance, 0);

      if v_amount < 0 and v_balance + v_amount < 0 then
        v_skip := 'clamped';
        v_amount := -v_balance;
      end if;

      if _apply then
        v_key := 'legacy-sms:' || v_row.t_id::text || ':' || v_already_converted::text || ':' || v_row.t_balance::text;

        perform public.wallet_mutation(
          v_row.t_id,
          v_amount,
          'migration',
          'sms',
          v_delta,
          null,
          null,
          v_unit_price,
          null,
          'legacy_sms_conversion',
          v_row.t_id::text,
          v_key,
          'Conversão dos créditos SMS antigos',
          jsonb_build_object('legacy_credits', v_delta),
          null
        );
      end if;
    end if;

    tenant_id := v_row.t_id;
    slug := v_row.t_slug;
    legacy_balance := v_row.t_balance;
    already_converted := v_already_converted;
    delta_credits := v_delta;
    unit_price := v_unit_price;
    amount := v_amount;
    skipped_reason := v_skip;

    return next;
  end loop;
end;
$$;

-- EXECUTE nunca para PUBLIC/anon (padrão F6). Só service_role: quem roda a
-- conversão é o superadmin via SQL/service role (Task 9), nunca um usuário
-- autenticado comum via PostgREST.
revoke execute on function public.billing_convert_legacy_sms_credits(boolean) from public, anon, authenticated;
grant execute on function public.billing_convert_legacy_sms_credits(boolean) to service_role;

notify pgrst, 'reload schema';
