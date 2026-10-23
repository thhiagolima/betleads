// PG3 Task 10 — SQL test for
// supabase/migrations/20261024100200_billing_manual_settle_paid_at.sql:
// `billing_admin_manual_settle` gains an optional `_paid_at`, passed through
// to `billing_settle_invoice` (already clamping it to `<= now()`), so a
// manual settle can backdate the payment and the next cycle is counted from
// that day.
//
// Applies the PG1 price book + wallet, the PG2 Pix charges and the PG1
// invoices migrations first (same base as billing-invoices.db.test.ts),
// then this task's migration on top. Every date is fixed with test.now +
// app.allow_test_clock, at noon in Brasília so the day is unambiguous.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readMigration, resetSession as resetDbSession, SCHEMA, SEED } from "./billing-db-test-support";

const PRICE_BOOK_MIGRATION = readMigration(
  "supabase/migrations/20261022100000_billing_price_book.sql",
);
const WALLET_MIGRATION = readMigration("supabase/migrations/20261022100100_billing_wallet.sql");
const PIX_CHARGES_MIGRATION = readMigration(
  "supabase/migrations/20261022110000_billing_pix_charges.sql",
);
const INVOICES_MIGRATION = readMigration("supabase/migrations/20261023100000_billing_invoices.sql");
const PAID_AT_MIGRATION = readMigration(
  "supabase/migrations/20261024100200_billing_manual_settle_paid_at.sql",
);

let db: PGlite;

async function setToday(day: string) {
  await db.exec(`set app.allow_test_clock = 'on'; set test.now = '${day} 12:00:00-03';`);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  await db.exec(PRICE_BOOK_MIGRATION);
  await db.exec(WALLET_MIGRATION);
  await db.exec(PIX_CHARGES_MIGRATION);
  await db.exec(`
    create or replace function public.accessible_tenant_ids() returns uuid[] language sql as $$
      select array[nullif(current_setting('test.tenant', true), '')::uuid]
    $$;
  `);
  await setToday("2026-10-23");
  await db.exec(INVOICES_MIGRATION);
  await db.exec(PAID_AT_MIGRATION);
  await resetDbSession(db);
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

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<T>(sql, params);
  return rows[0];
}

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  const row = await one<{ v: T }>(sql, params);
  return row.v;
}

async function admin(sql: string, params: unknown[] = []) {
  return asSuperAdmin(() => db.query(sql, params));
}

let tenantCounter = 0;
function freshTenant(): string {
  tenantCounter += 1;
  return `00000000-0000-4000-9300-${String(tenantCounter).padStart(12, "0")}`;
}

async function createHouse(plano: string): Promise<string> {
  const id = freshTenant();
  await asSuperAdmin(() =>
    db.query(`insert into public.tenants (id, slug, plano) values ($1, $2, $3)`, [
      id,
      `casa-${id.slice(-6)}`,
      plano,
    ]),
  );
  return id;
}

type BillingRow = { access_state: string; next_due_date: string | null };

async function billingOf(tenant: string): Promise<BillingRow> {
  return one<BillingRow>(
    `select access_state, next_due_date::text from public.tenant_billing where tenant_id = $1`,
    [tenant],
  );
}

type InvoiceRow = { id: string; status: string; due_date: string };

async function openInvoiceOf(tenant: string): Promise<InvoiceRow | undefined> {
  const { rows } = await db.query<InvoiceRow>(
    `select id, status, due_date::text from public.billing_invoices
     where tenant_id = $1 and status = 'open' order by created_at limit 1`,
    [tenant],
  );
  return rows[0];
}

async function paidAtAndVia(invoice: string): Promise<{ paid_at: string; paid_via: string }> {
  return one(
    `select (paid_at at time zone 'America/Sao_Paulo')::text paid_at, paid_via
     from public.billing_invoices where id = $1`,
    [invoice],
  );
}

// `billing_invoices.created_at` defaults to the REAL wall clock (`now()`),
// never the fixed `test.now` clock (that only drives `billing_now()` /
// `billing_today()`), so the invoice's issue day for the `_paid_at` lower
// bound must be read back from the row, not assumed from `setToday`.
async function issueDayBRT(invoice: string): Promise<string> {
  return scalar<string>(
    `select (created_at at time zone 'America/Sao_Paulo')::date::text v
     from public.billing_invoices where id = $1`,
    [invoice],
  );
}

