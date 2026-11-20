-- API de leitura (docs/superpowers/specs/2026-11-20-api-leitura-design.md).
-- Chaves de API por pessoa (só o hash fica no banco) e a coluna api_key_id no
-- log de chamadas do MCP, que a API também usa. Idempotente.

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  nome text not null check (char_length(nome) between 1 and 80),
  prefixo text not null,
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz null,
  revoked_at timestamptz null
);

create index if not exists api_keys_user_idx on public.api_keys (user_id);

alter table public.api_keys enable row level security;
revoke all on public.api_keys from anon, authenticated;
grant all on public.api_keys to service_role;

alter table public.mcp_call_log add column if not exists api_key_id uuid null;
create index if not exists mcp_call_log_api_key_created_idx
  on public.mcp_call_log (api_key_id, created_at)
  where api_key_id is not null;

notify pgrst, 'reload schema';
