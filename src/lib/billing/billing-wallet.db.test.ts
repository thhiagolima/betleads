// PG1 Task 3 — SQL test for
// supabase/migrations/20261022100100_billing_wallet.sql: the single BRL
// wallet (tenant_wallets/wallet_ledger/tenant_monthly_usage), wallet_mutation
// (internal), wallet_reserve, wallet_refund, admin_adjust_wallet,
// wallet_summary and billing_wallet_integrity.
//
// Applies the Task 2 migration first (billing_effective_price/
// billing_tenant_exempt are consumed by wallet_reserve/wallet_summary).

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
      [tenant, item, units, "sms_send", referenceId, idempotencyKey],
    );
    return rows[0].v;
  });
}

async function refund(tenant: string, referenceId: string, idempotencyKey: string, reason: string) {
  return asSuperAdmin(async () => {
    const { rows } = await db.query<{ v: Record<string, unknown> }>(
      "select public.wallet_refund($1, $2, $3, $4) v",
      [tenant, referenceId, idempotencyKey, reason],
    );
    return rows[0].v;
  });
}

async function summary(tenant: string) {
  const { rows } = await db.query<{ v: Record<string, unknown> }>(
    "select public.wallet_summary($1) v",
    [tenant],
  );
  return rows[0].v;
}

async function balanceOf(tenant: string): Promise<number> {
  const { rows } = await db.query<{ balance: string }>(
    "select balance from public.tenant_wallets where tenant_id = $1",
    [tenant],
  );
  return rows.length ? Number(rows[0].balance) : 0;
}

// Each describe block gets a fresh tenant so tests don't interfere with each
// other's wallet balance / monthly usage.
let tenantCounter = 0;
function freshTenant(): string {
  tenantCounter += 1;
  return `00000000-0000-4000-9000-${String(tenantCounter).padStart(12, "0")}`;
}

async function createTenant(id: string, slug: string) {
  await asSuperAdmin(async () => {
    await db.query(
      `insert into public.tenants (id, slug, plano, is_demo) values ($1, $2, 'starter', false)`,
      [id, slug],
    );
  });
}

describe("wallet_reserve + wallet_mutation: simple reservation", () => {
  const tenant = freshTenant();

  beforeAll(async () => {
    await createTenant(tenant, "wallet-simple");
  });

  it("reserves 2 sms at 0.08 each, leaving 0.84 from a 1.00 balance", async () => {
    await adjustWallet(tenant, 1.0, "saldo inicial", "adj:simple:1");
    const result = await reserve(tenant, "sms", 2, "a", "sms-reserve:a");
    expect(result.ok).toBe(true);
    expect(result.idempotent).toBe(false);
    expect(Number(result.amount)).toBeCloseTo(-0.16, 4);
    expect(Number(result.balance)).toBeCloseTo(0.84, 4);
  });

  it("repeating the same idempotency key is idempotent and balance stays 0.84", async () => {
    const before = await db.query<{ units: string; free_units_used: string; billed_amount: string }>(
      `select units::text, free_units_used::text, billed_amount::text
       from public.tenant_monthly_usage where tenant_id = $1 and item = 'sms'`,
      [tenant],
    );

    const result = await reserve(tenant, "sms", 2, "a", "sms-reserve:a");
    expect(result.idempotent).toBe(true);
    expect(Number(result.balance)).toBeCloseTo(0.84, 4);
    expect(await balanceOf(tenant)).toBeCloseTo(0.84, 4);

    const after = await db.query<{ units: string; free_units_used: string; billed_amount: string }>(
      `select units::text, free_units_used::text, billed_amount::text
       from public.tenant_monthly_usage where tenant_id = $1 and item = 'sms'`,
      [tenant],
    );
    expect(after.rows).toEqual(before.rows);
  });
});

describe("wallet_reserve: insufficient balance", () => {
  const tenant = freshTenant();

  beforeAll(async () => {
    await createTenant(tenant, "wallet-insufficient");
    await adjustWallet(tenant, 1.0, "saldo inicial", "adj:insufficient:1");
    await reserve(tenant, "sms", 2, "a", "sms-reserve:a");
  });

  it("11 segments (0.88) throws insufficient_balance and the balance stays 0.84", async () => {
    await expect(reserve(tenant, "sms", 11, "b", "sms-reserve:b")).rejects.toThrow(
      /insufficient_balance/,
    );
    expect(await balanceOf(tenant)).toBeCloseTo(0.84, 4);
  });
});

