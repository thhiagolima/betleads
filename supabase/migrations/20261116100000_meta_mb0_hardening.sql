-- Meta Ads, fase MB0 (docs/ESCOPO_META_MULTI_BM_2026-10-30.md, seção 6).
--
-- * MB0-02: `meta_ad_accounts` e `marketing_integrations` passam a ser só leitura
--   para `authenticated`. Hoje a policy é FOR ALL e o papel tem INSERT/UPDATE: um
--   membro da casa pode trocar `selected`/`connection_id` direto pelo PostgREST.
--   Toda escrita do app já passa por server functions com `supabaseAdmin`
--   (service_role). `meta_sync_jobs`/`meta_sync_runs` já só tinham policy de
--   SELECT; os privilégios de escrita também saem, por defesa em profundidade.
-- * MB0-03: apaga o token em texto puro das conexões `legacy_oauth` (a coluna
--   fica, já é nullable).
-- * MB0-04/MB0-05: `claim_meta_sync_jobs` ganha um reaper. Um job `running` com
--   lock vencido (10 min) na última tentativa não era mais reclamado nem
--   falhava: o run ficava `running` para sempre e o índice
--   `meta_sync_runs_one_active_tenant` travava a casa. Agora ele vira `failed` e
--   o run é recalculado por `refresh_meta_sync_run` (mesma regra de
--   `refreshMetaSyncRun` em src/lib/meta.functions.ts). O claim também deixa de
--   pegar jobs de casa suspensa/cancelada ou com bloqueio de cobrança
--   incondicional (`frozen`, `locked_manual`).
--
-- Idempotente. Pode ser aplicada antes do deploy: o código publicado não escreve
-- nessas tabelas com o client do usuário e a assinatura do claim não muda.

-- ---------------------------------------------------------------------------
-- 1. MB0-02: só leitura para quem está logado
-- ---------------------------------------------------------------------------

-- marketing_integrations: mesma expressão da policy FOR ALL de
-- 20261015090000_consolidate_tenant_rls.sql, agora só para SELECT.
drop policy if exists marketing_integrations_tenant_rls on public.marketing_integrations;
drop policy if exists marketing_integrations_tenant_select on public.marketing_integrations;
create policy marketing_integrations_tenant_select on public.marketing_integrations
  as permissive for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()));

drop policy if exists meta_ad_accounts_tenant_rls on public.meta_ad_accounts;
drop policy if exists meta_ad_accounts_tenant_update on public.meta_ad_accounts;
drop policy if exists meta_ad_accounts_tenant_select on public.meta_ad_accounts;
create policy meta_ad_accounts_tenant_select on public.meta_ad_accounts
  as permissive for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()));

revoke insert, update, delete, truncate on public.marketing_integrations from anon, authenticated;
revoke insert, update, delete, truncate on public.meta_ad_accounts from anon, authenticated;
revoke insert, update, delete, truncate on public.meta_sync_jobs from anon, authenticated;
revoke insert, update, delete, truncate on public.meta_sync_runs from anon, authenticated;

grant select on public.marketing_integrations to authenticated;
grant select on public.meta_ad_accounts to authenticated;
grant select on public.meta_sync_jobs to authenticated;
grant select on public.meta_sync_runs to authenticated;

grant all on public.marketing_integrations to service_role;
grant all on public.meta_ad_accounts to service_role;
grant all on public.meta_sync_jobs to service_role;
grant all on public.meta_sync_runs to service_role;

-- ---------------------------------------------------------------------------
-- 2. MB0-03: token legado em texto puro
-- ---------------------------------------------------------------------------

update public.meta_connections
set access_token = null
where auth_type = 'legacy_oauth'
  and access_token is not null;

-- ---------------------------------------------------------------------------
-- 3. MB0-04: recálculo de um run a partir dos seus jobs
-- ---------------------------------------------------------------------------
-- Espelha `refreshMetaSyncRun` (src/lib/meta.functions.ts):
--   processados = completed + failed; pendentes = o resto;
--   status = running se há pendente, senão completed (nenhuma falha),
--            partial (falhas e sucessos) ou failed (só falhas);
--   finished_at = now() quando nada está pendente, senão null;
--   error_summary = até 3 erros dos jobs que falharam, unidos por ' · '.
-- Devolve o status gravado, ou null se o run não existe.

