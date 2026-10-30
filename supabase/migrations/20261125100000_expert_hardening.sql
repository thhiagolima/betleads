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

commit;

notify pgrst, 'reload schema';
