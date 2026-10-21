// PG1 Task 4 — SQL test for
// supabase/migrations/20261022100200_billing_legacy_sms_conversion.sql:
// billing_convert_legacy_sms_credits, which converts the old prepaid SMS
// credits (tenant_sms_credit_balances, legacy migration
// 20260922193000_create_sms_credit_billing.sql) into the new BRL wallet.
//
// 1 old credit = 1 SMS at the house's NEW sms price (0.08 by default), never
// the legacy sale price (0.12) stored in tenant_sms_credit_balances'
// sibling tables. Applies the legacy credits migration, then Tasks 2/3/4.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  INTERNO,
  readMigration,
  resetSession as resetDbSession,
  SCHEMA,
  SEED,
} from "./billing-db-test-support";

const LEGACY_CREDITS_MIGRATION = readMigration(
  "supabase/migrations/20260922193000_create_sms_credit_billing.sql",
);
const PRICE_BOOK_MIGRATION = readMigration(
  "supabase/migrations/20261022100000_billing_price_book.sql",
);
const WALLET_MIGRATION = readMigration("supabase/migrations/20261022100100_billing_wallet.sql");
const CONVERSION_MIGRATION = readMigration(
  "supabase/migrations/20261022100200_billing_legacy_sms_conversion.sql",
);

let db: PGlite;

