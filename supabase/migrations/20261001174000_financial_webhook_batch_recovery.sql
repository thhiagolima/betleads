create or replace function public.record_financial_webhook_batch(p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  item record;
  processed integer := 0;
begin
  for item in
    select * from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(
      tenant_id uuid,
      player_id uuid,
      kind text,
      external_id text,
      event_id text,
      amount numeric,
      status text,
      provider_status text,
      method text,
      event_at timestamptz,
      payload jsonb
    )
  loop
    perform public.record_financial_webhook_event(
      item.tenant_id,
      item.player_id,
      item.kind,
      item.external_id,
      item.event_id,
      item.amount,
      item.status,
      item.provider_status,
      item.method,
      item.event_at,
      item.payload
    );
    processed := processed + 1;
  end loop;
  return processed;
end;
$$;

revoke all on function public.record_financial_webhook_batch(jsonb)
  from public, anon, authenticated;
grant execute on function public.record_financial_webhook_batch(jsonb)
  to service_role;
