// PG6-03 — SQL test for supabase/migrations/20261024100400_billing_health_monitor.sql:
// billing_monitor_signals + billing_record_signal (hourly counters, service_role
// only) and billing_health_snapshot (raw numbers the TS monitor turns into
// alerts: signals in the window, paid-but-uncredited charges older than 10 min,
// needs_review charges, wallet/ledger mismatches, last OK run of the billing
// jobs).

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { NORMAL, readMigration, resetSession, SCHEMA, SEED } from "./billing-db-test-support";

const PRICE_BOOK_MIGRATION = readMigration(
  "supabase/migrations/20261022100000_billing_price_book.sql",
);
const WALLET_MIGRATION = readMigration("supabase/migrations/20261022100100_billing_wallet.sql");
const PIX_CHARGES_MIGRATION = readMigration(
  "supabase/migrations/20261022110000_billing_pix_charges.sql",
);
const HEALTH_MIGRATION = readMigration(
  "supabase/migrations/20261024100400_billing_health_monitor.sql",
);

// Subset of dispatcher_runs (20260607023626 + 20261014220000) the snapshot reads.
const DISPATCHER_RUNS_STUB = `
create table public.dispatcher_runs (
  id bigserial primary key,
  channel text not null default 'x',
  job text,
  status text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
`;

const NOW = "2026-10-23T12:00:00Z";

let db: PGlite;

async function asServiceRole<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("set test.role = 'service_role'");
  try {
    return await fn();
  } finally {
    await db.exec("set test.role = ''");
  }
}

type Snapshot = {
  signals: Record<string, { count: number; last_at: string; last_detail: string | null }>;
  paid_uncredited: { count: number; oldest_paid_at: string | null };
  needs_review: { count: number; oldest_at: string | null };
  wallet_mismatch: { count: number; tenant_ids: string[] };
  jobs_last_ok: Record<string, string | null>;
};

async function snapshot(windowHours = 1, now = NOW): Promise<Snapshot> {
  return asServiceRole(async () => {
    const { rows } = await db.query<{ v: Snapshot }>(
      "select public.billing_health_snapshot($1, $2::timestamptz) v",
      [windowHours, now],
    );
    return rows[0].v;
  });
}

let chargeCounter = 0;
async function insertCharge(opts: {
  status: string;
  paidAt?: string | null;
  creditedAt?: string | null;
  needsReview?: boolean;
}) {
  chargeCounter += 1;
  await db.query(
    `insert into public.payment_charges
       (tenant_id, kind, ref_id, external_id, status, amount_cents, paid_amount_cents,
        paid_at, credited_at, needs_review, updated_at)
     values ($1, 'credit_topup', gen_random_uuid(), $2, $3, 10000, 10000, $4, $5, $6, $7)`,
    [
      NORMAL,
      `ext-${chargeCounter}`,
      opts.status,
      opts.paidAt ?? null,
      opts.creditedAt ?? null,
      opts.needsReview ?? false,
      opts.paidAt ?? NOW,
    ],
  );
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  await db.exec(PRICE_BOOK_MIGRATION);
  await db.exec(WALLET_MIGRATION);
  await db.exec(PIX_CHARGES_MIGRATION);
  await db.exec(DISPATCHER_RUNS_STUB);
  await db.exec(HEALTH_MIGRATION);
}, 60_000);

beforeEach(async () => {
  await resetSession(db);
  await db.exec(`
    delete from public.billing_monitor_signals;
    delete from public.payment_charges;
    delete from public.dispatcher_runs;
    delete from public.wallet_ledger;
    delete from public.tenant_wallets;
  `);
});

afterAll(async () => {
  await db?.close();
});

describe("billing_record_signal", () => {
  it("is forbidden outside service_role", async () => {
    await expect(
      db.query("select public.billing_record_signal('upper_unauthorized', 'x')"),
    ).rejects.toThrow(/forbidden/);
  });

  it("counts repeated signals in one hourly row and keeps the latest detail", async () => {
    await asServiceRole(async () => {
      await db.query(
        "select public.billing_record_signal('webhook_invalid_signature', 'mismatch')",
      );
      await db.query("select public.billing_record_signal('webhook_invalid_signature', 'stale')");
    });
    const { rows } = await db.query<{ count: string; last_detail: string }>(
      "select count, last_detail from public.billing_monitor_signals where code = 'webhook_invalid_signature'",
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].count)).toBe(2);
    expect(rows[0].last_detail).toBe("stale");
  });

  it("truncates the detail and rejects malformed codes", async () => {
    await asServiceRole(async () => {
      await db.query("select public.billing_record_signal('upper_unauthorized', $1)", [
        "x".repeat(500),
      ]);
      await expect(
        db.query("select public.billing_record_signal('Bad Code', null)"),
      ).rejects.toThrow();
    });
    const { rows } = await db.query<{ len: number }>(
      "select length(last_detail) len from public.billing_monitor_signals where code = 'upper_unauthorized'",
    );
    expect(rows[0].len).toBe(200);
  });

  it("grants nothing to authenticated", async () => {
    await db.exec("set role authenticated");
    try {
      await expect(db.query("select * from public.billing_monitor_signals")).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        db.query("select public.billing_record_signal('upper_unauthorized', null)"),
      ).rejects.toThrow(/permission denied/);
      await expect(db.query("select public.billing_health_snapshot(1, now())")).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await db.exec("reset role");
    }
  });
});

