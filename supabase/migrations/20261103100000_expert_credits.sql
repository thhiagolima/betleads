-- Área do Expert — fase 3: crédito por depósito.
--
-- * expert_settings: per-house click window (hours) used by the attribution.
-- * expert_deposit_credits: at most one expert per approved deposit, the
--   basis of the commission paid outside the system. Computed in batch (the
--   deposits imported by the sync scripts never pass through the webhook,
--   and clicks always precede the deposit), so recomputing any date range at
--   any time yields the same rows.
-- * refresh_expert_credits(tenant, from, to): delete + reinsert the house's
--   credits with deposit_at in [from, to). Rule (rule_version 1):
--     1. clique: the latest human click (occurred_at desc, id desc) on a
--        link_dispatches row with source_type 'expert', send_status 'sent',
--        sent to the depositing player, with occurred_at in
--        [greatest(sent_at, deposit - window), deposit]. The expert is
--        source_id (non-uuid values ignored), and must be an expert of the
--        same house;
--     2. otherwise afiliado: the house's expert_affiliates row whose
--        affiliate_id = btrim(players.affiliate_id), only for deposits at or
--        after greatest(experts.created_at, expert_affiliates.created_at);
--     3. otherwise no credit.
--   is_ftd: no earlier approved deposit of the player and players.ftd_em
--   null or at most 10 minutes before the deposit (same test as
--   refresh_crm_results_day). is_reativacao: the gap since the previous
--   approved deposit is >= gamification_settings.sleeping_after_days
--   (default 7). Deposits with the same created_at are ordered by id.
-- * refresh_expert_credits_recent(days): cron entry point, non-demo houses
--   with at least one expert, from (São Paulo today - days) 00:00 to now.
-- * Reads of expert_* data are restricted to admin/gestor of the house
--   (managed_tenant_ids()); everything else goes through service_role.

begin;

-- 1. expert_settings ---------------------------------------------------------

create table if not exists public.expert_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  click_window_hours integer not null default 72 check (click_window_hours between 1 and 720),
  updated_at timestamptz not null default now()
);

drop trigger if exists expert_settings_set_updated_at on public.expert_settings;
create trigger expert_settings_set_updated_at
  before update on public.expert_settings
  for each row execute function public.set_updated_at();

alter table public.expert_settings enable row level security;

drop policy if exists expert_settings_manager_select on public.expert_settings;
create policy expert_settings_manager_select on public.expert_settings
  as permissive for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = any ((select public.managed_tenant_ids())::uuid[]));

grant select on public.expert_settings to authenticated;
grant all on public.expert_settings to service_role;
revoke all on public.expert_settings from anon;
revoke insert, update, delete, truncate on public.expert_settings from authenticated;

-- 2. expert_deposit_credits --------------------------------------------------

create table if not exists public.expert_deposit_credits (
  deposit_id uuid primary key references public.deposits(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  expert_id uuid not null references public.experts(id) on delete cascade,
  via text not null check (via in ('clique', 'afiliado')),
  valor numeric not null,
  deposit_at timestamptz not null,
  link_dispatch_id uuid,
  click_at timestamptz,
  is_ftd boolean not null,
  is_reativacao boolean not null,
  click_window_hours integer not null,
  rule_version integer not null default 1,
  computed_at timestamptz not null default now()
);

create index if not exists expert_deposit_credits_tenant_expert_idx
  on public.expert_deposit_credits (tenant_id, expert_id, deposit_at desc);
create index if not exists expert_deposit_credits_tenant_deposit_at_idx
  on public.expert_deposit_credits (tenant_id, deposit_at desc);

alter table public.expert_deposit_credits enable row level security;

drop policy if exists expert_deposit_credits_manager_select on public.expert_deposit_credits;
create policy expert_deposit_credits_manager_select on public.expert_deposit_credits
  as permissive for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = any ((select public.managed_tenant_ids())::uuid[]));

grant select on public.expert_deposit_credits to authenticated;
grant all on public.expert_deposit_credits to service_role;
revoke all on public.expert_deposit_credits from anon;
revoke insert, update, delete, truncate on public.expert_deposit_credits from authenticated;

-- 3. refresh_expert_credits --------------------------------------------------

create or replace function public.refresh_expert_credits(_tenant uuid, _from timestamptz, _to timestamptz)
returns integer -- credits inserted
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_window integer;
  v_sleeping integer;
  v_rows integer;
