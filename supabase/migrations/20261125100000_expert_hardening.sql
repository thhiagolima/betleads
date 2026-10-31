-- Hardening before experts can send campaigns (slice 4a).
--
-- 1. Expert PII over PostgREST: players_expert_select, deposits_expert_select
--    and withdrawals_expert_select (20261025100200_expert_rls.sql) let a
--    logged-in expert read every column of the players it can see (cpf,
--    email, data_nascimento, saldo_carteira...) straight from the REST API.
--    Every expert server function now reads with supabaseAdmin, filtered by
--    house + affiliate ids and with an explicit column list
--    (expert-leads.functions.ts was the last one on the user client), so the
--    three policies and their helpers (current_expert_tenant_id/_tipo/
--    _affiliate_ids, used by nothing else) go. experts_expert_select_own and
--    expert_affiliates_expert_select_own stay (own profile only).
-- 2. link_dispatches / tracked_links writable by any member of the house:
--    the FOR ALL policies of 20261015090000_consolidate_tenant_rls.sql become
--    SELECT-only (same USING) and authenticated/anon lose the write
--    privileges. Every writer in the app already uses supabaseAdmin
--    (service_role) and the click trigger is SECURITY DEFINER.
-- 3. Expert credit rule_version 2 (refresh_expert_credits): a click of expert
--    E no longer takes a deposit from a player whose affiliate id belongs to
--    a DIFFERENT eligible expert at the deposit time (same eligibility as the
--    affiliate fallback: history row covering the deposit, deposit after the
--    expert's created_at and before its desativado_em). Only clicks of the
--    affiliate owner count for such a player; players without an eligible
--    owner keep "latest click wins". Stored credits carry the version; the
--    crons only recompute the last 8 days, so older credits keep version 1.
--
-- Idempotent. Deploy order: the application code of the same commit first
-- (expert-leads.functions.ts must already read with supabaseAdmin), then this
-- migration. Nothing in the code depends on this migration.

begin;

-- >>> section: expert_pii
drop policy if exists players_expert_select on public.players;
drop policy if exists deposits_expert_select on public.deposits;
drop policy if exists withdrawals_expert_select on public.withdrawals;

drop function if exists public.current_expert_affiliate_ids();
drop function if exists public.current_expert_tipo();
drop function if exists public.current_expert_tenant_id();
-- <<< section: expert_pii

-- >>> section: link_tables_read_only
drop policy if exists link_dispatches_tenant_rls on public.link_dispatches;
drop policy if exists link_dispatches_tenant_select on public.link_dispatches;
create policy link_dispatches_tenant_select on public.link_dispatches
  as permissive for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = any ((select public.accessible_tenant_ids())::uuid[]));

drop policy if exists tracked_links_tenant_rls on public.tracked_links;
drop policy if exists tracked_links_tenant_select on public.tracked_links;
create policy tracked_links_tenant_select on public.tracked_links
  as permissive for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = any ((select public.accessible_tenant_ids())::uuid[]));

revoke insert, update, delete, truncate on public.link_dispatches from authenticated, anon;
revoke insert, update, delete, truncate on public.tracked_links from authenticated, anon;
grant select on public.link_dispatches to authenticated;
grant select on public.tracked_links to authenticated;
-- <<< section: link_tables_read_only

-- >>> section: expert_credits_v2
-- Same body as 20261105143000_expert_credits.sql except: the affiliate owner
-- (`aff`) is resolved first, the click lateral only accepts clicks of that
-- owner when there is one, and rule_version is 2.
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
    -- The eligible owner of the player's affiliate id at the deposit time.
    left join lateral (
      select h.expert_id
      from public.expert_affiliate_history h
      join public.experts e on e.id = h.expert_id and e.tenant_id = _tenant
      where h.tenant_id = _tenant
        and h.affiliate_id = btrim(dp.affiliate_id)
        and h.valid_from <= dp.created_at
        and (h.valid_to is null or dp.created_at < h.valid_to)
        and dp.created_at >= e.created_at
        and (e.desativado_em is null or dp.created_at < e.desativado_em)
      order by h.valid_from desc
      limit 1
    ) aff on true
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
        -- rule_version 2: another expert's click never takes the deposit of
        -- a player whose affiliate id has an eligible owner.
        and (aff.expert_id is null or e.id = aff.expert_id)
      order by c.occurred_at desc, c.id desc
      limit 1
    ) clk on true
  )
  select a.id, _tenant, a.player_id, a.expert_id, a.via, a.valor, a.created_at,
         a.link_dispatch_id, a.click_at,
         (a.prev_at is null and (a.ftd_em is null or a.ftd_em >= a.created_at - interval '10 minutes')),
         (a.prev_at is not null and a.created_at - a.prev_at >= make_interval(days => v_sleeping)),
         v_window, 2, now()
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
-- <<< section: expert_credits_v2

commit;

notify pgrst, 'reload schema';
