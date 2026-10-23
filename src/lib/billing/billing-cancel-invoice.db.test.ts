// SQL test for
// supabase/migrations/20261024100300_billing_cancel_invoice_skips_cycle.sql:
// canceling a regular monthly invoice skips that month (the cycle moves to
// cycle_due_date + 1 month, or keeps a day moved by set_cycle_day), while an
// `upfront` (pay before use) invoice keeps next_due_date and is reissued by
// the hourly generator.
//
// Applies the PG1 price book + wallet, the PG2 Pix charges and the PG1
// invoices migrations first (same base as billing-invoices.db.test.ts),
// then this migration on top. Every date is fixed with test.now +
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
const CANCEL_MIGRATION = readMigration(
  "supabase/migrations/20261024100300_billing_cancel_invoice_skips_cycle.sql",
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
  await db.exec(CANCEL_MIGRATION);
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
  return `00000000-0000-4000-9400-${String(tenantCounter).padStart(12, "0")}`;
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

type InvoiceRow = {
  id: string;
  status: string;
  cycle_due_date: string;
  due_date: string;
  upfront: boolean;
  canceled_reason: string | null;
};

async function invoicesOf(tenant: string): Promise<InvoiceRow[]> {
  const { rows } = await db.query<InvoiceRow>(
    `select id, status, cycle_due_date::text, due_date::text, upfront, canceled_reason
     from public.billing_invoices where tenant_id = $1 order by created_at, cycle_due_date`,
    [tenant],
  );
  return rows;
}

async function openInvoiceOf(tenant: string): Promise<InvoiceRow | undefined> {
  return (await invoicesOf(tenant)).find((i) => i.status === "open");
}

async function generate(): Promise<string[]> {
  return asServiceRole(async () => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.billing_generate_due_invoices() as id",
    );
    return rows.map((r) => r.id);
  });
}

async function refresh(tenant: string): Promise<string> {
  return asServiceRole(() =>
    scalar<string>("select public.billing_refresh_access_state($1) v", [tenant]),
  );
}

async function cancel(invoice: string, reason = "Fatura emitida errada") {
  return asSuperAdmin(() =>
    scalar<Record<string, unknown>>("select public.billing_admin_cancel_invoice($1, $2) v", [
      invoice,
      reason,
    ]),
  );
}

// A paying house created on 2026-10-05 whose first (upfront) invoice was
// paid that day, so next_due_date = 2026-11-05; on 2026-10-31 the job issues
// the regular cycle invoice due 2026-11-05. Returns the open invoice.
async function houseWithOpenInvoiceDueNov5(): Promise<{ tenant: string; invoice: InvoiceRow }> {
  await setToday("2026-10-05");
  const tenant = await createHouse("enterprise");
  const first = await openInvoiceOf(tenant);
  await admin("select public.billing_admin_manual_settle($1, null, 'pago por TED', 'comprovante')", [
    first!.id,
  ]);
  await setToday("2026-10-31");
  await generate();
  const invoice = await openInvoiceOf(tenant);
  expect(invoice).toMatchObject({ due_date: "2026-11-05", cycle_due_date: "2026-11-05", upfront: false });
  expect((await billingOf(tenant)).next_due_date).toBe("2026-11-05");
  return { tenant, invoice: invoice! };
}

describe("billing_admin_cancel_invoice: regular invoice skips the month", () => {
  it("advances next_due_date one month and the generator does not reissue the old cycle", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();

    const result = await cancel(invoice.id);
    expect(result).toMatchObject({ ok: true, tenant_id: tenant, next_due_date: "2026-12-05" });

    const canceled = (await invoicesOf(tenant)).find((i) => i.id === invoice.id);
    expect(canceled).toMatchObject({ status: "canceled", canceled_reason: "Fatura emitida errada" });
    expect((await billingOf(tenant)).next_due_date).toBe("2026-12-05");

    // Same day and every day up to 29/11: nothing is issued for 05/11.
    expect(await generate()).toEqual([]);
    expect(await openInvoiceOf(tenant)).toBeUndefined();
    await setToday("2026-11-29");
    await generate();
    expect(await openInvoiceOf(tenant)).toBeUndefined();

    // 30/11 issues the next cycle's invoice (05/12), never 05/11 again.
    await setToday("2026-11-30");
    await generate();
    expect(await openInvoiceOf(tenant)).toMatchObject({
      cycle_due_date: "2026-12-05",
      due_date: "2026-12-05",
    });
    expect(
      (await invoicesOf(tenant)).filter((i) => i.cycle_due_date === "2026-11-05"),
    ).toHaveLength(1);
  });

  it("a house overdue (and locked) only because of this invoice becomes ok", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();
    await setToday("2026-11-06");
    expect(await refresh(tenant)).toBe("overdue");
    await setToday("2026-11-10");
    expect(await refresh(tenant)).toBe("locked_unpaid");

    const result = await cancel(invoice.id);
    expect(result).toMatchObject({ access_state: "ok", next_due_date: "2026-12-05" });
    expect(await billingOf(tenant)).toEqual({ access_state: "ok", next_due_date: "2026-12-05" });
  });

  it("keeps a cycle day moved with set_cycle_day", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();
    await admin("select public.billing_admin_set_cycle_day($1, '2026-12-15')", [tenant]);
    expect((await billingOf(tenant)).next_due_date).toBe("2026-12-15");

    const result = await cancel(invoice.id);
    expect(result).toMatchObject({ next_due_date: "2026-12-15" });
    expect((await billingOf(tenant)).next_due_date).toBe("2026-12-15");
  });
});

