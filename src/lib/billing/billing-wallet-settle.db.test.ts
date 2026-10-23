// PG3 Task 3 — SQL test for
// supabase/migrations/20261024100000_billing_wallet_settle.sql:
// wallet_settle (settlement by actual usage, a partial refund that never
// reprices), wallet_settle_voice (30 s blocks, unanswered rule from the
// price row in force at reservation time), the new price-book column
// charge_unanswered_blocks (admin_set_price overload) and the billing
// columns on call_history / email_send_logs.
//
// Applies the PG1 price book + wallet migrations first. call_history and
// email_send_logs are stubbed (only an id) so the ALTERs have a target.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  INTERNO,
  readMigration,
  resetSession as resetDbSession,
  SCHEMA,
  SEED,
} from "./billing-db-test-support";

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
create table public.sms_campaigns (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'agendada',
  constraint sms_campaigns_status_chk
    check (status in ('agendada', 'enviando', 'enviado', 'falhou', 'cancelada'))
);
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

async function call(sql: string, params: unknown[]): Promise<Json> {
  const { rows } = await db.query<{ v: Json }>(sql, params);
  return rows[0].v;
}

const adjust = (tenant: string, amount: number, key: string) =>
  asSuperAdmin(() =>
    call("select public.admin_adjust_wallet($1, $2, $3, $4) v", [tenant, amount, "saldo", key]),
  );

const reserve = (tenant: string, item: string, units: number, ref: string) =>
  asServiceRole(() =>
    call("select public.wallet_reserve($1, $2, $3, $4, $5, $6) v", [
      tenant,
      item,
      units,
      item === "email" ? "email_send" : "call",
      ref,
      `reserve:${ref}`,
    ]),
  );

const refund = (tenant: string, ref: string, key: string) =>
  asServiceRole(() =>
    call("select public.wallet_refund($1, $2, $3, $4) v", [tenant, ref, key, "falha"]),
  );

const settle = (tenant: string, ref: string, actual: number | null, key: string) =>
  asServiceRole(() =>
    call("select public.wallet_settle($1, $2, $3, $4, $5) v", [
      tenant,
      ref,
      actual,
      key,
      "Liquidação",
    ]),
  );

const settleVoice = (
  tenant: string,
  ref: string,
  duration: number | null,
  answered: boolean,
  key: string,
) =>
  asServiceRole(() =>
    call("select public.wallet_settle_voice($1, $2, $3, $4, $5) v", [
      tenant,
      ref,
      duration,
      answered,
      key,
    ]),
  );

async function setVoicePrice(chargeUnanswered: number | null) {
  await asSuperAdmin(async () => {
    if (chargeUnanswered === null) {
      await db.query("select public.admin_set_price($1, $2, $3, $4)", ["voice_30s", 0.09, null, 0]);
    } else {
      await db.query("select public.admin_set_price($1, $2, $3, $4, $5)", [
        "voice_30s",
        0.09,
        null,
        0,
        chargeUnanswered,
      ]);
    }
  });
}

