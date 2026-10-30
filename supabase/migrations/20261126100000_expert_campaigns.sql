-- Área do Expert — campanhas de SMS, e-mail e voz do expert
-- (spec docs/superpowers/specs/2026-10-23-area-expert-design.md §8).
--
-- O QUE ESTA MIGRAÇÃO FAZ (aditiva; nada da casa muda de comportamento)
--   1. Dono: expert_id em sms_audiences (cascade), sms_campaigns e
--      email_campaigns (restrict: campanha guarda histórico de envio e
--      consumo; expert com campanha é desativado, não excluído). NULL = casa.
--   2. sms_audiences: o nome único por casa passa a valer só entre os
--      públicos da casa; cada expert tem o próprio espaço de nomes.
--   3. Aprovação em sms_campaigns/email_campaigns: approval_status
--      ('pendente'|'aprovada'|'recusada'; NULL = casa ou expert no modo
--      livre), approved_by/at, rejection_reason, expert_estimated_cost.
--      Uma campanha pendente/recusada só pode estar em 'aguardando_aprovacao',
--      'recusada' ou 'cancelada' (CHECK), e claim_due_sms_campaigns /
--      claim_due_email_campaigns só pegam 'agendada'/'enviando': nenhum worker
--      dispara uma campanha antes da aprovação, por construção.
--   4. Linhas de expert (sms_audiences/sms_campaigns/email_campaigns com
--      expert_id) só são gravadas por server functions (service_role): o
--      REST da casa (authenticated) não cria, edita, aprova nem apaga.
--   5. expert_voice_campaigns: a voz em massa da casa não guarda campanha
--      (cria itens em call_queue na hora). A do expert fica guardada até a
--      aprovação; ao aprovar (ou no modo livre) os itens de call_queue são
--      criados com expert_id + expert_voice_campaign_id.
--   6. Teto mensal (experts.teto_mensal, R$, todos os canais, preço de venda
--      da casa): expert_monthly_usage (consumo por mês) +
--      expert_usage_entries (uma linha por reserva da carteira).
--      expert_wallet_reserve faz numa única transação: trava do expert +
--      wallet_reserve + checagem do teto + incremento. Acima do teto levanta
--      'expert_cap_reached' e a reserva da carteira é desfeita junto. O mês é
--      o usage_month da reserva (billing_now() em America/Sao_Paulo). Uma
--      repetição idempotente não conta de novo. Estornos (wallet_refund,
--      wallet_settle, wallet_settle_voice — todos gravam usage_refund com
--      reverses_ledger_id) devolvem o consumo ao MÊS DA RESERVA, por trigger,
--      proporcional às unidades estornadas. expert_cap_alerts: um aviso ao
--      admin por expert por mês.
--   7. resolve_sms_audience_v2 (corpo de 20261117100000) ganha o filtro
--      opcional _criteria->'affiliateIds' (text[]) em btrim(affiliate_id),
--      só quando a chave existe (lista vazia = ninguém), e devolve
--      'affiliateScoped' para o app recusar (falhar fechado) uma resolução
--      feita por um RPC antigo que ignoraria o escopo.
--   8. purge_stale_selection_audiences também preserva públicos de seleção
--      usados por campanhas aguardando aprovação e por campanhas de e-mail e
--      voz de expert ainda não concluídas.
--
-- ROLLBACK (manual)
--   drop trigger wallet_ledger_expert_refund on public.wallet_ledger;
--   drop function public.expert_wallet_reserve(uuid,uuid,text,integer,text,text,text);
--   drop function public.expert_usage_on_refund();
--   drop table public.expert_cap_alerts, public.expert_usage_entries, public.expert_monthly_usage;
--   alter table public.call_queue drop column expert_voice_campaign_id, drop column expert_id;
--   drop table public.expert_voice_campaigns;
--   drop trigger ..._expert_service_only (3 tabelas); drop function public.expert_rows_service_only();
--   colunas expert_id/approval_*/expert_estimated_cost e índices; restaurar
--   unique (tenant_id, name) em sms_audiences, o CHECK de status anterior de
--   sms_campaigns, o corpo de resolve_sms_audience_v2 de 20261117100000 e o de
--   purge_stale_selection_audiences de 20261026100000.

