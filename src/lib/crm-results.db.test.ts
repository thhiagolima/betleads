// Central de Resultados F1 — SQL tests for
// supabase/migrations/20261016130000_crm_results_daily.sql
// A small "golden" day with known expected results (Q-07).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const MIGRATION = readFileSync(
  resolve(root, "supabase/migrations/20261016130000_crm_results_daily.sql"),
  "utf8",
);
const HEALTH_MIGRATION = readFileSync(
  resolve(root, "supabase/migrations/20261016190000_crm_results_health.sql"),
  "utf8",
);
const PRICE_MIGRATION = readFileSync(
  resolve(root, "supabase/migrations/20261016200000_sms_price_0059.sql"),
  "utf8",
);
const DIRECT_PLAYERS_MIGRATION = readFileSync(
  resolve(root, "supabase/migrations/20261016210000_crm_direct_players.sql"),
  "utf8",
);
const INCREMENTAL_MIGRATION = readFileSync(
  resolve(root, "supabase/migrations/20261019120000_crm_click_conversion_incremental.sql"),
  "utf8",
);
const REPORTS_MIGRATION = readFileSync(
  resolve(root, "supabase/migrations/20261019150000_conversion_reports_exclude_active.sql"),
  "utf8",
);
const CAMPAIGN_ID_MIGRATION = readFileSync(
  resolve(root, "supabase/migrations/20261016170000_sms_log_campaign_id.sql"),
  "utf8",
);
const FINISHED_WITHOUT_MESSAGE_MIGRATION = readFileSync(
  resolve(root, "supabase/migrations/20261120100000_journey_metrics_finished_without_message.sql"),
  "utf8",
);
const DORMANT_FIRST_DEPOSIT_MIGRATION = readFileSync(
  resolve(root, "supabase/migrations/20261109100000_crm_influenced_dormant_first_deposit.sql"),
  "utf8",
);
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
  valor numeric, status text, created_at timestamptz);
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
const J1 = "00000000-0000-4000-8000-0000000000a1";
const J2 = "00000000-0000-4000-8000-0000000000a2";
const J3 = "00000000-0000-4000-8000-0000000000a3"; // welcome journey
const CAMPAIGN = "00000000-0000-4000-8000-0000000000c1";
const A = "00000000-0000-4000-8000-0000000000f1"; // cooling down, journey J1 step 2
const B = "00000000-0000-4000-8000-0000000000f2"; // active, campaign
const C = "00000000-0000-4000-8000-0000000000f3"; // never deposited, journey J2 step 0
const D = "00000000-0000-4000-8000-0000000000f4"; // old depositor, first deposit in our history
const E = "00000000-0000-4000-8000-0000000000f5"; // registered today, deposited after the welcome SMS
const LD1 = "00000000-0000-4000-8000-0000000000d1";
const LD2 = "00000000-0000-4000-8000-0000000000d2"; // campaign SMS clicked by the active player B
const KEY_A = "00000000-0000-4000-8000-0000000000e1";
const KEY_C = "00000000-0000-4000-8000-0000000000e2";
const DAY = "2026-10-10";
const at = (time: string) => `${DAY}T${time}:00-03:00`;

let db: PGlite;

type Row = {
  source_type: string;
  source_key: string;
  source_id: string | null;
  step_position: number;
  player_state: string;
  sent: number;
  failed: number;
  cost: string;
  recipients: number;
  human_clicks: number;
  direct_conversions: number;
  direct_players: number;
  direct_revenue: string;
  converted_clicks: number;
  direct_active_conversions: number;
  direct_active_players: number;
  direct_active_revenue: string;
  influenced_players: number;
  influenced_deposits: number;
  influenced_revenue: string;
};

