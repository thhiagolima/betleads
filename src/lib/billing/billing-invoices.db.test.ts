// Mensalidade Task 2 — SQL test for
// supabase/migrations/20261023100000_billing_invoices.sql: tenant_billing,
// billing_invoices, billing_email_log, the access-state precedence, the
// settle/cycle rules, invoice generation, the plano trigger, the invoice
// branch of billing_credit_paid_charge and the super admin actions.
//
// Applies the PG1 price book + wallet and the PG2 Pix charges migrations
// first. Every date is fixed with test.now + app.allow_test_clock (the PG1
// billing clock), at noon in Brasília so the Brasília day is unambiguous.

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
const PIX_CHARGES_MIGRATION = readMigration(
  "supabase/migrations/20261022110000_billing_pix_charges.sql",
);
const INVOICES_MIGRATION = readMigration("supabase/migrations/20261023100000_billing_invoices.sql");

const PIX_MINIMUM_TEXT = "O valor da fatura não pode ficar abaixo de R$ 100,00 (mínimo do Pix)";

let db: PGlite;

// Sets the billing clock to noon (Brasília) of the given day.
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
  // Same override as billing-pix-charges.db.test.ts: accessible_tenant_ids()
  // reads test.tenant so a test can act as one signed-in house.
  await db.exec(`
    create or replace function public.accessible_tenant_ids() returns uuid[] language sql as $$
      select array[nullif(current_setting('test.tenant', true), '')::uuid]
    $$;
  `);
  // The initial load inside the migration runs on 2026-10-23 (Brasília).
  await setToday("2026-10-23");
  await db.exec(INVOICES_MIGRATION);
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

