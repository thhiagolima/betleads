// PG6-03 fix wave — SQL test for
// supabase/migrations/20261024100500_billing_review_and_retention.sql:
// - billing_credit_paid_charge flags needs_review on amount_mismatch for a
//   credit_topup (both the paid-vs-charge and the order-vs-charge checks);
// - billing_resolve_charge_review (service_role; records the outcome, never
//   credits, writes a tenant audit row) and its effect on the health snapshot;
// - billing_purge_webhook_bodies (90-day raw body retention, batched).

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { NORMAL, readMigration, resetSession, SCHEMA, SEED } from "./billing-db-test-support";

const AUDIT_MIGRATION = readMigration(
  "supabase/migrations/20260923120000_create_tenant_audit_logs.sql",
);
const PRICE_BOOK_MIGRATION = readMigration(
  "supabase/migrations/20261022100000_billing_price_book.sql",
);
const WALLET_MIGRATION = readMigration("supabase/migrations/20261022100100_billing_wallet.sql");
const PIX_CHARGES_MIGRATION = readMigration(
  "supabase/migrations/20261022110000_billing_pix_charges.sql",
);
const INVOICES_MIGRATION = readMigration("supabase/migrations/20261023100000_billing_invoices.sql");
const HEALTH_MIGRATION = readMigration(
  "supabase/migrations/20261024100400_billing_health_monitor.sql",
);
const REVIEW_MIGRATION = readMigration(
  "supabase/migrations/20261024100500_billing_review_and_retention.sql",
);

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

const ADMIN_USER = "00000000-0000-4000-8000-00000000a0a1";

let db: PGlite;

async function asServiceRole<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("set test.role = 'service_role'");
  try {
    return await fn();
  } finally {
    await db.exec("set test.role = ''");
  }
}

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<{ v: T }>(sql, params);
  return rows[0].v;
}

let counter = 0;
async function seedTopup(opts: {
  orderAmount?: number;
  chargeAmount?: number;
  paidAmount?: number | null;
  status?: string;
  needsReview?: boolean;
}): Promise<{ chargeId: string; orderId: string }> {
  counter += 1;
  const orderId = await scalar<string>(
    `insert into public.credit_topup_orders (tenant_id, amount_cents) values ($1, $2) returning id v`,
    [NORMAL, opts.orderAmount ?? 10000],
  );
  const chargeId = await scalar<string>(
    `insert into public.payment_charges
       (tenant_id, kind, ref_id, external_id, status, amount_cents, paid_amount_cents, paid_at, needs_review)
     values ($1, 'credit_topup', $2, $3, $4, $5, $6, now() - interval '1 hour', $7)
     returning id v`,
    [
      NORMAL,
      orderId,
      `ext-review-${counter}`,
      opts.status ?? "PAID",
      opts.chargeAmount ?? 10000,
      opts.paidAmount === undefined ? 10000 : opts.paidAmount,
      opts.needsReview ?? false,
    ],
  );
  return { chargeId, orderId };
}

async function credit(chargeId: string) {
  return asServiceRole(() =>
    scalar<Record<string, unknown>>("select public.billing_credit_paid_charge($1) v", [chargeId]),
  );
}

async function chargeRow(chargeId: string) {
  const { rows } = await db.query<Record<string, unknown>>(
    "select * from public.payment_charges where id = $1",
    [chargeId],
  );
  return rows[0];
}

async function resolve(chargeId: string, outcome: string, reason: string, actor = ADMIN_USER) {
  return asServiceRole(() =>
    scalar<Record<string, unknown>>(
      "select public.billing_resolve_charge_review($1, $2, $3, $4) v",
      [chargeId, outcome, reason, actor],
    ),
  );
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  await db.exec(AUDIT_MIGRATION);
  await db.exec(PRICE_BOOK_MIGRATION);
  await db.exec(WALLET_MIGRATION);
  await db.exec(PIX_CHARGES_MIGRATION);
  await db.exec(`set app.allow_test_clock = 'on'; set test.now = '2026-10-23 12:00:00-03';`);
  await db.exec(INVOICES_MIGRATION);
  await resetSession(db);
  await db.exec(DISPATCHER_RUNS_STUB);
  await db.exec(HEALTH_MIGRATION);
  await db.exec(REVIEW_MIGRATION);
  await db.query("insert into auth.users (id) values ($1)", [ADMIN_USER]);
}, 60_000);

