-- Área do Expert — fase 3: crédito por depósito.
--
-- * expert_settings: per-house click window (hours) used by the attribution.
-- * expert_deposit_credits: at most one expert per approved deposit, the
--   basis of the commission paid outside the system. Computed in batch (the
--   deposits imported by the sync scripts never pass through the webhook,
--   and clicks always precede the deposit), so recomputing any date range at
--   any time yields the same rows.
-- * refresh_expert_credits(tenant, from, to): delete + reinsert the house's
--   credits with deposit_at in [from, to), plus those of deposits whose
--   created_at is now in that range (created_at can be re-upserted by the
--   sync scripts); the insert upserts on deposit_id. Rule (rule_version 1):
--     1. clique: the latest human click (occurred_at desc, id desc) on a
--        link_dispatches row with source_type 'expert', send_status 'sent',
--        sent to the depositing player, with occurred_at in
--        [greatest(sent_at, deposit - window), deposit]. The expert is
--        source_id (non-uuid values ignored), and must be an expert of the
--        same house;
--     2. otherwise afiliado: the expert whose expert_affiliate_history row
--        for btrim(players.affiliate_id) in this house covers the deposit
--        time (valid_from <= deposit < valid_to, or still open), and only
--        for deposits at or after experts.created_at;
--     3. otherwise no credit.
--   An expert gets no credit (click or affiliate) for deposits at or after
--   experts.desativado_em (set while the profile is deactivated): a click
--   of a deactivated expert is skipped, the next eligible click or the
--   affiliate fallback applies.
-- * expert_affiliate_history: who owned each affiliate id of the house and
--   when (one open row per current expert_affiliates row). save_expert is
--   redefined here to apply only the diff of the affiliate ids (untouched
--   ids keep their row and created_at; removed ids close their history row,
--   added ids open one), so editing a profile or moving an id between
--   experts never rewrites who earned the past deposits. delete_expert
--   closes the history too, and refuses a profile with credits
--   ('expert_has_credits'): expert_deposit_credits.expert_id is ON DELETE
--   NO ACTION, the credits are the commission history.
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

-- 0a. experts.desativado_em ----------------------------------------------------
--     Set by setExpertActive(false), cleared on reactivation. Profiles that
--     are already inactive take their last update as the deactivation time
--     (updated_at only moves forward after the deactivation, so this never
--     withholds credit from deposits made while the profile was active).

alter table public.experts
  add column if not exists desativado_em timestamptz;

update public.experts
set desativado_em = updated_at
where not ativo and desativado_em is null;

-- 0a2. experts.ja_vinculado -------------------------------------------------
--      Tracks whether the profile was ever linked to a person. The first
--      link to a never-linked profile always succeeds even with credits
--      (the normal flow: admin creates the profile with affiliate ids, the
--      cron credits deposits, only then the intended person is invited or
--      linked); once linked, credits can no longer move to someone else.
--      Set alongside user_id by inviteExpertFor/linkExpertToTeamMemberFor
--      (experts-admin.functions.ts) and never cleared by
--      removeExpertAccessFor.

alter table public.experts
  add column if not exists ja_vinculado boolean not null default false;

update public.experts
set ja_vinculado = true
where user_id is not null;

-- 0b. expert_affiliate_history ---------------------------------------------------

create table if not exists public.expert_affiliate_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  affiliate_id text not null,
  expert_id uuid not null references public.experts(id) on delete cascade,
  valid_from timestamptz not null,
  valid_to timestamptz,
  check (valid_to is null or valid_to > valid_from)
);

create index if not exists expert_affiliate_history_lookup_idx
  on public.expert_affiliate_history (tenant_id, affiliate_id, valid_from);
-- At most one current owner per affiliate id of a house (as expert_affiliates).
create unique index if not exists expert_affiliate_history_open_uniq
  on public.expert_affiliate_history (tenant_id, affiliate_id)
  where valid_to is null;

alter table public.expert_affiliate_history enable row level security;

drop policy if exists expert_affiliate_history_manager_select on public.expert_affiliate_history;
create policy expert_affiliate_history_manager_select on public.expert_affiliate_history
  as permissive for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = any ((select public.managed_tenant_ids())::uuid[]));

grant select on public.expert_affiliate_history to authenticated;
grant all on public.expert_affiliate_history to service_role;
revoke all on public.expert_affiliate_history from anon;
revoke insert, update, delete, truncate on public.expert_affiliate_history from authenticated;

-- Backfill: one open row per current expert_affiliates row.
insert into public.expert_affiliate_history (tenant_id, affiliate_id, expert_id, valid_from)
select ea.tenant_id, ea.affiliate_id, ea.expert_id, ea.created_at
from public.expert_affiliates ea
where not exists (
  select 1 from public.expert_affiliate_history h
  where h.tenant_id = ea.tenant_id and h.affiliate_id = ea.affiliate_id and h.valid_to is null
);