async function asHouse<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role authenticated; set test.tenant = '${tenant}'; set test.super = 'off';`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
    await db.exec("set test.tenant = ''");
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
  return `00000000-0000-4000-9200-${String(tenantCounter).padStart(12, "0")}`;
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

type BillingRow = {
  access_state: string;
  next_due_date: string | null;
  frozen: boolean;
  manual_block: boolean;
};

async function billingOf(tenant: string): Promise<BillingRow> {
  return one<BillingRow>(
    `select access_state, next_due_date::text, frozen, manual_block
     from public.tenant_billing where tenant_id = $1`,
    [tenant],
  );
}

type InvoiceRow = {
  id: string;
  status: string;
  period_start: string;
  period_end: string;
  cycle_due_date: string;
  due_date: string;
  base_amount_cents: string;
  discount_cents: string;
  one_off_discount_cents: string;
  amount_cents: string;
  paid_via: string | null;
  paid_amount_cents: string | null;
  payment_charge_id: string | null;
  canceled_reason: string | null;
};

async function invoicesOf(tenant: string): Promise<InvoiceRow[]> {
  const { rows } = await db.query<InvoiceRow>(
    `select id, status, period_start::text, period_end::text, cycle_due_date::text,
            due_date::text, base_amount_cents::text, discount_cents::text,
            one_off_discount_cents::text, amount_cents::text, paid_via,
            paid_amount_cents::text, payment_charge_id, canceled_reason
     from public.billing_invoices where tenant_id = $1 order by created_at, cycle_due_date`,
    [tenant],
  );
  return rows;
}

async function openInvoiceOf(tenant: string): Promise<InvoiceRow | undefined> {
  return (await invoicesOf(tenant)).find((i) => i.status === "open");
}

async function upfrontOf(invoice: string): Promise<boolean> {
  return scalar<boolean>("select upfront v from public.billing_invoices where id = $1", [invoice]);
}

async function refresh(tenant: string): Promise<string> {
  return asServiceRole(() =>
    scalar<string>("select public.billing_refresh_access_state($1) v", [tenant]),
  );
}

async function generate(): Promise<string[]> {
  return asServiceRole(async () => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.billing_generate_due_invoices() as id",
    );
    return rows.map((r) => r.id);
  });
}

async function manualSettle(invoice: string, paid?: number) {
  return admin("select public.billing_admin_manual_settle($1, $2, $3, $4)", [
    invoice,
    paid ?? null,
    "pago por TED",
    "comprovante 123",
  ]);
}

// A paying house created on 2026-10-05 whose first invoice (due that day)
// was paid that day, so next_due_date = 2026-11-05; then on 2026-10-31 the
// job issues the cycle invoice due 2026-11-05. Returns the open invoice.
async function houseWithOpenInvoiceDueNov5(): Promise<{ tenant: string; invoice: InvoiceRow }> {
  await setToday("2026-10-05");
  const tenant = await createHouse("enterprise");
  const first = await openInvoiceOf(tenant);
  await manualSettle(first!.id);
  expect((await billingOf(tenant)).next_due_date).toBe("2026-11-05");
  await setToday("2026-10-31");
  await generate();
  const invoice = await openInvoiceOf(tenant);
  expect(invoice?.due_date).toBe("2026-11-05");
  return { tenant, invoice: invoice! };
}

describe("billing_add_months and billing_today", () => {
  it("clamps to the last day of the target month", async () => {
    expect(await scalar<string>("select public.billing_add_months('2026-01-31', 1)::text v")).toBe(
      "2026-02-28",
    );
    expect(await scalar<string>("select public.billing_add_months('2028-01-31', 1)::text v")).toBe(
      "2028-02-29",
    );
    expect(await scalar<string>("select public.billing_add_months('2026-11-05', 1)::text v")).toBe(
      "2026-12-05",
    );
  });

  it("billing_today is the Brasília day of the test clock", async () => {
    await db.exec("set app.allow_test_clock = 'on'; set test.now = '2026-11-01 02:30:00+00';");
    // 02:30 UTC on 01/11 is still 31/10 23:30 in Brasília.
    expect(await scalar<string>("select public.billing_today()::text v")).toBe("2026-10-31");
  });
});

describe("initial load", () => {
  it("exempt houses are exempt; paying houses await their first invoice due on load day", async () => {
    expect((await billingOf(INTERNO)).access_state).toBe("exempt");
    expect(await invoicesOf(INTERNO)).toHaveLength(0);

    const normal = await billingOf(NORMAL);
    expect(normal.access_state).toBe("awaiting_first_payment");
    expect(normal.next_due_date).toBe("2026-10-23");
    const invoices = await invoicesOf(NORMAL);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      status: "open",
      due_date: "2026-10-23",
      cycle_due_date: "2026-10-23",
      period_start: "2026-10-23",
      period_end: "2026-11-22",
      amount_cents: "400000",
    });
    expect(await upfrontOf(invoices[0].id)).toBe(true);
  });

  it("re-running the load never duplicates rows or invoices", async () => {
    const before = await scalar<string>("select count(*)::text v from public.tenant_billing");
    await asServiceRole(() => db.query("select public.billing_backfill_tenant_billing()"));
    expect(await scalar<string>("select count(*)::text v from public.tenant_billing")).toBe(before);
    expect(await invoicesOf(NORMAL)).toHaveLength(1);
  });
});

describe("plano trigger", () => {
  it("interno -> enterprise opens an invoice due today; back to interno cancels it", async () => {
    await setToday("2026-10-23");
    const tenant = await createHouse("interno");
    expect((await billingOf(tenant)).access_state).toBe("exempt");
    expect(await invoicesOf(tenant)).toHaveLength(0);

    await admin("update public.tenants set plano = 'enterprise' where id = $1", [tenant]);
    const open = await openInvoiceOf(tenant);
    expect(open).toMatchObject({ due_date: "2026-10-23", amount_cents: "400000" });
    const billing = await billingOf(tenant);
    expect(billing.access_state).toBe("awaiting_first_payment");
    expect(billing.next_due_date).toBe("2026-10-23");
    expect(await upfrontOf(open!.id)).toBe(true);

    await admin("update public.tenants set plano = 'interno' where id = $1", [tenant]);
    const invoices = await invoicesOf(tenant);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ status: "canceled", canceled_reason: "Casa isenta" });
    expect((await billingOf(tenant)).access_state).toBe("exempt");
    // Exempt houses never get invoices from the job.
    await setToday("2026-12-23");
    await generate();
    expect(await openInvoiceOf(tenant)).toBeUndefined();
  });

  it("paying -> exempt clears next_due_date; exempt -> paying restarts today with an upfront invoice even after past payments", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();
    await admin("update public.tenants set plano = 'interno' where id = $1", [tenant]);
    expect(await billingOf(tenant)).toMatchObject({ access_state: "exempt", next_due_date: null });
    expect((await invoicesOf(tenant)).find((i) => i.id === invoice.id)?.status).toBe("canceled");

    await setToday("2026-11-20");
    await admin("update public.tenants set plano = 'enterprise' where id = $1", [tenant]);
    const open = await openInvoiceOf(tenant);
    expect(open).toMatchObject({ due_date: "2026-11-20", cycle_due_date: "2026-11-20" });
    expect(await upfrontOf(open!.id)).toBe(true);
    expect(await billingOf(tenant)).toMatchObject({
      access_state: "awaiting_first_payment",
      next_due_date: "2026-11-20",
    });
    await setToday("2026-11-22");
    await manualSettle(open!.id);
    expect((await billingOf(tenant)).next_due_date).toBe("2026-12-22");
  });

  it("set_block(false) clears a leftover manual block on an exempt house; set_block(true) is refused", async () => {
    const { tenant } = await houseWithOpenInvoiceDueNov5();
    await admin("select public.billing_admin_set_block($1, true, 'Fraude')", [tenant]);
    await admin("update public.tenants set plano = 'interno' where id = $1", [tenant]);
    await expect(
      admin("select public.billing_admin_set_block($1, true, 'Fraude')", [tenant]),
    ).rejects.toThrow(/tenant_exempt/);
    await admin("select public.billing_admin_set_block($1, false, null)", [tenant]);
    expect(await billingOf(tenant)).toMatchObject({ manual_block: false, access_state: "exempt" });
  });

  it("a new paying house starts awaiting its first payment", async () => {
    await setToday("2026-10-23");
    const tenant = await createHouse("starter");
    expect((await billingOf(tenant)).access_state).toBe("awaiting_first_payment");
    expect((await openInvoiceOf(tenant))?.due_date).toBe("2026-10-23");
  });

  it("starter -> pro (both paying) changes nothing", async () => {
    await setToday("2026-10-23");
    const tenant = await createHouse("starter");
    await admin("update public.tenants set plano = 'pro' where id = $1", [tenant]);
    expect(await invoicesOf(tenant)).toHaveLength(1);
  });
});

describe("access state by the open invoice (due 05/11)", () => {
  let tenant: string;

  beforeAll(async () => {
    ({ tenant } = await houseWithOpenInvoiceDueNov5());
  });

  it.each([
    ["2026-10-30", "ok"],
    ["2026-10-31", "due_soon"],
    ["2026-11-04", "due_soon"],
    ["2026-11-05", "overdue"],
    ["2026-11-08", "overdue"],
    ["2026-11-09", "locked_unpaid"],
  ])("on %s the state is %s", async (day, state) => {
    await setToday(day);
    expect(await refresh(tenant)).toBe(state);
    expect((await billingOf(tenant)).access_state).toBe(state);
  });

  it("precedence: locked_manual beats locked_unpaid, frozen beats locked_manual", async () => {
    await setToday("2026-11-09");
    await admin("select public.billing_admin_set_block($1, true, 'Fraude')", [tenant]);
    expect((await billingOf(tenant)).access_state).toBe("locked_manual");
    await admin("select public.billing_admin_set_block($1, false, null)", [tenant]);
    expect((await billingOf(tenant)).access_state).toBe("locked_unpaid");

    const { tenant: other } = await houseWithOpenInvoiceDueNov5();
    await admin("select public.billing_admin_set_block($1, true, 'Fraude')", [other]);
    await admin("select public.billing_admin_set_frozen($1, true)", [other]);
    expect((await billingOf(other)).access_state).toBe("frozen");
    // exempt beats everything.
    await admin("update public.tenants set plano = 'interno' where id = $1", [other]);
    expect((await billingOf(other)).access_state).toBe("exempt");
  });
});

describe("settle and the next cycle", () => {
  it("a house in due_soon paying on 03/11 gets next_due_date 05/12", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();
    await setToday("2026-11-03");
    expect(await refresh(tenant)).toBe("due_soon");
    const result = await asServiceRole(() =>
      scalar<Record<string, unknown>>(
        "select public.billing_settle_invoice($1, 'manual', 400000, null, null, null) v",
        [invoice.id],
      ),
    );
    expect(result).toMatchObject({ ok: true, tenant_id: tenant, next_due_date: "2026-12-05" });
    expect(await billingOf(tenant)).toMatchObject({
      next_due_date: "2026-12-05",
      access_state: "ok",
    });
  });

  it("a house in locked_unpaid paying on 20/12 restarts the cycle: next_due_date 20/01, state ok", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();
    await setToday("2026-12-20");
    // The job a month later does not issue another invoice while one is open.
    expect((await invoicesOf(tenant)).filter((i) => i.status === "open")).toHaveLength(1);
    expect(await refresh(tenant)).toBe("locked_unpaid");

    await manualSettle(invoice.id);
    expect(await billingOf(tenant)).toMatchObject({
      next_due_date: "2027-01-20",
      access_state: "ok",
    });
    const paid = (await invoicesOf(tenant)).find((i) => i.id === invoice.id);
    expect(paid).toMatchObject({ status: "paid", paid_via: "manual", paid_amount_cents: "400000" });
  });

  it("the first payment (awaiting_first_payment) restarts the cycle from the payment day", async () => {
    await setToday("2026-10-10");
    const tenant = await createHouse("enterprise");
    const first = await openInvoiceOf(tenant);
    await setToday("2026-10-12");
    await manualSettle(first!.id);
    expect(await billingOf(tenant)).toMatchObject({
      next_due_date: "2026-11-12",
      access_state: "ok",
    });
  });

  it("settling a paid invoice raises invoice_not_open", async () => {
    const { invoice } = await houseWithOpenInvoiceDueNov5();
    await manualSettle(invoice.id);
    await expect(manualSettle(invoice.id)).rejects.toThrow(/invoice_not_open/);
  });
});

describe("billing_generate_due_invoices", () => {
  it("issues the 05/12 invoice on 30/11, not on 29/11, and only once", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();
    await setToday("2026-11-03");
    await manualSettle(invoice.id);
    expect((await billingOf(tenant)).next_due_date).toBe("2026-12-05");

    await setToday("2026-11-29");
    await generate();
    expect(await openInvoiceOf(tenant)).toBeUndefined();

    await setToday("2026-11-30");
    const created = await generate();
    const open = await openInvoiceOf(tenant);
    expect(created).toContain(open!.id);
    expect(open).toMatchObject({
      period_start: "2026-12-05",
      period_end: "2027-01-04",
      cycle_due_date: "2026-12-05",
      due_date: "2026-12-05",
      amount_cents: "400000",
    });

    const again = await generate();
    expect(again).not.toContain(open!.id);
    expect((await invoicesOf(tenant)).filter((i) => i.status === "open")).toHaveLength(1);
  });

  it("skips a house whose invoice would be 1..9999 cents and isolates a failing house", async () => {
    const { tenant: tiny, invoice: i1 } = await houseWithOpenInvoiceDueNov5();
    const { tenant: broken, invoice: i2 } = await houseWithOpenInvoiceDueNov5();
    const { tenant: fine, invoice: i3 } = await houseWithOpenInvoiceDueNov5();
    await setToday("2026-11-03");
    for (const id of [i1.id, i2.id, i3.id]) await manualSettle(id);
    // Bypass the admin validation to force a R$ 50 invoice.
    await db.query(
      `update public.tenant_billing set discount_kind = 'fixed', discount_value = 395000
       where tenant_id = $1`,
      [tiny],
    );
    // A house whose insert fails must not abort the run for the others.
    await db.exec(`
      create function public.test_fail_insert() returns trigger language plpgsql as $fn$
      begin
        if new.tenant_id = '${broken}' then raise exception 'boom'; end if;
        return new;
      end $fn$;
      create trigger test_fail_insert before insert on public.billing_invoices
        for each row execute function public.test_fail_insert();
    `);
    try {
      await setToday("2026-11-30");
      await generate();
    } finally {
      await db.exec(`
        drop trigger test_fail_insert on public.billing_invoices;
        drop function public.test_fail_insert();
      `);
    }
    expect(await openInvoiceOf(tiny)).toBeUndefined();
    expect(await openInvoiceOf(broken)).toBeUndefined();
    expect((await openInvoiceOf(fine))?.due_date).toBe("2026-12-05");
  });

  it("does not issue invoices for frozen houses", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();
    await setToday("2026-11-03");
    await manualSettle(invoice.id);
    await admin("select public.billing_admin_set_frozen($1, true)", [tenant]);
    await setToday("2026-12-01");
    await generate();
    expect(await openInvoiceOf(tenant)).toBeUndefined();
  });
});

describe("super admin: extend due and free days", () => {
  it("extend_due +5 moves due_date to 10/11 and keeps cycle 05/11; settle then gives 05/12", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();
    await admin("select public.billing_admin_extend_due($1, 5)", [invoice.id]);
    const open = await openInvoiceOf(tenant);
    expect(open).toMatchObject({ due_date: "2026-11-10", cycle_due_date: "2026-11-05" });

    // The band follows due_date: on 09/11 it is due_soon, not locked_unpaid.
    await setToday("2026-11-09");
    expect(await refresh(tenant)).toBe("due_soon");
    await manualSettle(invoice.id);
    expect((await billingOf(tenant)).next_due_date).toBe("2026-12-05");
  });

  it("extend_due rejects invalid days and closed invoices", async () => {
    const { invoice } = await houseWithOpenInvoiceDueNov5();
    await expect(
      admin("select public.billing_admin_extend_due($1, 0)", [invoice.id]),
    ).rejects.toThrow(/invalid_days/);
    await expect(
      admin("select public.billing_admin_extend_due($1, 32)", [invoice.id]),
    ).rejects.toThrow(/invalid_days/);
    await admin("select public.billing_admin_extend_due($1, 31)", [invoice.id]);
    await manualSettle(invoice.id);
    await expect(
      admin("select public.billing_admin_extend_due($1, 5)", [invoice.id]),
    ).rejects.toThrow(/invoice_not_open/);
    await expect(
      admin("select public.billing_admin_extend_due($1, 5)", [
        "00000000-0000-4000-8000-00000000abcd",
      ]),
    ).rejects.toThrow(/invoice_not_found/);
  });

  it("free_days 15 with an open invoice moves due_date, cycle_due_date, period_end and next_due_date", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();
    await admin("select public.billing_admin_free_days($1, 15)", [tenant]);
    const open = await openInvoiceOf(tenant);
    expect(open).toMatchObject({
      id: invoice.id,
      due_date: "2026-11-20",
      cycle_due_date: "2026-11-20",
      period_start: "2026-11-05",
      period_end: "2026-12-19",
    });
    expect((await billingOf(tenant)).next_due_date).toBe("2026-11-20");
  });

  it("set_cycle_day only changes next_due_date; the open invoice keeps its date and the settle keeps the new day", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();
    await admin("select public.billing_admin_set_cycle_day($1, '2026-12-15')", [tenant]);
    expect((await openInvoiceOf(tenant))?.due_date).toBe("2026-11-05");
    expect((await billingOf(tenant)).next_due_date).toBe("2026-12-15");
    await setToday("2026-11-03");
    await manualSettle(invoice.id);
    expect((await billingOf(tenant)).next_due_date).toBe("2026-12-15");
  });
});

describe("super admin: discounts and price", () => {
  it("a 100% one-off discount settles the invoice as full_discount", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();
    await admin("select public.billing_admin_one_off_discount($1, 'percent', 100)", [invoice.id]);
    const inv = (await invoicesOf(tenant)).find((i) => i.id === invoice.id);
    expect(inv).toMatchObject({
      status: "paid",
      paid_via: "full_discount",
      amount_cents: "0",
      one_off_discount_cents: "400000",
    });
    expect((await billingOf(tenant)).next_due_date).toBe("2026-12-05");
  });

  it("a one-off discount that leaves R$ 50 is refused with the Pix minimum error", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();
    let error: { message?: string; detail?: string } | undefined;
    try {
      await admin("select public.billing_admin_one_off_discount($1, 'fixed', 395000)", [
        invoice.id,
      ]);
    } catch (e) {
      error = e as { message?: string; detail?: string };
    }
    expect(error?.message).toBe("amount_below_pix_minimum");
    expect(error?.detail).toBe(PIX_MINIMUM_TEXT);
    expect((await openInvoiceOf(tenant))?.amount_cents).toBe("400000");
  });

  it("a partial one-off discount recomputes amount_cents", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();
    await admin("select public.billing_admin_one_off_discount($1, 'fixed', 100000)", [invoice.id]);
    expect(await openInvoiceOf(tenant)).toMatchObject({
      amount_cents: "300000",
      one_off_discount_cents: "100000",
    });
    await expect(
      admin("select public.billing_admin_one_off_discount($1, 'percent', 101)", [invoice.id]),
    ).rejects.toThrow(/invalid_discount/);
  });

  it("a continuous 10% discount makes the next invoice 360000", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();
    await setToday("2026-11-03");
    await manualSettle(invoice.id);
    await admin(
      "select public.billing_admin_set_continuous_discount($1, 'percent', 10, '2026-11-01', null)",
      [tenant],
    );
    await setToday("2026-11-30");
    await generate();
    expect(await openInvoiceOf(tenant)).toMatchObject({
      base_amount_cents: "400000",
      discount_cents: "40000",
      amount_cents: "360000",
    });
  });

  it("custom price 300000 + 10% gives 270000", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();
    await setToday("2026-11-03");
    await manualSettle(invoice.id);
    await admin("select public.billing_admin_set_custom_price($1, 300000)", [tenant]);
    await admin(
      "select public.billing_admin_set_continuous_discount($1, 'percent', 10, '2026-11-01', null)",
      [tenant],
    );
    await setToday("2026-11-30");
    await generate();
    expect(await openInvoiceOf(tenant)).toMatchObject({
      base_amount_cents: "300000",
      amount_cents: "270000",
    });
  });

  it("custom price applies to the open invoice too (runbook: R$ 100 test price)", async () => {
    const { tenant } = await houseWithOpenInvoiceDueNov5();
    await admin("select public.billing_admin_set_custom_price($1, 10000)", [tenant]);
    expect((await openInvoiceOf(tenant))?.amount_cents).toBe("10000");
  });

  it("refuses a custom price below R$ 100 and a continuous discount leaving 1..9999 cents", async () => {
    const { tenant } = await houseWithOpenInvoiceDueNov5();
    await expect(
      admin("select public.billing_admin_set_custom_price($1, 9999)", [tenant]),
    ).rejects.toThrow(/amount_below_pix_minimum/);
    await expect(
      admin(
        "select public.billing_admin_set_continuous_discount($1, 'fixed', 395000, '2026-11-01', null)",
        [tenant],
      ),
    ).rejects.toThrow(/amount_below_pix_minimum/);
    // kind null removes the discount.
    await admin(
      "select public.billing_admin_set_continuous_discount($1, 'percent', 10, '2026-11-01', null)",
      [tenant],
    );
    await admin("select public.billing_admin_set_continuous_discount($1, null, null, null, null)", [
      tenant,
    ]);
    const row = await one<{ discount_kind: string | null }>(
      "select discount_kind from public.tenant_billing where tenant_id = $1",
      [tenant],
    );
    expect(row.discount_kind).toBeNull();
    expect((await openInvoiceOf(tenant))?.amount_cents).toBe("400000");
  });

  it("the continuous discount only applies when the cycle due date is inside its window", async () => {
    const { tenant } = await houseWithOpenInvoiceDueNov5();
    const amount = await asServiceRole(() =>
      scalar<Record<string, number>>("select public.billing_monthly_amount($1, '2026-12-05') v", [
        tenant,
      ]),
    );
    expect(amount).toMatchObject({ base_cents: 400000, discount_cents: 0, amount_cents: 400000 });
    await admin(
      "select public.billing_admin_set_continuous_discount($1, 'fixed', 50000, '2027-01-01', '2027-03-31')",
      [tenant],
    );
    const inWindow = await asServiceRole(() =>
      scalar<Record<string, number>>("select public.billing_monthly_amount($1, '2027-02-05') v", [
        tenant,
      ]),
    );
    expect(inWindow).toMatchObject({ discount_cents: 50000, amount_cents: 350000 });
    const after = await asServiceRole(() =>
      scalar<Record<string, number>>("select public.billing_monthly_amount($1, '2027-04-05') v", [
        tenant,
      ]),
    );
    expect(after).toMatchObject({ discount_cents: 0, amount_cents: 400000 });
  });
});

describe("super admin: freeze, cancel and permissions", () => {
  it("freezing makes the state frozen; unfreezing issues an upfront invoice due today (pay before use)", async () => {
    const { tenant } = await houseWithOpenInvoiceDueNov5();
    await admin("select public.billing_admin_set_frozen($1, true)", [tenant]);
    expect((await billingOf(tenant)).access_state).toBe("frozen");

    await setToday("2027-01-10");
    await admin("select public.billing_admin_set_frozen($1, false)", [tenant]);
    const open = await openInvoiceOf(tenant);
    expect(open).toMatchObject({ due_date: "2027-01-10", cycle_due_date: "2027-01-10" });
    expect(await billingOf(tenant)).toMatchObject({
      frozen: false,
      next_due_date: "2027-01-10",
      access_state: "awaiting_first_payment",
    });
    expect(await upfrontOf(open!.id)).toBe(true);
    await setToday("2027-01-12");
    await manualSettle(open!.id);
    expect(await billingOf(tenant)).toMatchObject({
      next_due_date: "2027-02-12",
      access_state: "ok",
    });
  });

  it("cancel_invoice cancels an open invoice with the reason", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();
    await admin("select public.billing_admin_cancel_invoice($1, 'Fatura emitida errada')", [
      invoice.id,
    ]);
    const inv = (await invoicesOf(tenant)).find((i) => i.id === invoice.id);
    expect(inv).toMatchObject({ status: "canceled", canceled_reason: "Fatura emitida errada" });
    await expect(
      admin("select public.billing_admin_cancel_invoice($1, 'de novo')", [invoice.id]),
    ).rejects.toThrow(/invoice_not_open/);
  });

  it("every action refuses a non super admin, and exempt houses are refused", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();
    await expect(
      db.query("select public.billing_admin_set_block($1, true, 'x')", [tenant]),
    ).rejects.toThrow(/forbidden/);
    await expect(
      db.query("select public.billing_admin_extend_due($1, 5)", [invoice.id]),
    ).rejects.toThrow(/forbidden/);
    await expect(
      db.query("select public.billing_admin_manual_settle($1, 400000, null, null)", [invoice.id]),
    ).rejects.toThrow(/forbidden/);
    await expect(admin("select public.billing_admin_free_days($1, 5)", [INTERNO])).rejects.toThrow(
      /tenant_exempt/,
    );
  });

  it("house users cannot execute the service-role functions", async () => {
    await expect(
      asHouse(NORMAL, () => db.query("select public.billing_generate_due_invoices()")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asHouse(NORMAL, () => db.query("select public.billing_refresh_access_state($1)", [NORMAL])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("billing_credit_paid_charge: invoice branch", () => {
  async function seedInvoiceCharge(
    tenant: string,
    invoiceId: string,
    amount: number,
    externalId: string,
    paidAt?: string,
  ): Promise<string> {
    return asServiceRole(() =>
      scalar<string>(
        `insert into public.payment_charges (
           tenant_id, kind, ref_id, external_id, status, amount_cents, paid_amount_cents, paid_at
         ) values ($1, 'invoice', $2, $3, 'PAID', $4, $4, coalesce($5::timestamptz, public.billing_now()))
         returning id v`,
        [tenant, invoiceId, externalId, amount, paidAt ?? null],
      ),
    );
  }

  async function needsReview(chargeId: string): Promise<boolean> {
    return scalar<boolean>("select needs_review v from public.payment_charges where id = $1", [
      chargeId,
    ]);
  }

  it("uses the charge's paid time: paid 23:59 on due+3, credited after midnight, keeps the normal cycle", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();
    const chargeId = await seedInvoiceCharge(
      tenant,
      invoice.id,
      400000,
      `bl-inv-${invoice.id}-1`,
      "2026-11-08 23:59:00-03",
    );
    await db.exec("set app.allow_test_clock = 'on'; set test.now = '2026-11-09 00:30:00-03';");
    const result = await asServiceRole(() =>
      scalar<Record<string, unknown>>("select public.billing_credit_paid_charge($1) v", [chargeId]),
    );
    expect(result).toMatchObject({ ok: true, next_due_date: "2026-12-05" });
    const paidAt = await scalar<string>(
      "select (paid_at at time zone 'America/Sao_Paulo')::text v from public.billing_invoices where id = $1",
      [invoice.id],
    );
    expect(paidAt).toBe("2026-11-08 23:59:00");
    expect((await billingOf(tenant)).access_state).toBe("ok");
  });

  it("settles the invoice via pix without touching the wallet, and is idempotent", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();
    await setToday("2026-11-09");
    expect(await refresh(tenant)).toBe("locked_unpaid");
    const chargeId = await seedInvoiceCharge(tenant, invoice.id, 400000, `bl-inv-${invoice.id}-1`);

    const result = await asServiceRole(() =>
      scalar<Record<string, unknown>>("select public.billing_credit_paid_charge($1) v", [chargeId]),
    );
    expect(result).toMatchObject({ ok: true, tenant_id: tenant, next_due_date: "2026-12-09" });

    const inv = (await invoicesOf(tenant)).find((i) => i.id === invoice.id);
    expect(inv).toMatchObject({
      status: "paid",
      paid_via: "pix",
      paid_amount_cents: "400000",
      payment_charge_id: chargeId,
    });
    expect((await billingOf(tenant)).access_state).toBe("ok");
    const credited = await scalar<string | null>(
      "select credited_at::text v from public.payment_charges where id = $1",
      [chargeId],
    );
    expect(credited).not.toBeNull();
    const wallet = await one<{ n: string }>(
      "select count(*)::text n from public.tenant_wallets where tenant_id = $1 and balance <> 0",
      [tenant],
    );
    expect(wallet.n).toBe("0");

    const again = await asServiceRole(() =>
      scalar<Record<string, unknown>>("select public.billing_credit_paid_charge($1) v", [chargeId]),
    );
    expect(again).toMatchObject({ ok: true, idempotent: true });
  });

  it("refuses a charge whose amount differs from the invoice, and a closed invoice", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();
    const wrong = await seedInvoiceCharge(tenant, invoice.id, 300000, `bl-inv-${invoice.id}-1`);
    const r1 = await asServiceRole(() =>
      scalar<Record<string, unknown>>("select public.billing_credit_paid_charge($1) v", [wrong]),
    );
    expect(r1).toMatchObject({ ok: false, reason: "amount_mismatch" });
    expect(await needsReview(wrong)).toBe(true);
    expect((await openInvoiceOf(tenant))?.id).toBe(invoice.id);

    await manualSettle(invoice.id);
    const late = await seedInvoiceCharge(tenant, invoice.id, 400000, `bl-inv-${invoice.id}-2`);
    const r2 = await asServiceRole(() =>
      scalar<Record<string, unknown>>("select public.billing_credit_paid_charge($1) v", [late]),
    );
    expect(r2).toMatchObject({ ok: false, reason: "invoice_not_open" });
    expect(await needsReview(late)).toBe(true);
    const credited = await scalar<string | null>(
      "select credited_at::text v from public.payment_charges where id = $1",
      [late],
    );
    expect(credited).toBeNull();

    const orphan = await seedInvoiceCharge(
      tenant,
      "00000000-0000-4000-8000-00000000beef",
      400000,
      `bl-inv-orphan-${invoice.id}`,
    );
    const r3 = await asServiceRole(() =>
      scalar<Record<string, unknown>>("select public.billing_credit_paid_charge($1) v", [orphan]),
    );
    expect(r3).toMatchObject({ ok: false, reason: "invoice_not_found" });
    expect(await needsReview(orphan)).toBe(true);
  });
});

describe("isolation", () => {
  it("house A does not read house B's invoices or billing", async () => {
    const { tenant: a } = await houseWithOpenInvoiceDueNov5();
    const { tenant: b } = await houseWithOpenInvoiceDueNov5();

    const seen = await asHouse(a, async () => {
      const { rows } = await db.query<{ tenant_id: string }>(
        "select distinct tenant_id from public.billing_invoices",
      );
      const { rows: billing } = await db.query<{ tenant_id: string }>(
        "select tenant_id from public.tenant_billing",
      );
      return { invoices: rows.map((r) => r.tenant_id), billing: billing.map((r) => r.tenant_id) };
    });
    expect(seen.invoices).toEqual([a]);
    expect(seen.billing).toEqual([a]);
    expect(seen.invoices).not.toContain(b);
  });

  it("a house reads its email log but not manual_note / manual_receipt", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();
    await manualSettle(invoice.id);
    await asServiceRole(() =>
      db.query(
        "insert into public.billing_email_log (invoice_id, kind, recipients) values ($1, 'paid', 2)",
        [invoice.id],
      ),
    );

    const log = await asHouse(tenant, async () => {
      const { rows } = await db.query<{ kind: string }>(
        "select kind from public.billing_email_log where invoice_id = $1",
        [invoice.id],
      );
      return rows;
    });
    expect(log).toEqual([{ kind: "paid" }]);

    const other = freshTenant();
    const none = await asHouse(other, async () => {
      const { rows } = await db.query("select * from public.billing_email_log");
      return rows;
    });
    expect(none).toHaveLength(0);

    await expect(
      asHouse(tenant, () => db.query("select manual_note from public.billing_invoices")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asHouse(tenant, () => db.query("select manual_receipt from public.billing_invoices")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asHouse(tenant, () =>
        db.query("insert into public.billing_invoices (tenant_id) values ($1)", [tenant]),
      ),
    ).rejects.toThrow(/permission denied/);

    const note = await asServiceRole(() =>
      scalar<string>("select manual_note v from public.billing_invoices where id = $1", [
        invoice.id,
      ]),
    );
    expect(note).toBe("pago por TED");
  });
});

describe("Fix round 1: payment_charges_one_open_per_invoice", () => {
  async function insertCharge(opts: {
    tenant: string;
    invoice: string;
    externalId: string;
    status: string;
    amountCents?: number;
  }) {
    return asServiceRole(() =>
      db.query(
        `insert into public.payment_charges (
           tenant_id, kind, ref_id, external_id, status, amount_cents
         ) values ($1, 'invoice', $2, $3, $4, $5)
         returning id`,
        [opts.tenant, opts.invoice, opts.externalId, opts.status, opts.amountCents ?? 400000],
      ),
    );
  }

  it("rejects a second PENDING/ACTIVE charge for the same invoice", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();

    await insertCharge({
      tenant,
      invoice: invoice.id,
      externalId: `bl-inv-${invoice.id}-1`,
      status: "ACTIVE",
    });

    await expect(
      insertCharge({
        tenant,
        invoice: invoice.id,
        externalId: `bl-inv-${invoice.id}-2`,
        status: "PENDING",
      }),
    ).rejects.toThrow(/duplicate key|unique constraint/i);
  });

  it("allows a new open charge once the previous one is EXPIRED", async () => {
    const { tenant, invoice } = await houseWithOpenInvoiceDueNov5();

    await insertCharge({
      tenant,
      invoice: invoice.id,
      externalId: `bl-inv-${invoice.id}-1`,
      status: "ACTIVE",
    });
    await asServiceRole(() =>
      db.query(`update public.payment_charges set status = 'EXPIRED' where external_id = $1`, [
        `bl-inv-${invoice.id}-1`,
      ]),
    );

    await expect(
      insertCharge({
        tenant,
        invoice: invoice.id,
        externalId: `bl-inv-${invoice.id}-2`,
        status: "ACTIVE",
      }),
    ).resolves.toBeTruthy();
  });

  it("does not constrain charges of different invoices or credit_topup charges", async () => {
    const { tenant: t1, invoice: inv1 } = await houseWithOpenInvoiceDueNov5();
    const { invoice: inv2 } = await houseWithOpenInvoiceDueNov5();

    await insertCharge({
      tenant: t1,
      invoice: inv1.id,
      externalId: `bl-inv-${inv1.id}-1`,
      status: "ACTIVE",
    });
    await expect(
      insertCharge({
        tenant: t1,
        invoice: inv2.id,
        externalId: `bl-inv-${inv2.id}-1`,
        status: "ACTIVE",
      }),
    ).resolves.toBeTruthy();
  });
});
