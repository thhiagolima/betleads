// Conta própria de provedor por casa — Tarefa 4: custo informado na Central.
// SQL tests for supabase/migrations/20261219100300_crm_results_own_cost.sql

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (name: string) => readFileSync(resolve(root, "supabase/migrations", name), "utf8");

const MIGRATION = read("20261016130000_crm_results_daily.sql");
const HEALTH_MIGRATION = read("20261016190000_crm_results_health.sql");
const PRICE_MIGRATION = read("20261016200000_sms_price_0059.sql");
const DIRECT_PLAYERS_MIGRATION = read("20261016210000_crm_direct_players.sql");
const INCREMENTAL_MIGRATION = read("20261019120000_crm_click_conversion_incremental.sql");
const CAMPAIGN_ID_MIGRATION = read("20261016170000_sms_log_campaign_id.sql");
const FINISHED_WITHOUT_MESSAGE_MIGRATION = read("20261120100000_journey_metrics_finished_without_message.sql");
const DORMANT_FIRST_DEPOSIT_MIGRATION = read("20261109100000_crm_influenced_dormant_first_deposit.sql");
const LATE_DAYS_MIGRATION = read("20261202100000_crm_results_late_days.sql");
const CONSUMO_P0_MIGRATION = read("20261129100000_supabase_consumo_p0.sql");
const OWN_COST_MIGRATION = read("20261219100300_crm_results_own_cost.sql");

// The current refresh_crm_results_day reads the SMS price through
// crm_sms_report_price (billing); stand-in with the legacy price chain.
const REPORT_PRICE_STUB = `
alter table public.sms_send_logs add column if not exists billed_units integer;
create or replace function public.crm_sms_report_price(_tenant uuid, _at timestamptz)
returns numeric language sql stable as $$
  select coalesce(
    (select sale_price_per_sms from public.tenant_sms_pricing where tenant_id = _tenant),
    (select default_sale_price_per_sms from public.sms_credit_settings limit 1),
    0.12)
$$;
`;

// provider_accounts / provider_account_id: added by Task 1
// (20261219100000_own_provider_accounts.sql). Stand-in with the columns this
// function reads: id, owner_tenant_id, own_unit_cost.
const PROVIDER_ACCOUNTS_STUB = `
create table public.provider_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_tenant_id uuid,
  own_unit_cost numeric(12, 4)
);
alter table public.sms_send_logs add column if not exists provider_account_id uuid;
`;

const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create table public.tenants (id uuid primary key, slug text);
create function public.has_tenant_access(_tenant uuid) returns boolean language sql as $$ select true $$;
create schema auth;
create function auth.role() returns text language sql as $$ select 'service_role' $$;
create table public.journeys (id uuid primary key, tenant_id uuid);
create table public.journey_enrollments (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, journey_id uuid, status text,
  exit_reason text, current_position integer);
create table public.players (
  id uuid primary key, tenant_id uuid, ftd_em timestamptz,
  created_at timestamptz not null default '2026-08-01');
create table public.deposits (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, player_id uuid,
  valor numeric, status text, created_at timestamptz, updated_at timestamptz not null default now());
create table public.sms_send_logs (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, player_id uuid, status text,
  trigger_name text, idempotency_key text, created_at timestamptz);
create table public.journey_step_executions (
  id uuid primary key default gen_random_uuid(), idempotency_key uuid, step_position integer,
  tenant_id uuid, journey_id uuid, channel text, status text, enrollment_id uuid);
create table public.sms_campaigns (
  id uuid primary key, tenant_id uuid, name text, created_at timestamptz, status text default 'enviado');
create table public.link_dispatches (
  id uuid primary key, tenant_id uuid, source_type text, source_id text,
  journey_step_position integer, recipient_player_id uuid, sent_at timestamptz,
  created_at timestamptz default now(), message_log_id text, idempotency_key text,
  channel text default 'sms', send_status text default 'sent', delivery_status text);
create table public.click_events (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, link_dispatch_id uuid,
  is_human boolean, occurred_at timestamptz);
create table public.conversion_attributions (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, link_dispatch_id uuid,
  source_type text, source_id uuid, player_id uuid, window_started_at timestamptz,
  classification text, event_type text, monetary_value numeric, occurred_at timestamptz);
create table public.tenant_sms_pricing (
  tenant_id uuid primary key, sale_price_per_sms numeric, provider_cost_per_sms numeric,
  updated_at timestamptz default now());
create table public.sms_credit_settings (
  id boolean primary key default true, default_sale_price_per_sms numeric,
  provider_cost_per_sms numeric, updated_at timestamptz);
insert into public.sms_credit_settings (id, default_sale_price_per_sms, provider_cost_per_sms)
values (true, 0.12, 0.05);
create table public.sms_credit_ledger (
  tenant_id uuid, delta_credits integer, entry_type text, unit_sale_price numeric, created_at timestamptz);
