-- Meta Ads, fase MB1: modelo multi-BM (docs/ESCOPO_META_MULTI_BM_2026-10-30.md,
-- seções 4 a 6; decisões D1, D2 e D4).
--
-- * D1: uma conexão por token (app_id + meta_user_id). A BM deixa de fazer parte
--   da identidade da conexão e vira atributo de cada conta (`business_id`/
--   `business_name` em `meta_ad_accounts`). `meta_connections.business_id` fica
--   (nullable, só informativo); conexões novas gravam null.
-- * D2: `meta_ad_account_access` (N:N conta × conexão). A conta continua
--   marcada enquanto houver pelo menos um acesso `active` por uma conexão
--   `connected`. `meta_ad_accounts.connection_id` passa a ser a conexão
--   PREFERIDA (o token que o worker tenta primeiro); continua NOT NULL com FK.
-- * D4: marcar contas cria um run `backfill` (90 dias, um job por conta). O
--   índice "um run ativo por casa" deixa de valer para backfill, que não bloqueia
--   nem é bloqueado pelo manual/agendado. O worker em TS quebra janelas > 30 dias
--   em blocos de 30.
-- * RPCs transacionais (só service_role): `meta_upsert_connection_accounts`,
--   `meta_connect_token`, `meta_select_accounts`, `meta_disconnect_connection`
--   e, para o worker, `meta_record_account_sync_success` e
--   `meta_revoke_account_access` (revogar sem pular a troca de preferência).
--   `meta_upsert_connection_accounts` também varre contas marcadas sem acesso
--   ativo por chave conectada (estados deixados por código antigo convergem).
-- * O reaper do `claim_meta_sync_jobs` também tira a conta de `syncing`.
-- * Cron `betleads-meta-sync-worker` reagendado com timeout de 55 s.
--   Mensagens de erro em português: o TS mostra `error.message` ao usuário.
--
-- Concorrência: toda RPC trava primeiro a(s) conexão(ões) e depois as contas
-- (sempre nessa ordem, contas por id), para que conectar o mesmo token duas vezes,
-- marcar contas enquanto uma chave é desconectada etc. se serializem sem deadlock.
--
-- Só mudanças aditivas (nenhuma coluna removida/renomeada): o código da MB0 em
-- produção continua funcionando nos minutos entre a migration e o deploy. Única
-- exceção de comportamento: o índice de identidade novo não aceita duas conexões
-- ativas do mesmo token em BMs diferentes (produção não tem nenhuma conexão por
-- token hoje).
--
-- Idempotente.

-- ---------------------------------------------------------------------------
-- 1. meta_connections: identidade por token
-- ---------------------------------------------------------------------------

drop index if exists public.meta_connections_system_identity_key;

create unique index if not exists meta_connections_token_identity_key
  on public.meta_connections (tenant_id, app_id, meta_user_id)
  where auth_type = 'system_user_token' and status <> 'disabled';

alter table public.meta_connections
  add column if not exists accounts_discovered_at timestamptz;

comment on column public.meta_connections.accounts_discovered_at is
  'Última vez que a lista de contas (/me/adaccounts) foi lida da Meta por esta conexão.';

comment on column public.meta_connections.business_id is
  'Legado (MB0): BM da conexão. Desde a MB1 a conexão é por token e a BM é atributo de cada conta; conexões novas gravam null.';

comment on column public.meta_ad_accounts.connection_id is
  'Conexão preferida: o token que o worker tenta primeiro. Os acessos reais ficam em meta_ad_account_access.';

-- ---------------------------------------------------------------------------
-- 2. meta_ad_account_access: quais tokens alcançam cada conta
-- ---------------------------------------------------------------------------

create table if not exists public.meta_ad_account_access (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  account_id uuid not null references public.meta_ad_accounts(id) on delete cascade,
  connection_id uuid not null references public.meta_connections(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'revoked')),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_error text,
  last_success_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, connection_id)
);

create index if not exists meta_ad_account_access_connection_idx
  on public.meta_ad_account_access (connection_id, status);

create index if not exists meta_ad_account_access_tenant_account_idx
  on public.meta_ad_account_access (tenant_id, account_id);

drop trigger if exists meta_ad_account_access_set_updated_at on public.meta_ad_account_access;
create trigger meta_ad_account_access_set_updated_at
  before update on public.meta_ad_account_access
  for each row execute function public.update_updated_at_column();

alter table public.meta_ad_account_access enable row level security;

-- Mesma expressão da MB0 (meta_ad_accounts_tenant_select): só leitura.
drop policy if exists meta_ad_account_access_tenant_select on public.meta_ad_account_access;
create policy meta_ad_account_access_tenant_select on public.meta_ad_account_access
  as permissive for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()));

revoke all on public.meta_ad_account_access from public, anon, authenticated;
grant select on public.meta_ad_account_access to authenticated;
grant all on public.meta_ad_account_access to service_role;

comment on table public.meta_ad_account_access is
  'N:N conta de anúncio × conexão Meta (token). active = o token alcança a conta; revoked = deixou de alcançar ou a conexão foi desconectada. Escrita só via service_role.';