create or replace function public.refresh_meta_sync_run(p_run_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer;
  v_completed integer;
  v_failed integer;
  v_rows integer;
  v_pending integer;
  v_status text;
  v_summary text;
begin
  select count(*)::integer,
         count(*) filter (where job.status = 'completed')::integer,
         count(*) filter (where job.status = 'failed')::integer,
         coalesce(sum(job.rows_imported), 0)::integer
    into v_total, v_completed, v_failed, v_rows
  from public.meta_sync_jobs job
  where job.run_id = p_run_id;

  v_pending := v_total - v_completed - v_failed;
  v_status := case
    when v_pending > 0 then 'running'
    when v_failed = 0 then 'completed'
    when v_completed > 0 then 'partial'
    else 'failed'
  end;

  select string_agg(err.message, ' · ' order by err.ord)
    into v_summary
  from (
    select job.last_error as message,
           row_number() over (order by job.finished_at nulls last, job.created_at, job.id) as ord
    from public.meta_sync_jobs job
    where job.run_id = p_run_id
      and job.status = 'failed'
      and nullif(job.last_error, '') is not null
    order by job.finished_at nulls last, job.created_at, job.id
    limit 3
  ) err;

  update public.meta_sync_runs run
  set status = v_status,
      processed_accounts = v_completed + v_failed,
      successful_accounts = v_completed,
      failed_accounts = v_failed,
      rows_imported = v_rows,
      finished_at = case when v_pending = 0 then now() else null end,
      error_summary = v_summary
  where run.id = p_run_id;

  if not found then
    return null;
  end if;
  return v_status;
end;
$$;

revoke execute on function public.refresh_meta_sync_run(uuid) from public, anon, authenticated;
grant execute on function public.refresh_meta_sync_run(uuid) to service_role;

comment on function public.refresh_meta_sync_run(uuid) is
  'Recalcula contadores, status, finished_at e error_summary de um meta_sync_run a partir dos jobs. Só service_role.';

-- ---------------------------------------------------------------------------
-- 4. MB0-04/MB0-05: claim com reaper e sem casas bloqueadas
--    base: 20261018110000_demo_tenant_skip_workers.sql (pula casas demo)
-- ---------------------------------------------------------------------------
-- Casa que não pode operar = o que `assertTenantCanOperate`
-- (src/lib/tenant-access.server.ts) recusa sem depender de variável de ambiente:
-- `tenants.status` em ('suspended', 'canceled') ou `tenant_billing.access_state`
-- em ('frozen', 'locked_manual'). `locked_unpaid`/`awaiting_first_payment` só
-- bloqueiam com BILLING_ENFORCEMENT_ENABLED, que o banco não enxerga: o claim os
-- pega, e o worker (`processMetaSyncQueue`) confere cada casa com
-- `assertTenantCanOperate` e devolve os jobs da casa bloqueada para `retry` em
-- 1 h, sem gastar tentativa. O "Atualizar agora" (`enqueueMetaSyncFor`) recusa,
-- mesmo para o super admin, toda casa que o claim recusa, para não criar um run
-- que nunca seria reclamado.

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
  -- qualquer casa (inclusive demo/suspensa): só destrava o run.
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
    returning job.run_id
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
-- 5. Destrava o que já está preso
-- ---------------------------------------------------------------------------
-- Runs ativos cujos jobs já terminaram todos (ex.: o refresh em TS falhou depois
-- do último job). Os jobs `running` vencidos são resolvidos pelo reaper no
-- próximo claim do worker.

do $$
declare
  v_run record;
begin
  for v_run in
    select run.id
    from public.meta_sync_runs run
    where run.status in ('queued', 'running')
      and exists (select 1 from public.meta_sync_jobs job where job.run_id = run.id)
      and not exists (
        select 1 from public.meta_sync_jobs job
        where job.run_id = run.id
          and job.status not in ('completed', 'failed')
      )
  loop
    perform public.refresh_meta_sync_run(v_run.id);
  end loop;
end;
$$;