describe("billing_admin_cancel_invoice: activation invoice is reissued immediately", () => {
  it("never-paid house: keeps next_due_date and reissues an upfront invoice in the same call", async () => {
    await setToday("2026-11-02");
    const tenant = await createHouse("enterprise");
    const upfront = await openInvoiceOf(tenant);
    expect(upfront).toMatchObject({ upfront: true, cycle_due_date: "2026-11-02" });
    expect((await billingOf(tenant)).next_due_date).toBe("2026-11-02");

    const result = await cancel(upfront!.id);
    expect(result).toMatchObject({
      ok: true,
      tenant_id: tenant,
      next_due_date: "2026-11-02",
      access_state: "awaiting_first_payment",
    });
    const reissued = await openInvoiceOf(tenant);
    expect(reissued).toMatchObject({ upfront: true, cycle_due_date: "2026-11-02", due_date: "2026-11-02" });
    expect(reissued!.id).not.toBe(upfront!.id);
    expect(await billingOf(tenant)).toEqual({
      access_state: "awaiting_first_payment",
      next_due_date: "2026-11-02",
    });

    // The hourly run has nothing left to issue.
    expect(await generate()).toEqual([]);
  });

  it("house with paid history and an upfront invoice (unfrozen): keeps next_due_date, reissues as upfront", async () => {
    const { tenant } = await houseWithOpenInvoiceDueNov5();
    await admin("select public.billing_admin_set_frozen($1, true)", [tenant]);
    await setToday("2027-01-10");
    await admin("select public.billing_admin_set_frozen($1, false)", [tenant]);
    const upfront = await openInvoiceOf(tenant);
    expect(upfront).toMatchObject({ upfront: true, cycle_due_date: "2027-01-10" });
    expect(await scalar<number>(
      "select count(*)::int v from public.billing_invoices where tenant_id = $1 and status = 'paid'",
      [tenant],
    )).toBe(1);

    const result = await cancel(upfront!.id);
    expect(result).toMatchObject({ next_due_date: "2027-01-10", access_state: "awaiting_first_payment" });
    const reissued = await openInvoiceOf(tenant);
    expect(reissued).toMatchObject({ upfront: true, cycle_due_date: "2027-01-10", due_date: "2027-01-10" });
    expect(reissued!.id).not.toBe(upfront!.id);
    expect(await billingOf(tenant)).toEqual({
      access_state: "awaiting_first_payment",
      next_due_date: "2027-01-10",
    });
  });

  it("never-paid house with a non-upfront open invoice counts as activation and is reissued as is", async () => {
    await setToday("2026-11-03");
    const tenant = await createHouse("enterprise");
    const first = await openInvoiceOf(tenant);
    // Simulates an invoice reissued by the hourly job before this migration
    // (billing_issue_invoice without _upfront).
    await db.query("update public.billing_invoices set upfront = false where id = $1", [first!.id]);

    const result = await cancel(first!.id);
    expect(result).toMatchObject({ next_due_date: "2026-11-03", access_state: "awaiting_first_payment" });
    const reissued = await openInvoiceOf(tenant);
    expect(reissued).toMatchObject({ upfront: false, cycle_due_date: "2026-11-03", due_date: "2026-11-03" });
    expect(reissued!.id).not.toBe(first!.id);
    expect(await billingOf(tenant)).toEqual({
      access_state: "awaiting_first_payment",
      next_due_date: "2026-11-03",
    });
  });
});

describe("billing_admin_cancel_invoice: late cancel", () => {
  it("clamps the advanced date to today: the next invoice is issued today, due today, read as overdue (grace)", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();
    // Canceled on 20/12: cycle 05/11 + 1 month = 05/12 is already past.
    await setToday("2026-12-20");
    const result = await cancel(invoice.id);
    expect(result).toMatchObject({ next_due_date: "2026-12-20", access_state: "ok" });

    await generate();
    expect(await openInvoiceOf(tenant)).toMatchObject({
      cycle_due_date: "2026-12-20",
      due_date: "2026-12-20",
    });
    // Due today = the `overdue` phase (3-day grace before locked_unpaid).
    expect((await billingOf(tenant)).access_state).toBe("overdue");
  });
});

describe("billing_admin_cancel_invoice: permissions", () => {
  it("refuses a non super admin and changes nothing", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();
    await expect(
      db.query("select public.billing_admin_cancel_invoice($1, 'tentativa')", [invoice.id]),
    ).rejects.toThrow(/forbidden/);
    expect(await openInvoiceOf(tenant)).toMatchObject({ id: invoice.id, status: "open" });
    expect((await billingOf(tenant)).next_due_date).toBe("2026-11-05");
  });

  it("keeps the original grants: authenticated and service_role yes, anon no", async () => {
    const sig = "public.billing_admin_cancel_invoice(uuid, text)";
    expect(await scalar<boolean>(`select has_function_privilege('anon', '${sig}', 'execute') v`)).toBe(false);
    expect(
      await scalar<boolean>(`select has_function_privilege('authenticated', '${sig}', 'execute') v`),
    ).toBe(true);
    expect(
      await scalar<boolean>(`select has_function_privilege('service_role', '${sig}', 'execute') v`),
    ).toBe(true);
  });
});