set local lock_timeout = '5s';

-- ─── 1. Dono (expert_id) ────────────────────────────────────────────────────

alter table public.sms_audiences
  add column if not exists expert_id uuid references public.experts(id) on delete cascade;
alter table public.sms_campaigns
  add column if not exists expert_id uuid references public.experts(id) on delete restrict;
alter table public.email_campaigns
  add column if not exists expert_id uuid references public.experts(id) on delete restrict;

create index if not exists sms_audiences_expert_idx
  on public.sms_audiences (expert_id, updated_at desc) where expert_id is not null;
create index if not exists sms_campaigns_expert_idx
  on public.sms_campaigns (tenant_id, expert_id, created_at desc) where expert_id is not null;
create index if not exists email_campaigns_expert_idx
  on public.email_campaigns (tenant_id, expert_id, created_at desc) where expert_id is not null;

-- ─── 2. Nome de público: casa e expert em espaços separados ─────────────────

alter table public.sms_audiences drop constraint if exists sms_audiences_tenant_id_name_key;
create unique index if not exists sms_audiences_house_name_uniq
  on public.sms_audiences (tenant_id, name) where expert_id is null;
create unique index if not exists sms_audiences_expert_name_uniq
  on public.sms_audiences (expert_id, name) where expert_id is not null;

-- ─── 3. Aprovação ───────────────────────────────────────────────────────────

alter table public.sms_campaigns
  add column if not exists approval_status text,
  add column if not exists approved_by uuid references auth.users(id) on delete set null,
  add column if not exists approved_at timestamptz,
  add column if not exists rejection_reason text,
  add column if not exists expert_estimated_cost numeric(14,4);
alter table public.email_campaigns
  add column if not exists approval_status text,
  add column if not exists approved_by uuid references auth.users(id) on delete set null,
  add column if not exists approved_at timestamptz,
  add column if not exists rejection_reason text,
  add column if not exists expert_estimated_cost numeric(14,4);

alter table public.sms_campaigns drop constraint if exists sms_campaigns_approval_status_chk;
alter table public.sms_campaigns
  add constraint sms_campaigns_approval_status_chk check (
    approval_status is null
    or (expert_id is not null and approval_status in ('pendente', 'aprovada', 'recusada'))
  );
alter table public.email_campaigns drop constraint if exists email_campaigns_approval_status_chk;
alter table public.email_campaigns
  add constraint email_campaigns_approval_status_chk check (
    approval_status is null
    or (expert_id is not null and approval_status in ('pendente', 'aprovada', 'recusada'))
  );

-- Pendente/recusada nunca está num status que um worker pega.
alter table public.sms_campaigns drop constraint if exists sms_campaigns_approval_gate_chk;
alter table public.sms_campaigns
  add constraint sms_campaigns_approval_gate_chk check (
    approval_status is null
    or approval_status = 'aprovada'
    or status in ('aguardando_aprovacao', 'recusada', 'cancelada')
  );
alter table public.email_campaigns drop constraint if exists email_campaigns_approval_gate_chk;
alter table public.email_campaigns
  add constraint email_campaigns_approval_gate_chk check (
    approval_status is null
    or approval_status = 'aprovada'
    or status in ('aguardando_aprovacao', 'recusada', 'cancelada')
  );

-- Mesmo conjunto de 20261024100000 + os dois status da aprovação.
alter table public.sms_campaigns drop constraint if exists sms_campaigns_status_chk;
alter table public.sms_campaigns
  add constraint sms_campaigns_status_chk
  check (status in (
    'agendada', 'enviando', 'enviado', 'falhou', 'cancelada', 'pausada',
    'aguardando_aprovacao', 'recusada'
  ));

