-- Meta Ads, fase MB2: sincronização robusta (docs/ESCOPO_META_MULTI_BM_2026-10-30.md,
-- seção 6, MB2-01, MB2-03 e MB2-05).
--
-- * MB2-01: `meta_sync_jobs.rate_limited_count`. Rate limit da Meta não consome
--   tentativa: o worker em TS devolve o job para `retry` com backoff, desconta a
--   tentativa e soma 1 aqui (até 5 vezes; depois segue o caminho normal).
-- * MB2-03: `meta_connections.token_type` (o `type` do debug_token: SYSTEM_USER,
--   USER, ...) e `health_checked_at` (última checagem da chave).
--   `meta_connect_token` passa a gravar `token_type`, `token_expires_at` e
--   `data_access_expires_at` (null = nunca expira / não informado).
-- * MB2-05: `claim_meta_sync_jobs` com justiça: entre os candidatos, no máximo 2
--   jobs por casa e 3 por app da Meta (app da conexão preferida da conta; conta
--   sem app forma um grupo próprio), na ordem de `next_attempt_at`.
-- * Cron `betleads-meta-sync-worker` passa a rodar a cada minuto (mesmo timeout
--   de 55 s da MB1).
--
-- Só mudanças aditivas e mesmas assinaturas: o código da MB1 em produção continua
-- funcionando nos minutos entre a migration e o deploy (o tick da MB1 já cabe em
-- 40 s, então o cron por minuto não sobrepõe ticks).
--
-- Idempotente.

-- ---------------------------------------------------------------------------
-- 1. Colunas novas
-- ---------------------------------------------------------------------------

alter table public.meta_sync_jobs
  add column if not exists rate_limited_count integer not null default 0
    check (rate_limited_count >= 0);

comment on column public.meta_sync_jobs.rate_limited_count is
  'MB2: quantas vezes o job voltou para a fila por rate limit da Meta sem consumir tentativa (máximo 5; depois conta como tentativa normal).';

alter table public.meta_connections
  add column if not exists token_type text,
  add column if not exists health_checked_at timestamptz;

comment on column public.meta_connections.token_type is
  'MB2: tipo da chave segundo o debug_token da Meta (SYSTEM_USER, USER, ...).';

comment on column public.meta_connections.health_checked_at is
  'MB2: última checagem da chave (debug_token) ao conectar, no "Testar acesso" ou na checagem diária.';