begin
  if _tenant is null or _from is null or _to is null then
    raise exception 'refresh_expert_credits: tenant, from and to are required';
  end if;

  -- Serialises refreshes of the same house (the two crons, a manual run):
  -- overlapping delete + insert would otherwise collide on deposit_id.
  perform pg_advisory_xact_lock(hashtext('betleads.refresh_expert_credits.tenant'), hashtext(_tenant::text));

  v_window := coalesce(
    (select s.click_window_hours from public.expert_settings s where s.tenant_id = _tenant), 72);
  v_sleeping := coalesce(
    (select g.sleeping_after_days from public.gamification_settings g where g.tenant_id = _tenant), 7);

  delete from public.expert_deposit_credits
  where tenant_id = _tenant and deposit_at >= _from and deposit_at < _to;

  insert into public.expert_deposit_credits (
    deposit_id, tenant_id, player_id, expert_id, via, valor, deposit_at,
    link_dispatch_id, click_at, is_ftd, is_reativacao, click_window_hours, rule_version, computed_at
  )
  with
  deps as (
    select d.id, d.player_id, d.valor, d.created_at, p.affiliate_id, p.ftd_em,
           (select max(pd.created_at) from public.deposits pd
            where pd.tenant_id = _tenant and pd.player_id = d.player_id and pd.status = 'aprovado'
              and (pd.created_at, pd.id) < (d.created_at, d.id)) prev_at
    from public.deposits d
    join public.players p on p.id = d.player_id and p.tenant_id = _tenant
    where d.tenant_id = _tenant and d.status = 'aprovado'
      and d.created_at >= _from and d.created_at < _to
  ),
  attributed as (
    select dp.*,
           coalesce(clk.expert_id, aff.expert_id) expert_id,
           case when clk.expert_id is not null then 'clique' else 'afiliado' end via,
           clk.link_dispatch_id,
           clk.click_at
    from deps dp
    left join lateral (
      select e.id expert_id, ld.id link_dispatch_id, c.occurred_at click_at
      from public.link_dispatches ld
      join public.click_events c on c.link_dispatch_id = ld.id and c.tenant_id = _tenant
      join public.experts e
        on e.tenant_id = _tenant
       and e.id = case
                    when ld.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    then ld.source_id::uuid
                  end
      where ld.tenant_id = _tenant
        and ld.recipient_player_id = dp.player_id
        and ld.source_type = 'expert'
        and ld.send_status = 'sent'
        and ld.sent_at is not null
        and c.is_human
        and c.occurred_at >= greatest(ld.sent_at, dp.created_at - make_interval(hours => v_window))
        and c.occurred_at <= dp.created_at
      order by c.occurred_at desc, c.id desc
      limit 1
    ) clk on true
    left join lateral (
      select ea.expert_id
      from public.expert_affiliates ea
      join public.experts e on e.id = ea.expert_id and e.tenant_id = _tenant
      where clk.expert_id is null
        and ea.tenant_id = _tenant
        and ea.affiliate_id = btrim(dp.affiliate_id)
        and dp.created_at >= greatest(e.created_at, ea.created_at)
      limit 1
    ) aff on true
  )
  select a.id, _tenant, a.player_id, a.expert_id, a.via, a.valor, a.created_at,
         a.link_dispatch_id, a.click_at,
         (a.prev_at is null and (a.ftd_em is null or a.ftd_em >= a.created_at - interval '10 minutes')),
         (a.prev_at is not null and a.created_at - a.prev_at >= make_interval(days => v_sleeping)),
         v_window, 1, now()
  from attributed a
  where a.expert_id is not null;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.refresh_expert_credits(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.refresh_expert_credits(uuid, timestamptz, timestamptz) to service_role;

-- 4. refresh_expert_credits_recent -------------------------------------------

create or replace function public.refresh_expert_credits_recent(_days integer default 2)
returns integer -- houses that failed (-1 = skipped, another run holds the lock)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_from timestamptz :=
    (((now() at time zone 'America/Sao_Paulo')::date - greatest(_days, 0))::timestamp
      at time zone 'America/Sao_Paulo');
  v_to timestamptz := now();
  v_tenant uuid;
  v_failed integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('betleads.refresh_expert_credits')::bigint) then
    return -1;
  end if;
  for v_tenant in
    select t.id from public.tenants t
    where not t.is_demo
      and exists (select 1 from public.experts e where e.tenant_id = t.id)
    order by t.id
  loop
    begin
      perform public.refresh_expert_credits(v_tenant, v_from, v_to);
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'refresh_expert_credits: tenant % failed: % %', v_tenant, sqlstate, left(sqlerrm, 200);
    end;
  end loop;
  return v_failed;
end;
$$;

revoke all on function public.refresh_expert_credits_recent(integer) from public, anon, authenticated;
grant execute on function public.refresh_expert_credits_recent(integer) to service_role;

-- 5. Cron ----------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job
      where jobname in ('betleads-expert-credits-recent', 'betleads-expert-credits-week');
    -- Today, yesterday and the day before, every 10 minutes.
    perform cron.schedule(
      'betleads-expert-credits-recent',
      '*/10 * * * *',
      $cron$set statement_timeout = '300s'; select public.refresh_expert_credits_recent(2);$cron$
    );
    -- Late imports: the last 8 days once a day, 03:30 BRT.
    perform cron.schedule(
      'betleads-expert-credits-week',
      '30 6 * * *',
      $cron$set statement_timeout = '300s'; select public.refresh_expert_credits_recent(8);$cron$
    );
  end if;
end $$;

-- 6. Expert data readable only by admin/gestor of the house --------------------
--    Same policy names as 20261027100000_expert_lead_sheet.sql.

drop policy if exists expert_links_tenant_rls on public.expert_links;
create policy expert_links_tenant_rls on public.expert_links
  as permissive for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = any ((select public.managed_tenant_ids())::uuid[]));

drop policy if exists expert_lead_contacts_tenant_rls on public.expert_lead_contacts;
create policy expert_lead_contacts_tenant_rls on public.expert_lead_contacts
  as permissive for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = any ((select public.managed_tenant_ids())::uuid[]));

drop policy if exists expert_lead_followups_tenant_rls on public.expert_lead_followups;
create policy expert_lead_followups_tenant_rls on public.expert_lead_followups
  as permissive for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = any ((select public.managed_tenant_ids())::uuid[]));

drop policy if exists expert_lead_claims_tenant_rls on public.expert_lead_claims;
create policy expert_lead_claims_tenant_rls on public.expert_lead_claims
  as permissive for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = any ((select public.managed_tenant_ids())::uuid[]));

drop policy if exists expert_message_templates_tenant_rls on public.expert_message_templates;
create policy expert_message_templates_tenant_rls on public.expert_message_templates
  as permissive for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = any ((select public.managed_tenant_ids())::uuid[]));

commit;