-- ─── 4. Linhas de expert: só service_role grava ─────────────────────────────
-- O REST da casa (papel authenticated) continua lendo pelas políticas de
-- casa, mas não cria/edita/apaga público ou campanha de expert, nem marca uma
-- linha da casa como de expert. Funções SECURITY DEFINER e o service_role
-- (server functions) passam.

create or replace function public.expert_rows_service_only()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if old.expert_id is not null then
      raise exception 'expert_row_service_only' using errcode = '42501';
    end if;
    return old;
  end if;
  if new.expert_id is not null or (tg_op = 'UPDATE' and old.expert_id is not null) then
    raise exception 'expert_row_service_only' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists sms_audiences_expert_service_only on public.sms_audiences;
create trigger sms_audiences_expert_service_only
  before insert or update or delete on public.sms_audiences
  for each row execute function public.expert_rows_service_only();
drop trigger if exists sms_campaigns_expert_service_only on public.sms_campaigns;
create trigger sms_campaigns_expert_service_only
  before insert or update or delete on public.sms_campaigns
  for each row execute function public.expert_rows_service_only();
drop trigger if exists email_campaigns_expert_service_only on public.email_campaigns;
create trigger email_campaigns_expert_service_only
  before insert or update or delete on public.email_campaigns
  for each row execute function public.expert_rows_service_only();

-- ─── 5. Campanha de voz do expert ───────────────────────────────────────────

create table if not exists public.expert_voice_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  expert_id uuid not null references public.experts(id) on delete restrict,
  name text not null,
  script_id uuid,
  voice_asset_id uuid,
  -- Critério do público (mesma forma de sms_campaigns.audience_criteria) e
  -- subconjunto opcional de jogadores; tudo revalidado contra o escopo do
  -- expert na aprovação e de novo a cada ligação.
  audience_criteria jsonb not null default '{}'::jsonb,
  player_ids jsonb check (player_ids is null or jsonb_typeof(player_ids) = 'array'),
  total_count integer not null default 0,
  queued_count integer not null default 0,
  scheduled_at timestamptz,
  status text not null default 'aguardando_aprovacao' check (
    status in ('aguardando_aprovacao', 'recusada', 'enfileirada', 'pausada', 'cancelada')
  ),
  approval_status text check (approval_status in ('pendente', 'aprovada', 'recusada')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  rejection_reason text,
  expert_estimated_cost numeric(14,4),
  last_error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((script_id is null) <> (voice_asset_id is null)),
  check (
    approval_status is null
    or approval_status = 'aprovada'
    or status in ('aguardando_aprovacao', 'recusada', 'cancelada')
  )
);

create index if not exists expert_voice_campaigns_tenant_idx
  on public.expert_voice_campaigns (tenant_id, expert_id, created_at desc);

drop trigger if exists expert_voice_campaigns_updated_at on public.expert_voice_campaigns;
create trigger expert_voice_campaigns_updated_at
  before update on public.expert_voice_campaigns
  for each row execute function public.set_updated_at();

alter table public.expert_voice_campaigns enable row level security;
revoke all on public.expert_voice_campaigns from anon, authenticated;
grant all on public.expert_voice_campaigns to service_role;

alter table public.call_queue
  add column if not exists expert_id uuid references public.experts(id) on delete restrict,
  add column if not exists expert_voice_campaign_id uuid
    references public.expert_voice_campaigns(id) on delete set null;
create index if not exists call_queue_expert_campaign_idx
  on public.call_queue (expert_voice_campaign_id) where expert_voice_campaign_id is not null;
create index if not exists call_queue_expert_idx
  on public.call_queue (expert_id, status) where expert_id is not null;

-- ─── 6. Teto mensal ─────────────────────────────────────────────────────────