`;

const T = "00000000-0000-4000-8000-000000000001";
const OWN_ACCOUNT = "00000000-0000-4000-8000-0000000000aa";
const MISSING_ACCOUNT = "00000000-0000-4000-8000-0000000000bb"; // never inserted
const DAY = "2026-10-10";
const at = (time: string) => `${DAY}T${time}:00-03:00`;

let db: PGlite;

async function applyBaseMigrations() {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(`begin; ${MIGRATION}; commit;`);
  await db.exec(`begin; ${CAMPAIGN_ID_MIGRATION}; commit;`);
  await db.exec(`begin; ${HEALTH_MIGRATION}; commit;`);
  await db.exec(`
    insert into tenants (id, slug) values
      ('00000000-0000-4000-8000-0000000000b1', 'pixpgf'),
      ('00000000-0000-4000-8000-0000000000b2', 'pixreals'),
      ('00000000-0000-4000-8000-0000000000b3', 'forrandobet'),
      ('${T}', 'casa-x');
  `);
  await db.exec(`begin; ${PRICE_MIGRATION}; commit;`);
  await db.exec(`begin; ${DIRECT_PLAYERS_MIGRATION}; commit;`);
  await db.exec(`begin; ${INCREMENTAL_MIGRATION}; commit;`);
  await db.exec(REPORT_PRICE_STUB);
  await db.exec(`begin; ${DORMANT_FIRST_DEPOSIT_MIGRATION}; commit;`);
  await db.exec(`begin; ${FINISHED_WITHOUT_MESSAGE_MIGRATION}; commit;`);
  await db.exec(`begin; ${CONSUMO_P0_MIGRATION}; commit;`);
  await db.exec(`begin; ${LATE_DAYS_MIGRATION}; commit;`);
  await db.exec(PROVIDER_ACCOUNTS_STUB);
  // Sale price 0,08 for this tenant.
  await db.exec(`
    insert into tenant_sms_pricing (tenant_id, sale_price_per_sms) values ('${T}', 0.08);
    insert into provider_accounts (id, owner_tenant_id, own_unit_cost) values
      ('${OWN_ACCOUNT}', '${T}', 0.05);
    insert into sms_send_logs (tenant_id, status, trigger_name, idempotency_key, created_at, billed_units, provider_account_id) values
      ('${T}', 'sent', 'outro', 'k-own', '${at("10:00")}', 2, '${OWN_ACCOUNT}'),
      ('${T}', 'sent', 'outro', 'k-platform', '${at("10:01")}', 2, null);
  `);
}

async function costOf(trigger: string): Promise<number> {
  const { rows } = await db.query<{ cost: string }>(
    `select cost from crm_results_daily where tenant_id = $1 and metric_date = $2 and source_key = $3`,
    [T, DAY, trigger],
  );
  return Number(rows[0]?.cost ?? 0);
}

async function totalCost(): Promise<number> {
  const { rows } = await db.query<{ total: string }>(
    `select coalesce(sum(cost), 0) total from crm_results_daily where tenant_id = $1 and metric_date = $2`,
    [T, DAY],
  );
  return Number(rows[0].total);
}

afterAll(async () => {
  await db?.close();
});

describe("custo informado na Central (conta própria)", () => {
  beforeAll(async () => {
    await applyBaseMigrations();
    await db.exec(`begin; ${OWN_COST_MIGRATION}; commit;`);
    await db.query(`select refresh_crm_results_day($1, $2::date)`, [T, DAY]);
  }, 60_000);

  it("SMS da conta própria usa o custo informado", async () => {
    // own: 2 * 0,05 = 0,10; platform: 2 * 0,08 = 0,16; total 0,26.
    expect(await totalCost()).toBeCloseTo(0.26);
  });

  it("conta própria sem custo informado custa 0", async () => {
    await db.exec(`update provider_accounts set own_unit_cost = null where id = '${OWN_ACCOUNT}'`);
    await db.query(`select refresh_crm_results_day($1, $2::date)`, [T, DAY]);
    // own: 2 * 0 = 0; platform: 2 * 0,08 = 0,16; total 0,16.
    expect(await totalCost()).toBeCloseTo(0.16);
  });

  it("conta inexistente no log não quebra", async () => {
    await db.exec(`
      insert into sms_send_logs (tenant_id, status, trigger_name, idempotency_key, created_at, billed_units, provider_account_id) values
        ('${T}', 'sent', 'outro', 'k-missing', '${at("10:02")}', 2, '${MISSING_ACCOUNT}');
    `);
    await expect(
      db.query(`select refresh_crm_results_day($1, $2::date)`, [T, DAY]),
    ).resolves.toBeTruthy();
    // k-missing priced at the sale price (0,08): 2 * 0,08 = 0,16, added to
    // the previous total (own_unit_cost null from the test above: 0,16).
    expect(await totalCost()).toBeCloseTo(0.32);
  });
});
