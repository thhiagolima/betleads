-- CON-03 — Replay de webhook sem bloqueio de cabeça de fila (backoff + DLQ).
-- CON-04 — suporte de banco para manter elegível ao replay o evento cujo
--          recibo ainda está em processamento (o app grava next_replay_at).
--
-- OPERAÇÃO (ler antes de aplicar)
-- * webhook_logs: ~316 MB de heap / ~510 MB total / ~190k linhas (2026-10-14).
-- * ADD COLUMN com DEFAULT não volátil (constante ou now(), que é STABLE) é
--   apenas metadado no PG >= 11 (valor guardado em pg_attribute.attmissingval):
--   não reescreve nem varre a tabela, inclusive com NOT NULL. Ainda exige
--   ACCESS EXCLUSIVE por alguns milissegundos; lock_timeout evita fila atrás
--   de uma transação longa (se estourar, basta reaplicar).
-- * CREATE INDEX (não CONCURRENTLY, pois a migração roda em transação) faz um
--   seq scan do heap inteiro (~316 MB, estimativa 2–6 s) segurando SHARE lock:
--   INSERT/UPDATE em webhook_logs (entrada de webhooks) ficam bloqueados nesse
--   intervalo. O índice resultante é minúsculo (só linhas pendentes, ~1k).
--   APLICAR FORA DO PICO. Alternativa sem bloqueio de escrita: executar o
--   CREATE INDEX CONCURRENTLY abaixo manualmente, fora de transação, antes de
--   aplicar esta migração (o IF NOT EXISTS torna o passo daqui um no-op).
-- * Compatibilidade: claim_webhook_event (boolean) NÃO muda; versões antigas do
--   app continuam funcionando. As colunas novas têm default, então inserts do
--   app antigo continuam válidos.

set lock_timeout = '5s';
set statement_timeout = '120s';

alter table public.webhook_logs
  add column if not exists replay_attempts integer not null default 0,
  -- Default now(): linhas existentes recebem o instante da migração (metadado,
  -- sem rewrite) e as novas recebem o instante do insert. Assim a coluna nunca
  -- é nula e a ordenação usa o índice diretamente, sem coalesce(created_at).
  add column if not exists next_replay_at timestamptz not null default now(),
  add column if not exists dead_lettered_at timestamptz,
  add column if not exists last_replay_error text;

comment on column public.webhook_logs.replay_attempts is
  'Quantas vezes o replay reivindicou esta linha. Ao atingir o máximo (5) a linha vai para a DLQ.';
comment on column public.webhook_logs.next_replay_at is
  'Quando a linha volta a ser elegível ao replay. Funciona como lease + backoff exponencial.';
comment on column public.webhook_logs.dead_lettered_at is
  'Preenchido quando a linha esgotou as tentativas de replay (DLQ). Reenfileirar: '
  'update ... set dead_lettered_at = null, replay_attempts = 0, next_replay_at = now().';
comment on column public.webhook_logs.last_replay_error is
  'Último erro observado durante um replay desta linha.';

-- (tenant_id, next_replay_at, created_at): atende a varredura por tenant do
-- claim (round-robin) e o filtro por tenant_id do endpoint. Parcial: só as
-- linhas pendentes ficam no índice.
create index if not exists webhook_logs_replay_due_idx
  on public.webhook_logs (tenant_id, next_replay_at, created_at)
  where status in ('recebido', 'erro') and dead_lettered_at is null;

-- Claim atômico do lote de replay.
--   * Elegível: status em p_statuses, fora da DLQ, created_at < now()-p_min_age,
--     next_replay_at <= now().
--   * Justiça: varre cada tenant separadamente (LATERAL sobre tenants) e
--     intercala os resultados (rank 1 de cada tenant, depois rank 2, ...),
--     com teto opcional por tenant. Um tenant com backlog envenenado não
--     consome o lote inteiro.
--   * FOR UPDATE SKIP LOCKED + next_replay_at no futuro (lease) impedem que
--     execuções sobrepostas peguem a mesma linha.
--   * replay_attempts é incrementado no claim; backoff = least(2^tentativas, 60) min.
--   * Linhas que já atingiram p_max_attempts (padrão 8, ~4 h de backoff somado,
--     para sobreviver a um incidente de mais de 1 h) vão para a DLQ (dead_lettered_at)
--     e são devolvidas com action = 'dead_lettered', sem payload, para contagem.
--   * p_dry_run: apenas lista (action = 'candidate' | 'would_dead_letter'),
--     sem lock e sem escrita.
create or replace function public.claim_webhook_logs_for_replay(
  p_limit integer default 20,
  p_min_age interval default interval '2 minutes',
  p_per_tenant integer default null,
  p_tenant_id uuid default null,
  p_evento text default null,
  p_statuses text[] default array['recebido', 'erro'],
  p_max_attempts integer default 8,
  p_dry_run boolean default false
)
returns table (
  id uuid,
  tenant_id uuid,
  evento text,
  payload jsonb,
  replay_attempts integer,
  action text
)
language plpgsql
security definer
set search_path = public, pg_temp
-- Plano sempre customizado: com p_statuses/p_evento constantes o planner
-- consegue provar o predicado do índice parcial.
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
declare
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_per_tenant integer;
  v_max_attempts integer := greatest(coalesce(p_max_attempts, 8), 1);
  v_min_age interval := coalesce(p_min_age, interval '2 minutes');
  v_statuses text[] := coalesce(p_statuses, array['recebido', 'erro']);
