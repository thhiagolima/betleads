// Task 2 (web push / OneSignal) — SQL test for
// supabase/migrations/20261210100100_webpush_billing_item.sql: adds the
// `webpush` billing item (R$ 0,01, provider_unit_cost 0) to
// billing_price_book/tenant_price_overrides (Task 2 pricing migration) and
// recreates wallet_reserve/wallet_summary (Task 3 wallet migration) to
// accept it.

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

const PRICE_BOOK_MIGRATION = readMigration(
  "supabase/migrations/20261022100000_billing_price_book.sql",
);
const WALLET_MIGRATION = readMigration("supabase/migrations/20261022100100_billing_wallet.sql");
const WALLET_ALERTS_MIGRATION = readMigration(
  "supabase/migrations/20261024100100_billing_wallet_alerts.sql",
);
const WEBPUSH_BILLING_MIGRATION = readMigration(
  "supabase/migrations/20261210100100_webpush_billing_item.sql",
);

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
  await db.exec(WALLET_ALERTS_MIGRATION);
  await db.exec(WEBPUSH_BILLING_MIGRATION);
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

async function effectivePrice(tenant: string, item: string) {
  const { rows } = await db.query<{ v: Record<string, unknown> }>(
    "select public.billing_effective_price($1, $2) v",
    [tenant, item],
  );
  return rows[0].v;
}

async function reserve(
  tenant: string,
  item: string,
  units: number,
  referenceId: string,
  idempotencyKey: string,
) {
  return asSuperAdmin(async () => {
    const { rows } = await db.query<{ v: Record<string, unknown> }>(
      "select public.wallet_reserve($1, $2, $3, $4, $5, $6) v",
      [tenant, item, units, "webpush_campaign", referenceId, idempotencyKey],
    );
    return rows[0].v;
  });
}

async function walletSummary(tenant: string) {
  const { rows } = await db.query<{ v: Record<string, unknown> }>(
    "select public.wallet_summary($1) v",
    [tenant],
  );
  return rows[0].v;
}

async function fundWallet(tenant: string, amount: number, key: string) {
  return asSuperAdmin(async () => {
    await db.query("select public.admin_adjust_wallet($1, $2, $3, $4)", [
      tenant,
      amount,
      "fund for test",
      key,
    ]);
  });
}

describe("webpush billing item", () => {
  it("billing_effective_price for webpush is R$ 0,01", async () => {
    const v = await effectivePrice(NORMAL, "webpush");
    expect(v).toMatchObject({ item: "webpush", exempt: false, source: "default" });
    expect(Number(v.unit_price)).toBeCloseTo(0.01, 4);
    expect(Number(v.provider_unit_cost)).toBeCloseTo(0, 4);
  });

  it("wallet_reserve debits 0,03 for 3 webpush units on a normal tenant", async () => {
    await fundWallet(NORMAL, 100, "fund-normal-1");
    const before = (await walletSummary(NORMAL)) as Record<string, unknown>;
    const balanceBefore = Number(before.balance ?? 0);

    const result = await reserve(NORMAL, "webpush", 3, "r1", "k1");
    expect(result).toMatchObject({ ok: true, exempt: false });
    expect(Number(result.amount)).toBeCloseTo(-0.03, 4);

    const after = (await walletSummary(NORMAL)) as Record<string, unknown>;
    expect(Number(after.balance)).toBeCloseTo(balanceBefore - 0.03, 4);
  });

  it("wallet_reserve is exempt (no debit) for the interno tenant", async () => {
    const before = (await walletSummary(INTERNO)) as Record<string, unknown>;
    const balanceBefore = Number(before.balance ?? 0);

    const result = await reserve(INTERNO, "webpush", 3, "r2", "k2");
    expect(result).toMatchObject({ ok: true, exempt: true });
    expect(Number(result.amount)).toBeCloseTo(0, 4);

    const after = (await walletSummary(INTERNO)) as Record<string, unknown>;
    expect(Number(after.balance)).toBeCloseTo(balanceBefore, 4);
  });

  it("wallet_summary includes a webpush line for the tenant", async () => {
    const summary = (await walletSummary(NORMAL)) as Record<string, unknown>;
    const usage = summary.month_usage as Array<Record<string, unknown>>;
    const webpushLine = usage.find((row) => row.item === "webpush");
    expect(webpushLine).toBeTruthy();
    expect(Number(webpushLine?.units)).toBe(3);

    const prices = summary.prices as Record<string, unknown>;
    expect(prices).toHaveProperty("webpush");
  });

  it("tenant_price_overrides accepts the webpush item", async () => {
    await asSuperAdmin(async () => {
      await db.query("select public.admin_set_tenant_price($1, $2, $3)", [
        NORMAL,
        "webpush",
        0.02,
      ]);
    });

    const v = await effectivePrice(NORMAL, "webpush");
    expect(v).toMatchObject({ source: "override" });
    expect(Number(v.unit_price)).toBeCloseTo(0.02, 4);

    await asSuperAdmin(async () => {
      await db.query("select public.admin_clear_tenant_price($1, $2)", [NORMAL, "webpush"]);
    });
  });
});
