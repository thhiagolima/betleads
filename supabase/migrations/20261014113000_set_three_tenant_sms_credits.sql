-- Operational credit allocation requested for Sorte Alta, PixReals and
-- ForrandoBet. Set the final balance (rather than adding a fixed amount) and
-- preserve the adjustment in the accounting ledger.
do $$
declare
  target record;
  current_balance integer;
  adjustment integer;
  pricing jsonb;
  actor_id uuid;
  tenant_count integer;
  target_balance constant integer := 99999999;
begin
  select count(*)
    into tenant_count
  from public.tenants
  where slug in ('pixpgf', 'pixreals', 'forrandobet');

  if tenant_count <> 3 then
    raise exception 'Expected Sorte Alta, PixReals and ForrandoBet tenants, found %', tenant_count;
  end if;

  select journey.approved_by
    into actor_id
  from public.journeys journey
  join public.tenants tenant on tenant.id = journey.tenant_id
  where tenant.slug = 'pixpgf'
    and journey.approved_by is not null
  order by journey.activated_at desc nulls last
  limit 1;

  for target in
    select id, nome, slug
    from public.tenants
    where slug in ('pixpgf', 'pixreals', 'forrandobet')
    order by slug
  loop
    insert into public.tenant_sms_credit_balances (tenant_id)
    values (target.id)
    on conflict (tenant_id) do nothing;

    select balance_credits
      into current_balance
    from public.tenant_sms_credit_balances
    where tenant_id = target.id
    for update;

    adjustment := target_balance - current_balance;
    if adjustment = 0 then
      continue;
    end if;

    update public.tenant_sms_credit_balances
    set
      balance_credits = target_balance,
      lifetime_manual_credits = lifetime_manual_credits + adjustment,
      updated_at = now()
    where tenant_id = target.id;

    pricing := public.sms_effective_pricing(target.id);

    insert into public.sms_credit_ledger (
      tenant_id,
      delta_credits,
      balance_after,
      entry_type,
      reference_type,
      reference_id,
      idempotency_key,
      reason,
      unit_sale_price,
      provider_cost_per_sms,
      metadata,
      created_by
    ) values (
      target.id,
      adjustment,
      target_balance,
      'manual_adjustment',
      'admin_adjustment',
      'three-tenant-journey-activation-20261014',
      'set-three-tenant-sms-credits-20261014',
      'Saldo solicitado para ativacao das jornadas das tres casas',
      (pricing ->> 'sale_price_per_sms')::numeric,
      (pricing ->> 'provider_cost_per_sms')::numeric,
      jsonb_build_object(
        'requested_balance', target_balance,
        'previous_balance', current_balance,
        'tenant_slug', target.slug,
        'source', 'codex_operational_request'
      ),
      actor_id
    );
  end loop;
end
$$;