describe("wallet_reserve: 20 sequential reservations (PGlite is single-connection)", () => {
  const tenant = freshTenant();

  beforeAll(async () => {
    await createTenant(tenant, "wallet-sequential");
    await adjustWallet(tenant, 1.0, "saldo inicial", "adj:sequential:1");
  });

  it("accepts 12, rejects 8, never goes negative, ends at 0.04", async () => {
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 20; i += 1) {
      try {
        const result = await reserve(tenant, "sms", 1, `seq-${i}`, `sms-reserve:seq-${i}`);
        expect(result.ok).toBe(true);
        accepted += 1;
      } catch (err) {
        expect(String(err)).toMatch(/insufficient_balance/);
        rejected += 1;
      }
      expect(await balanceOf(tenant)).toBeGreaterThanOrEqual(0);
    }
    expect(accepted).toBe(12);
    expect(rejected).toBe(8);
    expect(await balanceOf(tenant)).toBeCloseTo(0.04, 4);
  });
});

describe("wallet_refund", () => {
  const tenant = freshTenant();

  beforeAll(async () => {
    await createTenant(tenant, "wallet-refund");
    await adjustWallet(tenant, 1.0, "saldo inicial", "adj:refund:1");
    await reserve(tenant, "sms", 2, "a", "sms-reserve:a");
  });

  it("refunding the reservation returns the balance to 1.00", async () => {
    const result = await refund(tenant, "a", "sms-refund:a", "x");
    expect(result.ok).toBe(true);
    expect(await balanceOf(tenant)).toBeCloseTo(1.0, 4);
  });

  it("repeating the refund is idempotent", async () => {
    const result = await refund(tenant, "a", "sms-refund:a", "x");
    expect(result.idempotent).toBe(true);
    expect(await balanceOf(tenant)).toBeCloseTo(1.0, 4);
  });

  it("refunding an unknown reference returns ok:false without throwing", async () => {
    const result = await refund(tenant, "does-not-exist", "sms-refund:none", "x");
    expect(result).toMatchObject({ ok: false, reason: "reservation_not_found" });
  });
});

describe("wallet_refund: cannot refund the same reservation twice", () => {
  const tenant = freshTenant();

  beforeAll(async () => {
    await createTenant(tenant, "wallet-refund-once");
    await adjustWallet(tenant, 1.0, "saldo inicial", "adj:refund-once:1");
    await reserve(tenant, "sms", 2, "a", "sms-reserve:a");
    await refund(tenant, "a", "sms-refund:a", "primeiro estorno");
  });

  it("a second refund of the same reservation with a different key returns already_refunded, balance unchanged", async () => {
    const balanceBefore = await balanceOf(tenant);
    const result = await refund(tenant, "a", "sms-refund:a-again", "segunda tentativa");
    expect(result).toMatchObject({ ok: false, reason: "already_refunded" });
    expect(await balanceOf(tenant)).toBeCloseTo(balanceBefore, 4);
  });

  it("rejects a null/empty idempotency key with invalid_idempotency_key", async () => {
    await expect(
      asSuperAdmin(() =>
        db.query("select public.wallet_refund($1, $2, $3, $4)", [tenant, "a", null, "x"]),
      ),
    ).rejects.toThrow(/invalid_idempotency_key/);
    await expect(
      asSuperAdmin(() =>
        db.query("select public.wallet_refund($1, $2, $3, $4)", [tenant, "a", "", "x"]),
      ),
    ).rejects.toThrow(/invalid_idempotency_key/);
  });
});