begin
  v_per_tenant := least(greatest(coalesce(p_per_tenant, v_limit), 1), v_limit);

  if p_dry_run then
    return query
    with ranked as (
      select c.*, row_number() over (
        partition by c.tenant_id order by c.next_replay_at, c.created_at
      ) as rn
      from public.tenants t
      cross join lateral (
        select w.id, w.tenant_id, w.evento, w.replay_attempts, w.next_replay_at, w.created_at
        from public.webhook_logs w
        where w.tenant_id = t.id
          and w.status = any (v_statuses)
          and w.dead_lettered_at is null
          and w.next_replay_at <= now()
          and w.created_at < now() - v_min_age
          and (p_evento is null or w.evento = p_evento)
        order by w.next_replay_at, w.created_at
        limit v_per_tenant
      ) c
      where p_tenant_id is null or t.id = p_tenant_id
    )
    select r.id, r.tenant_id, r.evento, null::jsonb, r.replay_attempts,
           case when r.replay_attempts >= v_max_attempts then 'would_dead_letter' else 'candidate' end
    from ranked r
    order by r.rn, r.next_replay_at, r.created_at
    limit v_limit;
    return;
  end if;

  return query
  with locked as (
    select c.id, c.tenant_id, c.replay_attempts, c.next_replay_at, c.created_at
    from public.tenants t
    cross join lateral (
      select w.id, w.tenant_id, w.replay_attempts, w.next_replay_at, w.created_at
      from public.webhook_logs w
      where w.tenant_id = t.id
        and w.status = any (v_statuses)
        and w.dead_lettered_at is null
        and w.next_replay_at <= now()
        and w.created_at < now() - v_min_age
        and (p_evento is null or w.evento = p_evento)
      order by w.next_replay_at, w.created_at
      limit v_per_tenant
      for update of w skip locked
    ) c
    where p_tenant_id is null or t.id = p_tenant_id
  ),
  picked as (
    select l.*
    from (
      select l0.*, row_number() over (
        partition by l0.tenant_id order by l0.next_replay_at, l0.created_at
      ) as rn
      from locked l0
    ) l
    order by l.rn, l.next_replay_at, l.created_at
    limit v_limit
  ),
  updated as (
    update public.webhook_logs w
       set replay_attempts = case
             when p.replay_attempts >= v_max_attempts then w.replay_attempts
             else w.replay_attempts + 1
           end,
           next_replay_at = case
             when p.replay_attempts >= v_max_attempts then w.next_replay_at
             else now() + least(power(2, w.replay_attempts + 1), 60) * interval '1 minute'
           end,
           dead_lettered_at = case
             when p.replay_attempts >= v_max_attempts then now()
             else w.dead_lettered_at
           end,
           last_replay_error = case
             when p.replay_attempts >= v_max_attempts
               then coalesce(w.last_replay_error, 'max_replay_attempts_exceeded')
             else w.last_replay_error
           end
      from picked p
     where w.id = p.id
    returning w.id, w.tenant_id, w.evento,
              case when w.dead_lettered_at is null then w.payload else null end as payload,
              w.replay_attempts,
              case when w.dead_lettered_at is null then 'replay' else 'dead_lettered' end as action,
              p.rn, p.next_replay_at as due_at, w.created_at
  )
  select u.id, u.tenant_id, u.evento, u.payload, u.replay_attempts, u.action
  from updated u
  order by u.rn, u.due_at, u.created_at;
end;
$$;

revoke execute on function public.claim_webhook_logs_for_replay(
  integer, interval, integer, uuid, text, text[], integer, boolean
) from public, anon, authenticated;
grant execute on function public.claim_webhook_logs_for_replay(
  integer, interval, integer, uuid, text, text[], integer, boolean
) to service_role;

comment on function public.claim_webhook_logs_for_replay(
  integer, interval, integer, uuid, text, text[], integer, boolean
) is
  'CON-03: claim atômico, justo por tenant e com lease/backoff do lote de replay de webhook_logs; DLQ após p_max_attempts.';

-- Recuperação pontual (NÃO executada aqui; rodar manualmente se desejado):
-- logs marcados 'duplicado' cujo recibo ficou preso em 'processing' são
-- eventos perdidos pelo bug do CON-04 (447 linhas em 2026-10-14). Como o
-- recibo está vencido (> 10 min), o replay consegue reivindicá-lo:
--   update public.webhook_logs w
--      set status = 'recebido', next_replay_at = now()
--     from public.webhook_event_receipts r
--    where w.status = 'duplicado'
--      and r.tenant_id = w.tenant_id
--      and r.status in ('processing', 'failed')
--      and r.provider_event_id = coalesce(w.payload->>'eventId', w.payload->>'event_id',
--            w.payload->'data'->>'eventId', w.payload->'data'->>'event_id');

notify pgrst, 'reload schema';

reset lock_timeout;
reset statement_timeout;
