-- Voz em lote e interação por tecla (DTMF) — base de dados
-- (escopo docs/ESCOPO_VOZ_LOTE_E_INTERACAO_DTMF_2026-11-11.md §4.2, itens
-- V1-03 e V1-04).
--
-- O QUE ESTA MIGRAÇÃO FAZ (aditiva; nada muda de comportamento até o app
-- passar a gravar nas tabelas novas)
--   1. voice_campaigns: a campanha de voz da casa passa a ser guardada
--      (antes só existiam itens em call_queue agrupados por trigger_name).
--      dispatch_mode 'cml' (ligação a ligação) ou 'bulk' (/tts/3/advanced);
--      configuração de tecla (dtmf_enabled, dtmf_max_digits, dtmf_timeout_s,
--      repeat_digit).
--   2. voice_campaign_batches: um registro por lote enviado à Infobip.
--      bulk_id único e determinístico (vc:<campanha>:<n>): reenviar o mesmo
--      lote usa o mesmo bulk_id e a Infobip recusa a duplicata.
--   3. call_queue (+colunas): voice_campaign_id, batch_id,
--      provider_message_id (único quando presente), dispatch_mode.
--      voice_campaign_id e batch_id apontam para a campanha/lote DA MESMA
--      CASA: FK composta (tenant_id, …) → (tenant_id, id), com
--      "on delete set null (coluna)" para não apagar o tenant_id do item.
--      O mesmo vale para voice_campaign_batches.campaign_id.
--   4. call_history (+colunas): provider_message_id, bulk_id, answered_by
--      ('human'|'machine'), dtmf_codes.
--   5. voice_dtmf_options: tecla → ação, por campanha ou por roteiro
--      (owner_type/owner_id, sem FK: o dono pode ser de duas tabelas).
--      Única por (tenant_id, owner_type, owner_id, digit). 'no_input' =
--      "não apertou nada" (D5).
--   6. voice_dtmf_responses: a tecla recebida numa ligação. Única por
--      call_history_id (uma resposta por ligação).
--   7. voice_dtmf_action_runs: fila de execução das ações. Única por
--      (response_id, option_id): uma ação nunca roda duas vezes.
--   8. voice_campaign_item_counts(uuid[], timestamptz): contadores da lista
--      de campanhas agregados no banco (security invoker: a RLS de
--      call_queue continua valendo).
--
-- RLS (mesma regra SA_OR_CUR das tabelas de canal, 20261015090000):
--   * voice_campaigns e voice_dtmf_options: membro da casa lê e grava
--     (como call_queue/call_history).
--   * voice_campaign_batches, voice_dtmf_responses, voice_dtmf_action_runs:
--     membro da casa só lê. Quem grava é o despachante, o webhook da
--     Infobip e o executor de ações (service_role, que ignora RLS): o REST
--     da casa não forja resposta de tecla nem enfileira ação.
--
-- ROLLBACK (manual)
--   drop function public.voice_campaign_item_counts(uuid[], timestamptz);
--   drop table public.voice_dtmf_action_runs, public.voice_dtmf_responses,
--     public.voice_dtmf_options;
--   drop index public.call_history_provider_message_idx;
--   alter table public.call_history drop column dtmf_codes,
--     drop column answered_by, drop column bulk_id,
--     drop column provider_message_id;
--   drop index public.call_queue_provider_message_uidx,
--     public.call_queue_voice_campaign_idx;
--   alter table public.call_queue drop column dispatch_mode,
--     drop column provider_message_id, drop column batch_id,
--     drop column voice_campaign_id;
--   drop table public.voice_campaign_batches, public.voice_campaigns;

set local lock_timeout = '5s';

-- ─── 1. voice_campaigns ─────────────────────────────────────────────────────

create table if not exists public.voice_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  dispatch_mode text not null default 'cml'
    check (dispatch_mode in ('cml', 'bulk')),
  voice_asset_id uuid references public.journey_voice_assets(id) on delete set null,
  script_id uuid references public.call_scripts(id) on delete set null,
  scheduled_at timestamptz,
  status text not null default 'scheduled'
    check (status in ('draft', 'scheduled', 'sending', 'paused', 'cancelled', 'finished')),
  recipient_count integer not null default 0,
  dtmf_enabled boolean not null default false,
  dtmf_max_digits smallint not null default 1 check (dtmf_max_digits between 1 and 10),
  dtmf_timeout_s smallint not null default 10 check (dtmf_timeout_s between 1 and 60),
  repeat_digit text check (repeat_digit ~ '^[0-9*]$'),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Alvo das FKs compostas (tenant_id, …): um item/lote só aponta para uma
  -- campanha da própria casa.
  constraint voice_campaigns_tenant_id_id_key unique (tenant_id, id)
);

create index if not exists voice_campaigns_tenant_created_idx
  on public.voice_campaigns (tenant_id, created_at desc);

