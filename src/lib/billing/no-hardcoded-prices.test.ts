// PG1 Task 6 — SQL test for
// supabase/migrations/20261022100300_billing_prices_in_reports.sql:
// refresh_crm_results_day / check_crm_results_day / admin_list_users_with_usage
// stop reading the old platform_pricing table and read billing_price_book
// instead; check_crm_results_day reconciles against the new wallet_ledger
// (plus the legacy sms_credit_ledger) instead.
//
// Fix round 1: billing_report_unit_price is null before the price book's
// first valid_from (2026-10-01), so refresh/check now go through
// crm_sms_report_price, which falls back to the exact legacy price chain
// (tenant_sms_pricing -> sms_credit_settings -> 0.12) for days before the
// cutover. That legacy 0.12 literal is intentional now, so the migration
// text no longer asserts its absence -- it's covered by the behavior tests
// below instead.
//
// The TypeScript side (billing_report_unit_price callers elsewhere) is
// covered in Task 7; this file only exercises the SQL migration.

import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  INTERNO,
  NORMAL,
  readMigration,
  resetSession as resetDbSession,
  SCHEMA,
  SEED,
} from "./billing-db-test-support";

// PG1 Task 7 — none of the call sites fixed by this task may keep a
// hard-coded price literal: they all must read the price book through
// getReportUnitPrices/getEffectivePrices (pricing.server.ts) instead.
const TS_TARGET_FILES = [
  "src/lib/journeys.functions.ts",
  "src/lib/dashboard.functions.ts",
  "src/lib/conversion-report.functions.ts",
  "src/lib/sms.functions.ts",
  "src/routes/sms.tsx",
] as const;

const FORBIDDEN_LITERALS = ["0.12", "0.18", "0.35", "* 0.01", "FALLBACK_SMS_UNIT_PRICE"] as const;

