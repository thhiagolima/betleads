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
const LATE_DAYS_MIGRATION = readFileSync(
  resolve(root, "supabase/migrations/20261202100000_crm_results_late_days.sql"),
  "utf8",
);
const SUPERSET_MIGRATION = readFileSync(
  resolve(root, "supabase/migrations/20261220100000_crm_influenced_superset.sql"),
  "utf8",
);
const CONSUMO_P0_MIGRATION = readFileSync(
  resolve(root, "supabase/migrations/20261129100000_supabase_consumo_p0.sql"),
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
  await db.exec(`begin; ${CONSUMO_P0_MIGRATION}; commit;`);
  await db.exec(`begin; ${CONSUMO_P0_MIGRATION}; commit;`);
  await db.exec(`begin; ${LATE_DAYS_MIGRATION}; commit;`);
  await db.exec(`begin; ${LATE_DAYS_MIGRATION}; commit;`);
  await db.exec(`begin; ${SUPERSET_MIGRATION}; commit;`);
  await db.exec(`begin; ${SUPERSET_MIGRATION}; commit;`);
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

describe("consumption P0: journey join as uuid, quiet days skipped", () => {
  it("turns a text key into a uuid and anything else into null", async () => {
    const { rows: out } = await db.query<{
      ok: string | null;
      bad: string | null;
      none: string | null;
    }>(`select crm_try_uuid($1) ok, crm_try_uuid('k-d') bad, crm_try_uuid(null) none`, [
      KEY_A.toUpperCase(),
    ]);
    expect(out[0]).toEqual({ ok: KEY_A, bad: null, none: null });
  });

  it("rebuilds only the houses with activity or stored rows that day", async () => {
    const BUSY = "00000000-0000-4000-8000-0000000000b4";
    const STALE = "00000000-0000-4000-8000-0000000000b5";
    const QUIET = "00000000-0000-4000-8000-0000000000b6";
    await db.exec("begin");
    try {
      await db.exec(`
        alter table tenants add column if not exists is_demo boolean not null default false;
        insert into tenants (id, slug) values ('${BUSY}', 'busy'), ('${STALE}', 'stale'), ('${QUIET}', 'quiet');
        insert into sms_send_logs (tenant_id, status, trigger_name, idempotency_key, created_at)
          values ('${BUSY}', 'sent', 'outro', 'k', now());
        insert into crm_results_daily (tenant_id, metric_date, source_type, source_key, player_state)
          values ('${STALE}', (now() at time zone 'America/Sao_Paulo')::date, 'other', 'x', 'ativo');
        create table rebuilt (tenant_id uuid);
        create or replace function refresh_crm_results_day(_tenant uuid, _day date)
        returns integer language sql as $$ insert into rebuilt values (_tenant) returning 1 $$;
        create or replace function refresh_player_lifecycle_day(_tenant uuid, _day date)
        returns integer language sql as $$ select 0 $$;
      `);
      const { rows: failed } = await db.query<{ n: number }>(
        `select refresh_crm_results_recent(1) n`,
      );
      expect(failed[0].n).toBe(0);
      const { rows: done } = await db.query<{ tenant_id: string }>(
        `select tenant_id from rebuilt order by tenant_id`,
      );
      expect(done.map((r) => r.tenant_id)).toEqual([BUSY, STALE]);
    } finally {
      await db.exec("rollback");
    }
  });
});

describe("late data: past days rebuilt once their deposits change", () => {
  it("rebuilds an older day whose approved deposit changed after its last rebuild", async () => {
    const LATE = "00000000-0000-4000-8000-0000000000b7";
    await db.exec("begin");
    try {
      await db.exec(`
        alter table tenants add column if not exists is_demo boolean not null default false;
        insert into tenants (id, slug) values ('${LATE}', 'late');
        -- A deposit made 3 days ago (BRT) that only reached us now.
        insert into deposits (tenant_id, player_id, valor, status, created_at, updated_at) values
          ('${LATE}', '${A}', 10, 'aprovado',
           ((now() at time zone 'America/Sao_Paulo')::date - 3)::timestamp at time zone 'America/Sao_Paulo' + interval '20 hours',
           clock_timestamp());
        create table rebuilt (tenant_id uuid, day date);
        create or replace function refresh_crm_results_day(_tenant uuid, _day date)
        returns integer language sql as $$ insert into rebuilt values (_tenant, _day) returning 1 $$;
        create or replace function refresh_player_lifecycle_day(_tenant uuid, _day date)
        returns integer language sql as $$ select 0 $$;
      `);
      const lateDay = async () =>
        (
          await db.query<{ n: number }>(
            `select count(*)::int n from rebuilt
             where tenant_id = $1 and day = (now() at time zone 'America/Sao_Paulo')::date - 3`,
            [LATE],
          )
        ).rows[0].n;

      await db.query(`select refresh_crm_results_recent(1)`);
      expect(await lateDay()).toBe(1);

      // Nothing changed since: the next run leaves the day alone.
      await db.query(`select refresh_crm_results_recent(1)`);
      expect(await lateDay()).toBe(1);

      // Another late change (e.g. a pending deposit approved later): rebuilt again.
      await db.exec(
        `update deposits set updated_at = clock_timestamp() where tenant_id = '${LATE}'`,
      );
      await db.query(`select refresh_crm_results_recent(1)`);
      expect(await lateDay()).toBe(2);
    } finally {
      await db.exec("rollback");
    }
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

describe("Reativações após SMS is a superset of the Recuperado pelo CRM (rule_version 5)", () => {
  const T2 = "00000000-0000-4000-8000-000000000002";
  const JR = "00000000-0000-4000-8000-0000000000a9";
  const CLICKED = "00000000-0000-4000-8000-000000000101"; // stopped, clicked, deposited twice
  const EXPOSED = "00000000-0000-4000-8000-000000000102"; // stopped at the SMS, came back 2 days later without clicking
  const LATE = "00000000-0000-4000-8000-000000000105"; // came back 5 days after the SMS: outside the 3 days
  const BUSY = "00000000-0000-4000-8000-000000000103"; // deposited the day before the SMS
  const NEWBIE = "00000000-0000-4000-8000-000000000104"; // FTD minutes after a clicked welcome SMS
  const LDX = "00000000-0000-4000-8000-0000000001d1";
  const LDN = "00000000-0000-4000-8000-0000000001d2";
  const D1 = "2026-10-20";
  const D3 = "2026-10-22";
  const ts = (day: string, time: string) => `${day}T${time}:00-03:00`;

  type Totals = {
    direct_players: number;
    direct_revenue: string;
    influenced_players: number;
    influenced_deposits: number;
    influenced_revenue: string;
  };
  const totals = async (from: string, to: string) =>
    (
      await db.query<Totals>(
        `select coalesce(sum(direct_players), 0)::int direct_players,
                coalesce(sum(direct_revenue), 0) direct_revenue,
                coalesce(sum(influenced_players), 0)::int influenced_players,
                coalesce(sum(influenced_deposits), 0)::int influenced_deposits,
                coalesce(sum(influenced_revenue), 0) influenced_revenue
         from crm_results_daily where tenant_id = $1 and metric_date between $2 and $3`,
        [T2, from, to],
      )
    ).rows[0];

  beforeAll(async () => {
    await db.exec(`
      insert into tenants (id, slug) values ('${T2}', 'superset');
      insert into journeys values ('${JR}', '${T2}');
      insert into players (id, tenant_id, ftd_em, created_at) values
        ('${CLICKED}', '${T2}', '2026-09-01', '2026-08-01'),
        ('${EXPOSED}', '${T2}', '2026-09-01', '2026-08-01'),
        ('${LATE}', '${T2}', '2026-09-01', '2026-08-01'),
        ('${BUSY}', '${T2}', '2026-09-01', '2026-08-01'),
        ('${NEWBIE}', '${T2}', '${ts(D1, "09:10")}', '${ts(D1, "09:00")}');
      insert into deposits (tenant_id, player_id, valor, status, created_at) values
        ('${T2}', '${CLICKED}', 10, 'aprovado', '2026-10-10T10:00:00-03:00'),
        ('${T2}', '${CLICKED}', 100, 'aprovado', '${ts(D1, "12:00")}'),
        ('${T2}', '${CLICKED}', 40, 'aprovado', '${ts(D3, "12:00")}'),
        ('${T2}', '${EXPOSED}', 30, 'aprovado', '2026-10-12T10:00:00-03:00'),
        ('${T2}', '${EXPOSED}', 50, 'aprovado', '${ts(D1, "14:00")}'),
        ('${T2}', '${EXPOSED}', 20, 'aprovado', '${ts(D3, "09:00")}'),
        ('${T2}', '${LATE}', 30, 'aprovado', '2026-10-12T10:00:00-03:00'),
        ('${T2}', '${LATE}', 80, 'aprovado', '${ts(D1, "15:00")}'),
        ('${T2}', '${BUSY}', 15, 'aprovado', '2026-10-17T10:00:00-03:00'),
        ('${T2}', '${BUSY}', 60, 'aprovado', '${ts(D1, "12:00")}'),
        ('${T2}', '${NEWBIE}', 25, 'aprovado', '${ts(D1, "09:10")}');
      insert into sms_send_logs (tenant_id, player_id, status, trigger_name, idempotency_key, created_at) values
        ('${T2}', '${CLICKED}', 'sent', 'journey:${JR}', 'k-x1', '${ts(D1, "10:00")}'),
        -- 2 days before the return, 6 days after the last deposit: stopped at the send.
        ('${T2}', '${EXPOSED}', 'sent', 'journey:${JR}', 'k-x2', '2026-10-18T10:00:00-03:00'),
        -- 5 days before the return: outside the 3-day window.
        ('${T2}', '${LATE}', 'sent', 'journey:${JR}', 'k-x5', '2026-10-15T10:00:00-03:00'),
        -- 24 h after a deposit: active at the send (the old rule credited it).
        ('${T2}', '${BUSY}', 'sent', 'journey:${JR}', 'k-x3', '2026-10-18T10:00:00-03:00'),
        ('${T2}', '${NEWBIE}', 'sent', 'journey:${JR}', 'k-x4', '${ts(D1, "09:01")}');
      insert into link_dispatches values
        ('${LDX}', '${T2}', 'journey', '${JR}', 0, '${CLICKED}', '${ts(D1, "10:00")}', '${ts(D1, "10:00")}'),
        ('${LDN}', '${T2}', 'journey', '${JR}', 0, '${NEWBIE}', '${ts(D1, "09:01")}', '${ts(D1, "09:01")}');
      insert into click_events (tenant_id, link_dispatch_id, is_human, occurred_at) values
        ('${T2}', '${LDX}', true, '${ts(D1, "10:05")}'),
        ('${T2}', '${LDN}', true, '${ts(D1, "09:02")}');
      insert into conversion_attributions (tenant_id, link_dispatch_id, source_type, source_id, player_id, window_started_at, classification, event_type, monetary_value, occurred_at) values
        ('${T2}', '${LDX}', 'journey', '${JR}', '${CLICKED}', '${ts(D1, "10:05")}', 'direct', 'deposit_approved', 100, '${ts(D1, "12:00")}'),
        ('${T2}', '${LDX}', 'journey', '${JR}', '${CLICKED}', '${ts(D1, "10:05")}', 'direct', 'deposit_approved', 40, '${ts(D3, "12:00")}'),
        ('${T2}', '${LDN}', 'journey', '${JR}', '${NEWBIE}', '${ts(D1, "09:02")}', 'direct', 'deposit_approved', 25, '${ts(D1, "09:10")}');
    `);
    for (const day of ["2026-10-20", "2026-10-21", "2026-10-22"])
      await db.query(`select refresh_crm_results_day($1, $2::date)`, [T2, day]);
  });

  it("keeps influenced >= direct on every row, for players and value", async () => {
    const { rows: all } = await db.query<Totals & { rule_version: number }>(
      `select * from crm_results_daily where tenant_id = $1`,
      [T2],
    );
    expect(all.length).toBeGreaterThan(0);
    for (const row of all) {
      expect(row.rule_version).toBe(5);
      expect(row.influenced_players).toBeGreaterThanOrEqual(row.direct_players);
      expect(Number(row.influenced_revenue)).toBeGreaterThanOrEqual(Number(row.direct_revenue));
    }
  });

  it("adds who came back without clicking within 3 days, with every deposit of those 3 days", async () => {
    const period = await totals(D1, D3);
    // Direct: CLICKED (100 + 40) and NEWBIE (25).
    expect(period.direct_players).toBe(2);
    expect(Number(period.direct_revenue)).toBe(165);
    // Influenced: the same plus EXPOSED (50 on the return, 20 two days later).
    // BUSY was active at the SMS and LATE came back 5 days after it; the click
    // deposits are never counted twice.
    expect(period.influenced_players).toBe(3);
    expect(period.influenced_deposits).toBe(5);
    expect(Number(period.influenced_revenue)).toBe(235);
    const lastDay = await totals(D3, D3);
    expect(lastDay.influenced_players).toBe(0);
    expect(Number(lastDay.influenced_revenue)).toBe(60);
  });

  it("counts distinct people over the period, superset of the click players", async () => {
    const { rows: period } = await db.query<{
      converted_players: number;
      influenced_players: number;
    }>(`select * from crm_click_players_period($1, $2::date, $3::date)`, [T2, D1, D3]);
    expect(Number(period[0].converted_players)).toBe(2);
    expect(Number(period[0].influenced_players)).toBe(3);
  });

  it("rebuilds days without losing or duplicating people", async () => {
    await db.query(`select refresh_crm_results_day($1, $2::date)`, [T2, D1]);
    const { rows: people } = await db.query<{ n: number }>(
      `select count(*)::int n from crm_influenced_players_daily where tenant_id = $1 and metric_date = $2`,
      [T2, D1],
    );
    expect(people[0].n).toBe(3);
    const { rows: rebuilt } = await db.query<{ n: number }>(
      `select crm_results_rebuild_range($1, $2::date, $3::date) n`,
      [T2, D1, D3],
    );
    expect(rebuilt[0].n).toBe(3);
    expect((await totals(D1, D3)).influenced_players).toBe(3);
  });
});