async function rows(): Promise<Row[]> {
  return (
    await db.query<Row>(
      `select * from crm_results_daily where tenant_id = $1 and metric_date = $2
       order by source_type, source_key, step_position, player_state`,
      [T, DAY],
    )
  ).rows;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  // Applied twice: the migration must be idempotent.
  await db.exec(`begin; ${MIGRATION}; commit;`);
  await db.exec(`begin; ${MIGRATION}; commit;`);
  await db.exec(`begin; ${CAMPAIGN_ID_MIGRATION}; commit;`);
  await db.exec(`begin; ${CAMPAIGN_ID_MIGRATION}; commit;`);
  await db.exec(`begin; ${HEALTH_MIGRATION}; commit;`);
  await db.exec(`begin; ${HEALTH_MIGRATION}; commit;`);
  await db.exec(`
    insert into tenants (id, slug) values
      ('00000000-0000-4000-8000-0000000000b1', 'pixpgf'),
      ('00000000-0000-4000-8000-0000000000b2', 'pixreals'),
      ('00000000-0000-4000-8000-0000000000b3', 'forrandobet');
  `);
  await db.exec(`begin; ${PRICE_MIGRATION}; commit;`);
  await db.exec(`begin; ${PRICE_MIGRATION}; commit;`);
  await db.exec(`begin; ${DIRECT_PLAYERS_MIGRATION}; commit;`);
  await db.exec(`begin; ${DIRECT_PLAYERS_MIGRATION}; commit;`);
  await db.exec(`begin; ${INCREMENTAL_MIGRATION}; commit;`);
  await db.exec(`begin; ${INCREMENTAL_MIGRATION}; commit;`);
  await db.exec(REPORT_PRICE_STUB);
  await db.exec(`begin; ${DORMANT_FIRST_DEPOSIT_MIGRATION}; commit;`);
  await db.exec(`begin; ${DORMANT_FIRST_DEPOSIT_MIGRATION}; commit;`);
  await db.exec(`begin; ${FINISHED_WITHOUT_MESSAGE_MIGRATION}; commit;`);
  await db.exec(`begin; ${FINISHED_WITHOUT_MESSAGE_MIGRATION}; commit;`);
  // The home dashboard function reads tables this schema does not model.
  const reports = `begin; set local check_function_bodies = off; ${REPORTS_MIGRATION}; commit;`;
  await db.exec(reports);
  await db.exec(reports);
  await db.exec(`
    insert into tenants values ('${T}');
    insert into journeys values ('${J1}', '${T}'), ('${J2}', '${T}'), ('${J3}', '${T}');
    insert into players values ('${A}', '${T}', '2026-09-01'), ('${B}', '${T}', '2026-09-01'),
      ('${C}', '${T}', null), ('${D}', '${T}', '2026-08-01');
    insert into players (id, tenant_id, ftd_em, created_at) values
      ('${E}', '${T}', '${at("09:31")}', '${at("09:20")}');
    insert into sms_campaigns values ('${CAMPAIGN}', '${T}', 'Promo X', '2026-10-01');
    insert into journey_step_executions (idempotency_key, step_position) values
      ('${KEY_A}', 2), ('${KEY_C}', 0);
    insert into deposits (tenant_id, player_id, valor, status, created_at) values
      ('${T}', '${A}', 30, 'aprovado', '2026-10-05T10:00:00-03:00'),
      ('${T}', '${A}', 100, 'aprovado', '${at("15:00")}'),
      ('${T}', '${B}', 20, 'aprovado', '${at("08:00")}'),
      ('${T}', '${B}', 40, 'aprovado', '${at("11:00")}'),
      ('${T}', '${C}', 50, 'aprovado', '${at("12:00")}'),
      ('${T}', '${D}', 70, 'aprovado', '${at("13:00")}'),
      ('${T}', '${E}', 25, 'aprovado', '${at("09:30")}'),
      ('${T}', '${C}', 999, 'pendente', '${at("12:30")}');
    insert into sms_send_logs (tenant_id, player_id, status, trigger_name, idempotency_key, created_at) values
      ('${T}', '${A}', 'sent', 'journey:${J1}', '${KEY_A}', '${at("10:00")}'),
      ('${T}', '${B}', 'sent', 'campanha:Promo X:iGaming', 'k-b1', '${at("09:00")}'),
      ('${T}', '${B}', 'error', 'campanha:Promo X:iGaming', 'k-b2', '${at("09:01")}'),
      ('${T}', '${C}', 'sent', 'journey:${J2}', '${KEY_C}', '${at("09:00")}'),
      ('${T}', '${D}', 'sent', 'journey:${J2}', 'k-d', '${at("12:00")}'),
      ('${T}', '${E}', 'sent', 'journey:${J3}', 'k-e', '${at("09:21")}');
    insert into link_dispatches values
      ('${LD1}', '${T}', 'journey', '${J1}', 2, '${A}', '${at("10:00")}', '${at("10:00")}'),
      ('${LD2}', '${T}', 'campaign', '${CAMPAIGN}', null, '${B}', '${at("09:00")}', '${at("09:00")}');
    insert into click_events (tenant_id, link_dispatch_id, is_human, occurred_at) values
      ('${T}', '${LD1}', true, '${at("10:05")}'),
      ('${T}', '${LD1}', false, '${at("10:01")}'),
      ('${T}', '${LD2}', true, '${at("09:05")}');
    -- A last deposited 5 days before the click: a conversion. B deposited at
    -- 08:00 and clicked at 09:05: already active, never a conversion.
    insert into conversion_attributions (tenant_id, link_dispatch_id, source_type, source_id, player_id, window_started_at, classification, event_type, monetary_value, occurred_at) values
      ('${T}', '${LD1}', 'journey', '${J1}', '${A}', '${at("10:05")}', 'direct', 'deposit_approved', 100, '${at("15:00")}'),
      ('${T}', '${LD2}', 'campaign', '${CAMPAIGN}', '${B}', '${at("09:05")}', 'direct', 'deposit_approved', 40, '${at("11:00")}');
  `);
  await db.query(`select refresh_crm_results_day($1, $2::date)`, [T, DAY]);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("crm_results_daily (golden day)", () => {
  it("credits the cooling-down player to the journey step: direct and influenced", async () => {
    const row = (await rows()).find((r) => r.source_key === J1);
    expect(row).toMatchObject({
      source_type: "journey",
      source_id: J1,
      step_position: 2,
      player_state: "esfriando",
      sent: 1,
      recipients: 1,
      human_clicks: 1,
      direct_conversions: 1,
      influenced_players: 1,
      influenced_deposits: 1,
    });
    expect(Number(row?.direct_revenue)).toBe(100);
    expect(Number(row?.influenced_revenue)).toBe(100);
    expect(Number(row?.cost)).toBeCloseTo(0.12);
  });

  it("resolves the campaign by name, counts failures and never recovers an active player", async () => {
    const row = (await rows()).find((r) => r.source_type === "campaign");
    expect(row).toMatchObject({
      source_key: "Promo X",
      source_id: CAMPAIGN,
      player_state: "ativo",
      sent: 1,
      failed: 1,
      influenced_deposits: 0,
    });
  });

  it("counts a true first deposit after the sign-up journey as influenced", async () => {
    const row = (await rows()).find((r) => r.source_key === J2 && r.player_state === "sem_ftd");
    expect((await rows()).find((r) => r.source_key === J2 && r.step_position === -1)).toMatchObject(
      { player_state: "sem_historico", influenced_deposits: 0 },
    );
    expect(row).toMatchObject({ step_position: 0, influenced_players: 1, influenced_deposits: 1 });
    expect(Number(row?.influenced_revenue)).toBe(50);
  });

  it("does not count a first deposit right after sign-up as a recovery (rule_version 4)", async () => {
    const row = (await rows()).find((r) => r.source_key === J3);
    expect(row).toMatchObject({ player_state: "sem_ftd", sent: 1, influenced_deposits: 0 });
  });

  it("does not treat an old depositor's first deposit in our history as a recovery", async () => {
    const total = (await rows()).reduce((sum, r) => sum + Number(r.influenced_revenue), 0);
    expect(total).toBe(150);
  });

  it("matches the day totals (invariants)", async () => {
    const all = await rows();
    expect(all.reduce((sum, r) => sum + r.sent, 0)).toBe(5);
    expect(all.reduce((sum, r) => sum + r.failed, 0)).toBe(1);
    expect(all.reduce((sum, r) => sum + r.human_clicks, 0)).toBe(2);
    expect(all.reduce((sum, r) => sum + r.direct_conversions, 0)).toBe(1);
  });

  it("is idempotent: rebuilding the day gives the same rows", async () => {
    const strip = (all: Row[]) =>
      all.map(({ updated_at: _updatedAt, ...rest }: Row & { updated_at?: unknown }) => rest);
    const before = strip(await rows());
    await db.query(`select refresh_crm_results_day($1, $2::date)`, [T, DAY]);
    expect(strip(await rows())).toEqual(before);
  });
});

describe("campaign id on SMS logs", () => {
  const LATER = "00000000-0000-4000-8000-0000000000c2";

  it("stores the campaign id at insert and picks the campaign that existed at send time", async () => {
    await db.exec(`
      insert into sms_campaigns values ('${LATER}', '${T}', 'Promo X', '2026-10-12', 'enviado');
      insert into sms_send_logs (tenant_id, player_id, status, trigger_name, idempotency_key, created_at) values
        ('${T}', '${B}', 'sent', 'campanha:Promo X:iGaming', 'k-later', '2026-10-13T10:00:00-03:00');
    `);
    const { rows } = await db.query<{ idempotency_key: string; campaign_id: string }>(
      `select idempotency_key, campaign_id from sms_send_logs where trigger_name like 'campanha:%' order by created_at`,
    );
    expect(rows.find((row) => row.idempotency_key === "k-b1")?.campaign_id).toBe(CAMPAIGN);
    expect(rows.find((row) => row.idempotency_key === "k-later")?.campaign_id).toBe(LATER);
  });

  it("keeps crediting the day's results to the right campaign", async () => {
    await db.query(`select refresh_crm_results_day($1, $2::date)`, [T, DAY]);
    const row = (await rows()).find((r) => r.source_type === "campaign");
    expect(row).toMatchObject({ source_key: "Promo X", source_id: CAMPAIGN, sent: 1 });
  });
});

describe("daily consistency checks (Q-01)", () => {
  async function checks() {
    await db.query(`select refresh_crm_results_day($1, $2::date)`, [T, DAY]);
    const [{ failed }] = (
      await db.query<{ failed: number }>(`select check_crm_results_day($1, $2::date) failed`, [
        T,
        DAY,
      ])
    ).rows;
    const { rows } = await db.query<{
      check_name: string;
      expected: string;
      actual: string;
      ok: boolean;
    }>(
      `select check_name, expected, actual, ok from crm_results_health where tenant_id = $1 and metric_date = $2`,
      [T, DAY],
    );
    return { failed, byName: Object.fromEntries(rows.map((row) => [row.check_name, row])) };
  }

  it("passes when the table matches the raw sends and attributions", async () => {
    const { failed, byName } = await checks();
    expect(failed).toBe(0);
    expect(byName.sends).toMatchObject({ ok: true });
    expect(Number(byName.sends.expected)).toBe(5);
    expect(byName.direct).toMatchObject({ ok: true });
    expect(byName.cost).toBeUndefined();
  });

  it("flags a cost that does not match the credit ledger", async () => {
    await db.exec(`
      insert into sms_credit_ledger values
        ('${T}', -10, 'sms_reservation', 0.12, '${at("10:00")}'),
        ('${T}', 1, 'sms_refund', 0.12, '${at("10:01")}');
    `);
    const { failed, byName } = await checks();
    expect(byName.cost).toMatchObject({ ok: false });
    expect(Number(byName.cost.expected)).toBeCloseTo(1.08);
    expect(failed).toBe(1);
  });

  it("reconciles credits charged at an older unit price with the current price", async () => {
    await db.exec(`
      delete from sms_credit_ledger;
      insert into tenant_sms_pricing (tenant_id, sale_price_per_sms) values ('${T}', 0.059);
      insert into sms_credit_ledger values ('${T}', -4, 'sms_reservation', 0.12, '${at("10:00")}');
    `);
    const { failed, byName } = await checks();
    expect(Number(byName.cost.expected)).toBeCloseTo(0.236);
    expect(byName.cost).toMatchObject({ ok: true });
    expect(failed).toBe(0);
  });
});

describe("SMS price R$ 0,059", () => {
  it("is the provider cost and the sale price of the three houses only", async () => {
    const { rows: settings } = await db.query<{ cost: string; sale: string }>(
      `select provider_cost_per_sms cost, default_sale_price_per_sms sale from sms_credit_settings`,
    );
    expect(settings[0]).toMatchObject({ cost: "0.059", sale: "0.12" });
    const { rows } = await db.query<{ slug: string; sale: string }>(
      `select t.slug, p.sale_price_per_sms sale from tenants t
         join tenant_sms_pricing p on p.tenant_id = t.id where t.slug is not null order by 1`,
    );
    expect(rows).toEqual([
      { slug: "forrandobet", sale: "0.059" },
      { slug: "pixpgf", sale: "0.059" },
      { slug: "pixreals", sale: "0.059" },
    ]);
  });
});

describe("click conversion counts players (B-01)", () => {
  it("counts one player for one click followed by two deposits", async () => {
    await db.exec(`
      insert into conversion_attributions (tenant_id, link_dispatch_id, source_type, source_id, player_id, window_started_at, classification, event_type, monetary_value, occurred_at)
      values ('${T}', '${LD1}', 'journey', '${J1}', '${A}', '${at("10:05")}', 'direct', 'deposit_approved', 40, '${at("16:00")}');
    `);
    await db.query(`select refresh_crm_results_day($1, $2::date)`, [T, DAY]);
    const row = (await rows()).find((r) => r.source_key === J1);
    expect(row).toMatchObject({ human_clicks: 1, direct_conversions: 2, direct_players: 1 });
    expect(Number(row?.direct_revenue)).toBe(140);
  });
});

describe("click conversion excludes players already active (rule_version 3)", () => {
  const NEXT = "2026-10-11";

  it("moves the deposit of a player active at the click out of the click revenue", async () => {
    await db.query(`select refresh_crm_results_day($1, $2::date)`, [T, DAY]);
    const row = (await rows()).find((r) => r.source_type === "campaign");
    expect(row).toMatchObject({
      human_clicks: 1,
      converted_clicks: 0,
      direct_conversions: 0,
      direct_players: 0,
      direct_active_conversions: 1,
      direct_active_players: 1,
    });
    expect(Number(row?.direct_revenue)).toBe(0);
    expect(Number(row?.direct_active_revenue)).toBe(40);
  });

  it("counts the clicked SMS that converted (cohort of the click)", async () => {
    const row = (await rows()).find((r) => r.source_key === J1);
    expect(row).toMatchObject({ human_clicks: 1, converted_clicks: 1, direct_active_players: 0 });
  });

  it("keeps crediting a reactivated player's later deposits without counting them again", async () => {
    // Day after: A clicks the same SMS again and deposits. A is active by now,
    // but the SMS reactivated A, so the deposit is still click revenue.
    await db.exec(`
      insert into deposits (tenant_id, player_id, valor, status, created_at) values
        ('${T}', '${A}', 25, 'aprovado', '${NEXT}T10:00:00-03:00');
      insert into conversion_attributions (tenant_id, link_dispatch_id, source_type, source_id, player_id, window_started_at, classification, event_type, monetary_value, occurred_at)
      values ('${T}', '${LD1}', 'journey', '${J1}', '${A}', '${NEXT}T09:00:00-03:00', 'direct', 'deposit_approved', 25, '${NEXT}T10:00:00-03:00');
    `);
    await db.query(`select refresh_crm_results_day($1, $2::date)`, [T, NEXT]);
    const { rows: next } = await db.query<Row>(
      `select * from crm_results_daily where tenant_id = $1 and metric_date = $2 and source_key = $3`,
      [T, NEXT, J1],
    );
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      direct_conversions: 1,
      direct_players: 0,
      direct_active_players: 0,
    });
    expect(Number(next[0].direct_revenue)).toBe(25);
  });

  it("counts distinct players over the period", async () => {
    const { rows: period } = await db.query<{ converted_players: number; active_players: number }>(
      `select * from crm_click_players_period($1, $2::date, $3::date)`,
      [T, DAY, NEXT],
    );
    expect(period[0]).toMatchObject({ converted_players: 1, active_players: 1 });
  });

  it("reports only non-active click revenue as recovered on the journey cards", async () => {
    const { rows: metrics } = await db.query<{
      journey_id: string;
      metrics: { recovered: number };
    }>(`select * from list_journey_metrics($1)`, [T]);
    // A on J1: 100 + 40 (B-01 test) + 25 (next day). B's campaign deposit is not a journey.
    expect(Number(metrics.find((m) => m.journey_id === J1)?.metrics.recovered)).toBe(165);
    expect(Number(metrics.find((m) => m.journey_id === J2)?.metrics.recovered)).toBe(0);
  });

  it("counts people who left the journey without receiving any message", async () => {
    const J4 = "00000000-0000-4000-8000-0000000000a4";
    const [paidAfterSms, paidBeforeSms, onlyWaited, stillInside] = [1, 2, 3, 4].map(
      (n) => `00000000-0000-4000-8000-0000000000e${n}`,
    );
    await db.exec(`
      insert into journeys values ('${J4}', '${T}');
      insert into journey_enrollments (id, tenant_id, journey_id, status, exit_reason, current_position) values
        ('${paidAfterSms}', '${T}', '${J4}', 'exited', 'deposit', 1),
        ('${paidBeforeSms}', '${T}', '${J4}', 'exited', 'deposit', 1),
        ('${onlyWaited}', '${T}', '${J4}', 'completed', 'finished', 2),
        ('${stillInside}', '${T}', '${J4}', 'waiting', null, 0);
      insert into journey_step_executions (tenant_id, journey_id, enrollment_id, channel, status) values
        ('${T}', '${J4}', '${paidAfterSms}', 'sms', 'sent'),
        ('${T}', '${J4}', '${paidAfterSms}', null, 'sent'),
        ('${T}', '${J4}', '${onlyWaited}', null, 'sent'),
        ('${T}', '${J4}', '${onlyWaited}', 'sms', 'failed');
    `);
    const { rows: metrics } = await db.query<{
      journey_id: string;
      metrics: { finishedWithoutMessage: number; sentByChannel: Record<string, number> };
    }>(`select * from list_journey_metrics($1)`, [T]);
    const j4 = metrics.find((m) => m.journey_id === J4)?.metrics;
    expect(j4?.finishedWithoutMessage).toBe(2);
    expect(j4?.sentByChannel).toEqual({ sms: 1, other: 2 });
  });
});