function readTarget(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("TS: no hardcoded legacy prices in the price-book call sites", () => {
  for (const file of TS_TARGET_FILES) {
    for (const literal of FORBIDDEN_LITERALS) {
      it(`${file} does not contain ${JSON.stringify(literal)}`, () => {
        expect(readTarget(file)).not.toContain(literal);
      });
    }
  }

  it("journeys.functions.ts reads its journey/publication-estimate price from the price book helpers", () => {
    const source = readTarget("src/lib/journeys.functions.ts");
    expect(source).toContain("getReportUnitPrices");
    expect(source).toContain("getEffectivePrices");
  });

  it("conversion-report.functions.ts reads the SMS report price from the price book", () => {
    expect(readTarget("src/lib/conversion-report.functions.ts")).toContain("getReportUnitPrices");
  });

  it("sms.functions.ts dashboard ROI reads the SMS report price from the price book", () => {
    expect(readTarget("src/lib/sms.functions.ts")).toContain("getReportUnitPrices");
  });

  it("sms.tsx composer counts segments with countSmsSegments and prices via getBillingPrices", () => {
    const source = readTarget("src/routes/sms.tsx");
    expect(source).toContain("countSmsSegments");
    expect(source).toContain("getBillingPrices");
  });
});

const MIGRATION_PATH = "supabase/migrations/20261022100300_billing_prices_in_reports.sql";
const MIGRATION_SQL = readMigration(MIGRATION_PATH);

describe("migration text: no hardcoded legacy prices in the price-book path", () => {
  it("does not reference platform_pricing", () => {
    expect(MIGRATION_SQL).not.toContain("platform_pricing");
  });

  it("reads the SMS price from billing_report_unit_price", () => {
    expect(MIGRATION_SQL).toContain("billing_report_unit_price(_tenant, 'sms'");
  });

  it("sums billed_units (segments), defaulting unbilled rows to 1", () => {
    expect(MIGRATION_SQL).toContain("coalesce(s.billed_units, 1)");
  });
});

const PRICE_BOOK_MIGRATION = readMigration(
  "supabase/migrations/20261022100000_billing_price_book.sql",
);
const WALLET_MIGRATION = readMigration("supabase/migrations/20261022100100_billing_wallet.sql");

// Minimal stubs of the tables/functions refresh_crm_results_day and
// check_crm_results_day touch beyond what billing-db-test-support's
// SCHEMA/SEED already provide (tenants, wallet, price book). These are
// deliberately simplified stand-ins, not copies of the real production
// definitions: refresh_crm_results_day's cost expression doesn't depend on
// correct player-state/source attribution, only on the sends/sends_agg CTEs
// running without error and grouping consistently, so crm_player_state and
// crm_source_of_trigger are stubbed to trivial constants and
// crm_direct_deposits to an empty set. Building the full real dependency
// chain (journeys, deposits, click tracking with realistic data) would be
// Task 9/clone-test-harness-sized work for no gain here.
const REPORT_STUBS = `
create table public.crm_results_daily (
  tenant_id uuid not null,
  metric_date date not null,
  source_type text not null default 'other',
  source_key text not null default '(sem origem)',
  source_id uuid,
  step_position integer not null default -1,
  player_state text not null default 'sem_ftd',
  sent integer not null default 0,
  failed integer not null default 0,
  cost numeric not null default 0,
  recipients integer not null default 0,
  human_clicks integer not null default 0,
  converted_clicks integer not null default 0,
  direct_conversions integer not null default 0,
  direct_players integer not null default 0,
  direct_revenue numeric not null default 0,
  direct_active_conversions integer not null default 0,
  direct_active_players integer not null default 0,
  direct_active_revenue numeric not null default 0,
  influenced_players integer not null default 0,
  influenced_deposits integer not null default 0,
  influenced_revenue numeric not null default 0,
  rule_version integer not null default 1,
  updated_at timestamptz not null default now()
);
create table public.crm_results_health (
  tenant_id uuid not null,
  metric_date date not null,
  check_name text not null,
  expected numeric not null,
  actual numeric not null,
  ok boolean not null,
  checked_at timestamptz not null default now(),
  primary key (tenant_id, metric_date, check_name)
);
create table public.sms_send_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  created_at timestamptz not null default now(),
  status text not null,
  billed_units smallint null,
  campaign_id uuid null,
  idempotency_key text null,
  trigger_name text null,
  player_id uuid null
);
create table public.conversion_attributions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  link_dispatch_id uuid null,
  occurred_at timestamptz not null,
  classification text not null,
  event_type text not null
);
create table public.sms_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  created_at timestamptz not null default now(),
  entry_type text not null,
  delta_credits integer not null
);
-- Legacy price sources crm_sms_report_price falls back to pre-cutover.
create table public.tenant_sms_pricing (
  tenant_id uuid primary key,
  sale_price_per_sms numeric(10,4) null
);
create table public.sms_credit_settings (
  id boolean primary key default true,
  default_sale_price_per_sms numeric(10,4) not null default 0.12
);
insert into public.sms_credit_settings (id) values (true);
-- Tables refresh_crm_results_day joins into but doesn't need populated for
-- the cost assertions below (click/deposit/journey attribution).
create table public.sms_campaigns (id uuid primary key, name text not null);
create table public.journey_step_executions (idempotency_key text, step_position integer);
create table public.link_dispatches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  source_type text not null,
  source_id text,
  journey_step_position integer,
  recipient_player_id uuid,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.click_events (
  tenant_id uuid not null,
  link_dispatch_id uuid not null,
  is_human boolean not null default true,
  occurred_at timestamptz not null default now()
);
create table public.deposits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  player_id uuid,
  status text not null,
  valor numeric not null default 0,
  created_at timestamptz not null default now()
);
create table public.players (id uuid primary key, ftd_em timestamptz);

create function public.crm_player_state(_tenant uuid, _player uuid, _at timestamptz)
returns text language sql stable as $$ select 'sem_ftd'::text $$;

create function public.crm_source_of_trigger(_tenant uuid, _trigger text)
returns table (source_type text, source_key text, source_id uuid)
language sql stable as $$
  select 'other'::text, coalesce(_trigger, '(sem origem)')::text, null::uuid
$$;

create function public.crm_direct_deposits(_tenant uuid, _since timestamptz default '-infinity')
returns table (
  attribution_id uuid, link_dispatch_id uuid, source_type text, source_id uuid,
  player_id uuid, occurred_at timestamptz, monetary_value numeric,
  was_active boolean, is_first boolean
)
language sql stable as $$
  select null::uuid, null::uuid, null::text, null::uuid, null::uuid,
         null::timestamptz, null::numeric, null::boolean, null::boolean
  where false
$$;
`;

describe("check_crm_results_day and refresh_crm_results_day: price book + wallet_ledger reconciliation", () => {
  let db: PGlite;

  async function resetSession() {
    await resetDbSession(db);
  }

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(SCHEMA);
    await db.exec(SEED);
    await db.exec(PRICE_BOOK_MIGRATION);
    await db.exec(WALLET_MIGRATION);
    await db.exec(REPORT_STUBS);
    await db.exec(MIGRATION_SQL);
    await resetSession();
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  async function asSuperAdmin<T>(fn: () => Promise<T>): Promise<T> {
    await db.exec("set test.super = 'on'");
    try {
      return await fn();
    } finally {
      await db.exec("set test.super = 'off'");
    }
  }

  async function reserveSms(tenant: string, units: number, referenceId: string, key: string) {
    return asSuperAdmin(async () => {
      const { rows } = await db.query<{ v: Record<string, unknown> }>(
        "select public.wallet_reserve($1, 'sms', $2, 'sms_send', $3, $4) v",
        [tenant, units, referenceId, key],
      );
      return rows[0].v;
    });
  }

  async function refundSms(tenant: string, referenceId: string, key: string) {
    return asSuperAdmin(async () => {
      const { rows } = await db.query<{ v: Record<string, unknown> }>(
        "select public.wallet_refund($1, $2, $3, 'teste') v",
        [tenant, referenceId, key],
      );
      return rows[0].v;
    });
  }

  async function checkDay(tenant: string, day: string): Promise<number> {
    return asSuperAdmin(async () => {
      const { rows } = await db.query<{ v: number }>(
        "select public.check_crm_results_day($1, $2::date) v",
        [tenant, day],
      );
      return rows[0].v;
    });
  }

  async function costHealth(tenant: string, day: string) {
    const { rows } = await db.query<{ ok: boolean; expected: string; actual: string }>(
      `select ok, expected::text, actual::text from public.crm_results_health
       where tenant_id = $1 and metric_date = $2::date and check_name = 'cost'`,
      [tenant, day],
    );
    return rows;
  }

  let DAY: string;

  beforeAll(async () => {
    // wallet_reserve/wallet_refund stamp created_at with the real now() (no
    // test clock is set in this file), so same-day reservations/refunds must
    // use "today" in BRT, which is also on/after the price book's
    // 2026-10-01 cutover (billing_report_unit_price applies, not the legacy
    // fallback).
    const { rows } = await db.query<{ today: string }>(
      "select (now() at time zone 'America/Sao_Paulo')::date::text today",
    );
    DAY = rows[0].today;
  });

  describe("normal tenant: 3 reservations of 2 segments (0.08 each -> 0.48 total)", () => {
    const tenant = NORMAL;

    beforeAll(async () => {
      await asSuperAdmin(async () => {
        await db.query("select public.admin_adjust_wallet($1, $2, $3, $4)", [
          tenant,
          10.0,
          "saldo inicial",
          "adj:check-crm:1",
        ]);
      });
      for (let i = 0; i < 3; i += 1) {
        await reserveSms(tenant, 2, `check-crm-${i}`, `sms-reserve:check-crm-${i}`);
      }
    });

    it("cost ok = true when crm_results_daily.cost matches 0.48", async () => {
      await asSuperAdmin(async () => {
        await db.query(
          `insert into public.crm_results_daily (tenant_id, metric_date, sent, cost, direct_conversions, direct_active_conversions)
           values ($1, $2::date, 6, 0.48, 0, 0)`,
          [tenant, DAY],
        );
      });

      await checkDay(tenant, DAY);

      const rows = await costHealth(tenant, DAY);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].expected)).toBeCloseTo(0.48, 4);
      expect(rows[0].ok).toBe(true);
    });

    it("cost ok = false when crm_results_daily.cost is 0.24 (half of the real cost)", async () => {
      await asSuperAdmin(async () => {
        await db.query(
          `update public.crm_results_daily set cost = 0.24 where tenant_id = $1 and metric_date = $2::date`,
          [tenant, DAY],
        );
      });

      await checkDay(tenant, DAY);

      const rows = await costHealth(tenant, DAY);
      expect(rows).toHaveLength(1);
      expect(rows[0].ok).toBe(false);
    });
  });

  describe("interno tenant: exempt, wallet amount is 0 but units x price still reconciles", () => {
    const tenant = INTERNO;

    beforeAll(async () => {
      const result = (await reserveSms(tenant, 10, "check-crm-interno", "sms-reserve:check-crm-interno")) as {
        exempt: boolean;
        amount: number;
      };
      expect(result.exempt).toBe(true);
      expect(Number(result.amount)).toBe(0);

      // 10 units x 0.059 (provider cost, used for an exempt tenant's report price).
      await asSuperAdmin(async () => {
        await db.query(
          `insert into public.crm_results_daily (tenant_id, metric_date, sent, cost, direct_conversions, direct_active_conversions)
           values ($1, $2::date, 10, 0.59, 0, 0)`,
          [tenant, DAY],
        );
      });
    });

    it("cost ok = true using billing_report_unit_price (provider cost) x units reserved", async () => {
      await checkDay(tenant, DAY);

      const rows = await costHealth(tenant, DAY);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].expected)).toBeCloseTo(0.59, 4);
      expect(rows[0].ok).toBe(true);
    });
  });

  // Fix round 1, finding 3: usage_refund units subtracted from usage_reservation units.
  describe("check_crm_results_day: usage_refund units are subtracted from the day's raw cost", () => {
    const tenant = "00000000-0000-4000-9000-000000000101";

    beforeAll(async () => {
      await asSuperAdmin(async () => {
        await db.query(
          `insert into public.tenants (id, slug, plano, is_demo) values ($1, 'refund-subtract', 'starter', false)`,
          [tenant],
        );
        await db.query("select public.admin_adjust_wallet($1, $2, $3, $4)", [
          tenant,
          10.0,
          "saldo inicial",
          "adj:refund-subtract:1",
        ]);
      });
      // 5 units reserved, then fully refunded; 3 units reserved and kept.
      // Net for the day: 5 - 5 + 3 = 3 units -> 3 x 0.08 = 0.24.
      await reserveSms(tenant, 5, "refund-subtract-a", "sms-reserve:refund-subtract-a");
      await reserveSms(tenant, 3, "refund-subtract-b", "sms-reserve:refund-subtract-b");
      await refundSms(tenant, "refund-subtract-a", "sms-refund:refund-subtract-a");

      await asSuperAdmin(async () => {
        await db.query(
          `insert into public.crm_results_daily (tenant_id, metric_date, sent, cost, direct_conversions, direct_active_conversions)
           values ($1, $2::date, 3, 0.24, 0, 0)`,
          [tenant, DAY],
        );
      });
    });

    it("raw cost nets the refund out: expected = 0.24, not 0.64 (8 units)", async () => {
      await checkDay(tenant, DAY);

      const rows = await costHealth(tenant, DAY);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].expected)).toBeCloseTo(0.24, 4);
      expect(rows[0].ok).toBe(true);
    });
  });

  // Fix round 1, finding 3: legacy sms_credit_ledger rows add to the raw cost.
  describe("check_crm_results_day: legacy sms_credit_ledger rows (pre-cutover sends) add to the raw cost", () => {
    const tenant = "00000000-0000-4000-9000-000000000102";

    beforeAll(async () => {
      // 4 legacy credits reserved, 1 refunded the same day -> net 3 credits
      // x 0.08 (today is on/after the price book cutover) = 0.24.
      await asSuperAdmin(async () => {
        await db.query(
          `insert into public.sms_credit_ledger (tenant_id, created_at, entry_type, delta_credits) values
             ($1, now(), 'sms_reservation', -4),
             ($1, now(), 'sms_refund', 1)`,
          [tenant],
        );
        await db.query(
          `insert into public.crm_results_daily (tenant_id, metric_date, sent, cost, direct_conversions, direct_active_conversions)
           values ($1, $2::date, 3, 0.24, 0, 0)`,
          [tenant, DAY],
        );
      });
    });

    it("raw cost includes the legacy ledger: expected = 0.24", async () => {
      await checkDay(tenant, DAY);

      const rows = await costHealth(tenant, DAY);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].expected)).toBeCloseTo(0.24, 4);
      expect(rows[0].ok).toBe(true);
    });
  });

  // Fix round 1, finding 2: refresh_crm_results_day's cost sums billed_units,
  // defaulting null to 1, and never counts a rejected send.
  describe("refresh_crm_results_day: cost sums billed_units (null counts 1), skips rejected rows", () => {
    const tenant = "00000000-0000-4000-9000-000000000103";

    beforeAll(async () => {
      await asSuperAdmin(async () => {
        await db.query(
          `insert into public.sms_send_logs (tenant_id, created_at, status, billed_units) values
             ($1, (($2::date)::timestamp at time zone 'America/Sao_Paulo') + interval '10 hours', 'sent', 2),
             ($1, (($2::date)::timestamp at time zone 'America/Sao_Paulo') + interval '11 hours', 'delivered', null),
             ($1, (($2::date)::timestamp at time zone 'America/Sao_Paulo') + interval '12 hours', 'error', 5)`,
          [tenant, DAY],
        );
        await db.query("select public.refresh_crm_results_day($1, $2::date)", [tenant, DAY]);
      });
    });

    it("sent = 2 (the rejected row is excluded) and cost = (2 + 1) x 0.08 = 0.24", async () => {
      const { rows } = await db.query<{ sent: string; cost: string }>(
        `select coalesce(sum(sent), 0)::text sent, coalesce(sum(cost), 0)::text cost
         from public.crm_results_daily where tenant_id = $1 and metric_date = $2::date`,
        [tenant, DAY],
      );
      expect(Number(rows[0].sent)).toBe(2);
      expect(Number(rows[0].cost)).toBeCloseTo(0.24, 4);
    });
  });

  // Fix round 1, finding 1: crm_sms_report_price falls back to the legacy
  // chain before the price book's first valid_from (2026-10-01).
  describe("crm_sms_report_price: legacy fallback before the price book, price book on/after it", () => {
    const tenant = "00000000-0000-4000-9000-000000000104";

    beforeAll(async () => {
      await asSuperAdmin(async () => {
        await db.query(
          `insert into public.tenant_sms_pricing (tenant_id, sale_price_per_sms) values ($1, 0.12)`,
          [tenant],
        );
      });
    });

    it("uses the tenant's legacy override price before the price book exists (2026-09-15)", async () => {
      const { rows } = await db.query<{ v: string }>(
        "select public.crm_sms_report_price($1, '2026-09-15 12:00:00+00'::timestamptz)::text v",
        [tenant],
      );
      expect(Number(rows[0].v)).toBeCloseTo(0.12, 4);
    });

    it("uses the price book's 0.08 on/after the cutover (2026-10-02)", async () => {
      const { rows } = await db.query<{ v: string }>(
        "select public.crm_sms_report_price($1, '2026-10-02 12:00:00+00'::timestamptz)::text v",
        [tenant],
      );
      expect(Number(rows[0].v)).toBeCloseTo(0.08, 4);
    });
  });
});