describe("billing_health_snapshot", () => {
  it("is forbidden outside service_role", async () => {
    await expect(db.query("select public.billing_health_snapshot(1, now())")).rejects.toThrow(
      /forbidden/,
    );
  });

  it("returns an all-clear shape on an empty database", async () => {
    const snap = await snapshot();
    expect(snap.signals).toEqual({});
    expect(Number(snap.paid_uncredited.count)).toBe(0);
    expect(Number(snap.needs_review.count)).toBe(0);
    expect(Number(snap.wallet_mismatch.count)).toBe(0);
    expect(snap.jobs_last_ok).toEqual({ "billing-reconcile": null, "billing-cycle": null });
  });

  it("sums signals inside the window only", async () => {
    await db.exec(`
      insert into public.billing_monitor_signals (code, bucket_start, count, first_at, last_at, last_detail) values
        ('webhook_invalid_signature', '2026-10-23T11:00:00Z', 3, '2026-10-23T11:10:00Z', '2026-10-23T11:30:00Z', 'mismatch'),
        ('webhook_invalid_signature', '2026-10-23T09:00:00Z', 7, '2026-10-23T09:10:00Z', '2026-10-23T09:30:00Z', 'old'),
        ('upper_feature_disabled', '2026-10-23T11:00:00Z', 1, '2026-10-23T11:50:00Z', '2026-10-23T11:50:00Z', '403 FEATURE_DISABLED');
    `);
    const oneHour = await snapshot(1);
    expect(Number(oneHour.signals.webhook_invalid_signature.count)).toBe(3);
    expect(oneHour.signals.webhook_invalid_signature.last_detail).toBe("mismatch");
    expect(Number(oneHour.signals.upper_feature_disabled.count)).toBe(1);

    const day = await snapshot(24);
    expect(Number(day.signals.webhook_invalid_signature.count)).toBe(10);
    expect(day.signals.webhook_invalid_signature.last_detail).toBe("mismatch");
  });

  it("counts PAID charges not credited after 10 min, excluding needs_review", async () => {
    await insertCharge({ status: "PAID", paidAt: "2026-10-23T11:40:00Z" }); // 20 min: alert
    await insertCharge({ status: "PAID", paidAt: "2026-10-23T11:55:00Z" }); // 5 min: not yet
    await insertCharge({
      status: "PAID",
      paidAt: "2026-10-23T11:00:00Z",
      creditedAt: "2026-10-23T11:01:00Z",
    });
    await insertCharge({ status: "PAID", paidAt: "2026-10-23T10:00:00Z", needsReview: true });
    await insertCharge({ status: "ACTIVE" });

    const snap = await snapshot();
    expect(Number(snap.paid_uncredited.count)).toBe(1);
    expect(new Date(snap.paid_uncredited.oldest_paid_at!).toISOString()).toBe(
      "2026-10-23T11:40:00.000Z",
    );
    expect(Number(snap.needs_review.count)).toBe(1);
  });

  it("reports wallets whose balance differs from the ledger", async () => {
    await db.query("insert into public.tenant_wallets (tenant_id, balance) values ($1, 50)", [
      NORMAL,
    ]);
    const snap = await snapshot();
    expect(Number(snap.wallet_mismatch.count)).toBe(1);
    expect(snap.wallet_mismatch.tenant_ids).toEqual([NORMAL]);
  });

  it("returns the last succeeded/partial run of each billing job", async () => {
    await db.exec(`
      insert into public.dispatcher_runs (job, status, started_at, finished_at) values
        ('billing-reconcile', 'succeeded', '2026-10-23T11:50:00Z', '2026-10-23T11:50:05Z'),
        ('billing-reconcile', 'failed',    '2026-10-23T11:55:00Z', '2026-10-23T11:55:05Z'),
        ('billing-cycle',     'partial',   '2026-10-23T11:07:00Z', '2026-10-23T11:07:30Z'),
        ('billing-cycle',     'running',   '2026-10-23T11:59:00Z', null);
    `);
    const snap = await snapshot();
    expect(new Date(snap.jobs_last_ok["billing-reconcile"]!).toISOString()).toBe(
      "2026-10-23T11:50:05.000Z",
    );
    expect(new Date(snap.jobs_last_ok["billing-cycle"]!).toISOString()).toBe(
      "2026-10-23T11:07:30.000Z",
    );
  });
});