drop trigger if exists set_updated_at_voice_campaigns on public.voice_campaigns;
create trigger set_updated_at_voice_campaigns
  before update on public.voice_campaigns
  for each row execute function public.set_updated_at();

alter table public.voice_campaigns enable row level security;
drop policy if exists voice_campaigns_tenant_rls on public.voice_campaigns;
create policy voice_campaigns_tenant_rls on public.voice_campaigns
  as permissive for all to authenticated
  using ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()))
  with check ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()));
revoke all on public.voice_campaigns from anon;
grant select, insert, update, delete on public.voice_campaigns to authenticated;
grant all on public.voice_campaigns to service_role;

-- ─── 2. voice_campaign_batches ──────────────────────────────────────────────

create table if not exists public.voice_campaign_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  campaign_id uuid not null,
  seq integer not null,
  bulk_id text not null unique,
  message_count integer not null default 0,
  destination_count integer not null default 0,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'unknown', 'failed', 'paused', 'cancelled', 'finished')),
  provider_response jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, seq),
  constraint voice_campaign_batches_tenant_id_id_key unique (tenant_id, id),
  -- Lote e campanha da mesma casa.
  constraint voice_campaign_batches_campaign_id_fkey foreign key (tenant_id, campaign_id)
    references public.voice_campaigns (tenant_id, id) on delete cascade
);

drop trigger if exists set_updated_at_voice_campaign_batches on public.voice_campaign_batches;
create trigger set_updated_at_voice_campaign_batches
  before update on public.voice_campaign_batches
  for each row execute function public.set_updated_at();

alter table public.voice_campaign_batches enable row level security;
drop policy if exists voice_campaign_batches_tenant_select on public.voice_campaign_batches;
create policy voice_campaign_batches_tenant_select on public.voice_campaign_batches
  as permissive for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()));
revoke all on public.voice_campaign_batches from anon, authenticated;
grant select on public.voice_campaign_batches to authenticated;
grant all on public.voice_campaign_batches to service_role;

-- ─── 3. call_queue (+colunas) ───────────────────────────────────────────────

alter table public.call_queue
  add column if not exists voice_campaign_id uuid,
  add column if not exists batch_id uuid,
  add column if not exists provider_message_id text,
  add column if not exists dispatch_mode text
    check (dispatch_mode in ('cml', 'bulk'));

-- FKs compostas: o item só aponta para campanha/lote da própria casa. Ao
-- apagar a campanha/lote, só a coluna de ligação vira null (o tenant_id do
-- item fica; "set null (coluna)" é do Postgres 15+).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'call_queue_voice_campaign_id_fkey'
      and conrelid = 'public.call_queue'::regclass
  ) then
    alter table public.call_queue
      add constraint call_queue_voice_campaign_id_fkey
      foreign key (tenant_id, voice_campaign_id)
      references public.voice_campaigns (tenant_id, id)
      on delete set null (voice_campaign_id);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'call_queue_batch_id_fkey'
      and conrelid = 'public.call_queue'::regclass
  ) then
    alter table public.call_queue
      add constraint call_queue_batch_id_fkey
      foreign key (tenant_id, batch_id)
      references public.voice_campaign_batches (tenant_id, id)
      on delete set null (batch_id);
  end if;
end $$;

create index if not exists call_queue_voice_campaign_idx
  on public.call_queue (voice_campaign_id) where voice_campaign_id is not null;
create unique index if not exists call_queue_provider_message_uidx
  on public.call_queue (provider_message_id) where provider_message_id is not null;

-- ─── 4. call_history (+colunas) ─────────────────────────────────────────────

alter table public.call_history
  add column if not exists provider_message_id text,
  add column if not exists bulk_id text,
  add column if not exists answered_by text
    check (answered_by in ('human', 'machine')),
  add column if not exists dtmf_codes text;

create index if not exists call_history_provider_message_idx
  on public.call_history (provider_message_id) where provider_message_id is not null;

-- ─── 5. voice_dtmf_options ──────────────────────────────────────────────────

create table if not exists public.voice_dtmf_options (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  owner_type text not null check (owner_type in ('campaign', 'script')),
  owner_id uuid not null,
  digit text not null
    check (digit in ('0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', 'no_input')),
  label text not null default '',
  action_type text not null
    check (action_type in (
      'send_sms', 'add_tag', 'add_to_list', 'enroll_journey',
      'revoke_voice_consent', 'outbound_webhook', 'transfer'
    )),
  action_config jsonb not null default '{}'::jsonb,
  position smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Por casa: o mesmo dono/tecla de outra casa nunca colide (nem vaza).
  unique (tenant_id, owner_type, owner_id, digit)
);

create index if not exists voice_dtmf_options_tenant_idx
  on public.voice_dtmf_options (tenant_id);

drop trigger if exists set_updated_at_voice_dtmf_options on public.voice_dtmf_options;
create trigger set_updated_at_voice_dtmf_options
  before update on public.voice_dtmf_options
  for each row execute function public.set_updated_at();

