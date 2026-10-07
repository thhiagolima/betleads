insert into public.channel_consents (
  tenant_id, channel, subject, status, legal_basis, reason, source, occurred_at, created_at, updated_at
)
select
  tenant_id, channel, '55' || subject, status, legal_basis, reason, source, occurred_at, created_at, updated_at
from public.channel_consents
where channel in ('sms', 'voice') and length(subject) in (10, 11)
on conflict (tenant_id, channel, subject) do update set
  status = excluded.status,
  legal_basis = excluded.legal_basis,
  reason = excluded.reason,
  source = excluded.source,
  occurred_at = excluded.occurred_at,
  updated_at = excluded.updated_at;

delete from public.channel_consents
where channel in ('sms', 'voice') and length(subject) in (10, 11);