async function currentChargeUnanswered(): Promise<number> {
  const { rows } = await db.query<{ v: number }>(
    `select charge_unanswered_blocks v from public.billing_price_book
     where item = 'voice_30s' and valid_from <= now() order by valid_from desc limit 1`,
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

async function usage(tenant: string, item: string, month?: string) {
  const { rows } = await db.query<{ units: string; free_units_used: string; billed_amount: string }>(
    `select units::text, free_units_used::text, billed_amount::text
     from public.tenant_monthly_usage
     where tenant_id = $1 and item = $2 and ($3::date is null or month = $3::date)`,
    [tenant, item, month ?? null],
  );
  return rows.map((r) => ({
    units: Number(r.units),
    free_units_used: Number(r.free_units_used),
    billed_amount: Number(r.billed_amount),
  }));
}

let tenantCounter = 0;
async function freshTenant(balance = 10): Promise<string> {
  tenantCounter += 1;
  const id = `00000000-0000-4000-a000-${String(tenantCounter).padStart(12, "0")}`;
  await db.query(
    `insert into public.tenants (id, slug, plano, is_demo) values ($1, $2, 'starter', false)`,
    [id, `settle-${tenantCounter}`],
  );
  if (balance > 0) await adjust(id, balance, `adj:${id}`);
  return id;
}

describe("wallet_settle_voice: answered durations (cap reserved = 5 blocks, R$ 0,45)", () => {
  it.each([
    [61, 3, 0.27],
    [45, 2, 0.18],
    [30, 1, 0.09],
    [1, 1, 0.09],
  ])("%i s answered = %i blocks = R$ %f", async (duration, blocks, billed) => {
    const tenant = await freshTenant();
    const reserved = await reserve(tenant, "voice_30s", 5, `call-${duration}`);
    expect(Number(reserved.amount)).toBeCloseTo(-0.45, 4);

    const result = await settleVoice(tenant, `call-${duration}`, duration, true, `settle:${duration}`);
    expect(result).toMatchObject({ ok: true, idempotent: false, blocks, billed_units: blocks });
    expect(Number(result.billed_amount)).toBeCloseTo(billed, 4);
    expect(Number(result.amount)).toBeCloseTo(0.45 - billed, 4);
    expect(result.units_returned).toBe(5 - blocks);
    expect(await balanceOf(tenant)).toBeCloseTo(10 - billed, 4);

    const [month] = await usage(tenant, "voice_30s");
    expect(month.units).toBe(blocks);
    expect(month.billed_amount).toBeCloseTo(billed, 4);

    const { rows } = await db.query<{
      entry_type: string;
      units: number;
      metadata: Json;
      reverses_ok: boolean;
    }>(
      `select r.entry_type, r.units, r.metadata,
              r.reverses_ledger_id = (select id from public.wallet_ledger
                                      where tenant_id = $1 and entry_type = 'usage_reservation') reverses_ok
       from public.wallet_ledger r
       where r.tenant_id = $1 and r.entry_type = 'usage_refund'`,
      [tenant],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ units: 5 - blocks, reverses_ok: true });
    expect(rows[0].metadata).toMatchObject({ settlement: true, actual_units: blocks });
    expect(rows[0].metadata).not.toHaveProperty("over_cap");
  });

  it("answered with no duration in the callback keeps the cap (decision 3)", async () => {
    const tenant = await freshTenant();
    await reserve(tenant, "voice_30s", 5, "call-nodur");
    const result = await settleVoice(tenant, "call-nodur", null, true, "settle:nodur");
    expect(result).toMatchObject({ ok: true, blocks: 5, units_returned: 0 });
    expect(Number(result.billed_amount)).toBeCloseTo(0.45, 4);
    expect(await balanceOf(tenant)).toBeCloseTo(9.55, 4);
  });

  it("a call longer than the cap is charged the cap and flagged over_cap", async () => {
    const tenant = await freshTenant();
    await reserve(tenant, "voice_30s", 5, "call-long");
    const result = await settleVoice(tenant, "call-long", 400, true, "settle:long");
    expect(result).toMatchObject({ ok: true, blocks: 5, units_returned: 0, over_cap: true });
    expect(Number(result.amount)).toBe(0);
    const { rows } = await db.query<{ metadata: Json; amount: string }>(
      `select metadata, amount::text from public.wallet_ledger
       where tenant_id = $1 and entry_type = 'usage_refund'`,
      [tenant],
    );
    // The row is written even with nothing to return: the reservation is settled.
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBe(0);
    expect(rows[0].metadata).toMatchObject({ settlement: true, actual_units: 5, over_cap: true });
    expect(await balanceOf(tenant)).toBeCloseTo(9.55, 4);
  });
});

describe("wallet_settle_voice: unanswered calls", () => {
  it("free by default: everything returned, usage back to 0", async () => {
    expect(await currentChargeUnanswered()).toBe(0);
    const tenant = await freshTenant();
    await reserve(tenant, "voice_30s", 5, "call-unans");
    const result = await settleVoice(tenant, "call-unans", 0, false, "settle:unans");
    expect(result).toMatchObject({ ok: true, blocks: 0, units_returned: 5 });
    expect(Number(result.billed_amount)).toBe(0);
    expect(Number(result.amount)).toBeCloseTo(0.45, 4);
    expect(await balanceOf(tenant)).toBeCloseTo(10, 4);
    const [month] = await usage(tenant, "voice_30s");
    expect(month).toEqual({ units: 0, free_units_used: 0, billed_amount: 0 });
  });

  it("answered with duration 0 follows the unanswered rule", async () => {
    const tenant = await freshTenant();
    await reserve(tenant, "voice_30s", 5, "call-zero");
    const result = await settleVoice(tenant, "call-zero", 0, true, "settle:zero");
    expect(result).toMatchObject({ ok: true, blocks: 0 });
  });

  it("R$ 0,09 when the rule is set to 1 block", async () => {
    await setVoicePrice(1);
    try {
      expect(await currentChargeUnanswered()).toBe(1);
      const tenant = await freshTenant();
      await reserve(tenant, "voice_30s", 5, "call-unans-1");
      const result = await settleVoice(tenant, "call-unans-1", null, false, "settle:unans-1");
      expect(result).toMatchObject({ ok: true, blocks: 1, units_returned: 4 });
      expect(Number(result.billed_amount)).toBeCloseTo(0.09, 4);
      expect(await balanceOf(tenant)).toBeCloseTo(9.91, 4);
    } finally {
      await setVoicePrice(0);
    }
  });

  it("uses the rule in force at reservation time, not at settlement (never reprice)", async () => {
    const tenant = await freshTenant();
    await reserve(tenant, "voice_30s", 5, "call-rule-before");
    await setVoicePrice(2);
    try {
      const result = await settleVoice(tenant, "call-rule-before", 0, false, "settle:rule-before");
      expect(result).toMatchObject({ ok: true, blocks: 0 });
    } finally {
      await setVoicePrice(0);
    }
  });

  it("admin_set_price without the new argument keeps the current rule", async () => {
    await setVoicePrice(1);
    try {
      await setVoicePrice(null);
      expect(await currentChargeUnanswered()).toBe(1);
    } finally {
      await setVoicePrice(0);
    }
    expect(await currentChargeUnanswered()).toBe(0);
  });

  it("rejects a negative rule", async () => {
    await expect(setVoicePrice(-1)).rejects.toThrow();
  });
});

describe("wallet_settle: idempotency and single reversal", () => {
  it("repeating a settle with the same key returns the previous result and changes nothing", async () => {
    const tenant = await freshTenant();
    await reserve(tenant, "voice_30s", 5, "call-rep");
    const first = await settleVoice(tenant, "call-rep", 61, true, "settle:rep");
    const usageBefore = await usage(tenant, "voice_30s");

    // Even with a different duration, the same key replays the stored result.
    const again = await settleVoice(tenant, "call-rep", 10, true, "settle:rep");
    expect(again).toMatchObject({
      ok: true,
      idempotent: true,
      ledger_id: first.ledger_id,
      blocks: 3,
      billed_units: 3,
    });
    expect(Number(again.billed_amount)).toBeCloseTo(0.27, 4);
    expect(await balanceOf(tenant)).toBeCloseTo(9.73, 4);
    expect(await usage(tenant, "voice_30s")).toEqual(usageBefore);
  });

  it("a settle with a different key on a settled reservation returns already_reversed", async () => {
    const tenant = await freshTenant();
    await reserve(tenant, "voice_30s", 5, "call-twice");
    await settleVoice(tenant, "call-twice", 61, true, "settle:twice-1");
    const second = await settle(tenant, "call-twice", 1, "settle:twice-2");
    expect(second).toEqual({ ok: false, reason: "already_reversed" });
    expect(await balanceOf(tenant)).toBeCloseTo(9.73, 4);
  });

  it("a refund after a settle is refused", async () => {
    const tenant = await freshTenant();
    await reserve(tenant, "voice_30s", 5, "call-s-then-r");
    await settleVoice(tenant, "call-s-then-r", 61, true, "settle:s-then-r");
    const result = await refund(tenant, "call-s-then-r", "refund:s-then-r");
    expect(result).toMatchObject({ ok: false, reason: "already_refunded" });
    expect(await balanceOf(tenant)).toBeCloseTo(9.73, 4);
  });

  it("a refund after a full-usage settle (0 returned) is still refused", async () => {
    const tenant = await freshTenant();
    await reserve(tenant, "voice_30s", 5, "call-full");
    await settle(tenant, "call-full", 5, "settle:full");
    const result = await refund(tenant, "call-full", "refund:full");
    expect(result).toMatchObject({ ok: false, reason: "already_refunded" });
    expect(await balanceOf(tenant)).toBeCloseTo(9.55, 4);
  });

  it("a settle after a refund is refused", async () => {
    const tenant = await freshTenant();
    await reserve(tenant, "voice_30s", 5, "call-r-then-s");
    await refund(tenant, "call-r-then-s", "refund:r-then-s");
    const result = await settleVoice(tenant, "call-r-then-s", 61, true, "settle:r-then-s");
    expect(result).toEqual({ ok: false, reason: "already_reversed" });
    expect(await balanceOf(tenant)).toBeCloseTo(10, 4);
  });

  it("an unknown reference returns reservation_not_found", async () => {
    const tenant = await freshTenant();
    expect(await settle(tenant, "nope", 1, "settle:nope")).toEqual({
      ok: false,
      reason: "reservation_not_found",
    });
    expect(await settleVoice(tenant, "nope", 10, true, "settle:nope-v")).toEqual({
      ok: false,
      reason: "reservation_not_found",
    });
  });

  it("another house cannot settle a reservation it does not own (PG3 Task 5, addendum c)", async () => {
    const owner = await freshTenant();
    const intruder = await freshTenant();
    await reserve(owner, "voice_30s", 5, "call-cross");
    expect(await settleVoice(intruder, "call-cross", 0, false, "voice-settle:call-cross")).toEqual({
      ok: false,
      reason: "reservation_not_found",
    });
    // Nothing moved for either house; the owner can still settle it.
    expect(await balanceOf(owner)).toBeCloseTo(9.55, 4);
    expect(await balanceOf(intruder)).toBeCloseTo(10, 4);
    const own = await settleVoice(owner, "call-cross", 0, false, "voice-settle:call-cross");
    expect(own).toMatchObject({ ok: true, idempotent: false, blocks: 0 });
    expect(await balanceOf(owner)).toBeCloseTo(10, 4);
  });

  it("refuses a key already used by another ledger row instead of replaying it", async () => {
    const tenant = await freshTenant();
    await reserve(tenant, "voice_30s", 5, "call-keyclash");
    const result = await settle(tenant, "call-keyclash", 1, "reserve:call-keyclash");
    expect(result).toEqual({ ok: false, reason: "idempotency_key_conflict" });
    expect(await balanceOf(tenant)).toBeCloseTo(9.55, 4);
  });

  it("validates input", async () => {
    const tenant = await freshTenant();
    await reserve(tenant, "voice_30s", 5, "call-val");
    await expect(settle(tenant, "call-val", null, "settle:val")).rejects.toThrow(/invalid_units/);
    await expect(settle(tenant, "call-val", 1, "")).rejects.toThrow(/invalid_idempotency_key/);
    await expect(settleVoice(tenant, "call-val", -5, true, "settle:val-neg")).rejects.toThrow(
      /invalid_duration/,
    );
    await reserve(tenant, "email", 1, "mail-val");
    await expect(settleVoice(tenant, "mail-val", 10, true, "settle:val-mail")).rejects.toThrow(
      /invalid_item/,
    );
  });

  it("a negative actual is clamped to 0 (everything returned)", async () => {
    const tenant = await freshTenant();
    await reserve(tenant, "voice_30s", 2, "call-neg");
    const result = await settle(tenant, "call-neg", -3, "settle:neg");
    expect(result).toMatchObject({ ok: true, billed_units: 0, units_returned: 2 });
    expect(await balanceOf(tenant)).toBeCloseTo(10, 4);
  });
});

describe("wallet_settle: exempt house", () => {
  it("charges 0 but counts the usage", async () => {
    await reserve(INTERNO, "voice_30s", 5, "call-exempt");
    const result = await settleVoice(INTERNO, "call-exempt", 61, true, "settle:exempt");
    expect(result).toMatchObject({ ok: true, blocks: 3, units_returned: 2 });
    expect(Number(result.amount)).toBe(0);
    expect(Number(result.billed_amount)).toBe(0);
    expect(await balanceOf(INTERNO)).toBe(0);
    const [month] = await usage(INTERNO, "voice_30s");
    expect(month).toEqual({ units: 3, free_units_used: 0, billed_amount: 0 });
  });
});

describe("wallet_settle: e-mail franchise", () => {
  it("returns billable units first, then gives the rest back to the franchise", async () => {
    await asSuperAdmin(() =>
      db.query("select public.admin_set_price($1, $2, $3, $4)", ["email", 0.002, null, 2]),
    );
    try {
      const tenant = await freshTenant();
      // 5 e-mails: 2 free (franchise of 2) + 3 billable = R$ 0,006.
      const reserved = await reserve(tenant, "email", 5, "mail-batch");
      expect(Number(reserved.amount)).toBeCloseTo(-0.006, 4);

      const result = await settle(tenant, "mail-batch", 1, "settle:mail-batch");
      expect(result).toMatchObject({ ok: true, billed_units: 1, units_returned: 4 });
      expect(Number(result.amount)).toBeCloseTo(0.006, 4);
      expect(Number(result.billed_amount)).toBe(0);
      expect(await balanceOf(tenant)).toBeCloseTo(10, 4);

      const [month] = await usage(tenant, "email");
      expect(month).toEqual({ units: 1, free_units_used: 1, billed_amount: 0 });

      const { rows } = await db.query<{ units: number; free_units: number }>(
        `select units, free_units from public.wallet_ledger
         where tenant_id = $1 and entry_type = 'usage_refund'`,
        [tenant],
      );
      expect(rows[0]).toEqual({ units: 4, free_units: 1 });
    } finally {
      await asSuperAdmin(() =>
        db.query("select public.admin_set_price($1, $2, $3, $4)", ["email", 0.002, null, 100000]),
      );
    }
  });

  it("a fully free e-mail returned gives the franchise unit back", async () => {
    const tenant = await freshTenant();
    await reserve(tenant, "email", 1, "mail-free");
    const result = await settle(tenant, "mail-free", 0, "settle:mail-free");
    expect(result).toMatchObject({ ok: true, units_returned: 1 });
    expect(Number(result.amount)).toBe(0);
    const [month] = await usage(tenant, "email");
    expect(month).toEqual({ units: 0, free_units_used: 0, billed_amount: 0 });
  });
});

describe("wallet_settle: franchise straddle", () => {
  it("1 free + 1 paid e-mail settled at 0 returns exactly R$ 0,002 and 1 franchise unit", async () => {
    await asSuperAdmin(() =>
      db.query("select public.admin_set_price($1, $2, $3, $4)", ["email", 0.002, null, 1]),
    );
    try {
      const tenant = await freshTenant();
      const reserved = await reserve(tenant, "email", 2, "mail-straddle");
      expect(Number(reserved.amount)).toBeCloseTo(-0.002, 4);

      const result = await settle(tenant, "mail-straddle", 0, "settle:mail-straddle");
      expect(result).toMatchObject({
        ok: true,
        billed_units: 0,
        units_returned: 2,
        free_units_returned: 1,
      });
      expect(Number(result.amount)).toBe(0.002);
      expect(Number(result.billed_amount)).toBe(0);
      expect(await balanceOf(tenant)).toBe(10);

      const { rows } = await db.query<{ amount: string; units: number; free_units: number }>(
        `select amount::text, units, free_units from public.wallet_ledger
         where tenant_id = $1 and entry_type = 'usage_refund'`,
        [tenant],
      );
      expect(rows).toEqual([{ amount: "0.0020", units: 2, free_units: 1 }]);
      const [month] = await usage(tenant, "email");
      expect(month).toEqual({ units: 0, free_units_used: 0, billed_amount: 0 });
    } finally {
      await asSuperAdmin(() =>
        db.query("select public.admin_set_price($1, $2, $3, $4)", ["email", 0.002, null, 100000]),
      );
    }
  });
});

describe("wallet_settle: no drift between balance and ledger", () => {
  it("reserve, settle, replay and a refund attempt leave balance = ledger sum", async () => {
    const tenant = await freshTenant();
    await reserve(tenant, "voice_30s", 5, "call-drift");
    const first = await settleVoice(tenant, "call-drift", 61, true, "settle:drift");
    expect(first).toMatchObject({ ok: true, idempotent: false });
    const replay = await settleVoice(tenant, "call-drift", 61, true, "settle:drift");
    expect(replay).toMatchObject({ ok: true, idempotent: true });
    const refused = await refund(tenant, "call-drift", "refund:drift");
    expect(refused).toMatchObject({ ok: false, reason: "already_refunded" });

    const { rows: drift } = await asSuperAdmin(() =>
      db.query<{ tenant_id: string }>("select tenant_id from public.billing_wallet_integrity()"),
    );
    expect(drift.find((r) => r.tenant_id === tenant)).toBeUndefined();

    const { rows } = await db.query<{ balance: string; ledger_sum: string }>(
      `select w.balance::text,
              (select coalesce(sum(amount), 0) from public.wallet_ledger l
               where l.tenant_id = w.tenant_id)::text ledger_sum
       from public.tenant_wallets w where w.tenant_id = $1`,
      [tenant],
    );
    expect(Number(rows[0].balance)).toBe(Number(rows[0].ledger_sum));
    expect(Number(rows[0].balance)).toBeCloseTo(9.73, 4);
  });
});

describe("wallet_settle: month boundary", () => {
  it("reserved on 31/10 and settled on 01/11 decrements October, never November", async () => {
    const tenant = await freshTenant();
    await db.exec("set app.allow_test_clock = 'on'; set test.now = '2026-10-31 23:59-03';");
    try {
      await reserve(tenant, "voice_30s", 5, "call-month");
      await db.exec("set test.now = '2026-11-01 00:01-03'");
      const result = await settleVoice(tenant, "call-month", 61, true, "settle:month");
      expect(result).toMatchObject({ ok: true, blocks: 3 });

      const [oct] = await usage(tenant, "voice_30s", "2026-10-01");
      expect(oct.units).toBe(3);
      expect(oct.billed_amount).toBeCloseTo(0.27, 4);
      expect(await usage(tenant, "voice_30s", "2026-11-01")).toEqual([]);
    } finally {
      await db.exec("set test.now = ''; set app.allow_test_clock = '';");
    }
  });
});

describe("permissions and schema", () => {
  it("an authenticated house user cannot settle", async () => {
    const tenant = await freshTenant();
    await reserve(tenant, "voice_30s", 1, "call-perm");
    await db.exec("set test.role = 'authenticated'");
    try {
      await expect(
        db.query("select public.wallet_settle($1, $2, $3, $4, $5)", [
          tenant,
          "call-perm",
          1,
          "settle:perm",
          "x",
        ]),
      ).rejects.toThrow(/forbidden/);
      await expect(
        db.query("select public.wallet_settle_voice($1, $2, $3, $4, $5)", [
          tenant,
          "call-perm",
          1,
          true,
          "settle:perm-v",
        ]),
      ).rejects.toThrow(/forbidden/);
    } finally {
      await db.exec("set test.role = ''");
    }
  });

  it("EXECUTE on wallet_settle* is granted to service_role only", async () => {
    const { rows } = await db.query<{ role: string; fn: string; ok: boolean }>(
      `select r.role, f.fn, has_function_privilege(r.role, f.fn, 'execute') ok
       from (values ('anon'), ('authenticated'), ('service_role')) r(role),
            (values ('public.wallet_settle(uuid, text, integer, text, text)'),
                    ('public.wallet_settle_voice(uuid, text, integer, boolean, text)')) f(fn)`,
    );
    for (const row of rows) {
      expect(row.ok, `${row.role} ${row.fn}`).toBe(row.role === "service_role");
    }
  });

  it("admin_set_price: the old 4-argument signature is gone, the new one is callable by authenticated", async () => {
    const { rows } = await db.query<{ sig: string }>(
      `select pg_get_function_identity_arguments(p.oid) sig from pg_proc p
       where p.proname = 'admin_set_price' and p.pronamespace = 'public'::regnamespace`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].sig).toContain("_charge_unanswered_blocks integer");
    const { rows: priv } = await db.query<{ auth: boolean; anon: boolean }>(
      `select has_function_privilege('authenticated', 'public.admin_set_price(text, numeric, numeric, integer, integer)', 'execute') auth,
              has_function_privilege('anon', 'public.admin_set_price(text, numeric, numeric, integer, integer)', 'execute') anon`,
    );
    expect(priv[0]).toEqual({ auth: true, anon: false });
  });

  it("adds the billing columns to call_history and email_send_logs", async () => {
    const { rows } = await db.query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type from information_schema.columns
       where table_schema = 'public'
         and table_name in ('call_history', 'email_send_logs')
         and column_name like 'bill%'
       order by table_name, column_name`,
    );
    expect(rows).toEqual([
      { table_name: "call_history", column_name: "billed_amount", data_type: "numeric" },
      { table_name: "call_history", column_name: "billed_blocks", data_type: "integer" },
      { table_name: "call_history", column_name: "billing_reference_id", data_type: "text" },
      {
        table_name: "call_history",
        column_name: "billing_settled_at",
        data_type: "timestamp with time zone",
      },
      { table_name: "email_send_logs", column_name: "billed_amount", data_type: "numeric" },
      { table_name: "email_send_logs", column_name: "billing_reference_id", data_type: "text" },
    ]);
  });
});

// PG3 final fix I3: an SMS campaign can be paused for lack of balance.
describe("sms_campaigns status", () => {
  it("accepts 'pausada' and still refuses an unknown status", async () => {
    await db.exec("insert into public.sms_campaigns (status) values ('pausada')");
    await expect(
      db.exec("insert into public.sms_campaigns (status) values ('qualquer')"),
    ).rejects.toThrow(/sms_campaigns_status_chk/);
  });
});