alter table public.voice_dtmf_options enable row level security;
drop policy if exists voice_dtmf_options_tenant_rls on public.voice_dtmf_options;
create policy voice_dtmf_options_tenant_rls on public.voice_dtmf_options
  as permissive for all to authenticated
  using ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()))
  with check ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()));
revoke all on public.voice_dtmf_options from anon;
grant select, insert, update, delete on public.voice_dtmf_options to authenticated;
grant all on public.voice_dtmf_options to service_role;

-- ─── 6. voice_dtmf_responses ────────────────────────────────────────────────

create table if not exists public.voice_dtmf_responses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  call_history_id uuid references public.call_history(id) on delete set null,
  call_queue_id uuid references public.call_queue(id) on delete set null,
  -- Nulo para campanha de lista de números (sem jogador).
  player_id uuid,
  phone text not null,
  digits text,
  matched_option_id uuid references public.voice_dtmf_options(id) on delete set null,
  received_via text not null check (received_via in ('report', 'cml')),
  received_at timestamptz not null default now()
);

-- Uma resposta por ligação.
create unique index if not exists voice_dtmf_responses_call_history_uidx
  on public.voice_dtmf_responses (call_history_id) where call_history_id is not null;
create index if not exists voice_dtmf_responses_tenant_received_idx
  on public.voice_dtmf_responses (tenant_id, received_at desc);
create index if not exists voice_dtmf_responses_call_queue_idx
  on public.voice_dtmf_responses (call_queue_id) where call_queue_id is not null;

alter table public.voice_dtmf_responses enable row level security;
drop policy if exists voice_dtmf_responses_tenant_select on public.voice_dtmf_responses;
create policy voice_dtmf_responses_tenant_select on public.voice_dtmf_responses
  as permissive for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()));
revoke all on public.voice_dtmf_responses from anon, authenticated;
grant select on public.voice_dtmf_responses to authenticated;
grant all on public.voice_dtmf_responses to service_role;

-- ─── 7. voice_dtmf_action_runs ──────────────────────────────────────────────

create table if not exists public.voice_dtmf_action_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  response_id uuid not null references public.voice_dtmf_responses(id) on delete cascade,
  option_id uuid references public.voice_dtmf_options(id) on delete set null,
  action_type text not null
    check (action_type in (
      'send_sms', 'add_tag', 'add_to_list', 'enroll_journey',
      'revoke_voice_consent', 'outbound_webhook', 'transfer'
    )),
  status text not null default 'pending'
    check (status in ('pending', 'done', 'failed', 'skipped')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Uma ação nunca roda duas vezes para a mesma resposta.
  unique (response_id, option_id)
);

create index if not exists voice_dtmf_action_runs_pending_idx
  on public.voice_dtmf_action_runs (status, next_attempt_at) where status = 'pending';
create index if not exists voice_dtmf_action_runs_tenant_idx
  on public.voice_dtmf_action_runs (tenant_id, created_at desc);

drop trigger if exists set_updated_at_voice_dtmf_action_runs on public.voice_dtmf_action_runs;
create trigger set_updated_at_voice_dtmf_action_runs
  before update on public.voice_dtmf_action_runs
  for each row execute function public.set_updated_at();

alter table public.voice_dtmf_action_runs enable row level security;
drop policy if exists voice_dtmf_action_runs_tenant_select on public.voice_dtmf_action_runs;
create policy voice_dtmf_action_runs_tenant_select on public.voice_dtmf_action_runs
  as permissive for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()));
revoke all on public.voice_dtmf_action_runs from anon, authenticated;
grant select on public.voice_dtmf_action_runs to authenticated;
grant all on public.voice_dtmf_action_runs to service_role;

-- ─── 8. voice_campaign_item_counts ──────────────────────────────────────────
-- Contadores da lista de campanhas (hub, atualiza a cada 30 s) agregados no
-- banco em vez de ler item a item: uma linha por (campanha, status,
-- provider_status, horário ainda à frente). sample_item_id é o id do item
-- quando o grupo tem exatamente um (o link "Relatório" de campanha de uma
-- ligação). security invoker: a RLS de call_queue vale para quem chama.

create or replace function public.voice_campaign_item_counts(
  p_campaign_ids uuid[],
  p_now timestamptz default now()
)
returns table (
  voice_campaign_id uuid,
  status text,
  provider_status text,
  is_future boolean,
  item_count bigint,
  sample_item_id uuid
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    q.voice_campaign_id,
    q.status::text,
    q.provider_status,
    coalesce(coalesce(q.scheduled_at, q.created_at) > p_now, false),
    count(*),
    case when count(*) = 1 then min(q.id::text)::uuid end
  from public.call_queue q
  where q.voice_campaign_id = any(p_campaign_ids)
  group by 1, 2, 3, 4
$$;

revoke all on function public.voice_campaign_item_counts(uuid[], timestamptz) from public, anon;
grant execute on function public.voice_campaign_item_counts(uuid[], timestamptz)
  to authenticated, service_role;
