-- Hide the SMS supplier cost (provider_cost_per_sms) from house users.
--
-- What Betleads pays the SMS supplier and the margin derived from it are for
-- the super admin only. The app already strips it on the server (phase 0 of the
-- redesign), but house users could still read it straight from PostgREST:
--   * sms_effective_pricing / sms_credit_summary (EXECUTE granted to authenticated)
--   * tenant_sms_pricing (SELECT policy for the current house)
--   * sms_credit_ledger.provider_cost_per_sms (SELECT policy for the current house)
--   * tenant_audit_logs before/after/metadata of pricing changes
--
-- Who still sees the cost: the super admin, the service role (the app server)
-- and database-internal callers without a JWT (auth.uid() is null). The credit
-- mutation (apply_sms_credit_mutation) only runs for the service role or the
-- super admin, so the ledger keeps recording the cost.

create or replace function public.sms_effective_pricing(_tenant uuid default current_tenant_id())
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_settings public.sms_credit_settings%rowtype;
  v_override public.tenant_sms_pricing%rowtype;
  v_result jsonb;
begin
  if _tenant is null
     or (
       not public.has_tenant_access(_tenant)
       and not public.is_super_admin()
       and auth.role() <> 'service_role'
     ) then
    raise exception 'forbidden';
  end if;

  select * into v_settings from public.sms_credit_settings where id = true;
  select * into v_override from public.tenant_sms_pricing where tenant_id = _tenant;

  v_result := jsonb_build_object(
    'tenant_id', _tenant,
    'sale_price_per_sms', coalesce(v_override.sale_price_per_sms, v_settings.default_sale_price_per_sms),
    'provider_cost_per_sms', coalesce(v_override.provider_cost_per_sms, v_settings.provider_cost_per_sms),
    'min_checkout_credits', v_settings.min_checkout_credits,
    'low_balance_threshold', v_settings.low_balance_threshold,
    'has_tenant_override', v_override.tenant_id is not null
  );

  -- A signed-in house user (any role but super admin) never gets the supplier cost.
  -- sms_credit_summary calls this function, so its nested pricing follows the same rule.
  if auth.uid() is not null and not public.is_super_admin() then
    v_result := v_result - 'provider_cost_per_sms';
  end if;

  return v_result;
end;
$function$;

-- Per-house price overrides carry the supplier cost: super admin only.
-- (The app reads this table with the service role.)
alter policy tenant_sms_pricing_tenant_select on public.tenant_sms_pricing
  using ((select public.is_super_admin()));

-- Audit rows of pricing and credit changes carry the cost in before/after/metadata.
-- House users see their audit trail through the app server, which redacts it.
alter policy tenant_audit_logs_tenant_select on public.tenant_audit_logs
  using ((select public.is_super_admin()));

-- The ledger records the cost per entry. House users keep reading their statement,
-- every column but the cost.
revoke select on public.sms_credit_ledger from anon, authenticated;
grant select (
  id, tenant_id, delta_credits, balance_after, entry_type, reference_type, reference_id,
  idempotency_key, reason, unit_sale_price, metadata, created_by, created_at
) on public.sms_credit_ledger to authenticated;
