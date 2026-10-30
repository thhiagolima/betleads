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

commit;

notify pgrst, 'reload schema';
