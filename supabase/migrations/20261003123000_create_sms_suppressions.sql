-- Descadastros de SMS por tenant. O telefone e armazenado apenas em digitos,
-- no mesmo formato usado pelas filas de automacao.
create table if not exists public.sms_suppressions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  phone text not null check (phone ~ '^[0-9]{10,20}$'),
  reason text not null default 'opt_out',
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  unique (tenant_id, phone)
);

create index if not exists sms_suppressions_tenant_phone_idx
  on public.sms_suppressions (tenant_id, phone);

alter table public.sms_suppressions enable row level security;

-- A lista e manipulada exclusivamente por rotas/servicos autorizados.
revoke all on table public.sms_suppressions from anon, authenticated;
grant all on table public.sms_suppressions to service_role;