describe("other CRM screens use the same rule (conversion reports)", () => {
  it("flags each attribution through the computed column", async () => {
    const { rows: flags } = await db.query<{ player_id: string; active: boolean }>(
      `select a.player_id, player_active_at_click(a) active
         from conversion_attributions a order by a.occurred_at`,
    );
    expect(flags.filter((f) => f.player_id === A).every((f) => f.active === false)).toBe(true);
    expect(flags.find((f) => f.player_id === B)?.active).toBe(true);
  });

  it("keeps already-active revenue apart in the report list", async () => {
    const { rows: sources } = await db.query<{
      source_type: string;
      source_id: string;
      conversions: number;
      direct_revenue: string;
      active_revenue: string;
    }>(`select * from conversion_report_sources($1, '2026-10-01', '2026-10-31')`, [T]);
    const campaign = sources.find((r) => r.source_type === "campaign");
    expect(campaign).toMatchObject({ conversions: 0 });
    expect(Number(campaign?.direct_revenue)).toBe(0);
    expect(Number(campaign?.active_revenue)).toBe(40);
    const journey = sources.find((r) => r.source_id === J1);
    expect(Number(journey?.direct_revenue)).toBe(165);
    expect(Number(journey?.active_revenue)).toBe(0);
  });

  it("leaves the Central de Resultados numbers unchanged", async () => {
    await db.query(`select refresh_crm_results_day($1, $2::date)`, [T, DAY]);
    const row = (await rows()).find((r) => r.source_type === "campaign");
    expect(row).toMatchObject({ direct_players: 0, direct_active_players: 1 });
    expect(Number(row?.direct_active_revenue)).toBe(40);
  });
});
