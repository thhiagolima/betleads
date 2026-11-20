-- Públicos: "Cadastrou ontem" e "Só fez o 1º depósito".
-- base: corpo de 20261210100200_audience_player_ids.sql, idêntico, mais:
--   * `registeredYesterday` (boolean): cadastro no dia anterior inteiro,
--     00:00–23:59 de Brasília. Virou o dia, o jogador sai do público.
--   * `activity.deposit = 'first_only'`: tem 1º depósito (ftd_em) e nenhum
--     depósito aprovado depois dele (mesma regra de redepósito da tela Início:
--     aprovado com created_at > ftd_em + 1 minuto).
--   * facetas activity.depositFirstOnly e activity.registeredYesterday.
--   * flags `firstDepositFilter` / `registeredYesterdayFilter` no retorno: o
--     servidor recusa o público se o banco ainda tiver a função anterior.

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
    coalesce((_criteria->>'deadLeads')::boolean,false) dead_rule,
    coalesce((_criteria->>'registeredYesterday')::boolean,false) registered_yesterday_rule
),
-- Dia de ontem em Brasília: [00:00 de ontem, 00:00 de hoje).
day_bounds as (
  select
    ((date_trunc('day',now() at time zone 'America/Sao_Paulo') - interval '1 day') at time zone 'America/Sao_Paulo') yesterday_start,
    (date_trunc('day',now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo') today_start
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
-- Quem já fez um depósito aprovado depois do 1º (redepósito).
redeposit_players as (
  select distinct d.player_id
  from public.deposits d
  join public.players p on p.id=d.player_id and p.tenant_id=_tenant
  where d.tenant_id=_tenant and d.status='aprovado' and d.player_id is not null
    and p.ftd_em is not null and d.created_at > p.ftd_em + interval '1 minute'
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
    (p.ftd_em is not null and rd.player_id is null) first_deposit_only,
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
    (p.created_at >= db.yesterday_start and p.created_at < db.today_start) registered_yesterday,
    s.*
  from public.players p
  cross join settings s
  cross join scope sc
  cross join day_bounds db
  left join pending_deposits pd on pd.player_id=p.id
  left join redeposit_players rd on rd.player_id=p.id
  left join withdrawal_flags wf on wf.player_id=p.id
  left join dead_players dp on dp.player_id=p.id
  where p.tenant_id=_tenant
    and (not sc.scoped or btrim(p.affiliate_id) = any(sc.affiliate_ids))
),
flags as (
  select e.*,p.*,
    (p.deposit_rule='any' or (p.deposit_rule='yes' and e.has_deposit) or (p.deposit_rule='never' and not e.has_deposit)
      or (p.deposit_rule='first_only' and e.first_deposit_only)) deposit_ok,
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
      and (not p.dead_rule or e.is_dead) extra_base_ok,
    (not p.registered_yesterday_rule or e.registered_yesterday) registered_ok
  from enriched e cross join params p
),
flags_all as (
  select f.*,(f.extra_base_ok and f.registered_ok) extra_ok from flags f
),
matched as (
  select * from flags_all
  where deposit_ok and pix_ok and cashback_ok and withdrawal_ok and withdrawal_pending_ok
    and level_ok and timing_ok and extra_ok
),
counts as (
  select
    count(*) filter (where not has_deposit and pix_ok and cashback_ok and withdrawal_ok and withdrawal_pending_ok and extra_ok) deposit_never,
    count(*) filter (where has_deposit and pix_ok and cashback_ok and withdrawal_ok and withdrawal_pending_ok and level_ok and timing_ok and extra_ok) deposit_yes,
    count(*) filter (where first_deposit_only and pix_ok and cashback_ok and withdrawal_ok and withdrawal_pending_ok and level_ok and timing_ok and extra_ok) deposit_first_only,
    count(*) filter (where activity_ok and level_ok and timing_ok and extra_base_ok and registered_yesterday) registered_yesterday_count,
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
    from flags_all f
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
matched_count as (select count(*)::int value from matched),
-- Ids de jogadores do público: só calculado (e só exposto) quando a chamada
-- pede explicitamente (`includePlayerIds=true`), hoje o público do push. O
-- filtro fica dentro do FROM (não num CASE em torno do agregado) para que o
-- SMS, que nunca manda a flag, não pague o custo de agregar `matched` aqui:
-- com a flag ausente/false a CTE filtra para zero linhas e jsonb_agg devolve
-- null sem percorrer `matched`.
player_ids as (
  select jsonb_agg(id) value
  from matched
  where coalesce((_criteria->>'includePlayerIds')::boolean,false)
)
select jsonb_build_object(
  'phones',pl.value,
  'total',mc.value,
  'recipientTotal',pl.count,
  'emailPlayerIds',el.value,
  'emailRecipientTotal',el.count,
  'deadLeadsFilter',pr.dead_rule,
  'firstDepositFilter',(pr.deposit_rule='first_only'),
  'registeredYesterdayFilter',pr.registered_yesterday_rule,
  'affiliateScoped',sc.scoped,
  'facets',jsonb_build_object(
    'activity',jsonb_build_object(
      'depositNever',c.deposit_never,'depositYes',c.deposit_yes,'depositFirstOnly',c.deposit_first_only,
      'registeredYesterday',c.registered_yesterday_count,'pixUnpaid',c.pix_unpaid,
      'withdrawalYes',c.withdrawal_yes,'withdrawalNever',c.withdrawal_never,
      'withdrawalPending',c.withdrawal_pending,'cashback',c.cashback),
    'levels',jsonb_build_object('bronze',c.bronze,'silver',c.silver,'gold',c.gold,'diamond',c.diamond,'black',c.black),
    'timings',jsonb_build_object('cooling',c.cooling_count,'sleeping',c.sleeping_count,'inactive30',c.inactive30_count,'inactive90',c.inactive90_count)
  ),
  'settings',jsonb_build_object(
    'thresholds',jsonb_build_object('bronze',s.bronze,'silver',s.silver,'gold',s.gold,'diamond',s.diamond,'black',s.black),
    'cooling',s.cooling,'sleeping',s.sleeping)
) || case when coalesce((_criteria->>'includePlayerIds')::boolean,false)
  then jsonb_build_object('playerIds', coalesce(pi.value,'[]'::jsonb))
  else '{}'::jsonb end
from guard g cross join settings s cross join params pr cross join scope sc cross join counts c
  cross join phone_list pl cross join email_list el cross join matched_count mc cross join player_ids pi
where g.ok;
$function$;