-- ---------------------------------------------------------------------------
-- 2. meta_connect_token: grava tipo e validade da chave
--    base: 20261118100000_meta_mb1_multi_bm.sql (mesma assinatura, grants,
--    trava da casa e comportamento; só acrescenta os campos do debug_token)
-- ---------------------------------------------------------------------------
-- p_connection = {meta_user_id, meta_user_name, app_id, app_name,
--   encrypted_access_token, token_hint, scopes (array), label,
--   token_type, token_expires_at (ISO ou null = nunca expira),
--   data_access_expires_at (ISO ou null)}
-- Chave ausente grava null. Se `token_type` veio, a chave acabou de passar pelo
-- debug_token: `health_checked_at` = agora.

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
  v_token_type text := nullif(btrim(p_connection ->> 'token_type'), '');
  v_token_expires_at timestamptz;
  v_data_access_expires_at timestamptz;
  v_health_checked_at timestamptz;
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

  begin
    v_token_expires_at := nullif(btrim(p_connection ->> 'token_expires_at'), '')::timestamptz;
    v_data_access_expires_at := nullif(btrim(p_connection ->> 'data_access_expires_at'), '')::timestamptz;
  exception when others then
    raise exception 'Validade da chave Meta em formato inválido.';
  end;
  v_health_checked_at := case when v_token_type is not null then now() end;

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
          connected_by_user_id = p_actor,
          token_type = v_token_type,
          token_expires_at = v_token_expires_at,
          data_access_expires_at = v_data_access_expires_at,
          health_checked_at = coalesce(v_health_checked_at, health_checked_at)
      where id = v_connection_id;
      v_created := false;
      exit;
    end if;

    insert into public.meta_connections (
      tenant_id, connected_by_user_id, auth_type, meta_user_id, meta_user_name,
      app_id, app_name, business_id, encrypted_access_token, access_token, token_hint,
      scopes, connection_label, status, token_validated_at, permissions_checked_at,
      connected_at, last_error, token_type, token_expires_at, data_access_expires_at,
      health_checked_at
    )
    values (
      p_tenant_id, p_actor, 'system_user_token', v_meta_user_id,
      p_connection ->> 'meta_user_name', v_app_id, p_connection ->> 'app_name', null,
      v_token, null, p_connection ->> 'token_hint', v_scopes, v_label, 'connected',
      now(), now(), now(), null, v_token_type, v_token_expires_at, v_data_access_expires_at,
      v_health_checked_at
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
  'MB1/MB2: conecta ou troca a chave de um Usuário do Sistema (conexão com tipo e validade da chave, contas, acessos, auditoria e marketing_integrations numa transação). Só service_role.';

-- ---------------------------------------------------------------------------
-- 3. claim_meta_sync_jobs: justiça entre casas e apps
--    base: 20261118100000_meta_mb1_multi_bm.sql (mesma assinatura, grants,
--    filtros de casa demo/bloqueada e reaper com a conta saindo de `syncing`)
-- ---------------------------------------------------------------------------
-- Entre os candidatos (ordem `next_attempt_at, created_at`), no máximo 2 jobs
-- por casa e, desses, no máximo 3 por app da Meta (app da conexão preferida da
-- conta, `meta_ad_accounts.connection_id`; sem app = um grupo só), até p_limit
-- (1..10). A escolha é feita sem trava; depois só os ids escolhidos são travados
-- com FOR UPDATE SKIP LOCKED e as condições são conferidas de novo, então dois
-- workers simultâneos nunca pegam o mesmo job (o segundo só recebe menos jobs).

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
  v_limit integer := greatest(1, least(coalesce(p_limit, 2), 10));
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
        locked_at = null,
        -- Solta o dono: o worker original (que ainda pode estar vivo) filtra
        -- por worker_id ao concluir/liberar e não pode reabrir um job já
        -- finalizado pelo reaper.
        worker_id = null
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
  with eligible as (
    select job.id, job.tenant_id, job.next_attempt_at, job.created_at,
           connection.app_id
    from public.meta_sync_jobs job
    left join public.meta_ad_accounts account on account.id = job.account_id
    left join public.meta_connections connection on connection.id = account.connection_id
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
  ),
  per_tenant as (
    select eligible.*,
           row_number() over (
             partition by eligible.tenant_id
             order by eligible.next_attempt_at, eligible.created_at, eligible.id
           ) as tenant_rank
    from eligible
  ),
  per_app as (
    -- PARTITION BY junta os nulls: contas sem app formam um grupo só.
    select per_tenant.*,
           row_number() over (
             partition by per_tenant.app_id
             order by per_tenant.next_attempt_at, per_tenant.created_at, per_tenant.id
           ) as app_rank
    from per_tenant
    where per_tenant.tenant_rank <= 2
  ),
  chosen as (
    select per_app.id
    from per_app
    where per_app.app_rank <= 3
    order by per_app.next_attempt_at, per_app.created_at, per_app.id
    limit v_limit
  ),
  locked as (
    select job.id
    from public.meta_sync_jobs job
    where job.id in (select chosen.id from chosen)
      and (
        (job.status in ('queued', 'retry') and job.next_attempt_at <= now())
        or (job.status = 'running' and job.locked_at < now() - interval '10 minutes')
      )
      and job.attempt_count < job.max_attempts
    for update skip locked
  )
  update public.meta_sync_jobs job
  set status = 'running',
      attempt_count = job.attempt_count + 1,
      locked_at = now(),
      worker_id = coalesce(p_worker_id, gen_random_uuid()::text),
      started_at = coalesce(job.started_at, now()),
      last_error = null
  from locked
  where job.id = locked.id
  returning job.*;
end;
$$;

revoke execute on function public.claim_meta_sync_jobs(integer, text) from public, anon, authenticated;
grant execute on function public.claim_meta_sync_jobs(integer, text) to service_role;

comment on function public.claim_meta_sync_jobs(integer, text) is
  'MB2: reaper + claim justo (até 10 jobs; no máximo 2 por casa e 3 por app da Meta), ignorando casas demo, suspensas/canceladas ou com cobrança bloqueada. Só service_role.';

-- ---------------------------------------------------------------------------
-- 4. Cron do worker a cada minuto
--    base: 20261118100000_meta_mb1_multi_bm.sql (mesma URL, segredo do Vault e
--    timeout de 55 s; só muda o agendamento de */5 para todo minuto)
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

select cron.schedule('betleads-meta-sync-worker', '* * * * *', $job$
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
