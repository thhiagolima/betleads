-- PG3 Task 10 — manual settlement with a payment date.
--
-- `billing_admin_manual_settle` (20261023100000, already applied in
-- production — that migration is never edited) takes a 4-arg signature with
-- no payment date, so every manual settle is recorded `paid_at = now()`.
-- This drops that exact signature and recreates the function with a 5th,
-- optional `_paid_at timestamptz default null`, passed straight through to
-- `billing_settle_invoice` (which already accepts `_paid_at` and clamps it
-- to `least(_paid_at, billing_now())`, so a future date can never slip in
-- even if a caller somehow bypassed the TS-side clamp). A null `_paid_at`
-- keeps today's behaviour (now()). The next due date is computed by
-- `billing_settle_invoice` from the (possibly past) payment day, so a house
-- settled while `locked_unpaid` with a past `_paid_at` restarts its cycle
-- from that day, not from today.
--
-- Grants are redone exactly as the original: revoke from public/anon, grant
-- to authenticated and service_role (the superadmin check stays inside
-- `billing_admin_lock_open_invoice`, via `is_super_admin()`).

drop function public.billing_admin_manual_settle(uuid, bigint, text, text);

create or replace function public.billing_admin_manual_settle(
  _invoice uuid,
  _paid_amount_cents bigint,
  _note text,
  _receipt text,
  _paid_at timestamptz default null
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
    v_inv.id, 'manual', coalesce(_paid_amount_cents, v_inv.amount_cents), _note, _receipt, null, _paid_at
  );

  return public.billing_admin_result(v_inv.tenant_id) || jsonb_build_object('invoice_id', v_inv.id);
end;
$$;

revoke execute on function public.billing_admin_manual_settle(uuid, bigint, text, text, timestamptz) from public, anon;
grant execute on function public.billing_admin_manual_settle(uuid, bigint, text, text, timestamptz) to authenticated, service_role;
