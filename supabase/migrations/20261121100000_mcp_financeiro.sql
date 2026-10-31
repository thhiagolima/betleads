-- MCP financeiro, fase 1 (docs/superpowers/specs/2026-10-30-mcp-financeiro-design.md).
--
-- Tabelas de base do servidor MCP remoto da área financeira: nível de acesso
-- por usuário, clientes/códigos/tokens OAuth, conexões, prévias de escrita
-- (preview antes de confirmar) e o log de chamadas. As tarefas seguintes
-- (resolução de acesso, fluxo OAuth, preview/confirmação e as tools em si)
-- só leem e escrevem aqui com `supabaseAdmin` (service_role); por isso RLS
-- fica ativo em todas e nenhum privilégio vai para `anon`/`authenticated`.
--
-- `mcp_access`: ausência de linha para o usuário = sem acesso ao MCP.
-- `mcp_call_log.connection_id` é nullable: ações feitas pelo admin (fora de
-- uma conexão MCP) também geram linha de log, sem conexão associada.
--
-- Idempotente.

-- ---------------------------------------------------------------------------
-- 1. Nível de acesso por usuário
-- ---------------------------------------------------------------------------

create table if not exists public.mcp_access (
  user_id uuid primary key,
  level text not null
    constraint mcp_access_level_check check (level in ('read', 'write')),
  granted_by uuid,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. OAuth: clientes, códigos de autorização, conexões e tokens
-- ---------------------------------------------------------------------------

create table if not exists public.mcp_oauth_clients (
  id text primary key,
  client_name text,
  redirect_uris text[] not null,
  created_at timestamptz not null default now()
);

create table if not exists public.mcp_auth_codes (
  code_hash text primary key,
  client_id text not null references public.mcp_oauth_clients(id),
  user_id uuid not null,
  redirect_uri text not null,
  code_challenge text not null,
  expires_at timestamptz not null,
  used_at timestamptz null
);

create table if not exists public.mcp_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  client_id text not null references public.mcp_oauth_clients(id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz null,
  revoked_at timestamptz null
);

create table if not exists public.mcp_tokens (
  token_hash text primary key,
  connection_id uuid not null references public.mcp_connections(id) on delete cascade,
  kind text not null
    constraint mcp_tokens_kind_check check (kind in ('access', 'refresh')),
  expires_at timestamptz not null,
  -- Marca um refresh token já girado (rotacionado); reuso é sinal de roubo.
  used_at timestamptz null
);

-- ---------------------------------------------------------------------------
-- 3. Prévia de escrita (preview antes de confirmar) e log de chamadas
-- ---------------------------------------------------------------------------

create table if not exists public.mcp_previews (
  code_hash text primary key,
  user_id uuid not null,
  connection_id uuid not null references public.mcp_connections(id),
  action text not null,
  tenant_id uuid not null,
  input jsonb not null,
  snapshot jsonb not null,
  expires_at timestamptz not null,
  confirmed_at timestamptz null,
  result jsonb null
);

create table if not exists public.mcp_call_log (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  -- Nullable: ações do admin fora de uma conexão MCP também logam aqui.
  connection_id uuid null,
  tool text not null,
  tenant_id uuid null,
  ok boolean not null,
  error text null,
  duration_ms int not null,
  preview_code_hash text null,
  created_at timestamptz not null default now()
);

create index if not exists mcp_call_log_connection_created_idx
  on public.mcp_call_log (connection_id, created_at);
create index if not exists mcp_call_log_user_tool_created_idx
  on public.mcp_call_log (user_id, tool, created_at);

-- ---------------------------------------------------------------------------
-- 4. RLS: ativa em todas, nenhum privilégio para anon/authenticated
-- ---------------------------------------------------------------------------

alter table public.mcp_access enable row level security;
alter table public.mcp_oauth_clients enable row level security;
alter table public.mcp_auth_codes enable row level security;
alter table public.mcp_connections enable row level security;
alter table public.mcp_tokens enable row level security;
alter table public.mcp_previews enable row level security;
alter table public.mcp_call_log enable row level security;

revoke all on public.mcp_access from anon, authenticated;
revoke all on public.mcp_oauth_clients from anon, authenticated;
revoke all on public.mcp_auth_codes from anon, authenticated;
revoke all on public.mcp_connections from anon, authenticated;
revoke all on public.mcp_tokens from anon, authenticated;
revoke all on public.mcp_previews from anon, authenticated;
revoke all on public.mcp_call_log from anon, authenticated;

grant all on public.mcp_access to service_role;
grant all on public.mcp_oauth_clients to service_role;
grant all on public.mcp_auth_codes to service_role;
grant all on public.mcp_connections to service_role;
grant all on public.mcp_tokens to service_role;
grant all on public.mcp_previews to service_role;
grant all on public.mcp_call_log to service_role;

grant usage, select on sequence public.mcp_call_log_id_seq to service_role;
