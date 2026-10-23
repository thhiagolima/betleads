-- PG6-03: saúde da cobrança (painel e alertas).
--
-- 1) billing_monitor_signals: contadores por hora de eventos que hoje não
--    deixam rastro no banco, para o monitor ler depois:
--      - webhook_invalid_signature: callback da Upper com X-Upper-Signature
--        ausente, malformada, vencida ou que não confere (a rota responde
--        400 e não grava nada em payment_webhook_events, de propósito: o
--        event_id de um pedido sem assinatura válida não pode bloquear o
--        evento verdadeiro);
--      - upper_feature_disabled / upper_unauthorized: a API da Upper
--        respondeu 403 FEATURE_DISABLED ou 401 (chave inválida).
--    Uma linha por (code, hora): uma enxurrada de pedidos inválidos só
--    incrementa um contador, nunca cresce a tabela sem limite. O detalhe
--    guardado é curto e nunca carrega segredo (só o motivo/código).
--
-- 2) billing_record_signal(code, detail): grava/incrementa o contador.
--    Só service_role (webhook e cliente da Upper rodam no backend).
--
-- 3) billing_health_snapshot(window_hours, now): números crus que o
--    monitor (src/lib/billing/billing-health.server.ts) transforma em
--    alertas. Só service_role. Não devolve valores de carteira nem custo do
--    fornecedor: só contagens, datas e ids de casa.
--
-- Aditiva: nenhuma tabela/função existente muda.

create table if not exists public.billing_monitor_signals (
  code text not null check (code ~ '^[a-z][a-z0-9_]{0,63}$'),
  bucket_start timestamptz not null,
  count bigint not null default 0,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  last_detail text null,
  primary key (code, bucket_start)
);

create index if not exists idx_billing_monitor_signals_last_at
  on public.billing_monitor_signals (code, last_at desc);

alter table public.billing_monitor_signals enable row level security;
-- Sem policy: nenhum acesso por anon/authenticated. O painel do superadmin lê
-- pelo backend (service_role).
revoke all on public.billing_monitor_signals from public, anon, authenticated;
grant all on public.billing_monitor_signals to service_role;

create or replace function public.billing_record_signal(_code text, _detail text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden';
  end if;

  insert into public.billing_monitor_signals as s
    (code, bucket_start, count, first_at, last_at, last_detail)
  values
    (_code, date_trunc('hour', now()), 1, now(), now(), left(_detail, 200))
  on conflict (code, bucket_start) do update
    set count = s.count + 1,
        last_at = excluded.last_at,
        last_detail = coalesce(excluded.last_detail, s.last_detail);
end;
$$;

revoke execute on function public.billing_record_signal(text, text) from public, anon, authenticated;
grant execute on function public.billing_record_signal(text, text) to service_role;

create or replace function public.billing_health_snapshot(
  _window_hours integer default 1,
  _now timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_since timestamptz;
  v_signals jsonb;
  v_paid_uncredited jsonb;
  v_needs_review jsonb;
  v_wallets jsonb;
  v_jobs jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden';
  end if;

  v_since := _now - make_interval(hours => greatest(1, least(coalesce(_window_hours, 1), 168)));

  -- Contadores do período. O bucket é por hora, então filtra por last_at
  -- (um bucket conta se teve evento dentro da janela).
  select coalesce(jsonb_object_agg(code, jsonb_build_object(
           'count', total, 'last_at', last_at, 'last_detail', last_detail)), '{}'::jsonb)
    into v_signals
  from (
    select s.code,
           sum(s.count) as total,
           max(s.last_at) as last_at,
           (array_agg(s.last_detail order by s.last_at desc))[1] as last_detail
    from public.billing_monitor_signals s
    where s.last_at >= v_since and s.last_at <= _now
    group by s.code
  ) agg;

  -- Pagas no provedor e não creditadas/baixadas há mais de 10 min, fora as
  -- que já estão em revisão (essas têm alerta próprio).
  select jsonb_build_object(
           'count', count(*),
           'oldest_paid_at', min(coalesce(c.paid_at, c.updated_at)))
    into v_paid_uncredited
  from public.payment_charges c
  where c.status = 'PAID'
    and c.credited_at is null
    and c.needs_review = false
    and coalesce(c.paid_at, c.updated_at) < _now - interval '10 minutes';

  select jsonb_build_object(
           'count', count(*),
           'oldest_at', min(coalesce(c.paid_at, c.updated_at)))
    into v_needs_review
  from public.payment_charges c
  where c.needs_review = true
    and c.credited_at is null;

  select jsonb_build_object(
           'count', count(*),
           'tenant_ids', coalesce(jsonb_agg(i.tenant_id order by i.tenant_id), '[]'::jsonb))
    into v_wallets
  from public.billing_wallet_integrity() i;

  -- Última execução concluída (succeeded/partial) de cada job de cobrança.
  -- Ordena por started_at para usar dispatcher_runs_job_started_idx.
  select jsonb_build_object(
           'billing-reconcile', (
             select r.finished_at from public.dispatcher_runs r
             where r.job = 'billing-reconcile'
               and r.status in ('succeeded', 'partial')
               and r.finished_at <= _now
             order by r.started_at desc
             limit 1),
           'billing-cycle', (
             select r.finished_at from public.dispatcher_runs r
             where r.job = 'billing-cycle'
               and r.status in ('succeeded', 'partial')
               and r.finished_at <= _now
             order by r.started_at desc
             limit 1))
    into v_jobs;

  return jsonb_build_object(
    'now', _now,
    'since', v_since,
    'signals', v_signals,
    'paid_uncredited', v_paid_uncredited,
    'needs_review', v_needs_review,
    'wallet_mismatch', v_wallets,
    'jobs_last_ok', v_jobs
  );
end;
$$;

revoke execute on function public.billing_health_snapshot(integer, timestamptz) from public, anon, authenticated;
grant execute on function public.billing_health_snapshot(integer, timestamptz) to service_role;

notify pgrst, 'reload schema';