create table if not exists public.expert_monthly_usage (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  expert_id uuid not null references public.experts(id) on delete cascade,
  month date not null,
  amount numeric(14,4) not null default 0 check (amount >= 0),
  updated_at timestamptz not null default now(),
  primary key (expert_id, month)
);

create table if not exists public.expert_usage_entries (
  ledger_id uuid primary key references public.wallet_ledger(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  expert_id uuid not null references public.experts(id) on delete cascade,
  month date not null,
  item text not null,
  units integer not null,
  unit_price numeric(12,4) not null,
  amount numeric(14,4) not null,
  refunded numeric(14,4) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists expert_usage_entries_expert_idx
  on public.expert_usage_entries (expert_id, month);

-- Um aviso de "teto atingido" ao admin por expert por mês (claim atômico:
-- insert ... on conflict do nothing).
create table if not exists public.expert_cap_alerts (
  expert_id uuid not null references public.experts(id) on delete cascade,
  month date not null,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (expert_id, month)
);

alter table public.expert_monthly_usage enable row level security;
alter table public.expert_usage_entries enable row level security;
alter table public.expert_cap_alerts enable row level security;
revoke all on public.expert_monthly_usage from anon, authenticated;
revoke all on public.expert_usage_entries from anon, authenticated;
revoke all on public.expert_cap_alerts from anon, authenticated;
grant all on public.expert_monthly_usage to service_role;
grant all on public.expert_usage_entries to service_role;
grant all on public.expert_cap_alerts to service_role;

-- wallet_reserve + teto do expert, atômicos. Mesmo contrato de retorno de
-- wallet_reserve (+ expert_id, expert_cost, expert_month). Erros:
-- 'expert_inactive', 'expert_cap_reached' (e os de wallet_reserve, ex.
-- 'insufficient_balance'). teto 0 bloqueia tudo; teto NULL = sem teto.
-- Ordem de travas: experts -> tenant_wallets -> expert_monthly_usage. O
-- estorno trava tenant_wallets -> expert_usage_entries ->
-- expert_monthly_usage (nunca experts): sem ciclo.
create or replace function public.expert_wallet_reserve(
  _expert uuid,
  _tenant uuid,
  _item text,
  _units integer,
  _reference_type text,
  _reference_id text,
  _idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_ativo boolean;
  v_teto numeric(12,2);
  v_result jsonb;
  v_ledger public.wallet_ledger%rowtype;
  v_cost numeric(14,4);
  v_used numeric(14,4);
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden';
  end if;

  -- Serializa as reservas do mesmo expert (duas reservas no limite nunca
  -- passam juntas).
  select ativo, teto_mensal into v_ativo, v_teto
  from public.experts
  where id = _expert and tenant_id = _tenant
  for update;
  if not found or not coalesce(v_ativo, false) then
    raise exception 'expert_inactive';
  end if;

  if v_teto is not null and v_teto <= 0 then
    raise exception 'expert_cap_reached';
  end if;

  v_result := public.wallet_reserve(
    _tenant, _item, _units, _reference_type, _reference_id, _idempotency_key
  );
  -- Repetição da mesma reserva: já foi contada (ou é anterior ao teto).
  if coalesce((v_result ->> 'idempotent')::boolean, false) then
    return v_result || jsonb_build_object('expert_id', _expert);
  end if;

  select * into v_ledger
  from public.wallet_ledger
  where id = (v_result ->> 'ledger_id')::uuid;

  -- Preço de venda da casa × unidades reservadas, mesmo dentro da franquia
  -- ou para casa isenta (senão o teto não valeria nessas casas).
  v_cost := round(coalesce(v_ledger.unit_price, 0) * coalesce(v_ledger.units, _units), 4);

  insert into public.expert_monthly_usage (tenant_id, expert_id, month, amount)
  values (_tenant, _expert, v_ledger.usage_month, 0)
  on conflict (expert_id, month) do nothing;

  select amount into v_used
  from public.expert_monthly_usage
  where expert_id = _expert and month = v_ledger.usage_month
  for update;

  if v_teto is not null and v_used + v_cost > v_teto then
    -- Desfaz também a reserva da carteira (mesma transação).
    raise exception 'expert_cap_reached';
  end if;

  update public.expert_monthly_usage
     set amount = amount + v_cost, updated_at = now()
   where expert_id = _expert and month = v_ledger.usage_month;

  insert into public.expert_usage_entries (
    ledger_id, tenant_id, expert_id, month, item, units, unit_price, amount
  ) values (
    v_ledger.id, _tenant, _expert, v_ledger.usage_month, _item,
    coalesce(v_ledger.units, _units), coalesce(v_ledger.unit_price, 0), v_cost
  );

  return v_result || jsonb_build_object(
    'expert_id', _expert,
    'expert_cost', v_cost,
    'expert_month', v_ledger.usage_month
  );
end;
$$;

revoke execute on function public.expert_wallet_reserve(uuid, uuid, text, integer, text, text, text)
  from public, anon, authenticated;
grant execute on function public.expert_wallet_reserve(uuid, uuid, text, integer, text, text, text)
  to service_role;

-- Estorno de uma reserva de expert (wallet_refund, wallet_settle,
-- wallet_settle_voice): devolve ao teto do MÊS DA RESERVA a parte
-- estornada, proporcional às unidades estornadas, nunca além do contado.
create or replace function public.expert_usage_on_refund()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_entry public.expert_usage_entries%rowtype;
  v_back numeric(14,4);
begin
  select * into v_entry
  from public.expert_usage_entries
  where ledger_id = new.reverses_ledger_id
  for update;
  if not found then
    return new;
  end if;

  v_back := least(
    v_entry.amount - v_entry.refunded,
    round(v_entry.unit_price * greatest(coalesce(new.units, v_entry.units), 0), 4)
  );
  if v_back <= 0 then
    return new;
  end if;

  update public.expert_usage_entries
     set refunded = refunded + v_back
   where ledger_id = v_entry.ledger_id;

  update public.expert_monthly_usage
     set amount = greatest(amount - v_back, 0), updated_at = now()
   where expert_id = v_entry.expert_id and month = v_entry.month;

  return new;
end;
$$;

revoke execute on function public.expert_usage_on_refund() from public, anon, authenticated;

drop trigger if exists wallet_ledger_expert_refund on public.wallet_ledger;
create trigger wallet_ledger_expert_refund
  after insert on public.wallet_ledger
  for each row
  when (new.entry_type = 'usage_refund' and new.reverses_ledger_id is not null)
  execute function public.expert_usage_on_refund();

-- ─── 7. Público com escopo de afiliados ─────────────────────────────────────
-- base: corpo de 20261117100000_journey_dead_leads.sql (seção 10). Novidades:
-- CTE scope + filtro em enriched + 'affiliateScoped' na resposta.

CREATE OR REPLACE FUNCTION public.resolve_sms_audience_v2(_tenant uuid, _criteria jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
with
guard as (
  select (public.has_tenant_access(_tenant) or auth.role() = 'service_role') ok
),
settings as (
  select
    coalesce((level_thresholds->>'bronze')::numeric,10) bronze,
    coalesce((level_thresholds->>'silver')::numeric,200) silver,
    coalesce((level_thresholds->>'gold')::numeric,500) gold,
    coalesce((level_thresholds->>'diamond')::numeric,1000) diamond,
    coalesce((level_thresholds->>'black')::numeric,3000) black,
    coalesce(cooling_after_days,2)::int cooling,
    coalesce(sleeping_after_days,7)::int sleeping
  from (select 1) seed
  left join public.gamification_settings gs on gs.tenant_id = _tenant
),
params as (
  select
    coalesce(_criteria #>> '{activity,deposit}','any') deposit_rule,
    coalesce((_criteria #>> '{activity,pixUnpaid}')::boolean,false) pix_rule,
    coalesce((_criteria #>> '{activity,cashback}')::boolean,false) cashback_rule,
    coalesce(_criteria #>> '{activity,withdrawal}','any') withdrawal_rule,
    coalesce((_criteria #>> '{activity,withdrawalPending}')::boolean,false) withdrawal_pending_rule,
    nullif(_criteria->>'level','') level_rule,
    coalesce(_criteria->>'timing','any') timing_rule,
    greatest(1,coalesce((_criteria->>'customDays')::int,2)) custom_days,
    nullif(_criteria->>'daysWithoutLogin','')::int days_without_login,
    nullif(_criteria->>'daysSinceRegistration','')::int days_since_registration,
    coalesce((_criteria->>'deadLeads')::boolean,false) dead_rule
),
-- Escopo de afiliados (expert restrito): só quando a chave existe. Lista
-- vazia (ou que não é array) = nenhum jogador.
scope as (
  select
    (_criteria ? 'affiliateIds') scoped,
    coalesce(
      array(
        select btrim(v) from jsonb_array_elements_text(
          case when jsonb_typeof(_criteria->'affiliateIds') = 'array'
            then _criteria->'affiliateIds' else '[]'::jsonb end
        ) v
        where btrim(v) <> ''
      ),
      array[]::text[]
    ) affiliate_ids
),
pending_deposits as (
  select player_id, bool_or(metodo is null or lower(metodo) like '%pix%') has_pending_pix
  from public.deposits
  where tenant_id=_tenant and status='pendente' and player_id is not null
  group by player_id
),
withdrawal_flags as (
  select player_id,
    bool_or(status='aprovado') has_approved_withdrawal,
    bool_or(status='pendente') has_pending_withdrawal
  from public.withdrawals
  where tenant_id=_tenant and status in ('aprovado','pendente') and player_id is not null
  group by player_id
),
dead_players as (
  select player_id
  from public.journey_dead_leads
  where tenant_id=_tenant and revived_at is null
),
enriched as (
  select p.id,p.email,
    regexp_replace(coalesce(p.telefone,''),'\D','','g') phone,
    (coalesce(p.total_depositado,0)>0 or p.ftd_em is not null) has_deposit,
    coalesce(pd.has_pending_pix,false) has_pending_pix,
    (coalesce(p.total_sacado,0)>0 or coalesce(wf.has_approved_withdrawal,false)) has_withdrawal,
    coalesce(wf.has_pending_withdrawal,false) has_pending_withdrawal,
    p.last_cashback_paid_at is not null has_cashback,
    (dp.player_id is not null) is_dead,
    case
      when coalesce(p.total_depositado,0)>=s.black then 'black'
      when coalesce(p.total_depositado,0)>=s.diamond then 'diamond'
      when coalesce(p.total_depositado,0)>=s.gold then 'gold'
      when coalesce(p.total_depositado,0)>=s.silver then 'silver'
      when coalesce(p.total_depositado,0)>=s.bronze then 'bronze'
      else 'novice'
    end level,
    greatest(0,floor(extract(epoch from (now()-coalesce(p.ultimo_deposito,p.ftd_em,p.created_at)))/86400))::int inactive_days,
    greatest(0,floor(extract(epoch from (now()-coalesce(p.ultimo_login,p.created_at)))/86400))::int login_days,
    greatest(0,floor(extract(epoch from (now()-p.created_at))/86400))::int registration_days,
    p.created_at >= (date_trunc('week',now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo') registered_week,
    s.*
  from public.players p
  cross join settings s
  cross join scope sc
  left join pending_deposits pd on pd.player_id=p.id
  left join withdrawal_flags wf on wf.player_id=p.id
  left join dead_players dp on dp.player_id=p.id
  where p.tenant_id=_tenant
    and (not sc.scoped or btrim(p.affiliate_id) = any(sc.affiliate_ids))
),
flags as (
  select e.*,p.*,
    (p.deposit_rule='any' or (p.deposit_rule='yes' and e.has_deposit) or (p.deposit_rule='never' and not e.has_deposit)) deposit_ok,
    (not p.pix_rule or e.has_pending_pix) pix_ok,
    (not p.cashback_rule or e.has_cashback) cashback_ok,
    (p.withdrawal_rule='any' or (p.withdrawal_rule='yes' and e.has_withdrawal) or (p.withdrawal_rule='never' and not e.has_withdrawal)) withdrawal_ok,
    (not p.withdrawal_pending_rule or e.has_pending_withdrawal) withdrawal_pending_ok,
    (p.level_rule is null or p.level_rule='null' or e.level=p.level_rule) level_ok,
    (case p.timing_rule
      when 'cooling' then e.has_deposit and e.inactive_days>=e.cooling and e.inactive_days<e.sleeping
      when 'sleeping' then e.has_deposit and e.inactive_days>=e.sleeping
      when 'inactive30' then e.has_deposit and e.inactive_days>=30
      when 'inactive90' then e.has_deposit and e.inactive_days>=90
      when 'custom' then e.has_deposit and e.inactive_days>=p.custom_days
      when 'registered_week' then e.registered_week
      else true end) timing_ok,
    (p.days_without_login is null or e.login_days>=p.days_without_login)
      and (p.days_since_registration is null or e.registration_days>=p.days_since_registration)
      and (not p.dead_rule or e.is_dead) extra_ok
  from enriched e cross join params p
),
matched as (
  select * from flags
  where deposit_ok and pix_ok and cashback_ok and withdrawal_ok and withdrawal_pending_ok
    and level_ok and timing_ok and extra_ok
),
counts as (
  select
    count(*) filter (where not has_deposit and pix_ok and cashback_ok and withdrawal_ok and withdrawal_pending_ok and extra_ok) deposit_never,
    count(*) filter (where has_deposit and pix_ok and cashback_ok and withdrawal_ok and withdrawal_pending_ok and level_ok and timing_ok and extra_ok) deposit_yes,
    count(*) filter (where deposit_ok and has_pending_pix and cashback_ok and withdrawal_ok and withdrawal_pending_ok and level_ok and timing_ok and extra_ok) pix_unpaid,
    count(*) filter (where deposit_ok and pix_ok and cashback_ok and has_withdrawal and withdrawal_pending_ok and level_ok and timing_ok and extra_ok) withdrawal_yes,
    count(*) filter (where deposit_ok and pix_ok and cashback_ok and not has_withdrawal and withdrawal_pending_ok and level_ok and timing_ok and extra_ok) withdrawal_never,
    count(*) filter (where deposit_ok and pix_ok and cashback_ok and withdrawal_ok and has_pending_withdrawal and level_ok and timing_ok and extra_ok) withdrawal_pending,
    count(*) filter (where deposit_ok and pix_ok and has_cashback and withdrawal_ok and withdrawal_pending_ok and level_ok and timing_ok and extra_ok) cashback,
    count(*) filter (where activity_ok and timing_ok and extra_ok and level='bronze') bronze,
    count(*) filter (where activity_ok and timing_ok and extra_ok and level='silver') silver,
    count(*) filter (where activity_ok and timing_ok and extra_ok and level='gold') gold,
    count(*) filter (where activity_ok and timing_ok and extra_ok and level='diamond') diamond,
    count(*) filter (where activity_ok and timing_ok and extra_ok and level='black') black,
    count(*) filter (where activity_ok and level_ok and extra_ok and has_deposit and inactive_days>=cooling and inactive_days<sleeping) cooling_count,
    count(*) filter (where activity_ok and level_ok and extra_ok and has_deposit and inactive_days>=sleeping) sleeping_count,
    count(*) filter (where activity_ok and level_ok and extra_ok and has_deposit and inactive_days>=30) inactive30_count,
    count(*) filter (where activity_ok and level_ok and extra_ok and has_deposit and inactive_days>=90) inactive90_count
  from (
    select f.*,(deposit_ok and pix_ok and cashback_ok and withdrawal_ok and withdrawal_pending_ok) activity_ok
    from flags f
  ) x
),
phone_list as (
  select coalesce(jsonb_agg(phone order by phone),'[]'::jsonb) value,count(*)::int count
  from (select distinct phone from matched where length(phone)>=10) p
),
email_list as (
  select coalesce(jsonb_agg(id),'[]'::jsonb) value,count(*)::int count
  from matched where nullif(trim(email),'') is not null
),
matched_count as (select count(*)::int value from matched)
select jsonb_build_object(
  'phones',pl.value,
  'total',mc.value,
  'recipientTotal',pl.count,
  'emailPlayerIds',el.value,
  'emailRecipientTotal',el.count,
  'deadLeadsFilter',pr.dead_rule,
  'affiliateScoped',sc.scoped,
  'facets',jsonb_build_object(
    'activity',jsonb_build_object(
      'depositNever',c.deposit_never,'depositYes',c.deposit_yes,'pixUnpaid',c.pix_unpaid,
      'withdrawalYes',c.withdrawal_yes,'withdrawalNever',c.withdrawal_never,
      'withdrawalPending',c.withdrawal_pending,'cashback',c.cashback),
    'levels',jsonb_build_object('bronze',c.bronze,'silver',c.silver,'gold',c.gold,'diamond',c.diamond,'black',c.black),
    'timings',jsonb_build_object('cooling',c.cooling_count,'sleeping',c.sleeping_count,'inactive30',c.inactive30_count,'inactive90',c.inactive90_count)
  ),
  'settings',jsonb_build_object(
    'thresholds',jsonb_build_object('bronze',s.bronze,'silver',s.silver,'gold',s.gold,'diamond',s.diamond,'black',s.black),
    'cooling',s.cooling,'sleeping',s.sleeping)
)
from guard g cross join settings s cross join params pr cross join scope sc cross join counts c cross join phone_list pl cross join email_list el cross join matched_count mc
where g.ok;
$function$;

-- ─── 8. Purga de seleções: preserva as de campanha aguardando aprovação ─────
-- base: 20261026100000_purge_stale_selection_audiences.sql.

create or replace function public.purge_stale_selection_audiences(_older_than interval default interval '30 days')
returns integer
language sql
security definer
set search_path = public
as $$
  with removed as (
    delete from public.sms_audiences a
    where a.criteria ->> 'timing' = 'selection'
      and greatest(a.created_at, a.updated_at) < now() - _older_than
      and not exists (
        select 1 from public.campaign_drafts d
        where d.tenant_id = a.tenant_id
          and (d.audience_id = a.id::text or d.audience_criteria ->> 'audienceId' = a.id::text)
      )
      and not exists (
        select 1 from public.sms_campaigns c
        where c.tenant_id = a.tenant_id
          and c.status in ('agendada', 'enviando', 'pausada', 'aguardando_aprovacao')
          and c.audience_criteria ->> 'audienceId' = a.id::text
      )
      and not exists (
        select 1 from public.email_campaigns e
        where e.tenant_id = a.tenant_id
          and e.expert_id is not null
          and e.status in ('agendada', 'enviando', 'pausada', 'aguardando_aprovacao')
          and e.audience_filter #>> '{audience_criteria,audienceId}' = a.id::text
      )
      and not exists (
        select 1 from public.expert_voice_campaigns v
        where v.tenant_id = a.tenant_id
          and v.status in ('aguardando_aprovacao', 'enfileirada', 'pausada')
          and v.audience_criteria ->> 'audienceId' = a.id::text
      )
    returning 1
  )
  select count(*)::integer from removed;
$$;

revoke all on function public.purge_stale_selection_audiences(interval) from public, anon, authenticated;
grant execute on function public.purge_stale_selection_audiences(interval) to service_role;