describe("lifetime_used: net of refunds", () => {
  const tenant = freshTenant();

  async function lifetimeUsedOf(t: string): Promise<number> {
    const { rows } = await db.query<{ lifetime_used: string }>(
      "select lifetime_used::text from public.tenant_wallets where tenant_id = $1",
      [t],
    );
    return Number(rows[0].lifetime_used);
  }

  beforeAll(async () => {
    await createTenant(tenant, "wallet-lifetime-used");
    await adjustWallet(tenant, 1.0, "saldo inicial", "adj:lifetime:1");
  });

  it("a reservation increases lifetime_used, a refund decreases it back (floored at 0)", async () => {
    const result = await reserve(tenant, "sms", 2, "a", "sms-reserve:lifetime-a");
    const reserved = Math.abs(Number(result.amount));
    expect(await lifetimeUsedOf(tenant)).toBeCloseTo(reserved, 4);

    await refund(tenant, "a", "sms-refund:lifetime-a", "estorno");
    expect(await lifetimeUsedOf(tenant)).toBeCloseTo(0, 4);
  });
});

describe("wallet_refund: price change between reservation and refund", () => {
  const tenant = freshTenant();

  beforeAll(async () => {
    await createTenant(tenant, "wallet-price-change");
    await adjustWallet(tenant, 1.0, "saldo inicial", "adj:pricechange:1");
    await reserve(tenant, "sms", 1, "a", "sms-reserve:a");
  });

  it("refund returns exactly the original 0.08, not units x the new price", async () => {
    const before = await balanceOf(tenant);
    expect(before).toBeCloseTo(0.92, 4);

    await asSuperAdmin(async () => {
      await db.query("select public.admin_set_price($1, $2, $3, $4)", ["sms", 0.1, 0.059, 0]);
    });

    const result = await refund(tenant, "a", "sms-refund:a", "troca de preco");
    expect(Number(result.amount)).toBeCloseTo(0.08, 4);
    expect(await balanceOf(tenant)).toBeCloseTo(1.0, 4);
  });
});

describe("wallet_reserve: email free tier", () => {
  const tenant = freshTenant();

  beforeAll(async () => {
    await createTenant(tenant, "wallet-email-free");
    await adjustWallet(tenant, 10.0, "saldo inicial", "adj:email:1");
    await asSuperAdmin(async () => {
      await db.query(
        `insert into public.tenant_monthly_usage (tenant_id, month, item, units, free_units_used, billed_amount)
         values ($1, date_trunc('month', public.billing_now() at time zone 'America/Sao_Paulo')::date, 'email', 99999, 99999, 0)`,
        [tenant],
      );
    });
  });

  it("reserving 2 emails uses 1 free unit and bills 0.002", async () => {
    const result = await reserve(tenant, "email", 2, "a", "email-reserve:a");
    expect(Number(result.amount)).toBeCloseTo(-0.002, 4);

    const { rows } = await db.query<{ free_units: number }>(
      `select free_units from public.wallet_ledger
       where tenant_id = $1 and reference_id = 'a' and entry_type = 'usage_reservation'`,
      [tenant],
    );
    expect(rows[0].free_units).toBe(1);

    const { rows: usageRows } = await db.query<{ free_units_used: string }>(
      `select free_units_used::text from public.tenant_monthly_usage
       where tenant_id = $1 and item = 'email'
         and month = date_trunc('month', public.billing_now() at time zone 'America/Sao_Paulo')::date`,
      [tenant],
    );
    expect(Number(usageRows[0].free_units_used)).toBe(100000);
  });

  it("the next reservation of 1 unit costs 0.002 (franchise exhausted)", async () => {
    const result = await reserve(tenant, "email", 1, "b", "email-reserve:b");
    expect(Number(result.amount)).toBeCloseTo(-0.002, 4);
  });
});

