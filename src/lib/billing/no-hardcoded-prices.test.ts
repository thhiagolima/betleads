// PG1 Task 6 — SQL test for
// supabase/migrations/20261022100300_billing_prices_in_reports.sql:
// refresh_crm_results_day / check_crm_results_day / admin_list_users_with_usage
// stop reading the legacy flat 0,12 fallback or the old platform_pricing
// table, and check_crm_results_day reconciles against the new wallet_ledger
// (plus the legacy sms_credit_ledger) instead.
//
// The TypeScript side (billing_report_unit_price callers elsewhere) is
// covered in Task 7; this file only exercises the SQL migration.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  INTERNO,
  NORMAL,
  readMigration,
  resetSession as resetDbSession,
  SCHEMA,
  SEED,
} from "./billing-db-test-support";

const MIGRATION_PATH = "supabase/migrations/20261022100300_billing_prices_in_reports.sql";
const MIGRATION_SQL = readMigration(MIGRATION_PATH);

describe("migration text: no hardcoded legacy prices", () => {
  it("does not contain the legacy 0.12 literal", () => {
    expect(MIGRATION_SQL).not.toContain("0.12");
  });

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

// Minimal stubs of the tables check_crm_results_day touches beyond what
// billing-db-test-support's SCHEMA/SEED already provide (tenants, wallet,
// price book). These mirror just the columns the function reads.
const REPORT_STUBS = `
create table public.crm_results_daily (
  tenant_id uuid not null,
  metric_date date not null,
  sent integer not null default 0,
  cost numeric not null default 0,
  direct_conversions integer not null default 0,
  direct_active_conversions integer not null default 0
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
  billed_units smallint null
);
create table public.conversion_attributions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
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
`;

function readMigrationFile(relativePath: string): string {
  return readFileSync(resolve(__dirname, "../../..", relativePath), "utf8");
}

describe("check_crm_results_day: reconciles against wallet_ledger x billing_report_unit_price", () => {
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
    await db.exec(readMigrationFile(MIGRATION_PATH));
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

  async function checkDay(tenant: string, day: string): Promise<number> {
    return asSuperAdmin(async () => {
      const { rows } = await db.query<{ v: number }>(
        "select public.check_crm_results_day($1, $2::date) v",
        [tenant, day],
      );
      return rows[0].v;
    });
  }

  let DAY: string;

  beforeAll(async () => {
    // wallet_reserve stamps created_at with the real now() (no test clock is
    // set in this file), so the day under test must be "today" in BRT.
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

      const { rows } = await db.query<{ ok: boolean; expected: string; actual: string }>(
        `select ok, expected::text, actual::text from public.crm_results_health
         where tenant_id = $1 and metric_date = $2::date and check_name = 'cost'`,
        [tenant, DAY],
      );
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

      const { rows } = await db.query<{ ok: boolean }>(
        `select ok from public.crm_results_health
         where tenant_id = $1 and metric_date = $2::date and check_name = 'cost'`,
        [tenant, DAY],
      );
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

      const { rows } = await db.query<{ ok: boolean; expected: string }>(
        `select ok, expected::text from public.crm_results_health
         where tenant_id = $1 and metric_date = $2::date and check_name = 'cost'`,
        [tenant, DAY],
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].expected)).toBeCloseTo(0.59, 4);
      expect(rows[0].ok).toBe(true);
    });
  });
});
