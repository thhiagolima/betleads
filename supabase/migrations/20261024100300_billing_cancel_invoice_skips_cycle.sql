-- Cancelar uma fatura mensal pula aquele mês.
--
-- Antes, `billing_admin_cancel_invoice` só marcava a fatura como
-- 'canceled' e o job da hora a reemitia para o mesmo next_due_date. Decisão
-- de produto: fatura cancelada não é reemitida. O mês não é cobrado, o ciclo
-- anda e a próxima fatura é a do ciclo seguinte.
--
-- Exceção: a fatura de ativação não pula o mês. next_due_date não muda e a
-- fatura é reemitida na hora, dentro desta função
-- (`billing_issue_invoice`, com o mesmo `upfront` da cancelada), com o valor
-- atual. Assim a casa segue em awaiting_first_payment, sem a janela de até
-- 1 h em que, sem fatura aberta, ela leria `ok`. Conta como ativação a
-- fatura `upfront` ("paga antes de usar", de casa que vira pagante ou é
-- descongelada) e qualquer fatura de casa que nunca pagou nenhuma.
--
-- Regra do próximo vencimento (a mesma de `billing_settle_invoice`, sem o
-- caso de recomeço pelo dia do pagamento):
-- - se o superadmin já trocou o dia do ciclo com a fatura aberta
--   (`billing_admin_set_cycle_day`: next_due_date diferente do
--   cycle_due_date da fatura e ainda no futuro), esse dia é mantido;
-- - senão: cycle_due_date + 1 mês, nunca antes de hoje. Num cancelamento
--   atrasado, a próxima fatura sai hoje e vence hoje; vencendo hoje, a casa
--   já lê a fase `overdue` (com 3 dias de tolerância antes de
--   `locked_unpaid`).
--
-- `billing_admin_lock_open_invoice` confere superadmin e trava a linha de
-- tenant_billing (for update) e a fatura, nessa ordem, antes de exigir
-- `open`. `billing_admin_result` recalcula access_state (depois da
-- reemissão da fatura de ativação), então uma casa vencida ou bloqueada só
-- por uma fatura mensal cancelada volta a `ok`.

create or replace function public.billing_admin_cancel_invoice(_invoice uuid, _reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_inv public.billing_invoices%rowtype;
  v_next_due date;
  v_today date := public.billing_today();
begin
  v_inv := public.billing_admin_lock_open_invoice(_invoice);

  update public.billing_invoices
     set status = 'canceled',
         canceled_reason = _reason,
         updated_at = now()
   where id = v_inv.id;

  if not v_inv.upfront
     and exists (
       select 1 from public.billing_invoices
       where tenant_id = v_inv.tenant_id and status = 'paid'
     ) then
    select next_due_date into v_next_due
    from public.tenant_billing
    where tenant_id = v_inv.tenant_id;

    if not (
      v_next_due is not null
      and v_next_due is distinct from v_inv.cycle_due_date
      and v_next_due > v_today
    ) then
      update public.tenant_billing
         set next_due_date = greatest(public.billing_add_months(v_inv.cycle_due_date, 1), v_today),
             updated_at = now()
       where tenant_id = v_inv.tenant_id;
    end if;
  else
    perform public.billing_issue_invoice(v_inv.tenant_id, v_inv.upfront);
  end if;

  return public.billing_admin_result(v_inv.tenant_id);
end;
$$;

revoke execute on function public.billing_admin_cancel_invoice(uuid, text) from public, anon;
grant execute on function public.billing_admin_cancel_invoice(uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';
