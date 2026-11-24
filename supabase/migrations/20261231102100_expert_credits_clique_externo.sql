-- Expert credit rule_version 3 (refresh_expert_credits): an expert who is
-- not the affiliate owner of a player now takes the FIRST approved deposit
-- after their own click (within the house click window). The player stays
-- with the affiliate owner: the next deposits go back to the owner (owner's
-- click, else affiliate), until the outside expert gets a new click.
--
-- rule_version 2 (20261125100000_expert_hardening.sql) never let another
-- expert's click take a deposit of a player with an eligible affiliate owner;
-- an expert who talked to the lead directly and got them to deposit was left
-- with nothing. Players without an eligible owner keep "latest click wins".
-- Stored credits carry the version; the crons recompute the last 8 days.
--
-- Idempotent. No application code depends on this migration.

begin;

-- >>> section: expert_credits_v3
-- Same body as 20261125100000_expert_hardening.sql (expert_credits_v2)
-- except the owner filter of the click lateral and rule_version 3.
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
        -- rule_version 3: on a player whose affiliate id has an eligible
        -- owner, another expert's click only takes the first approved
        -- deposit after it; the player stays with the owner.
        and (aff.expert_id is null or e.id = aff.expert_id
             or not exists (
               select 1 from public.deposits pd
               where pd.tenant_id = _tenant and pd.player_id = dp.player_id
                 and pd.status = 'aprovado'
                 and pd.created_at >= c.occurred_at
                 and (pd.created_at, pd.id) < (dp.created_at, dp.id)))
      order by c.occurred_at desc, c.id desc
      limit 1
    ) clk on true
  )
  select a.id, _tenant, a.player_id, a.expert_id, a.via, a.valor, a.created_at,
         a.link_dispatch_id, a.click_at,
         (a.prev_at is null and (a.ftd_em is null or a.ftd_em >= a.created_at - interval '10 minutes')),
         (a.prev_at is not null and a.created_at - a.prev_at >= make_interval(days => v_sleeping)),
         v_window, 3, now()
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
-- <<< section: expert_credits_v3

commit;

notify pgrst, 'reload schema';