-- Backfill: um acesso por conta existente, pela conexão atual dela. Conexão
-- desconectada => acesso revogado. A conexão legada fica como está.
insert into public.meta_ad_account_access (tenant_id, account_id, connection_id, status, revoked_at)
select account.tenant_id,
       account.id,
       account.connection_id,
       case when connection.status = 'disabled' then 'revoked' else 'active' end,
       case when connection.status = 'disabled' then now() else null end
from public.meta_ad_accounts account
join public.meta_connections connection on connection.id = account.connection_id
on conflict (account_id, connection_id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Backfill fora da regra "um run ativo por casa"
-- ---------------------------------------------------------------------------

drop index if exists public.meta_sync_runs_one_active_tenant;
create unique index meta_sync_runs_one_active_tenant
  on public.meta_sync_runs (tenant_id)
  where status in ('queued', 'running') and trigger_type <> 'backfill';

-- ---------------------------------------------------------------------------
-- 4. Auxiliares internos
-- ---------------------------------------------------------------------------
-- Trava transacional por casa, comum às quatro RPCs: além das travas de linha
-- (conexão FOR UPDATE/SHARE e depois contas), serializa as escritas de contas
-- Meta de uma mesma casa e evita deadlock entre operações de chaves diferentes
-- que alcançam as mesmas contas.

create or replace function public.meta_lock_tenant_accounts(p_tenant_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  select pg_advisory_xact_lock(hashtextextended('meta_ad_accounts:' || p_tenant_id::text, 0));
$$;

revoke execute on function public.meta_lock_tenant_accounts(uuid) from public, anon, authenticated;
grant execute on function public.meta_lock_tenant_accounts(uuid) to service_role;

-- Mover a preferência de contas que perderam o token.
-- Para cada conta de `p_account_ids` cuja conexão preferida está desconectada
-- ou não tem mais acesso `active` à conta: passa a preferir outro acesso
-- `active` numa conexão `connected` da mesma casa (a validada mais
-- recentemente). Se não houver nenhum, a conta sai da seleção com aviso.
-- Devolve {"moved": n, "stopped": n} (stopped = estava marcada e foi desmarcada).
-- Quem chama já deve ter travado a(s) conexão(ões) envolvida(s).

create or replace function public.meta_reassign_account_preference(
  p_tenant_id uuid,
  p_account_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account record;
  v_next uuid;
  v_moved integer := 0;
  v_stopped integer := 0;
begin
  if p_account_ids is null or cardinality(p_account_ids) = 0 then
    return jsonb_build_object('moved', 0, 'stopped', 0);
  end if;

  for v_account in
    select account.id, account.selected, account.connection_id
    from public.meta_ad_accounts account
    where account.tenant_id = p_tenant_id
      and account.id = any(p_account_ids)
      and (
        not exists (
          select 1
          from public.meta_ad_account_access access
          where access.account_id = account.id
            and access.connection_id = account.connection_id
            and access.status = 'active'
        )
        or exists (
          select 1
          from public.meta_connections connection
          where connection.id = account.connection_id
            and connection.status = 'disabled'
        )
      )
    order by account.id
    for update of account
  loop
    select access.connection_id
      into v_next
    from public.meta_ad_account_access access
    join public.meta_connections connection on connection.id = access.connection_id
    where access.account_id = v_account.id
      and access.status = 'active'
      and access.connection_id <> v_account.connection_id
      and connection.tenant_id = p_tenant_id
      and connection.status = 'connected'
    order by connection.token_validated_at desc nulls last, connection.id
    limit 1;

    if v_next is not null then
      update public.meta_ad_accounts
      set connection_id = v_next
      where id = v_account.id;
      v_moved := v_moved + 1;
    else
      update public.meta_ad_accounts
      set selected = false,
          sync_status = 'warning',
          last_error = 'Nenhuma chave conectada alcança esta conta.'
      where id = v_account.id;
      if v_account.selected then
        v_stopped := v_stopped + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('moved', v_moved, 'stopped', v_stopped);
end;
$$;

revoke execute on function public.meta_reassign_account_preference(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.meta_reassign_account_preference(uuid, uuid[]) to service_role;

comment on function public.meta_reassign_account_preference(uuid, uuid[]) is
  'Interno (MB1): move a conexão preferida das contas que perderam o token, ou as desmarca se nenhuma chave conectada as alcança. Só service_role.';

-- ---------------------------------------------------------------------------
-- 5. meta_upsert_connection_accounts: grava a lista de contas que um token alcança
-- ---------------------------------------------------------------------------
-- Usada por meta_connect_token, pelo "Testar acesso" e pela redescoberta diária.
-- p_accounts = [{meta_ad_account_id, account_id, name, business_id,
--   business_name, currency, timezone_name, account_status, raw}, ...]

create or replace function public.meta_upsert_connection_accounts(
  p_tenant_id uuid,
  p_connection_id uuid,
  p_accounts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
  v_new integer;
  v_businesses integer;
  v_revoked_ids uuid[];
  v_affected uuid[];
  v_stale uuid[];
begin
  perform public.meta_lock_tenant_accounts(p_tenant_id);

  perform 1
  from public.meta_connections connection
  where connection.id = p_connection_id
    and connection.tenant_id = p_tenant_id
    and connection.status <> 'disabled'
  for update;
  if not found then
    raise exception 'Conexão Meta não encontrada.';
  end if;

  if p_accounts is null or jsonb_typeof(p_accounts) <> 'array' then
    raise exception 'Lista de contas Meta inválida.';
  end if;

  -- Lista vazia (ou sem nenhum id válido) é problema da chave/da resposta da
  -- Meta, não "o token perdeu todas as contas": recusa sem revogar nada.
  if not exists (
    select 1
    from jsonb_array_elements(p_accounts) as item(value)
    where jsonb_typeof(item.value) = 'object'
      and nullif(btrim(item.value ->> 'meta_ad_account_id'), '') is not null
  ) then
    raise exception 'A Meta não devolveu nenhuma conta para esta chave.';
  end if;

  -- Contas: insere as novas (desmarcadas, preferindo esta conexão) e atualiza
  -- os dados descritivos das existentes sem mexer em `selected`.
  with input as (
    select distinct on (btrim(item.meta_ad_account_id))
           btrim(item.meta_ad_account_id) as meta_ad_account_id,
           item.account_id,
           item.name,
           item.business_id,
           item.business_name,
           item.currency,
           item.timezone_name,
           item.account_status,
           coalesce(item.raw, '{}'::jsonb) as raw
    from jsonb_to_recordset(p_accounts) as item(
      meta_ad_account_id text,
      account_id text,
      name text,
      business_id text,
      business_name text,
      currency text,
      timezone_name text,
      account_status integer,
      raw jsonb
    )
    where nullif(btrim(item.meta_ad_account_id), '') is not null
    order by btrim(item.meta_ad_account_id)
  ),
  upserted as (
    insert into public.meta_ad_accounts as account (
      tenant_id, connection_id, meta_ad_account_id, account_id, name, business_id,
      business_name, currency, timezone_name, account_status, raw, selected
    )
    select p_tenant_id, p_connection_id, input.meta_ad_account_id, input.account_id,
           input.name, input.business_id, input.business_name, input.currency,
           input.timezone_name, input.account_status, input.raw, false
    from input
    on conflict (tenant_id, meta_ad_account_id) do update
    set account_id = coalesce(excluded.account_id, account.account_id),
        name = coalesce(excluded.name, account.name),
        business_id = coalesce(excluded.business_id, account.business_id),
        business_name = coalesce(excluded.business_name, account.business_name),
        currency = coalesce(excluded.currency, account.currency),
        timezone_name = coalesce(excluded.timezone_name, account.timezone_name),
        account_status = coalesce(excluded.account_status, account.account_status),
        raw = excluded.raw
    returning account.id, (account.xmax = 0) as inserted, account.business_id
  )
  select coalesce(array_agg(upserted.id), '{}'::uuid[]),
         count(*) filter (where upserted.inserted)::integer,
         count(distinct coalesce(upserted.business_id, '∅'))::integer
    into v_ids, v_new, v_businesses
  from upserted;

  -- Acessos das contas listadas: ativos.
  insert into public.meta_ad_account_access as access (
    tenant_id, account_id, connection_id, status, last_seen_at, revoked_at, last_error
  )
  select p_tenant_id, listed.id, p_connection_id, 'active', now(), null, null
  from unnest(v_ids) as listed(id)
  on conflict (account_id, connection_id) do update
  set status = 'active',
      revoked_at = null,
      last_seen_at = now(),
      last_error = null;

  -- Contas listadas cuja preferida está fora do ar (desconectada/erro) ou não
  -- alcança mais a conta passam a preferir esta conexão.
  update public.meta_ad_accounts account
  set connection_id = p_connection_id
  from public.meta_connections preferred
  where account.id = any(v_ids)
    and preferred.id = account.connection_id
    and account.connection_id <> p_connection_id
    and (
      preferred.status in ('disabled', 'error')
      or not exists (
        select 1
        from public.meta_ad_account_access access
        where access.account_id = account.id
          and access.connection_id = account.connection_id
          and access.status = 'active'
      )
    );

  -- O aviso "nenhuma chave" deixa de valer para conta alcançada de novo (ela
  -- continua desmarcada: marcar é decisão da casa).
  update public.meta_ad_accounts account
  set last_error = null,
      sync_status = case when account.last_success_at is null then 'never' else 'healthy' end
  where account.id = any(v_ids)
    and account.sync_status = 'warning'
    and account.last_error = 'Nenhuma chave conectada alcança esta conta.';

  -- Acessos desta conexão a contas que não vieram na lista: revogados.
  with revoked as (
    update public.meta_ad_account_access access
    set status = 'revoked',
        revoked_at = now(),
        last_error = 'A chave não alcança mais esta conta.'
    where access.connection_id = p_connection_id
      and access.status = 'active'
      and not (access.account_id = any(v_ids))
    returning access.account_id
  )
  select coalesce(array_agg(revoked.account_id), '{}'::uuid[])
    into v_revoked_ids
  from revoked;

  -- Contas que preferiam esta conexão e perderam o acesso por ela.
  select coalesce(array_agg(account.id), '{}'::uuid[])
    into v_affected
  from public.meta_ad_accounts account
  where account.id = any(v_revoked_ids)
    and account.connection_id = p_connection_id;
  perform public.meta_reassign_account_preference(p_tenant_id, v_affected);

  -- Varredura: conta marcada da casa sem nenhum acesso `active` por conexão
  -- `connected` (estado deixado por código/caminhos antigos) passa pela mesma
  -- troca de preferência. A própria meta_reassign_account_preference só mexe
  -- em quem tem a preferida desconectada ou sem acesso ativo; conta com acesso
  -- ativo por chave conectada nem entra na lista.
  select coalesce(array_agg(account.id order by account.id), '{}'::uuid[])
    into v_stale
  from public.meta_ad_accounts account
  where account.tenant_id = p_tenant_id
    and account.selected
    and not exists (
      select 1
      from public.meta_ad_account_access access
      join public.meta_connections connection on connection.id = access.connection_id
      where access.account_id = account.id
        and access.status = 'active'
        and connection.tenant_id = p_tenant_id
        and connection.status = 'connected'
    );
  perform public.meta_reassign_account_preference(p_tenant_id, v_stale);

  update public.meta_connections
  set accounts_discovered_at = now()
  where id = p_connection_id;

  return jsonb_build_object(
    'accounts_total', cardinality(v_ids),
    'accounts_new', v_new,
    'accounts_revoked', cardinality(v_revoked_ids),
    'businesses', v_businesses
  );
end;
$$;

revoke execute on function public.meta_upsert_connection_accounts(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.meta_upsert_connection_accounts(uuid, uuid, jsonb) to service_role;

comment on function public.meta_upsert_connection_accounts(uuid, uuid, jsonb) is
  'MB1: grava as contas que um token alcança (contas, acessos, revogações e troca de preferência) numa transação. Só service_role.';

-- ---------------------------------------------------------------------------
-- 6. meta_connect_token: conectar (ou trocar a chave de) um Usuário do Sistema
-- ---------------------------------------------------------------------------
-- p_connection = {meta_user_id, meta_user_name, app_id, app_name,
--   encrypted_access_token, token_hint, scopes (array), label}

create or replace function public.meta_connect_token(
  p_tenant_id uuid,
  p_actor uuid,
  p_connection jsonb,
  p_accounts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app_id text := nullif(btrim(p_connection ->> 'app_id'), '');
  v_meta_user_id text := nullif(btrim(p_connection ->> 'meta_user_id'), '');
  v_token text := nullif(p_connection ->> 'encrypted_access_token', '');
  v_label text := nullif(btrim(p_connection ->> 'label'), '');
  v_scopes text[];
  v_connection_id uuid;
  v_created boolean := false;
  v_attempt integer := 0;
  v_counts jsonb;
  v_selected integer;
begin
  if p_tenant_id is null or v_app_id is null or v_meta_user_id is null then
    raise exception 'Dados da conexão Meta incompletos.';
  end if;
  if v_token is null then
    raise exception 'Chave de acesso Meta ausente.';
  end if;
  if p_actor is null then
    raise exception 'Usuário responsável pela conexão não informado.';
  end if;

  perform public.meta_lock_tenant_accounts(p_tenant_id);

  v_scopes := case
    when jsonb_typeof(p_connection -> 'scopes') = 'array'
      then array(select jsonb_array_elements_text(p_connection -> 'scopes'))
    else '{}'::text[]
  end;

  -- Mesma chave (app + Usuário do Sistema): atualiza a conexão ativa travada;
  -- senão cria. Duas chamadas simultâneas: a segunda cai no ON CONFLICT e na
  -- volta do laço encontra (e espera) a linha da primeira.
  loop
    v_attempt := v_attempt + 1;

    select connection.id
      into v_connection_id
    from public.meta_connections connection
    where connection.tenant_id = p_tenant_id
      and connection.auth_type = 'system_user_token'
      and connection.status <> 'disabled'
      and connection.app_id = v_app_id
      and connection.meta_user_id = v_meta_user_id
    for update;

    if v_connection_id is not null then
      update public.meta_connections
      set encrypted_access_token = v_token,
          access_token = null,
          token_hint = p_connection ->> 'token_hint',
          scopes = v_scopes,
          meta_user_name = coalesce(p_connection ->> 'meta_user_name', meta_user_name),
          app_name = coalesce(p_connection ->> 'app_name', app_name),
          connection_label = coalesce(v_label, connection_label),
          status = 'connected',
          token_validated_at = now(),
          permissions_checked_at = now(),
          connected_at = now(),
          last_error = null,
          connected_by_user_id = p_actor
      where id = v_connection_id;
      v_created := false;
      exit;
    end if;

    insert into public.meta_connections (
      tenant_id, connected_by_user_id, auth_type, meta_user_id, meta_user_name,
      app_id, app_name, business_id, encrypted_access_token, access_token, token_hint,
      scopes, connection_label, status, token_validated_at, permissions_checked_at,
      connected_at, last_error
    )
    values (
      p_tenant_id, p_actor, 'system_user_token', v_meta_user_id,
      p_connection ->> 'meta_user_name', v_app_id, p_connection ->> 'app_name', null,
      v_token, null, p_connection ->> 'token_hint', v_scopes, v_label, 'connected',
      now(), now(), now(), null
    )
    on conflict (tenant_id, app_id, meta_user_id)
      where auth_type = 'system_user_token' and status <> 'disabled'
      do nothing
    returning id into v_connection_id;

    if v_connection_id is not null then
      v_created := true;
      exit;
    end if;

    if v_attempt >= 3 then
      raise exception 'Não foi possível gravar a conexão Meta. Tente novamente.';
    end if;
  end loop;

  v_counts := public.meta_upsert_connection_accounts(p_tenant_id, v_connection_id, coalesce(p_accounts, '[]'::jsonb));

  insert into public.meta_connection_audit (tenant_id, connection_id, actor_user_id, action, metadata)
  values
    (p_tenant_id, v_connection_id, p_actor,
     case when v_created then 'connected' else 'token_replaced' end,
     jsonb_build_object('app_id', v_app_id)),
    (p_tenant_id, v_connection_id, p_actor, 'accounts_discovered', v_counts);

  select count(*)::integer
    into v_selected
  from public.meta_ad_accounts account
  join public.meta_ad_account_access access
    on access.account_id = account.id
   and access.connection_id = v_connection_id
   and access.status = 'active'
  where account.tenant_id = p_tenant_id
    and account.selected;

  insert into public.marketing_integrations as integration (
    tenant_id, provider, external_account_id, account_name, status, settings, connected_at
  )
  values (
    p_tenant_id, 'meta', 'meta:' || v_app_id || ':' || v_meta_user_id,
    coalesce(v_label, p_connection ->> 'app_name', 'Meta Ads'), 'configured',
    jsonb_build_object(
      'connection_id', v_connection_id,
      'app_id', v_app_id,
      'discovered_accounts', (v_counts ->> 'accounts_total')::integer,
      'selected_accounts', v_selected
    ),
    now()
  )
  on conflict (tenant_id, provider, external_account_id) do update
  set account_name = excluded.account_name,
      status = 'configured',
      settings = coalesce(integration.settings, '{}'::jsonb) || excluded.settings,
      connected_at = excluded.connected_at;

  return jsonb_build_object('connection_id', v_connection_id, 'created', v_created) || v_counts;
end;
$$;

revoke execute on function public.meta_connect_token(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.meta_connect_token(uuid, uuid, jsonb, jsonb) to service_role;

comment on function public.meta_connect_token(uuid, uuid, jsonb, jsonb) is
  'MB1: conecta ou troca a chave de um Usuário do Sistema (conexão, contas, acessos, auditoria e marketing_integrations numa transação). Só service_role.';

-- ---------------------------------------------------------------------------
-- 7. meta_select_accounts: seleção com diff e backfill
-- ---------------------------------------------------------------------------

create or replace function public.meta_select_accounts(
  p_tenant_id uuid,
  p_actor uuid,
  p_account_ids uuid[],
  p_backfill_days integer default 90
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
  v_days integer := coalesce(p_backfill_days, 90);
  v_added uuid[];
  v_removed uuid[];
  v_invalid integer;
  v_run_id uuid;
  v_selected integer;
begin
  if v_days < 1 or v_days > 90 then
    raise exception 'Período de leitura inicial inválido (1 a 90 dias).';
  end if;

  perform public.meta_lock_tenant_accounts(p_tenant_id);

  select coalesce(array_agg(distinct id), '{}'::uuid[])
    into v_ids
  from unnest(coalesce(p_account_ids, '{}'::uuid[])) as input(id)
  where id is not null;

  -- Ordem de travas: conexões (FOR SHARE: um desconectar em andamento termina
  -- antes) e depois as contas da casa.
  perform 1
  from public.meta_connections connection
  where connection.tenant_id = p_tenant_id
    and connection.status <> 'disabled'
  order by connection.id
  for share;

  perform 1
  from public.meta_ad_accounts account
  where account.tenant_id = p_tenant_id
  order by account.id
  for update;

  -- Toda conta da lista é da casa. Conta que entra na seleção precisa de pelo
  -- menos um acesso ativo por uma conexão conectada da casa; conta que já estava
  -- marcada pode continuar (ex.: a chave dela está em erro temporário).
  select count(*)::integer
    into v_invalid
  from unnest(v_ids) as input(id)
  where not exists (
    select 1
    from public.meta_ad_accounts account
    where account.id = input.id
      and account.tenant_id = p_tenant_id
      and (
        account.selected
        or exists (
          select 1
          from public.meta_ad_account_access access
          join public.meta_connections connection on connection.id = access.connection_id
          where access.account_id = account.id
            and access.status = 'active'
            and connection.tenant_id = p_tenant_id
            and connection.status = 'connected'
        )
      )
  );
  if v_invalid > 0 then
    raise exception 'Uma das contas selecionadas não pertence à sua operação.';
  end if;

  select coalesce(array_agg(account.id order by account.id), '{}'::uuid[])
    into v_added
  from public.meta_ad_accounts account
  where account.tenant_id = p_tenant_id
    and account.id = any(v_ids)
    and not account.selected;

  select coalesce(array_agg(account.id order by account.id), '{}'::uuid[])
    into v_removed
  from public.meta_ad_accounts account
  where account.tenant_id = p_tenant_id
    and account.selected
    and not (account.id = any(v_ids));

  update public.meta_ad_accounts
  set selected = true,
      sync_status = 'queued',
      last_error = null
  where id = any(v_added);

  update public.meta_ad_accounts
  set selected = false
  where id = any(v_removed);

  -- D4: leitura inicial das contas recém-marcadas (casa demo não sincroniza).
  if cardinality(v_added) > 0 and not public.is_demo_tenant(p_tenant_id) then
    insert into public.meta_sync_runs (
      tenant_id, requested_by_user_id, trigger_type, days, status, total_accounts
    )
    values (p_tenant_id, p_actor, 'backfill', v_days, 'queued', cardinality(v_added))
    returning id into v_run_id;

    insert into public.meta_sync_jobs (run_id, tenant_id, account_id, days)
    select v_run_id, p_tenant_id, added.id, v_days
    from unnest(v_added) as added(id);
  end if;

  -- Auditoria por conexão preferida das contas alteradas.
  insert into public.meta_connection_audit (tenant_id, connection_id, actor_user_id, action, metadata)
  select p_tenant_id,
         account.connection_id,
         p_actor,
         'accounts_selected',
         jsonb_build_object(
           'added', count(*) filter (where account.id = any(v_added)),
           'removed', count(*) filter (where account.id = any(v_removed))
         )
  from public.meta_ad_accounts account
  where account.id = any(v_added) or account.id = any(v_removed)
  group by account.connection_id;

  -- settings.selected_accounts de cada integração Meta da casa ligada a uma conexão.
  update public.marketing_integrations integration
  set settings = jsonb_set(
    coalesce(integration.settings, '{}'::jsonb),
    '{selected_accounts}',
    to_jsonb((
      select count(*)::integer
      from public.meta_ad_accounts account
      join public.meta_ad_account_access access
        on access.account_id = account.id
       and access.status = 'active'
      where account.tenant_id = p_tenant_id
        and account.selected
        and access.connection_id::text = integration.settings ->> 'connection_id'
    ))
  )
  where integration.tenant_id = p_tenant_id
    and integration.provider = 'meta'
    and integration.settings ? 'connection_id';

  select count(*)::integer
    into v_selected
  from public.meta_ad_accounts account
  where account.tenant_id = p_tenant_id
    and account.selected;

  return jsonb_build_object(
    'selected', v_selected,
    'added', cardinality(v_added),
    'removed', cardinality(v_removed),
    'backfill_run_id', v_run_id
  );
end;
$$;

revoke execute on function public.meta_select_accounts(uuid, uuid, uuid[], integer) from public, anon, authenticated;
grant execute on function public.meta_select_accounts(uuid, uuid, uuid[], integer) to service_role;

comment on function public.meta_select_accounts(uuid, uuid, uuid[], integer) is
  'MB1: aplica a seleção de contas (diff), cria o run de backfill das contas novas e audita, numa transação. Só service_role.';

-- ---------------------------------------------------------------------------
-- 8. meta_disconnect_connection
-- ---------------------------------------------------------------------------

create or replace function public.meta_disconnect_connection(
  p_tenant_id uuid,
  p_actor uuid,
  p_connection_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection public.meta_connections%rowtype;
  v_preferring uuid[];
  v_result jsonb;
begin
  perform public.meta_lock_tenant_accounts(p_tenant_id);

  select *
    into v_connection
  from public.meta_connections connection
  where connection.id = p_connection_id
    and connection.tenant_id = p_tenant_id
    and connection.status <> 'disabled'
  for update;
  if not found then
    raise exception 'Conexão Meta não encontrada.';
  end if;

  update public.meta_connections
  set status = 'disabled',
      encrypted_access_token = null,
      access_token = null,
      disabled_at = now(),
      disabled_by_user_id = p_actor,
      last_error = null
  where id = p_connection_id;

  update public.meta_ad_account_access
  set status = 'revoked',
      revoked_at = now(),
      last_error = 'Chave desconectada.'
  where connection_id = p_connection_id
    and status = 'active';

  select coalesce(array_agg(account.id), '{}'::uuid[])
    into v_preferring
  from public.meta_ad_accounts account
  where account.tenant_id = p_tenant_id
    and account.connection_id = p_connection_id;

  v_result := public.meta_reassign_account_preference(p_tenant_id, v_preferring);

  insert into public.meta_connection_audit (tenant_id, connection_id, actor_user_id, action, metadata)
  values (
    p_tenant_id, p_connection_id, p_actor, 'disabled',
    jsonb_build_object(
      'accounts_moved', (v_result ->> 'moved')::integer,
      'accounts_stopped', (v_result ->> 'stopped')::integer
    )
  );

  -- 'disabled' é aceito pelo check de marketing_integrations.status.
  update public.marketing_integrations integration
  set status = 'disabled',
      settings = jsonb_set(coalesce(integration.settings, '{}'::jsonb), '{selected_accounts}', '0'::jsonb)
  where integration.tenant_id = p_tenant_id
    and integration.provider = 'meta'
    and (
      integration.settings ->> 'connection_id' = p_connection_id::text
      or (
        v_connection.app_id is not null
        and integration.external_account_id = 'meta:' || v_connection.app_id || ':' || v_connection.meta_user_id
      )
    );

  return jsonb_build_object(
    'accounts_moved', (v_result ->> 'moved')::integer,
    'accounts_stopped', (v_result ->> 'stopped')::integer
  );
end;
$$;

revoke execute on function public.meta_disconnect_connection(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.meta_disconnect_connection(uuid, uuid, uuid) to service_role;

comment on function public.meta_disconnect_connection(uuid, uuid, uuid) is
  'MB1: desconecta uma chave (apaga o token, revoga acessos, move a preferência ou desmarca contas) numa transação. Só service_role.';

-- ---------------------------------------------------------------------------
-- 9. meta_record_account_sync_success: sucesso do worker sem ressuscitar chave
-- ---------------------------------------------------------------------------
-- O worker sincronizou a conta `p_account_id` com o token da conexão
-- `p_connection_id`. Só grava (acesso, preferência da conta e saúde da conexão)
-- se, sob a trava da casa, o acesso continuar `active` e a conexão `connected`:
-- se a chave foi desconectada (ou perdeu a conta) durante a sincronização, nada
-- muda e a função devolve false. Nunca altera o status da conexão.

create or replace function public.meta_record_account_sync_success(
  p_tenant_id uuid,
  p_account_id uuid,
  p_connection_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.meta_lock_tenant_accounts(p_tenant_id);

  perform 1
  from public.meta_connections connection
  join public.meta_ad_account_access access
    on access.connection_id = connection.id
   and access.account_id = p_account_id
   and access.status = 'active'
  join public.meta_ad_accounts account
    on account.id = access.account_id
   and account.tenant_id = p_tenant_id
  where connection.id = p_connection_id
    and connection.tenant_id = p_tenant_id
    and connection.status = 'connected'
  for update of connection, access, account;
  if not found then
    return false;
  end if;

  update public.meta_ad_account_access
  set last_success_at = now(),
      last_error = null
  where account_id = p_account_id
    and connection_id = p_connection_id;

  update public.meta_ad_accounts
  set connection_id = p_connection_id
  where id = p_account_id
    and tenant_id = p_tenant_id
    and connection_id is distinct from p_connection_id;

  update public.meta_connections
  set last_sync_at = now(),
      last_error = null
  where id = p_connection_id;

  return true;
end;
$$;

revoke execute on function public.meta_record_account_sync_success(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.meta_record_account_sync_success(uuid, uuid, uuid) to service_role;

comment on function public.meta_record_account_sync_success(uuid, uuid, uuid) is
  'MB1: registra o sucesso do worker numa conta por uma conexão (acesso, conexão preferida, saúde da conexão) só se o acesso segue active e a conexão connected; devolve se aplicou. Só service_role.';

-- ---------------------------------------------------------------------------
-- 9b. meta_revoke_account_access: o worker descobriu que um token não alcança
--     mais uma conta (erro de permissão da conta)
-- ---------------------------------------------------------------------------
-- Sob a trava da casa: se o acesso (conta, conexão, casa) está `active`, vira
-- `revoked` com o erro; se a conta preferia essa conexão (ou ficou sem nenhum
-- acesso ativo), a preferência é movida ou a conta sai da seleção com aviso
-- (meta_reassign_account_preference). Acesso já revogado/inexistente: nada muda.
-- Devolve {"revoked": bool, "moved": n, "stopped": n}.

create or replace function public.meta_revoke_account_access(
  p_tenant_id uuid,
  p_account_id uuid,
  p_connection_id uuid,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_access_id uuid;
  v_reassign jsonb := jsonb_build_object('moved', 0, 'stopped', 0);
begin
  perform public.meta_lock_tenant_accounts(p_tenant_id);

  select access.id
    into v_access_id
  from public.meta_ad_account_access access
  join public.meta_ad_accounts account
    on account.id = access.account_id
   and account.tenant_id = p_tenant_id
  where access.account_id = p_account_id
    and access.connection_id = p_connection_id
    and access.tenant_id = p_tenant_id
    and access.status = 'active'
  for update of access;

  if v_access_id is null then
    return jsonb_build_object('revoked', false, 'moved', 0, 'stopped', 0);
  end if;

  update public.meta_ad_account_access
  set status = 'revoked',
      revoked_at = now(),
      last_error = coalesce(nullif(btrim(p_error), ''), 'A chave não alcança mais esta conta.')
  where id = v_access_id;

  if exists (
    select 1
    from public.meta_ad_accounts account
    where account.id = p_account_id
      and account.tenant_id = p_tenant_id
      and (
        account.connection_id = p_connection_id
        or not exists (
          select 1
          from public.meta_ad_account_access access
          where access.account_id = account.id
            and access.status = 'active'
        )
      )
  ) then
    v_reassign := public.meta_reassign_account_preference(p_tenant_id, array[p_account_id]);
  end if;

  return jsonb_build_object(
    'revoked', true,
    'moved', (v_reassign ->> 'moved')::integer,
    'stopped', (v_reassign ->> 'stopped')::integer
  );
end;
$$;

revoke execute on function public.meta_revoke_account_access(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.meta_revoke_account_access(uuid, uuid, uuid, text) to service_role;

comment on function public.meta_revoke_account_access(uuid, uuid, uuid, text) is
  'MB1: revoga o acesso de uma conexão a uma conta (erro de permissão no worker) e move a preferência ou desmarca a conta se nenhuma chave conectada a alcança. Só service_role.';

-- ---------------------------------------------------------------------------
-- 10. claim_meta_sync_jobs: o reaper também tira a conta de `syncing`
--     base: 20261116100000_meta_mb0_hardening.sql (mesma assinatura, grants,
--     filtros de casa demo/bloqueada e reaper; só acrescenta o update da conta)
-- ---------------------------------------------------------------------------

create or replace function public.claim_meta_sync_jobs(
  p_limit integer default 2,
  p_worker_id text default null
)
returns setof public.meta_sync_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_ids uuid[];
  v_run_id uuid;
begin
  -- Reaper: lock vencido na última tentativa vira falha definitiva. Vale para
  -- qualquer casa (inclusive demo/suspensa): destrava o run e tira a conta de
  -- `syncing` (senão ela ficaria "sincronizando" para sempre).
  with stale as (
    select job.id
    from public.meta_sync_jobs job
    where job.status = 'running'
      and job.locked_at < now() - interval '10 minutes'
      and job.attempt_count >= job.max_attempts
    for update skip locked
  ),
  reaped as (
    update public.meta_sync_jobs job
    set status = 'failed',
        last_error = 'Tempo esgotado: o processamento da conta foi interrompido.',
        finished_at = now(),
        locked_at = null
    from stale
    where job.id = stale.id
    returning job.run_id, job.account_id, job.last_error
  ),
  reaped_accounts as (
    update public.meta_ad_accounts account
    set sync_status = 'error',
        last_error = reaped.last_error
    from reaped
    where account.id = reaped.account_id
    returning account.id
  )
  select array_agg(distinct reaped.run_id) into v_run_ids from reaped;

  if v_run_ids is not null then
    foreach v_run_id in array v_run_ids loop
      perform public.refresh_meta_sync_run(v_run_id);
    end loop;
  end if;

  return query
  with candidates as (
    select job.id
    from public.meta_sync_jobs job
    where (
      (job.status in ('queued', 'retry') and job.next_attempt_at <= now())
      or (job.status = 'running' and job.locked_at < now() - interval '10 minutes')
    )
      and job.attempt_count < job.max_attempts
      and not public.is_demo_tenant(job.tenant_id)
      and not exists (
        select 1
        from public.tenants t
        where t.id = job.tenant_id
          and t.status in ('suspended', 'canceled')
      )
      and not exists (
        select 1
        from public.tenant_billing tb
        where tb.tenant_id = job.tenant_id
          and tb.access_state in ('frozen', 'locked_manual')
      )
    order by job.next_attempt_at, job.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 2), 10))
  )
  update public.meta_sync_jobs job
  set status = 'running',
      attempt_count = job.attempt_count + 1,
      locked_at = now(),
      worker_id = coalesce(p_worker_id, gen_random_uuid()::text),
      started_at = coalesce(job.started_at, now()),
      last_error = null
  from candidates
  where job.id = candidates.id
  returning job.*;
end;
$$;

revoke execute on function public.claim_meta_sync_jobs(integer, text) from public, anon, authenticated;
grant execute on function public.claim_meta_sync_jobs(integer, text) to service_role;

-- ---------------------------------------------------------------------------
-- 11. Cron do worker com timeout de 55 s
--     base: 20261003153000_schedule_meta_sync_worker.sql (o pg_net usava o
--     padrão de 5 s e abortava o tick); mesmo formato dos outros crons, ex.
--     20261021100100_tenant_domains_verify_cron.sql
-- ---------------------------------------------------------------------------

do $$
declare
  v_job record;
begin
  for v_job in
    select jobid from cron.job where jobname = 'betleads-meta-sync-worker'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule('betleads-meta-sync-worker', '*/5 * * * *', $job$
  select net.http_post(
    url := 'https://betleads.io/api/public/meta-sync/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization',
      'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'betleads_cron_secret'
        limit 1
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
$job$);

notify pgrst, 'reload schema';