beforeEach(async () => {
  await resetSession(db);
});

afterAll(async () => {
  await db?.close();
});

describe("billing_credit_paid_charge: credit_topup amount mismatch", () => {
  it("flags needs_review when the paid amount differs from the charge", async () => {
    const { chargeId } = await seedTopup({ paidAmount: 9000 });
    const result = await credit(chargeId);
    expect(result).toMatchObject({ ok: false, reason: "amount_mismatch" });
    const row = await chargeRow(chargeId);
    expect(row.needs_review).toBe(true);
    expect(row.credited_at).toBeNull();
    // Retrying never credits: the review flag is now sticky.
    expect(await credit(chargeId)).toMatchObject({ ok: false, reason: "needs_review" });
  });

  it("flags needs_review when the order amount differs from the charge", async () => {
    const { chargeId } = await seedTopup({
      orderAmount: 20000,
      chargeAmount: 10000,
      paidAmount: 10000,
    });
    const result = await credit(chargeId);
    expect(result).toMatchObject({ ok: false, reason: "amount_mismatch" });
    expect((await chargeRow(chargeId)).needs_review).toBe(true);
  });

  it("still credits a matching charge", async () => {
    const { chargeId } = await seedTopup({});
    const result = await credit(chargeId);
    expect(result.ok).toBe(true);
    const row = await chargeRow(chargeId);
    expect(row.credited_at).not.toBeNull();
    expect(row.needs_review).toBe(false);
  });

  it("keeps the function service_role only", async () => {
    const { chargeId } = await seedTopup({});
    await expect(
      db.query("select public.billing_credit_paid_charge($1)", [chargeId]),
    ).rejects.toThrow(/forbidden/);
  });
});

describe("billing_resolve_charge_review", () => {
  it("records the outcome, never credits, and writes an audit row", async () => {
    const { chargeId } = await seedTopup({ paidAmount: 9000, needsReview: true });
    const before = await scalar<string>(
      "select count(*)::text v from public.wallet_ledger where tenant_id = $1",
      [NORMAL],
    );
    const result = await resolve(chargeId, "devolvido", "Pix devolvido pelo banco em 23/10");
    expect(result).toMatchObject({ ok: true, tenant_id: NORMAL });

    const row = await chargeRow(chargeId);
    expect(row.review_outcome).toBe("devolvido");
    expect(row.review_note).toBe("Pix devolvido pelo banco em 23/10");
    expect(row.review_resolved_by).toBe(ADMIN_USER);
    expect(row.review_resolved_at).not.toBeNull();
    expect(row.credited_at).toBeNull();
    expect(row.needs_review).toBe(true);
    expect(
      await scalar<string>(
        "select count(*)::text v from public.wallet_ledger where tenant_id = $1",
        [NORMAL],
      ),
    ).toBe(before);

    const audit = await db.query<{
      action: string;
      entity_id: string;
      metadata: Record<string, unknown>;
    }>("select action, entity_id, metadata from public.tenant_audit_logs where entity_id = $1", [
      chargeId,
    ]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].action).toBe("billing.resolve_charge_review");
    expect(audit.rows[0].metadata).toMatchObject({
      outcome: "devolvido",
      reason: "Pix devolvido pelo banco em 23/10",
    });
  });

  it("rejects bad input and a charge not in review, and is idempotent-safe", async () => {
    const { chargeId: open } = await seedTopup({});
    await expect(resolve(open, "devolvido", "motivo válido")).rejects.toThrow(
      /charge_not_in_review/,
    );

    const { chargeId } = await seedTopup({ paidAmount: 1, needsReview: true });
    await expect(resolve(chargeId, "outro", "motivo válido")).rejects.toThrow(/invalid_outcome/);
    await expect(resolve(chargeId, "devolvido", "abc")).rejects.toThrow(/reason_required/);
    await resolve(chargeId, "creditado_manual", "Ajustar saldo feito");
    await expect(resolve(chargeId, "devolvido", "de novo")).rejects.toThrow(
      /review_already_resolved/,
    );
    await expect(
      resolve("00000000-0000-4000-8000-00000000ffff", "devolvido", "motivo válido"),
    ).rejects.toThrow(/charge_not_found/);
  });

  it("is service_role only", async () => {
    const { chargeId } = await seedTopup({ needsReview: true });
    await expect(
      db.query(
        "select public.billing_resolve_charge_review($1, 'devolvido', 'motivo válido', $2)",
        [chargeId, ADMIN_USER],
      ),
    ).rejects.toThrow(/forbidden/);
  });

  it("resolved charges drop out of the health snapshot's needs_review", async () => {
    await db.exec("delete from public.payment_charges where needs_review");
    const { chargeId } = await seedTopup({ paidAmount: 9000, needsReview: true });
    await seedTopup({ paidAmount: 9000, needsReview: true });
    const count = async () =>
      asServiceRole(async () =>
        Number(
          (
            await scalar<{ needs_review: { count: number } }>(
              "select public.billing_health_snapshot(1, now()) v",
            )
          ).needs_review.count,
        ),
      );
    expect(await count()).toBe(2);
    await resolve(chargeId, "creditado_manual", "Crédito manual pelo Ajustar saldo");
    expect(await count()).toBe(1);
  });
});

