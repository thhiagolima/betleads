alter table public.meta_connections
  alter column access_token drop not null,
  add column if not exists auth_type text not null default 'legacy_oauth'
    check (auth_type in ('legacy_oauth', 'system_user_token')),
  add column if not exists encrypted_access_token text,
  add column if not exists token_hint text,
  add column if not exists token_validated_at timestamptz,
  add column if not exists data_access_expires_at timestamptz,
  add column if not exists app_id text,
  add column if not exists business_id text;

comment on column public.meta_connections.encrypted_access_token is
  'AES-GCM encrypted Meta token. Server-only; never expose through authenticated APIs.';
comment on column public.meta_connections.auth_type is
  'legacy_oauth for the former shared CRM app; system_user_token for customer-owned Meta apps.';
