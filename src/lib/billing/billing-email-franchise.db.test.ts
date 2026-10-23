// PG3 Task 6 — the e-mail monthly free allowance (100.000 per house) at its
// boundaries, as `sendInfobipEmail` uses it: one `wallet_reserve` of 1 unit
// per e-mail (reference type `email_send`, keys `email-reserve:<ref>` /
// `email-refund:<ref>`), a `wallet_refund` on any failure.
//
// The franchise is counted atomically inside wallet_reserve
// (20261022100100_billing_wallet.sql); the refund gives free units back.
// This pins the behaviour at 99.999, 100.000 and 100.001 used.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readMigration, resetSession as resetDbSession, SCHEMA, SEED } from "./billing-db-test-support";

const PRICE_BOOK_MIGRATION = readMigration(
  "supabase/migrations/20261022100000_billing_price_book.sql",
);
const WALLET_MIGRATION = readMigration("supabase/migrations/20261022100100_billing_wallet.sql");
const SETTLE_MIGRATION = readMigration(
  "supabase/migrations/20261024100000_billing_wallet_settle.sql",
);

const STUB_TABLES = `
create table public.call_history (id uuid primary key default gen_random_uuid());
create table public.email_send_logs (id uuid primary key default gen_random_uuid());
`;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  await db.exec(STUB_TABLES);
  await db.exec(PRICE_BOOK_MIGRATION);
  await db.exec(WALLET_MIGRATION);
  await db.exec(SETTLE_MIGRATION);
  await resetDbSession(db);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

type Json = Record<string, unknown>;

