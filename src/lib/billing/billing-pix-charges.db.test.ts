// PG2 Task 1 — SQL test for
// supabase/migrations/20261022110000_billing_pix_charges.sql: the Pix charge
// tables (credit_topup_orders, payment_charges, payment_webhook_events,
// payment_fee_settings) and billing_credit_paid_charge, the idempotent RPC
// that credits a paid charge into the PG1 wallet.
//
// Applies the Task 2 (price book) and Task 3 (wallet) PG1 migrations first,
// since billing_credit_paid_charge calls wallet_mutation from 20261022100100.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  readMigration,
  resetSession as resetDbSession,
  SCHEMA,
  SEED,
} from "./billing-db-test-support";

const PRICE_BOOK_MIGRATION = readMigration(
  "supabase/migrations/20261022100000_billing_price_book.sql",
);
const WALLET_MIGRATION = readMigration("supabase/migrations/20261022100100_billing_wallet.sql");
const PIX_CHARGES_MIGRATION = readMigration(
  "supabase/migrations/20261022110000_billing_pix_charges.sql",
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
  await db.exec(PIX_CHARGES_MIGRATION);
  // Fix round 1: the shared stub in billing-db-test-support.ts hardcodes
  // accessible_tenant_ids() to an empty array, which makes a real
  // "house A sees its own rows, not house B's" RLS test impossible. This
  // file overrides it to read test.tenant instead, so a test can act as a
  // specific signed-in house. test.tenant is reset to '' by resetSession(),
  // which turns into array[null] here (not the empty array) — under RLS's
  // `tenant_id = ANY(...)`, a null element never matches any row, so every
  // other test in this file that didn't opt into a tenant keeps seeing zero
  // rows, same as before this override.
  await db.exec(`
    create or replace function public.accessible_tenant_ids() returns uuid[] language sql as $$
      select array[nullif(current_setting('test.tenant', true), '')::uuid]
    $$;
  `);
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

async function asServiceRole<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("set test.role = 'service_role'");
  try {
    return await fn();
  } finally {
    await db.exec("set test.role = ''");
  }
}