describe("billing_purge_webhook_bodies", () => {
  async function seedEvent(id: string, daysAgo: number) {
    await db.query(
      `insert into public.payment_webhook_events
         (event_id, event, delivery_id, signature_valid, raw_body, headers, received_at, processed_at, outcome)
       values ($1, 'charge.paid', 'd', true, '{"x":1}', '{"user-agent":"u"}',
               now() - make_interval(days => $2), now() - make_interval(days => $2), 'credited')`,
      [id, daysAgo],
    );
  }

  it("nulls raw_body and headers older than 90 days in batches, keeping metadata", async () => {
    await db.exec("delete from public.payment_webhook_events");
    await seedEvent("old-1", 91);
    await seedEvent("old-2", 120);
    await seedEvent("old-3", 200);
    await seedEvent("new-1", 89);

    const first = await asServiceRole(() =>
      scalar<number>("select public.billing_purge_webhook_bodies(90, 2) v"),
    );
    expect(Number(first)).toBe(2);
    const second = await asServiceRole(() =>
      scalar<number>("select public.billing_purge_webhook_bodies(90, 2) v"),
    );
    expect(Number(second)).toBe(1);
    const third = await asServiceRole(() =>
      scalar<number>("select public.billing_purge_webhook_bodies(90, 2) v"),
    );
    expect(Number(third)).toBe(0);

    const { rows } = await db.query<{
      event_id: string;
      raw_body: string | null;
      headers: unknown;
      event: string;
      outcome: string;
      received_at: string;
    }>("select * from public.payment_webhook_events order by event_id");
    expect(rows).toHaveLength(4);
    for (const row of rows.filter((r) => r.event_id.startsWith("old"))) {
      expect(row.raw_body).toBeNull();
      expect(row.headers).toBeNull();
      expect(row.event).toBe("charge.paid");
      expect(row.outcome).toBe("credited");
      expect(row.received_at).not.toBeNull();
    }
    const fresh = rows.find((r) => r.event_id === "new-1")!;
    expect(fresh.raw_body).toBe('{"x":1}');
  });

  it("never goes below 90 days and is service_role only", async () => {
    await db.exec("delete from public.payment_webhook_events");
    await seedEvent("recent", 30);
    const purged = await asServiceRole(() =>
      scalar<number>("select public.billing_purge_webhook_bodies(7, 100) v"),
    );
    expect(Number(purged)).toBe(0);
    await expect(db.query("select public.billing_purge_webhook_bodies(90, 100)")).rejects.toThrow(
      /forbidden/,
    );
  });
});