async function as<T>(setting: string, on: string, off: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set ${setting} = '${on}'`);
  try {
    return await fn();
  } finally {
    await db.exec(`set ${setting} = '${off}'`);
  }
}

const asSuperAdmin = <T>(fn: () => Promise<T>) => as("test.super", "on", "off", fn);
const asServiceRole = <T>(fn: () => Promise<T>) => as("test.role", "service_role", "", fn);

async function call(sql: string, params: unknown[]): Promise<Json> {
  const { rows } = await db.query<{ v: Json }>(sql, params);
  return rows[0].v;
}

const reserveEmail = (tenant: string, units: number, ref: string) =>
  asServiceRole(() =>
    call("select public.wallet_reserve($1, $2, $3, $4, $5, $6) v", [
      tenant,
      "email",
      units,
      "email_send",
      ref,
      `email-reserve:${ref}`,
    ]),
  );

const refundEmail = (tenant: string, ref: string) =>
  asServiceRole(() =>
    call("select public.wallet_refund($1, $2, $3, $4) v", [
      tenant,
      ref,
      `email-refund:${ref}`,
      "infobip_email_400",
    ]),
  );

async function balanceOf(tenant: string): Promise<number> {
  const { rows } = await db.query<{ balance: string }>(
    "select balance from public.tenant_wallets where tenant_id = $1",
    [tenant],
  );
  return rows.length ? Number(rows[0].balance) : 0;
}

async function emailUsage(tenant: string) {
  const { rows } = await db.query<{ units: string; free_units_used: string; billed_amount: string }>(
    `select units::text, free_units_used::text, billed_amount::text
     from public.tenant_monthly_usage
     where tenant_id = $1 and item = 'email'
       and month = date_trunc('month', public.billing_now() at time zone 'America/Sao_Paulo')::date`,
    [tenant],
  );
  const row = rows[0];
  return {
    units: Number(row?.units ?? 0),
    free_units_used: Number(row?.free_units_used ?? 0),
    billed_amount: Number(row?.billed_amount ?? 0),
  };
}

async function ledgerRow(tenant: string, ref: string, entryType: string) {
  const { rows } = await db.query<{ amount: string; units: number; free_units: number }>(
    `select amount::text, units, free_units from public.wallet_ledger
     where tenant_id = $1 and reference_id = $2 and entry_type = $3`,
    [tenant, ref, entryType],
  );
  return rows[0] ? { amount: Number(rows[0].amount), units: rows[0].units, free_units: rows[0].free_units } : null;
}

let tenantCounter = 0;
/** A fresh house with `balance` in the wallet and `used` e-mails this month (`free` of them free). */
async function houseWithUsage(balance: number, used: number, free = Math.min(used, 100000)) {
  tenantCounter += 1;
  const id = `00000000-0000-4000-b000-${String(tenantCounter).padStart(12, "0")}`;
  await db.query(
    `insert into public.tenants (id, slug, plano, is_demo) values ($1, $2, 'starter', false)`,
    [id, `email-franchise-${tenantCounter}`],
  );
  if (balance > 0) {
    await asSuperAdmin(() =>
      call("select public.admin_adjust_wallet($1, $2, $3, $4) v", [id, balance, "saldo", `adj:${id}`]),
    );
  }
  if (used > 0) {
    await asSuperAdmin(() =>
      db.query(
        `insert into public.tenant_monthly_usage (tenant_id, month, item, units, free_units_used, billed_amount)
         values ($1, date_trunc('month', public.billing_now() at time zone 'America/Sao_Paulo')::date,
                 'email', $2, $3, $4)`,
        [id, used, free, (used - free) * 0.002],
      ),
    );
  }
  return id;
}

describe("e-mail franchise: 100.000 free per month, then R$ 0,002", () => {
  it("99.999 used + 1 e-mail = free (the 100.000th), even with a zero balance", async () => {
    const tenant = await houseWithUsage(0, 99999);
    const result = await reserveEmail(tenant, 1, "email:k-99999");
    expect(Number(result.amount)).toBe(0);
    expect(await ledgerRow(tenant, "email:k-99999", "usage_reservation")).toEqual({
      amount: 0,
      units: 1,
      free_units: 1,
    });
    expect(await emailUsage(tenant)).toEqual({ units: 100000, free_units_used: 100000, billed_amount: 0 });
    expect(await balanceOf(tenant)).toBe(0);
  });

  it("100.000 used + 1 e-mail = R$ 0,002", async () => {
    const tenant = await houseWithUsage(1, 100000);
    const result = await reserveEmail(tenant, 1, "email:k-100000");
    expect(Number(result.amount)).toBeCloseTo(-0.002, 4);
    expect(await ledgerRow(tenant, "email:k-100000", "usage_reservation")).toMatchObject({
      units: 1,
      free_units: 0,
    });
    expect(await balanceOf(tenant)).toBeCloseTo(0.998, 4);
    expect(await emailUsage(tenant)).toMatchObject({ units: 100001, free_units_used: 100000 });
  });

  it("100.000 used + 1 e-mail with a zero balance is refused (insufficient_balance)", async () => {
    const tenant = await houseWithUsage(0, 100000);
    await expect(reserveEmail(tenant, 1, "email:k-broke")).rejects.toThrow(/insufficient_balance/);
    expect(await emailUsage(tenant)).toMatchObject({ units: 100000, free_units_used: 100000 });
  });

  it("100.001 used + 1 e-mail = R$ 0,002", async () => {
    const tenant = await houseWithUsage(1, 100001, 100000);
    const result = await reserveEmail(tenant, 1, "email:k-100001");
    expect(Number(result.amount)).toBeCloseTo(-0.002, 4);
    expect(await ledgerRow(tenant, "email:k-100001", "usage_reservation")).toMatchObject({
      free_units: 0,
    });
    expect(await emailUsage(tenant)).toMatchObject({ units: 100002, free_units_used: 100000 });
  });

  it("a 2-unit reservation at 99.999 used = 1 free + 1 charged", async () => {
    const tenant = await houseWithUsage(1, 99999);
    const result = await reserveEmail(tenant, 2, "email:k-straddle");
    expect(Number(result.amount)).toBeCloseTo(-0.002, 4);
    expect(await ledgerRow(tenant, "email:k-straddle", "usage_reservation")).toMatchObject({
      units: 2,
      free_units: 1,
    });
    expect(await balanceOf(tenant)).toBeCloseTo(0.998, 4);
    expect(await emailUsage(tenant)).toMatchObject({ units: 100001, free_units_used: 100000 });
  });

  it("refunding a free e-mail gives the unit back to the franchise", async () => {
    const tenant = await houseWithUsage(0, 99999);
    await reserveEmail(tenant, 1, "email:k-free");
    expect(await emailUsage(tenant)).toMatchObject({ free_units_used: 100000 });

    const refunded = await refundEmail(tenant, "email:k-free");
    expect(refunded).toMatchObject({ ok: true });
    expect(Number(refunded.amount)).toBe(0);
    expect(await ledgerRow(tenant, "email:k-free", "usage_refund")).toMatchObject({ free_units: 1 });
    expect(await emailUsage(tenant)).toEqual({ units: 99999, free_units_used: 99999, billed_amount: 0 });

    // The unit is free again: the next e-mail still costs nothing.
    const next = await reserveEmail(tenant, 1, "email:k-free-again");
    expect(Number(next.amount)).toBe(0);
    expect(await balanceOf(tenant)).toBe(0);
  });
});