// Acts as a signed-in house user: real Postgres role `authenticated` (so
// column-level grants and `for select to authenticated` policies actually
// apply), test.tenant set so the overridden accessible_tenant_ids() above
// resolves to that one house, and superadmin off.
async function asHouse<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role authenticated; set test.tenant = '${tenant}'; set test.super = 'off';`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
    await resetSession();
  }
}

async function balanceOf(tenant: string): Promise<number> {
  const { rows } = await db.query<{ balance: string }>(
    "select balance from public.tenant_wallets where tenant_id = $1",
    [tenant],
  );
  return rows.length ? Number(rows[0].balance) : 0;
}

async function creditPaidCharge(chargeId: string) {
  return asServiceRole(async () => {
    const { rows } = await db.query<{ v: Record<string, unknown> }>(
      "select public.billing_credit_paid_charge($1) v",
      [chargeId],
    );
    return rows[0].v;
  });
}

let tenantCounter = 0;
function freshTenant(): string {
  tenantCounter += 1;
  return `00000000-0000-4000-9100-${String(tenantCounter).padStart(12, "0")}`;
}

async function createTenant(id: string, slug: string) {
  await asSuperAdmin(async () => {
    await db.query(
      `insert into public.tenants (id, slug, plano, is_demo) values ($1, $2, 'starter', false)`,
      [id, slug],
    );
  });
}

async function seedOrderAndChargeWithAmounts(
  tenant: string,
  opts: {
    orderAmountCents: number;
    chargeAmountCents: number;
    paidAmountCents: number;
    status: string;
    externalId: string;
    refId?: string;
  },
): Promise<{ orderId: string; chargeId: string }> {
  return asServiceRole(async () => {
    const { rows: orderRows } = await db.query<{ id: string }>(
      `insert into public.credit_topup_orders (tenant_id, amount_cents)
       values ($1, $2) returning id`,
      [tenant, opts.orderAmountCents],
    );
    const orderId = orderRows[0].id;

    const { rows: chargeRows } = await db.query<{ id: string }>(
      `insert into public.payment_charges (
         tenant_id, kind, ref_id, external_id, status, amount_cents, paid_amount_cents, paid_at
       ) values ($1, 'credit_topup', $2, $3, $4, $5, $6, now())
       returning id`,
      [
        tenant,
        opts.refId ?? orderId,
        opts.externalId,
        opts.status,
        opts.chargeAmountCents,
        opts.paidAmountCents,
      ],
    );
    const chargeId = chargeRows[0].id;

    await db.query(`update public.credit_topup_orders set charge_id = $1 where id = $2`, [
      chargeId,
      orderId,
    ]);

    return { orderId, chargeId };
  });
}

async function seedOrderAndCharge(
  tenant: string,
  opts: {
    amountCents: number;
    paidAmountCents: number;
    status: string;
    externalId: string;
  },
): Promise<{ orderId: string; chargeId: string }> {
  return seedOrderAndChargeWithAmounts(tenant, {
    orderAmountCents: opts.amountCents,
    chargeAmountCents: opts.amountCents,
    paidAmountCents: opts.paidAmountCents,
    status: opts.status,
    externalId: opts.externalId,
  });
}

describe("billing_credit_paid_charge: happy path", () => {
  const tenant = freshTenant();
  let orderId: string;
  let chargeId: string;

  beforeAll(async () => {
    await createTenant(tenant, "pix-happy");
    const seeded = await seedOrderAndCharge(tenant, {
      amountCents: 50000,
      paidAmountCents: 50000,
      status: "PAID",
      externalId: "bl-top-happy-1",
    });
    orderId = seeded.orderId;
    chargeId = seeded.chargeId;
  });

  it("credits the wallet, writes a purchase ledger entry with key charge:<id>, and marks the order paid", async () => {
    const result = await creditPaidCharge(chargeId);
    expect(result.ok).toBe(true);
    expect(result.idempotent).toBeFalsy();
    expect(await balanceOf(tenant)).toBeCloseTo(500.0, 4);

    const { rows: ledgerRows } = await asSuperAdmin(() =>
      db.query<{ entry_type: string; amount: string; idempotency_key: string }>(
        `select entry_type, amount::text, idempotency_key from public.wallet_ledger
         where tenant_id = $1 and reference_type = 'payment_charge' and reference_id = $2`,
        [tenant, chargeId],
      ),
    );
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].entry_type).toBe("purchase");
    expect(Number(ledgerRows[0].amount)).toBeCloseTo(500.0, 4);
    expect(ledgerRows[0].idempotency_key).toBe(`charge:${chargeId}`);

    const { rows: orderRows } = await asSuperAdmin(() =>
      db.query<{ status: string; paid_at: string | null }>(
        `select status, paid_at from public.credit_topup_orders where id = $1`,
        [orderId],
      ),
    );
    expect(orderRows[0].status).toBe("paid");
    expect(orderRows[0].paid_at).not.toBeNull();

    const { rows: chargeRows } = await asSuperAdmin(() =>
      db.query<{ credited_at: string | null }>(
        `select credited_at from public.payment_charges where id = $1`,
        [chargeId],
      ),
    );
    expect(chargeRows[0].credited_at).not.toBeNull();
  });

  it("calling it again is idempotent and the balance stays 500", async () => {
    const result = await creditPaidCharge(chargeId);
    expect(result).toMatchObject({ ok: true, idempotent: true });
    expect(await balanceOf(tenant)).toBeCloseTo(500.0, 4);

    const { rows: ledgerRows } = await asSuperAdmin(() =>
      db.query<{ count: string }>(
        `select count(*)::text as count from public.wallet_ledger
         where tenant_id = $1 and reference_type = 'payment_charge' and reference_id = $2`,
        [tenant, chargeId],
      ),
    );
    expect(Number(ledgerRows[0].count)).toBe(1);
  });
});

describe("billing_credit_paid_charge: not paid", () => {
  const tenant = freshTenant();

  it("an ACTIVE charge returns ok:false reason:not_paid and credits nothing", async () => {
    await createTenant(tenant, "pix-active");
    const { chargeId } = await seedOrderAndCharge(tenant, {
      amountCents: 50000,
      paidAmountCents: 0,
      status: "ACTIVE",
      externalId: "bl-top-active-1",
    });

    const result = await creditPaidCharge(chargeId);
    expect(result).toMatchObject({ ok: false, reason: "not_paid" });
    expect(await balanceOf(tenant)).toBeCloseTo(0, 4);
  });
});

describe("billing_credit_paid_charge: amount mismatch", () => {
  const tenant = freshTenant();

  it("paid_amount_cents different from amount_cents returns amount_mismatch and credits nothing", async () => {
    await createTenant(tenant, "pix-mismatch");
    const { chargeId } = await seedOrderAndCharge(tenant, {
      amountCents: 50000,
      paidAmountCents: 49999,
      status: "PAID",
      externalId: "bl-top-mismatch-1",
    });

    const result = await creditPaidCharge(chargeId);
    expect(result).toMatchObject({ ok: false, reason: "amount_mismatch" });
    expect(await balanceOf(tenant)).toBeCloseTo(0, 4);
  });
});

describe("billing_credit_paid_charge: topup order not found", () => {
  const tenant = freshTenant();

  it("raises topup_order_not_found when ref_id points at no order of this tenant", async () => {
    await createTenant(tenant, "pix-order-missing");
    const { rows } = await asServiceRole(() =>
      db.query<{ id: string }>(
        `insert into public.payment_charges (
           tenant_id, kind, ref_id, external_id, status, amount_cents, paid_amount_cents, paid_at
         ) values ($1, 'credit_topup', gen_random_uuid(), 'bl-top-no-order-1', 'PAID', 50000, 50000, now())
         returning id`,
        [tenant],
      ),
    );

    await expect(creditPaidCharge(rows[0].id)).rejects.toThrow(/topup_order_not_found/);
    expect(await balanceOf(tenant)).toBeCloseTo(0, 4);
  });

  it("also raises topup_order_not_found when the order exists but belongs to another tenant", async () => {
    const otherTenant = freshTenant();
    await createTenant(otherTenant, "pix-order-other-tenant");
    const { orderId } = await seedOrderAndCharge(otherTenant, {
      amountCents: 50000,
      paidAmountCents: 50000,
      status: "PENDING",
      externalId: "bl-top-other-tenant-order",
    });

    const { rows } = await asServiceRole(() =>
      db.query<{ id: string }>(
        `insert into public.payment_charges (
           tenant_id, kind, ref_id, external_id, status, amount_cents, paid_amount_cents, paid_at
         ) values ($1, 'credit_topup', $2, 'bl-top-cross-tenant-1', 'PAID', 50000, 50000, now())
         returning id`,
        [tenant, orderId],
      ),
    );

    await expect(creditPaidCharge(rows[0].id)).rejects.toThrow(/topup_order_not_found/);
    expect(await balanceOf(tenant)).toBeCloseTo(0, 4);
  });
});

describe("billing_credit_paid_charge: order amount vs charge amount mismatch", () => {
  const tenant = freshTenant();

  it("returns ok:false reason:amount_mismatch when the order's amount_cents differs from the charge's, credits nothing", async () => {
    await createTenant(tenant, "pix-order-charge-mismatch");
    const { chargeId } = await seedOrderAndChargeWithAmounts(tenant, {
      orderAmountCents: 50000,
      chargeAmountCents: 60000,
      paidAmountCents: 60000,
      status: "PAID",
      externalId: "bl-top-order-charge-mismatch-1",
    });

    const result = await creditPaidCharge(chargeId);
    expect(result).toMatchObject({ ok: false, reason: "amount_mismatch" });
    expect(await balanceOf(tenant)).toBeCloseTo(0, 4);
  });
});

describe("billing_credit_paid_charge: needs_review", () => {
  const tenant = freshTenant();

  it("needs_review = true returns ok:false reason:needs_review and credits nothing", async () => {
    await createTenant(tenant, "pix-needs-review");
    const { chargeId } = await seedOrderAndCharge(tenant, {
      amountCents: 50000,
      paidAmountCents: 50000,
      status: "PAID",
      externalId: "bl-top-needs-review-1",
    });
    await asServiceRole(() =>
      db.query(`update public.payment_charges set needs_review = true where id = $1`, [chargeId]),
    );

    const result = await creditPaidCharge(chargeId);
    expect(result).toMatchObject({ ok: false, reason: "needs_review" });
    expect(await balanceOf(tenant)).toBeCloseTo(0, 4);
  });
});

describe("billing_credit_paid_charge: fee settings", () => {
  // Order matters: payment_fee_settings has no tenant_id (global, like
  // billing_price_book), so the "no fee row" case must run before any test
  // in this file inserts a fee row.
  it("without a fee row, fee_cents stays null", async () => {
    const tenant = freshTenant();
    await createTenant(tenant, "pix-no-fee");
    const { chargeId } = await seedOrderAndCharge(tenant, {
      amountCents: 50000,
      paidAmountCents: 50000,
      status: "PAID",
      externalId: "bl-top-no-fee-1",
    });

    await creditPaidCharge(chargeId);

    const { rows } = await asSuperAdmin(() =>
      db.query<{ fee_cents: number | null }>(
        `select fee_cents from public.payment_charges where id = $1`,
        [chargeId],
      ),
    );
    expect(rows[0].fee_cents).toBeNull();
  });

  it("1.5% + 0 fee gives fee_cents = 750 on a 50000 cents charge", async () => {
    const tenant = freshTenant();
    await createTenant(tenant, "pix-fee");
    const { chargeId } = await seedOrderAndCharge(tenant, {
      amountCents: 50000,
      paidAmountCents: 50000,
      status: "PAID",
      externalId: "bl-top-fee-1",
    });
    await asServiceRole(() =>
      db.query(
        `insert into public.payment_fee_settings (provider, fee_percent, fee_fixed_cents, valid_from)
         values ('upper', 1.5, 0, now())`,
      ),
    );

    await creditPaidCharge(chargeId);

    const { rows } = await asSuperAdmin(() =>
      db.query<{ fee_cents: number | null }>(
        `select fee_cents from public.payment_charges where id = $1`,
        [chargeId],
      ),
    );
    expect(rows[0].fee_cents).toBe(750);
  });
});

describe("billing_credit_paid_charge: permissions", () => {
  const tenant = freshTenant();
  let chargeId: string;

  beforeAll(async () => {
    await createTenant(tenant, "pix-perm");
    const seeded = await seedOrderAndCharge(tenant, {
      amountCents: 50000,
      paidAmountCents: 50000,
      status: "PAID",
      externalId: "bl-top-perm-1",
    });
    chargeId = seeded.chargeId;
  });

  beforeEach(async () => {
    await resetSession();
  });

  it("authenticated cannot execute the RPC (permission denied)", async () => {
    await db.exec("set role authenticated;");
    try {
      await expect(
        db.query("select public.billing_credit_paid_charge($1)", [chargeId]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("reset role");
    }
  });
});

describe("billing_credit_paid_charge: invoice kind is not supported yet", () => {
  const tenant = freshTenant();

  it("raises invoice_not_supported for kind = invoice", async () => {
    await createTenant(tenant, "pix-invoice");
    const { rows } = await asServiceRole(() =>
      db.query<{ id: string }>(
        `insert into public.payment_charges (
           tenant_id, kind, ref_id, external_id, status, amount_cents, paid_amount_cents, paid_at
         ) values ($1, 'invoice', gen_random_uuid(), 'bl-inv-1', 'PAID', 50000, 50000, now())
         returning id`,
        [tenant],
      ),
    );

    await expect(creditPaidCharge(rows[0].id)).rejects.toThrow(/invoice_not_supported/);
  });
});

describe("RLS: reading the 4 tables as authenticated", () => {
  const tenantA = freshTenant();
  const tenantB = freshTenant();
  let orderA: string;
  let chargeA: string;
  let orderB: string;

  beforeAll(async () => {
    await createTenant(tenantA, "pix-rls-a");
    await createTenant(tenantB, "pix-rls-b");
    const seededA = await seedOrderAndCharge(tenantA, {
      amountCents: 50000,
      paidAmountCents: 50000,
      status: "PENDING",
      externalId: "bl-top-rls-a",
    });
    orderA = seededA.orderId;
    chargeA = seededA.chargeId;
    const seededB = await seedOrderAndCharge(tenantB, {
      amountCents: 70000,
      paidAmountCents: 70000,
      status: "PENDING",
      externalId: "bl-top-rls-b",
    });
    orderB = seededB.orderId;
    await asServiceRole(() =>
      db.query(
        `insert into public.payment_webhook_events (event_id, event, raw_body) values ('evt-1', 'charge.paid', '{}')`,
      ),
    );
    await asServiceRole(() =>
      db.query(
        `insert into public.payment_fee_settings (provider, fee_percent, fee_fixed_cents, valid_from)
         values ('upper', 2, 0, now())`,
      ),
    );
  });

  beforeEach(async () => {
    await resetSession();
  });

  // Fix round 1: accessible_tenant_ids() is overridden at the top of this
  // file to read test.tenant, so asHouse(tenant, ...) now exercises the real
  // RLS policy (is_super_admin() OR tenant_id = ANY(accessible_tenant_ids())),
  // not just the "always empty" stub.
  it("house A sees its own order and charge, not house B's", async () => {
    await asHouse(tenantA, async () => {
      const { rows: ordersAsA } = await db.query<{ id: string }>(
        `select id from public.credit_topup_orders where id in ($1, $2)`,
        [orderA, orderB],
      );
      expect(ordersAsA.map((r) => r.id)).toEqual([orderA]);

      const { rows: chargesAsA } = await db.query<{ id: string }>(
        `select id from public.payment_charges where id = $1`,
        [chargeA],
      );
      expect(chargesAsA).toHaveLength(1);
    });
  });

  it("house A cannot read house B's order by id", async () => {
    await asHouse(tenantA, async () => {
      const { rows } = await db.query<{ id: string }>(
        `select id from public.credit_topup_orders where id = $1`,
        [orderB],
      );
      expect(rows).toHaveLength(0);
    });
  });

  it("a house (not superadmin) cannot read payment_webhook_events or payment_fee_settings", async () => {
    await asHouse(tenantA, async () => {
      const { rows: events } = await db.query<{ event_id: string }>(
        `select event_id from public.payment_webhook_events`,
      );
      expect(events).toHaveLength(0);

      const { rows: fees } = await db.query<{ id: string }>(
        `select id from public.payment_fee_settings`,
      );
      expect(fees).toHaveLength(0);
    });
  });

  it("the superadmin reads all 4 tables regardless of tenant", async () => {
    await db.exec("set role authenticated; set test.super = 'on';");
    try {
      const { rows: orders } = await db.query<{ id: string }>(
        `select id from public.credit_topup_orders where id in ($1, $2)`,
        [orderA, orderB],
      );
      expect(orders.map((r) => r.id).sort()).toEqual([orderA, orderB].sort());

      const { rows: events } = await db.query<{ event_id: string }>(
        `select event_id from public.payment_webhook_events`,
      );
      expect(events.length).toBeGreaterThanOrEqual(1);

      const { rows: fees } = await db.query<{ id: string }>(
        `select id from public.payment_fee_settings`,
      );
      expect(fees.length).toBeGreaterThanOrEqual(1);
    } finally {
      await db.exec("reset role");
    }
  });
});

describe("Fix round 1: payment_charges column-level grants hide provider-only fields from houses", () => {
  const tenant = freshTenant();
  let chargeId: string;

  beforeAll(async () => {
    await createTenant(tenant, "pix-column-grants");
    const seeded = await seedOrderAndCharge(tenant, {
      amountCents: 50000,
      paidAmountCents: 50000,
      status: "PAID",
      externalId: "bl-top-column-grants-1",
    });
    chargeId = seeded.chargeId;
    await asServiceRole(() =>
      db.query(
        `update public.payment_charges
           set fee_cents = 123, last_provider_payload = '{"payer": {"document": "12345678900"}}'::jsonb,
               last_error = 'boom'
         where id = $1`,
        [chargeId],
      ),
    );
  });

  it("a house in scope can select the public columns (id, status, amount_cents, emv)", async () => {
    await asHouse(tenant, async () => {
      const { rows } = await db.query<{ id: string; status: string; amount_cents: number }>(
        `select id, status, amount_cents, emv from public.payment_charges where id = $1`,
        [chargeId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("PAID");
      expect(rows[0].amount_cents).toBe(50000);
    });
  });

  it("a house in scope gets permission denied selecting fee_cents", async () => {
    await asHouse(tenant, async () => {
      await expect(
        db.query(`select fee_cents from public.payment_charges where id = $1`, [chargeId]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("a house in scope gets permission denied selecting last_provider_payload", async () => {
    await asHouse(tenant, async () => {
      await expect(
        db.query(`select last_provider_payload from public.payment_charges where id = $1`, [
          chargeId,
        ]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("a house in scope gets permission denied selecting last_error", async () => {
    await asHouse(tenant, async () => {
      await expect(
        db.query(`select last_error from public.payment_charges where id = $1`, [chargeId]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("service_role (backend) can still read fee_cents and last_provider_payload", async () => {
    const { rows } = await asServiceRole(() =>
      db.query<{ fee_cents: number; last_provider_payload: unknown }>(
        `select fee_cents, last_provider_payload from public.payment_charges where id = $1`,
        [chargeId],
      ),
    );
    expect(rows[0].fee_cents).toBe(123);
    expect(rows[0].last_provider_payload).not.toBeNull();
  });
});