describe("wallet_reserve + wallet_refund: month rollover (America/Sao_Paulo)", () => {
  const tenant = freshTenant();

  beforeAll(async () => {
    await createTenant(tenant, "wallet-month-rollover");
    await adjustWallet(tenant, 10.0, "saldo inicial", "adj:rollover:1");
  });

  it("reserves in October 31st 23:59 BRT, refunds credit back to October after the rollover", async () => {
    await db.exec("set app.allow_test_clock = 'on'; set test.now = '2026-10-31 23:59-03';");
    await reserve(tenant, "sms", 1, "a", "sms-reserve:rollover-a");

    const { rows: octRows } = await db.query<{ units: string; month: string }>(
      `select units::text, month::text from public.tenant_monthly_usage
       where tenant_id = $1 and item = 'sms'`,
      [tenant],
    );
    expect(octRows).toHaveLength(1);
    expect(octRows[0].month).toBe("2026-10-01");
    expect(Number(octRows[0].units)).toBe(1);

    await db.exec("set test.now = '2026-11-01 00:01-03'");
    await refund(tenant, "a", "sms-refund:rollover-a", "virada de mes");

    const { rows: afterRefund } = await db.query<{ units: string }>(
      `select units::text from public.tenant_monthly_usage
       where tenant_id = $1 and item = 'sms' and month = '2026-10-01'`,
      [tenant],
    );
    expect(Number(afterRefund[0].units)).toBe(0);

    const { rows: novRows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.tenant_monthly_usage
       where tenant_id = $1 and item = 'sms' and month = '2026-11-01'`,
      [tenant],
    );
    expect(Number(novRows[0].count)).toBe(0);

    await db.exec("set test.now = ''; set app.allow_test_clock = '';");
  });
});

describe("billing_now(): test.now is only honored with app.allow_test_clock = 'on'", () => {
  it("ignores test.now when app.allow_test_clock is not 'on'", async () => {
    await db.exec("set test.now = '2099-01-01 00:00-03'");
    try {
      const { rows } = await db.query<{ v: string }>("select public.billing_now()::text v");
      const parsed = new Date(rows[0].v);
      expect(parsed.getUTCFullYear()).toBeLessThan(2099);
    } finally {
      await db.exec("set test.now = ''");
    }
  });

  it("honors test.now once app.allow_test_clock = 'on'", async () => {
    await db.exec("set app.allow_test_clock = 'on'; set test.now = '2099-01-01 00:00-03';");
    try {
      const { rows } = await db.query<{ v: string }>("select public.billing_now()::text v");
      expect(new Date(rows[0].v).getUTCFullYear()).toBe(2099);
    } finally {
      await db.exec("set test.now = ''; set app.allow_test_clock = '';");
    }
  });
});

describe("wallet_reserve: exempt (interno) tenant", () => {
  it("reserving 5 sms with a 0 balance succeeds, exempt, amount 0; ledger keeps the provider cost", async () => {
    const result = await reserve(INTERNO, "sms", 5, "a", "sms-reserve:interno-a");
    expect(result.ok).toBe(true);
    expect(result.exempt).toBe(true);
    expect(Number(result.amount)).toBe(0);
    expect(await balanceOf(INTERNO)).toBe(0);

    const { rows } = await db.query<{ units: number; provider_unit_cost: string }>(
      `select units, provider_unit_cost::text from public.wallet_ledger
       where tenant_id = $1 and reference_id = 'a' order by created_at desc limit 1`,
      [INTERNO],
    );
    expect(rows[0].units).toBe(5);
    expect(Number(rows[0].provider_unit_cost)).toBeCloseTo(0.059, 4);
  });
});

describe("billing_wallet_integrity", () => {
  const tenant = freshTenant();

  beforeAll(async () => {
    await createTenant(tenant, "wallet-integrity");
    await adjustWallet(tenant, 1.0, "saldo inicial", "adj:integrity:1");
  });

  it("is empty when balance matches the ledger sum", async () => {
    const { rows } = await asSuperAdmin(() =>
      db.query<{ tenant_id: string }>("select tenant_id from public.billing_wallet_integrity()"),
    );
    expect(rows.find((r) => r.tenant_id === tenant)).toBeUndefined();
  });

  it("lists the tenant after a direct balance update bypassing the ledger", async () => {
    await asSuperAdmin(async () => {
      await db.query("update public.tenant_wallets set balance = balance + 1 where tenant_id = $1", [
        tenant,
      ]);
    });
    const { rows } = await asSuperAdmin(() =>
      db.query<{ tenant_id: string }>("select tenant_id from public.billing_wallet_integrity()"),
    );
    expect(rows.find((r) => r.tenant_id === tenant)).toBeDefined();
  });
});

describe("permissions", () => {
  beforeEach(async () => {
    await resetSession();
  });

  it("wallet_reserve without service_role or superadmin throws forbidden", async () => {
    await db.exec("set test.role = 'authenticated'");
    await expect(
      db.query("select public.wallet_reserve($1, $2, $3, $4, $5, $6)", [
        NORMAL,
        "sms",
        1,
        "sms_send",
        "perm-test",
        "sms-reserve:perm-test",
      ]),
    ).rejects.toThrow(/forbidden/);
  });

  it("admin_adjust_wallet with an empty reason throws invalid_reason", async () => {
    await db.exec("set test.super = 'on'");
    try {
      await expect(
        db.query("select public.admin_adjust_wallet($1, $2, $3, $4)", [
          NORMAL,
          1,
          "",
          "adj:invalid-reason",
        ]),
      ).rejects.toThrow(/invalid_reason/);
    } finally {
      await db.exec("set test.super = 'off'");
    }
  });
});

describe("wallet_reserve: input validation", () => {
  const tenant = freshTenant();

  beforeAll(async () => {
    await createTenant(tenant, "wallet-validation");
  });

  it("rejects an item outside sms/voice_30s/email with invalid_item", async () => {
    await expect(
      reserve(tenant, "whatsapp", 1, "a", "sms-reserve:invalid-item"),
    ).rejects.toThrow(/invalid_item/);
  });

  it("rejects units <= 0 with invalid_units", async () => {
    await expect(reserve(tenant, "sms", 0, "a", "sms-reserve:invalid-units-0")).rejects.toThrow(
      /invalid_units/,
    );
    await expect(reserve(tenant, "sms", -1, "a", "sms-reserve:invalid-units-neg")).rejects.toThrow(
      /invalid_units/,
    );
  });

  it("raises price_not_found when there is no price row for the item, even for an exempt tenant", async () => {
    await asSuperAdmin(async () => {
      await db.query("delete from public.billing_price_book where item = 'voice_30s'");
    });
    try {
      await expect(
        reserve(tenant, "voice_30s", 1, "a", "sms-reserve:no-price"),
      ).rejects.toThrow(/price_not_found/);
      await expect(
        reserve(INTERNO, "voice_30s", 1, "a", "sms-reserve:no-price-interno"),
      ).rejects.toThrow(/price_not_found/);
    } finally {
      await asSuperAdmin(async () => {
        await db.query("select public.admin_set_price($1, $2, $3, $4)", ["voice_30s", 0.09, null, 0]);
      });
    }
  });
});

describe("wallet_summary", () => {
  const tenant = freshTenant();

  let reservedAmount: number;

  beforeAll(async () => {
    await createTenant(tenant, "wallet-summary");
    await adjustWallet(tenant, 1.0, "saldo inicial", "adj:summary:1");
    // The sms unit price may have been changed by an earlier describe block
    // (billing_price_book is shared across this whole test file), so read
    // the amount back from the reservation itself instead of hardcoding it.
    const result = await reserve(tenant, "sms", 1, "a", "sms-reserve:summary-a");
    reservedAmount = Number(result.amount);
  });

  it("never exposes provider_unit_cost to a signed-in house user", async () => {
    await db.exec(`set test.uid = '${tenant}'; set test.super = 'off'; set test.role = 'authenticated';`);
    try {
      const result = await summary(tenant);
      expect(JSON.stringify(result)).not.toContain("provider_unit_cost");
    } finally {
      await resetSession();
    }
  });

  it("returns balance, lifetime fields, exempt, month_usage and prices", async () => {
    const result = await summary(tenant);
    expect(Number(result.balance)).toBeCloseTo(1.0 + reservedAmount, 4);
    expect(result.exempt).toBe(false);
    expect(Array.isArray(result.month_usage)).toBe(true);
    const smsUsage = (result.month_usage as Array<Record<string, unknown>>).find(
      (u) => u.item === "sms",
    );
    expect(smsUsage).toMatchObject({ units: 1, free_units_used: 0 });
    expect(Number((smsUsage as Record<string, unknown>).billed_amount)).toBeCloseTo(
      Math.abs(reservedAmount),
      4,
    );
    expect(result.prices).toHaveProperty("sms");
    expect(result.prices).toHaveProperty("email");
    expect(result.prices).toHaveProperty("voice_30s");
  });
});