async function resetSession() {
  await resetDbSession(db);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  await db.exec(LEGACY_CREDITS_MIGRATION);
  await db.exec(PRICE_BOOK_MIGRATION);
  await db.exec(WALLET_MIGRATION);
  await db.exec(CONVERSION_MIGRATION);
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

type ConversionRow = {
  tenant_id: string;
  slug: string;
  legacy_balance: number;
  already_converted: number;
  delta_credits: number;
  unit_price: string;
  amount: string;
  skipped_reason: string | null;
};

async function convert(apply: boolean): Promise<ConversionRow[]> {
  return asSuperAdmin(async () => {
    const { rows } = await db.query<ConversionRow>(
      "select * from public.billing_convert_legacy_sms_credits($1)",
      [apply],
    );
    return rows;
  });
}

async function balanceOf(tenant: string): Promise<number> {
  const { rows } = await db.query<{ balance: string }>(
    "select balance from public.tenant_wallets where tenant_id = $1",
    [tenant],
  );
  return rows.length ? Number(rows[0].balance) : 0;
}

async function setLegacyBalance(tenant: string, slug: string, credits: number, legacySalePrice = 0.12) {
  await asSuperAdmin(async () => {
    await db.query(
      `insert into public.tenant_sms_pricing (tenant_id, sale_price_per_sms)
       values ($1, $2)
       on conflict (tenant_id) do update set sale_price_per_sms = excluded.sale_price_per_sms`,
      [tenant, legacySalePrice],
    );
    await db.query(
      `insert into public.tenant_sms_credit_balances (tenant_id, balance_credits)
       values ($1, $2)
       on conflict (tenant_id) do update set balance_credits = excluded.balance_credits`,
      [tenant, credits],
    );
  });
}

describe("billing_convert_legacy_sms_credits: preview (_apply = false)", () => {
  const CASA_A = "00000000-0000-4000-9100-000000000001";

  beforeAll(async () => {
    await asSuperAdmin(() =>
      db.query(`insert into public.tenants (id, slug, plano, is_demo) values ($1, 'casa-a', 'starter', false)`, [
        CASA_A,
      ]),
    );
    await setLegacyBalance(CASA_A, "casa-a", 1000, 0.12);
    await setLegacyBalance(INTERNO, "minha-demo", 99_999_999, 0.12);
  });

  it("shows casa A at the new sms price (0.08), never the legacy 0.12", async () => {
    const rows = await convert(false);
    const a = rows.find((r) => r.tenant_id === CASA_A);
    expect(a).toBeDefined();
    expect(Number(a!.unit_price)).toBeCloseTo(0.08, 4);
    expect(Number(a!.amount)).toBeCloseTo(80.0, 4);
    expect(a!.delta_credits).toBe(1000);
    expect(a!.already_converted).toBe(0);
    expect(a!.skipped_reason).toBeNull();
  });

  it("skips the interno tenant with skipped_reason = 'interno'", async () => {
    const rows = await convert(false);
    const interno = rows.find((r) => r.tenant_id === INTERNO);
    expect(interno).toBeDefined();
    expect(interno!.skipped_reason).toBe("interno");
  });

  it("does not write anything to wallet_ledger", async () => {
    const { rows } = await db.query<{ count: string }>(
      "select count(*)::text as count from public.wallet_ledger",
    );
    expect(Number(rows[0].count)).toBe(0);
  });
});

describe("billing_convert_legacy_sms_credits: apply (_apply = true)", () => {
  const CASA_B = "00000000-0000-4000-9100-000000000002";

  beforeAll(async () => {
    await asSuperAdmin(() =>
      db.query(`insert into public.tenants (id, slug, plano, is_demo) values ($1, 'casa-b', 'starter', false)`, [
        CASA_B,
      ]),
    );
    await setLegacyBalance(CASA_B, "casa-b", 1000, 0.12);
  });

  it("converts casa B to a wallet balance of 80.00", async () => {
    const rows = await convert(true);
    const b = rows.find((r) => r.tenant_id === CASA_B);
    expect(b).toBeDefined();
    expect(b!.skipped_reason).toBeNull();
    expect(await balanceOf(CASA_B)).toBeCloseTo(80.0, 4);
  });

  it("running _apply = true again gives delta 0 for B and no new ledger row", async () => {
    const before = await db.query<{ count: string }>(
      "select count(*)::text as count from public.wallet_ledger where tenant_id = $1",
      [CASA_B],
    );

    const rows = await convert(true);
    const b = rows.find((r) => r.tenant_id === CASA_B);
    expect(b!.delta_credits).toBe(0);

    const after = await db.query<{ count: string }>(
      "select count(*)::text as count from public.wallet_ledger where tenant_id = $1",
      [CASA_B],
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
    expect(await balanceOf(CASA_B)).toBeCloseTo(80.0, 4);
  });

  it("the ledger row recorded for B has the right shape", async () => {
    const { rows } = await db.query<{
      entry_type: string;
      item: string;
      units: number;
      unit_price: string;
      reference_type: string;
      reason: string;
      metadata: Record<string, unknown>;
    }>(
      `select entry_type, item, units, unit_price::text, reference_type, reason, metadata
       from public.wallet_ledger where tenant_id = $1`,
      [CASA_B],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entry_type: "migration",
      item: "sms",
      units: 1000,
      reference_type: "legacy_sms_conversion",
      reason: "Conversão dos créditos SMS antigos",
    });
    expect(Number(rows[0].unit_price)).toBeCloseTo(0.08, 4);
    expect(rows[0].metadata).toMatchObject({ legacy_credits: 1000 });
  });

  it("a later drop in the legacy balance to 990 (sent via the old code) converts just -0.80", async () => {
    await setLegacyBalance(CASA_B, "casa-b", 990, 0.12);
    const rows = await convert(true);
    const b = rows.find((r) => r.tenant_id === CASA_B);
    expect(b!.delta_credits).toBe(-10);
    expect(Number(b!.amount)).toBeCloseTo(-0.8, 4);
    expect(await balanceOf(CASA_B)).toBeCloseTo(79.2, 4);
  });
});

describe("billing_convert_legacy_sms_credits: clamped case", () => {
  const CASA_C = "00000000-0000-4000-9100-000000000003";

  beforeAll(async () => {
    await asSuperAdmin(() =>
      db.query(`insert into public.tenants (id, slug, plano, is_demo) values ($1, 'casa-c', 'starter', false)`, [
        CASA_C,
      ]),
    );
    await setLegacyBalance(CASA_C, "casa-c", 1000, 0.12);
    // First conversion: wallet goes to 80.00.
    await convert(true);
  });

  it("clamps a negative delta that would take the wallet below zero", async () => {
    // Spend most of the wallet via a normal usage reservation first, then
    // drop the legacy balance to 0: a full -80.00 conversion would take the
    // wallet from ~0.08 to -79.92. It should clamp to 0 instead.
    await asSuperAdmin(async () => {
      await db.query(
        `update public.tenant_wallets set balance = 0.08 where tenant_id = $1`,
        [CASA_C],
      );
    });
    await setLegacyBalance(CASA_C, "casa-c", 0, 0.12);

    const rows = await convert(true);
    const c = rows.find((r) => r.tenant_id === CASA_C);
    expect(c!.delta_credits).toBe(-1000);
    expect(c!.skipped_reason).toBe("clamped");
    expect(Number(c!.amount)).toBeCloseTo(-0.08, 4);
    expect(await balanceOf(CASA_C)).toBeCloseTo(0, 4);

    const { rows: ledgerRows } = await db.query<{ metadata: Record<string, unknown> }>(
      `select metadata from public.wallet_ledger
       where tenant_id = $1 and entry_type = 'migration' order by created_at desc limit 1`,
      [CASA_C],
    );
    // metadata keeps the full delta so a later run does not retry the
    // clamped-off difference.
    expect(ledgerRows[0].metadata).toMatchObject({ legacy_credits: -1000 });

    // Running again gives delta 0 (already_converted now reflects the full
    // -1000, even though only -0.08 was actually posted).
    const again = await convert(true);
    const cAgain = again.find((r) => r.tenant_id === CASA_C);
    expect(cAgain!.delta_credits).toBe(0);
    expect(await balanceOf(CASA_C)).toBeCloseTo(0, 4);
  });
});

describe("billing_convert_legacy_sms_credits: permissions", () => {
  beforeEach(async () => {
    await resetSession();
  });

  it("throws forbidden without superadmin or service_role", async () => {
    await db.exec("set test.role = 'authenticated'");
    await expect(db.query("select * from public.billing_convert_legacy_sms_credits($1)", [false])).rejects.toThrow(
      /forbidden/,
    );
  });

  it("allows service_role", async () => {
    await db.exec("set test.role = 'service_role'");
    await expect(
      db.query("select * from public.billing_convert_legacy_sms_credits($1)", [false]),
    ).resolves.toBeDefined();
  });
});
