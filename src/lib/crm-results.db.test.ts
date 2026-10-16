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
const CAMPAIGN_ID_MIGRATION = readFileSync(
  resolve(root, "supabase/migrations/20261016170000_sms_log_campaign_id.sql"),
  "utf8",
);

const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create table public.tenants (id uuid primary key);
create function public.has_tenant_access(_tenant uuid) returns boolean language sql as $$ select true $$;
create table public.players (id uuid primary key, tenant_id uuid, ftd_em timestamptz);
create table public.deposits (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, player_id uuid,
  valor numeric, status text, created_at timestamptz);
create table public.sms_send_logs (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, player_id uuid, status text,
  trigger_name text, idempotency_key text, created_at timestamptz);
create table public.journey_step_executions (
  id uuid primary key default gen_random_uuid(), idempotency_key uuid, step_position integer);
create table public.sms_campaigns (
  id uuid primary key, tenant_id uuid, name text, created_at timestamptz, status text default 'enviado');
create table public.link_dispatches (
  id uuid primary key, tenant_id uuid, source_type text, source_id text,
  journey_step_position integer, recipient_player_id uuid, sent_at timestamptz,
  created_at timestamptz default now());
create table public.click_events (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, link_dispatch_id uuid,
  is_human boolean, occurred_at timestamptz);
create table public.conversion_attributions (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, link_dispatch_id uuid,
  classification text, event_type text, monetary_value numeric, occurred_at timestamptz);
create table public.tenant_sms_pricing (tenant_id uuid primary key, sale_price_per_sms numeric);
create table public.sms_credit_settings (id boolean primary key default true, default_sale_price_per_sms numeric);
insert into public.sms_credit_settings values (true, 0.12);
create table public.sms_credit_ledger (
  tenant_id uuid, delta_credits integer, entry_type text, unit_sale_price numeric, created_at timestamptz);
`;

const T = "00000000-0000-4000-8000-000000000001";
const J1 = "00000000-0000-4000-8000-0000000000a1";
const J2 = "00000000-0000-4000-8000-0000000000a2";
const CAMPAIGN = "00000000-0000-4000-8000-0000000000c1";
const A = "00000000-0000-4000-8000-0000000000f1"; // cooling down, journey J1 step 2
const B = "00000000-0000-4000-8000-0000000000f2"; // active, campaign
const C = "00000000-0000-4000-8000-0000000000f3"; // never deposited, journey J2 step 0
const D = "00000000-0000-4000-8000-0000000000f4"; // old depositor, first deposit in our history
const LD1 = "00000000-0000-4000-8000-0000000000d1";
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
  direct_revenue: string;
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
    insert into tenants values ('${T}');
    insert into players values ('${A}', '${T}', '2026-09-01'), ('${B}', '${T}', '2026-09-01'),
      ('${C}', '${T}', null), ('${D}', '${T}', '2026-08-01');
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
      ('${T}', '${C}', 999, 'pendente', '${at("12:30")}');
    insert into sms_send_logs (tenant_id, player_id, status, trigger_name, idempotency_key, created_at) values
      ('${T}', '${A}', 'sent', 'journey:${J1}', '${KEY_A}', '${at("10:00")}'),
      ('${T}', '${B}', 'sent', 'campanha:Promo X:iGaming', 'k-b1', '${at("09:00")}'),
      ('${T}', '${B}', 'error', 'campanha:Promo X:iGaming', 'k-b2', '${at("09:01")}'),
      ('${T}', '${C}', 'sent', 'journey:${J2}', '${KEY_C}', '${at("09:00")}'),
      ('${T}', '${D}', 'sent', 'journey:${J2}', 'k-d', '${at("12:00")}');
    insert into link_dispatches values
      ('${LD1}', '${T}', 'journey', '${J1}', 2, '${A}', '${at("10:00")}', '${at("10:00")}');
    insert into click_events (tenant_id, link_dispatch_id, is_human, occurred_at) values
      ('${T}', '${LD1}', true, '${at("10:05")}'),
      ('${T}', '${LD1}', false, '${at("10:01")}');
    insert into conversion_attributions (tenant_id, link_dispatch_id, classification, event_type, monetary_value, occurred_at) values
      ('${T}', '${LD1}', 'direct', 'deposit_approved', 100, '${at("15:00")}');
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

  it("does not treat an old depositor's first deposit in our history as a recovery", async () => {
    const total = (await rows()).reduce((sum, r) => sum + Number(r.influenced_revenue), 0);
    expect(total).toBe(150);
  });

  it("matches the day totals (invariants)", async () => {
    const all = await rows();
    expect(all.reduce((sum, r) => sum + r.sent, 0)).toBe(4);
    expect(all.reduce((sum, r) => sum + r.failed, 0)).toBe(1);
    expect(all.reduce((sum, r) => sum + r.human_clicks, 0)).toBe(1);
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
    expect(Number(byName.sends.expected)).toBe(4);
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
});