-- 0c. save_expert / delete_expert (phase 1, 20261025100100) redefined ---------
--     Same signatures, error codes and players.expert label sync.

create or replace function public.save_expert(
  _tenant uuid,
  _expert_id uuid,
  _nome text,
  _tipo text,
  _affiliate_ids text[],
  _envio_modo text,
  _teto_mensal numeric,
  _assumir_prazo_dias integer
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_expert_id uuid;
  v_old_nome text;
  v_expert_tenant uuid;
  v_ids text[];
  v_taken text;
begin
  _nome := btrim(_nome);
  if _nome is null or _nome = '' then
    raise exception 'expert_nome_required';
  end if;

  select array_agg(distinct btrim(v))
  into v_ids
  from unnest(coalesce(_affiliate_ids, array[]::text[])) as v
  where btrim(v) <> '';
  v_ids := coalesce(v_ids, array[]::text[]);

  if _expert_id is null then
    insert into public.experts (tenant_id, nome, tipo, envio_modo, teto_mensal, assumir_prazo_dias)
    values (_tenant, _nome, _tipo, _envio_modo, _teto_mensal, _assumir_prazo_dias)
    returning id into v_expert_id;
    v_old_nome := _nome;
  else
    select nome, tenant_id
    into v_old_nome, v_expert_tenant
    from public.experts
    where id = _expert_id
    for update;

    if v_expert_tenant is null or v_expert_tenant <> _tenant then
      raise exception 'expert_not_found';
    end if;

    update public.experts
    set nome = _nome,
        tipo = _tipo,
        envio_modo = _envio_modo,
        teto_mensal = _teto_mensal,
        assumir_prazo_dias = _assumir_prazo_dias,
        updated_at = now()
    where id = _expert_id;

    v_expert_id := _expert_id;
  end if;

  select affiliate_id
  into v_taken
  from public.expert_affiliates
  where tenant_id = _tenant
    and expert_id <> v_expert_id
    and affiliate_id = any(v_ids)
  limit 1;

  if v_taken is not null then
    raise exception 'affiliate_taken:%', v_taken;
  end if;

  -- Removed ids: close their history row (a row opened in this same
  -- transaction would have no length, so it is dropped instead), then
  -- delete them. Untouched ids are left alone.
  delete from public.expert_affiliate_history h
  where h.tenant_id = _tenant
    and h.expert_id = v_expert_id
    and h.valid_to is null
    and h.valid_from >= now()
    and not (h.affiliate_id = any(v_ids));

  update public.expert_affiliate_history h
  set valid_to = now()
  where h.tenant_id = _tenant
    and h.expert_id = v_expert_id
    and h.valid_to is null
    and not (h.affiliate_id = any(v_ids));

  delete from public.expert_affiliates
  where expert_id = v_expert_id
    and not (affiliate_id = any(v_ids));

  -- Added ids: insert them and open their history row.
  with added as (
    insert into public.expert_affiliates (tenant_id, expert_id, affiliate_id)
    select _tenant, v_expert_id, x
    from unnest(v_ids) as x
    where not exists (
      select 1 from public.expert_affiliates ea
      where ea.expert_id = v_expert_id and ea.affiliate_id = x
    )
    returning affiliate_id
  )
  insert into public.expert_affiliate_history (tenant_id, affiliate_id, expert_id, valid_from)
  select _tenant, a.affiliate_id, v_expert_id, now()
  from added a;

  update public.players
  set expert = _nome
  where tenant_id = _tenant
    and btrim(affiliate_id) = any(v_ids);

  update public.players
  set expert = null
  where tenant_id = _tenant
    and expert in (v_old_nome, _nome)
    -- coalesce: a null affiliate_id makes the comparison NULL, and
    -- "not NULL" would keep a stale label.
    and not coalesce(btrim(affiliate_id) = any(v_ids), false);

  return v_expert_id;
end;
$$;

revoke all on function public.save_expert(uuid, uuid, text, text, text[], text, numeric, integer)
  from public, anon, authenticated;
grant execute on function public.save_expert(uuid, uuid, text, text, text[], text, numeric, integer)
  to service_role;

create or replace function public.delete_expert(_tenant uuid, _expert_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_nome text;
begin
  select user_id, nome
  into v_user_id, v_nome
  from public.experts
  where id = _expert_id and tenant_id = _tenant
  for update;

  if not found then
    return;
  end if;

  if v_user_id is not null then
    raise exception 'expert_has_user';
  end if;

  -- The credits are the commission history: deactivate instead.
  if exists (
    select 1 from public.expert_deposit_credits c
    where c.tenant_id = _tenant and c.expert_id = _expert_id
  ) then
    raise exception 'expert_has_credits';
  end if;

  -- By affiliate id, and by name too (unique per house): a player labelled
  -- with this expert but with a null/other affiliate_id is cleared as well.
  update public.players p
  set expert = null
  where p.tenant_id = _tenant
    and (
      p.expert = v_nome
      or coalesce(
        btrim(p.affiliate_id) in (
          select affiliate_id from public.expert_affiliates where expert_id = _expert_id
        ),
        false
      )
    );

  update public.expert_affiliate_history
  set valid_to = now()
  where tenant_id = _tenant and expert_id = _expert_id and valid_to is null
    and valid_from < now();

  -- expert_affiliates and expert_affiliate_history rows of this expert
  -- cascade-delete with it.
  delete from public.experts where id = _expert_id and tenant_id = _tenant;
end;
$$;

revoke all on function public.delete_expert(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_expert(uuid, uuid) to service_role;

-- 0d. Expert click lookups ---------------------------------------------------------
--     refresh_expert_credits looks up, per deposit, the expert links sent
--     to that player (same literals as its click lateral); the "clicked
--     without deposit" list looks up the expert's own links.

create index if not exists link_dispatches_expert_recipient_idx
  on public.link_dispatches (tenant_id, recipient_player_id, sent_at)
  where source_type = 'expert' and send_status = 'sent';

create index if not exists link_dispatches_expert_source_idx
  on public.link_dispatches (tenant_id, source_id, sent_at)
  where source_type = 'expert' and send_status = 'sent';

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
  -- No cascade: a profile with credits cannot be deleted (delete_expert).
  expert_id uuid not null references public.experts(id),
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

  -- Also the deposits whose created_at moved into the range since their
  -- credit was stored (the sync scripts re-upsert created_at): their old row
  -- has a deposit_at outside the range and would collide on deposit_id.
  delete from public.expert_deposit_credits
  where tenant_id = _tenant
    and ((deposit_at >= _from and deposit_at < _to)
         or deposit_id in (
           select d.id from public.deposits d
           where d.tenant_id = _tenant and d.created_at >= _from and d.created_at < _to
         ));

  insert into public.expert_deposit_credits (
    deposit_id, tenant_id, player_id, expert_id, via, valor, deposit_at,
    link_dispatch_id, click_at, is_ftd, is_reativacao, click_window_hours, rule_version, computed_at
  )
  with
  deps as (
    select d.id, d.player_id, d.valor, d.created_at, p.affiliate_id, p.ftd_em,
           (select max(pd.created_at) from public.deposits pd
            where pd.tenant_id = _tenant and pd.player_id = d.player_id and pd.status = 'aprovado'
              and pd.created_at <= d.created_at
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
        and ld.sent_at <= dp.created_at
        and c.is_human
        and c.occurred_at >= greatest(ld.sent_at, dp.created_at - make_interval(hours => v_window))
        and c.occurred_at <= dp.created_at
        and (e.desativado_em is null or dp.created_at < e.desativado_em)
      order by c.occurred_at desc, c.id desc
      limit 1
    ) clk on true
    left join lateral (
      select h.expert_id
      from public.expert_affiliate_history h
      join public.experts e on e.id = h.expert_id and e.tenant_id = _tenant
      where clk.expert_id is null
        and h.tenant_id = _tenant
        and h.affiliate_id = btrim(dp.affiliate_id)
        and h.valid_from <= dp.created_at
        and (h.valid_to is null or dp.created_at < h.valid_to)
        and dp.created_at >= e.created_at
        and (e.desativado_em is null or dp.created_at < e.desativado_em)
      order by h.valid_from desc
      limit 1
    ) aff on true
  )
  select a.id, _tenant, a.player_id, a.expert_id, a.via, a.valor, a.created_at,
         a.link_dispatch_id, a.click_at,
         (a.prev_at is null and (a.ftd_em is null or a.ftd_em >= a.created_at - interval '10 minutes')),
         (a.prev_at is not null and a.created_at - a.prev_at >= make_interval(days => v_sleeping)),
         v_window, 1, now()
  from attributed a
  where a.expert_id is not null
  on conflict (deposit_id) do update set
    tenant_id = excluded.tenant_id,
    player_id = excluded.player_id,
    expert_id = excluded.expert_id,
    via = excluded.via,
    valor = excluded.valor,
    deposit_at = excluded.deposit_at,
    link_dispatch_id = excluded.link_dispatch_id,
    click_at = excluded.click_at,
    is_ftd = excluded.is_ftd,
    is_reativacao = excluded.is_reativacao,
    click_window_hours = excluded.click_window_hours,
    rule_version = excluded.rule_version,
    computed_at = excluded.computed_at;

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
    -- Late imports: the last 8 days once a day, 03:35 BRT (off the */10
    -- minutes, or it would always lose the try-lock to the recent run).
    perform cron.schedule(
      'betleads-expert-credits-week',
      '35 6 * * *',
      $cron$set statement_timeout = '900s'; select public.refresh_expert_credits_recent(8);$cron$
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
