// Task 6 — SQL test for supabase/migrations/20261211100000_billing_month_usage.sql:
// billing_month_usage(_month) aggregates one month's usage_reservation/usage_refund
// wallet_ledger rows per tenant x item, and only service_role may execute it.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { NORMAL, readMigration, resetSession, SCHEMA, SEED } from "./billing-db-test-support";

const PRICE_BOOK_MIGRATION = readMigration(
  "supabase/migrations/20261022100000_billing_price_book.sql",
);
const WALLET_MIGRATION = readMigration("supabase/migrations/20261022100100_billing_wallet.sql");
const MONTH_USAGE_MIGRATION = readMigration(
  "supabase/migrations/20261211100000_billing_month_usage.sql",
);

const OTHER = "00000000-0000-4000-8000-0000000000f1";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  await db.exec(PRICE_BOOK_MIGRATION);
  await db.exec(WALLET_MIGRATION);
  await db.exec(MONTH_USAGE_MIGRATION);

  // (tenant, entry_type, item, units, usage_month, provider_unit_cost, amount)
  await db.exec(`
    insert into public.wallet_ledger
      (tenant_id, entry_type, item, units, usage_month, provider_unit_cost, amount, balance_after)
    values
      ('${NORMAL}', 'usage_reservation', 'sms', 1000, '2026-10-01', 0.059, -80, 0),
      ('${NORMAL}', 'usage_reservation', 'sms', 500, '2026-10-01', 0.059, -40, 0),
      ('${NORMAL}', 'usage_refund', 'sms', 10, '2026-10-01', 0.059, 0.8, 0),
      ('${NORMAL}', 'usage_reservation', 'sms', 100, '2026-10-01', null, -8, 0),
      ('${NORMAL}', 'usage_reservation', 'voice_30s', 200, '2026-10-01', 0.034, -20, 0),
      ('${NORMAL}', 'usage_reservation', 'sms', 999, '2026-09-01', 0.059, -79.92, 0),
      ('${NORMAL}', 'purchase', null, null, '2026-10-01', null, 500, 500),
      ('${OTHER}', 'usage_reservation', 'email', 300, '2026-10-01', null, -0.3, 0),
      ('${OTHER}', 'usage_refund', 'email', 20, '2026-10-01', null, 0.02, 0),
      ('${OTHER}', 'usage_reservation', 'voice_30s', 40, '2026-10-01', 0.034, -4, 0);
  `);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec("reset role");
  await resetSession(db);
});

type UsageRow = {
  tenant_id: string;
  item: string;
  units: string;
  sale_amount: string;
  provider_cost: string;
  missing_cost_units: string;
};

async function usage(month: string) {
  const { rows } = await db.query<UsageRow>(
    `select tenant_id, item, units::text, sale_amount::text, provider_cost::text,
            missing_cost_units::text
       from public.billing_month_usage($1::date)
      order by tenant_id, item`,
    [month],
  );
  return rows.map((r) => ({
    tenant_id: r.tenant_id,
    item: r.item,
    units: Number(r.units),
    sale_amount: Number(r.sale_amount),
    provider_cost: Number(r.provider_cost),
    missing_cost_units: Number(r.missing_cost_units),
  }));
}

describe("billing_month_usage", () => {
  it("aggregates the month's usage rows per tenant x item, signed by entry type", async () => {
    expect(await usage("2026-10-01")).toEqual([
      {
        tenant_id: NORMAL,
        item: "sms",
        units: 1590, // 1000 + 500 - 10 (refund) + 100 (null cost)
        sale_amount: 127.2,
        provider_cost: 87.91, // 1490 x 0.059; the null-cost row is left out
        missing_cost_units: 100,
      },
      {
        tenant_id: NORMAL,
        item: "voice_30s",
        units: 200,
        sale_amount: 20,
        provider_cost: 6.8,
        missing_cost_units: 0,
      },
      {
        tenant_id: OTHER,
        item: "email",
        units: 280, // 300 - 20 (refund)
        sale_amount: 0.28,
        provider_cost: 0,
        missing_cost_units: 280, // 300 - 20 (refund)
      },
      {
        tenant_id: OTHER,
        item: "voice_30s",
        units: 40,
        sale_amount: 4,
        provider_cost: 1.36,
        missing_cost_units: 0,
      },
    ]);
  });

  it("only sees the requested usage_month", async () => {
    expect(await usage("2026-09-01")).toEqual([
      {
        tenant_id: NORMAL,
        item: "sms",
        units: 999,
        sale_amount: 79.92,
        provider_cost: 58.941,
        missing_cost_units: 0,
      },
    ]);
    expect(await usage("2026-11-01")).toEqual([]);
  });

  it("service_role can execute it", async () => {
    await db.exec("set role service_role");
    const { rows } = await db.query(
      "select count(*)::int as n from public.billing_month_usage('2026-10-01')",
    );
    expect(rows[0]).toEqual({ n: 4 });
  });

  it.each(["anon", "authenticated"])("%s cannot execute it", async (role) => {
    await db.exec(`set role ${role}`);
    await expect(
      db.query("select * from public.billing_month_usage('2026-10-01')"),
    ).rejects.toThrow(/permission denied/);
  });
});
