-- A shared secret can be provisioned before the betting house starts signing.
-- Enforcement is an explicit second step so a credential rotation never drops
-- valid production webhooks during the provider cutover.
alter table public.tenants
  add column if not exists webhook_hmac_enforced boolean not null default false;

comment on column public.tenants.webhook_hmac_enforced is
  'When true, public tenant webhooks require x-webhook-signature HMAC SHA-256.';