/** The calendar day immediately before `yyyyMmDd` (plain date arithmetic). */
async function dayBefore(yyyyMmDd: string): Promise<string> {
  return scalar<string>(`select (date '${yyyyMmDd}' - interval '1 day')::date::text v`);
}

async function manualSettle(invoice: string, paidAt: string | null): Promise<void> {
  await admin(
    "select public.billing_admin_manual_settle($1, $2, $3, $4, $5)",
    [invoice, 400000, "pago por TED", "comprovante 123", paidAt],
  );
}

async function refresh(tenant: string): Promise<string> {
  return asServiceRole(() =>
    scalar<string>("select public.billing_refresh_access_state($1) v", [tenant]),
  );
}

async function generate(): Promise<void> {
  await asServiceRole(() => db.query("select public.billing_generate_due_invoices()"));
}

describe("billing_admin_manual_settle with _paid_at", () => {
  it("a past date is kept as the recorded paid_at", async () => {
    await setToday("2026-11-10");
    const tenant = await createHouse("enterprise");
    const invoice = await openInvoiceOf(tenant);

    await manualSettle(invoice!.id, "2026-11-08 09:00:00-03");

    const row = await paidAtAndVia(invoice!.id);
    expect(row.paid_via).toBe("manual");
    expect(row.paid_at).toBe("2026-11-08 09:00:00");
  });

  it("a future date is clamped to now", async () => {
    await setToday("2026-11-10");
    const tenant = await createHouse("enterprise");
    const invoice = await openInvoiceOf(tenant);

    await manualSettle(invoice!.id, "2026-12-25 09:00:00-03");

    const row = await paidAtAndVia(invoice!.id);
    // Clamped to billing_now(), i.e. the fixed test clock (2026-11-10 noon),
    // never the future date passed in.
    expect(row.paid_at).toBe("2026-11-10 12:00:00");
  });

  it("omitting _paid_at keeps today's behaviour (paid_at = now)", async () => {
    await setToday("2026-11-10");
    const tenant = await createHouse("enterprise");
    const invoice = await openInvoiceOf(tenant);

    await manualSettle(invoice!.id, null);

    const row = await paidAtAndVia(invoice!.id);
    expect(row.paid_at).toBe("2026-11-10 12:00:00");
  });

  it("rejects a _paid_at earlier than the invoice's own issue day", async () => {
    await setToday("2026-11-10");
    const tenant = await createHouse("enterprise");
    const invoice = await openInvoiceOf(tenant);
    const issueDay = await issueDayBRT(invoice!.id);
    const prevDay = await dayBefore(issueDay);

    // A payment "received" the day before the invoice existed makes no
    // sense. `created_at` is the real wall clock, so the day before IT
    // (not the fixed test clock's "today") is what must be rejected.
    await expect(manualSettle(invoice!.id, `${prevDay} 23:59:00-03`)).rejects.toThrow(
      /invalid_paid_at/,
    );
  });

  it("accepts a _paid_at exactly on the invoice's issue day", async () => {
    await setToday("2026-11-10");
    const tenant = await createHouse("enterprise");
    const invoice = await openInvoiceOf(tenant);
    const issueDay = await issueDayBRT(invoice!.id);

    await manualSettle(invoice!.id, `${issueDay} 08:00:00-03`);

    const row = await paidAtAndVia(invoice!.id);
    expect(row.paid_via).toBe("manual");
  });

  it("the next due date is counted from the payment date, not from today — paid while locked", async () => {
    await setToday("2026-10-05");
    const tenant = await createHouse("enterprise");
    const first = await openInvoiceOf(tenant);
    await manualSettle(first!.id, null);
    expect((await billingOf(tenant)).next_due_date).toBe("2026-11-05");

    await setToday("2026-10-31");
    await generate();
    const invoice = await openInvoiceOf(tenant);
    expect(invoice?.due_date).toBe("2026-11-05");

    // "Today" is 2026-12-20 (well past due, locked_unpaid), but the house
    // actually paid on 2026-12-15 — the cycle must restart from THAT day,
    // not from "today".
    await setToday("2026-12-20");
    expect(await refresh(tenant)).toBe("locked_unpaid");

    await manualSettle(invoice!.id, "2026-12-15 10:00:00-03");

    expect(await billingOf(tenant)).toMatchObject({
      next_due_date: "2027-01-15",
      access_state: "ok",
    });
  });
});
