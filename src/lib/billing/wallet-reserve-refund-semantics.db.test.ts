// Task 11 fix round 1 (controller ruling) — pins the two real
// wallet_reserve/wallet_refund semantics that the webpush campaign dispatcher
// (src/lib/webpush/campaign-dispatch.server.ts) and its in-memory test fake
// both depend on:
//
//   1. wallet_mutation dedupes FOREVER on (tenant_id, idempotency_key)
//      (20261022100100_billing_wallet.sql:159-167) — even after the
//      reservation it names has been refunded, reserving again with that
//      SAME key returns the old reservation as `idempotent: true` and
//      charges nothing new. A design that refunds and then re-reserves with
//      the same key on retry (the bug this migration's sibling,
//      20261210100300_webpush_dispatch_batches.sql, fixes) sends the retried
//      batch for free.
//   2. wallet_refund refunds only the NEWEST usage_reservation row for a
//      given reference_id (`order by created_at desc limit 1`) — a second,
//      older reservation sharing the same reference_id is never reachable
//      through that reference again.
//
// If either of these ever changes, this test (not just the dispatcher's own
// in-memory fake) must fail first.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
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

async function adjustWallet(tenant: string, amount: number, reason: string, key: string) {
  return asSuperAdmin(async () => {
    const { rows } = await db.query<{ v: Record<string, unknown> }>(
      "select public.admin_adjust_wallet($1, $2, $3, $4) v",
      [tenant, amount, reason, key],
    );
    return rows[0].v;
  });
}

async function reserve(referenceId: string, idempotencyKey: string, units = 1) {
  return asSuperAdmin(async () => {
    const { rows } = await db.query<{ v: Record<string, unknown> }>(
      "select public.wallet_reserve($1, $2, $3, $4, $5, $6) v",
      [NORMAL, "sms", units, "webpush_campaign", referenceId, idempotencyKey],
    );
    return rows[0].v as { ok: boolean; idempotent: boolean; amount: number; balance: number };
  });
}

async function refund(referenceId: string, idempotencyKey: string, reason = "test") {
  return asSuperAdmin(async () => {
    const { rows } = await db.query<{ v: Record<string, unknown> }>(
      "select public.wallet_refund($1, $2, $3, $4) v",
      [NORMAL, referenceId, idempotencyKey, reason],
    );
    return rows[0].v as { ok: boolean; idempotent?: boolean; reason?: string; amount?: number };
  });
}

async function balanceOf(): Promise<number> {
  const { rows } = await db.query<{ balance: string }>(
    "select balance from public.tenant_wallets where tenant_id = $1",
    [NORMAL],
  );
  return rows.length ? Number(rows[0].balance) : 0;
}

describe("wallet_reserve/wallet_refund — real semantics the webpush dispatcher relies on", () => {
  beforeAll(async () => {
    await adjustWallet(NORMAL, 10.0, "saldo inicial", "adj:webpush-semantics:1");
  });

  it("reserve-after-refund with the SAME idempotency key charges nothing (the critical bug this migration fixes)", async () => {
    const before = await balanceOf();

    const first = await reserve("ref:temp-then-retry", "key:temp-then-retry");
    expect(first.ok).toBe(true);
    expect(first.idempotent).toBe(false);
    const afterReserve = await balanceOf();
    expect(afterReserve).toBeLessThan(before); // actually charged

    const refunded = await refund("ref:temp-then-retry", "key:temp-then-retry:refund");
    expect(refunded.ok).toBe(true);
    const afterRefund = await balanceOf();
    expect(afterRefund).toBeCloseTo(before, 6); // fully reversed

    // The critical bug: re-reserving with the SAME key after the refund must
    // not charge again — it must come back idempotent, referencing the OLD
    // (now-refunded) reservation, and the balance must not move.
    const retried = await reserve("ref:temp-then-retry", "key:temp-then-retry");
    expect(retried.ok).toBe(true);
    expect(retried.idempotent).toBe(true);
    const afterRetry = await balanceOf();
    expect(afterRetry).toBeCloseTo(afterRefund, 6);
    expect(afterRetry).toBeCloseTo(before, 6);
  });

  it("wallet_refund targets only the NEWEST reservation for a reference_id — an older one sharing it is never reachable again", async () => {
    const before = await balanceOf();

    const older = await reserve("ref:shared", "key:shared:older");
    const newer = await reserve("ref:shared", "key:shared:newer");
    expect(older.ok).toBe(true);
    expect(newer.ok).toBe(true);
    const afterBothReserved = await balanceOf();
    expect(afterBothReserved).toBeCloseTo(before + older.amount + newer.amount, 6);

    // Refunds the NEWER one (order by created_at desc).
    const refunded = await refund("ref:shared", "key:shared:refund-1");
    expect(refunded.ok).toBe(true);
    expect(Number(refunded.amount)).toBeCloseTo(-newer.amount, 6);
    const afterFirstRefund = await balanceOf();
    expect(afterFirstRefund).toBeCloseTo(afterBothReserved - newer.amount, 6);

    // A second refund attempt against the same reference_id (a different
    // key, since the SAME key would just be idempotent on the first refund)
    // looks up "the newest reservation" again — finds the SAME (newer) one,
    // sees it already has a refund under a different key, and refuses.
    // The OLDER reservation is never refunded through this reference again.
    const secondAttempt = await refund("ref:shared", "key:shared:refund-2");
    expect(secondAttempt.ok).toBe(false);
    expect(secondAttempt.reason).toBe("already_refunded");
    const afterSecondAttempt = await balanceOf();
    expect(afterSecondAttempt).toBeCloseTo(afterFirstRefund, 6); // unchanged
  });
});
