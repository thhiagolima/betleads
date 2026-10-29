// PG3 Task 8 — SQL test for
// supabase/migrations/20261024100100_billing_wallet_alerts.sql:
// tenant_wallets.low_balance_threshold, wallet_alerts +
// billing_claim_wallet_alert (atomic throttle), billing_set_low_balance_threshold
// (house payer/superadmin, bounds, audit), billing_low_balance_candidates
// (balance < threshold, never exempt/demo/inactive) and wallet_summary's new
// low_balance_threshold key.
//
// PGlite is a single connection, so a real two-session race cannot be run
// here. The atomicity argument is in the migration: one INSERT ... ON
// CONFLICT DO UPDATE ... WHERE statement, which row-locks the conflicting
// row and re-checks the WHERE against its latest version. These tests pin
// the observable contract: true only for the call that moved last_sent_at.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  INTERNO,
  LEGACY_INTERNO,
  NORMAL,
  readMigration,
  resetSession,
  SCHEMA,
  SEED,
} from "./billing-db-test-support";

const AUDIT_MIGRATION = readMigration(
  "supabase/migrations/20260923120000_create_tenant_audit_logs.sql",
);
const PRICE_BOOK_MIGRATION = readMigration(
  "supabase/migrations/20261022100000_billing_price_book.sql",
);
const WALLET_MIGRATION = readMigration("supabase/migrations/20261022100100_billing_wallet.sql");
const ALERTS_MIGRATION = readMigration(
  "supabase/migrations/20261024100100_billing_wallet_alerts.sql",
);
const RUNWAY_MIGRATION = readMigration(
  "supabase/migrations/20261115100000_billing_runway_alert_candidates.sql",
);

// Paying (non-exempt) houses added here: the shared seed's pixpgf/pixreals/
// forrandobet become plano 'interno' (exempt) in the price-book migration.
const OTHER = "00000000-0000-4000-8000-0000000000b1";
const SUSPENDED = "00000000-0000-4000-8000-0000000000b2";
const THIRD = "00000000-0000-4000-8000-0000000000b3";

const ADMIN_USER = "00000000-0000-4000-8000-00000000a001";
const OWNER_USER = "00000000-0000-4000-8000-00000000a002";
const GESTOR_USER = "00000000-0000-4000-8000-00000000a003";
const MEMBER_USER = "00000000-0000-4000-8000-00000000a004";
const OTHER_HOUSE_ADMIN = "00000000-0000-4000-8000-00000000a005";

// Columns/tables the shared stub lacks but this migration reads.
const EXTRA_STUBS = `
alter table public.tenants add column nome text;
alter table public.tenants add column status text not null default 'active';
insert into public.tenants (id, slug, plano, is_demo, status) values
  ('${OTHER}', 'casa-b', 'starter', false, 'active'),
  ('${SUSPENDED}', 'casa-suspensa', 'starter', false, 'suspended'),
  ('${THIRD}', 'casa-c', 'starter', false, 'trial');
update public.tenants set nome = slug;
-- Subset of 20261023100000's tenant_billing (final fix m7 reads access_state).
create table public.tenant_billing (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  access_state text not null default 'ok'
);
create type public.app_role as enum ('admin', 'user', 'super_admin', 'owner', 'member', 'gestor');
create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  role public.app_role not null,
  tenant_id uuid null
);
insert into auth.users (id) values
  ('${ADMIN_USER}'), ('${OWNER_USER}'), ('${GESTOR_USER}'), ('${MEMBER_USER}'), ('${OTHER_HOUSE_ADMIN}');
insert into public.user_roles (user_id, role, tenant_id) values
  ('${ADMIN_USER}', 'admin', '${NORMAL}'),
  ('${OWNER_USER}', 'owner', '${NORMAL}'),
  ('${GESTOR_USER}', 'gestor', '${NORMAL}'),
  ('${MEMBER_USER}', 'member', '${NORMAL}'),
  ('${OTHER_HOUSE_ADMIN}', 'admin', '${OTHER}');
`;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  await db.exec(EXTRA_STUBS);
  await db.exec(AUDIT_MIGRATION);
  await db.exec(PRICE_BOOK_MIGRATION);
  await db.exec(WALLET_MIGRATION);
  await db.exec(ALERTS_MIGRATION);
  await db.exec(RUNWAY_MIGRATION);
  // The price-book migration also makes the demo house 'interno'; put it back
  // on a paying plan so the demo filter is tested on its own.
  await db.exec(
    `set test.super = 'on'; update public.tenants set plano = 'starter' where id = '${INTERNO}'; set test.super = 'off';`,
  );
  await resetSession(db);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await resetSession(db);
  await db.exec(`
    truncate public.wallet_alerts;
    truncate public.tenant_audit_logs;
    truncate public.tenant_billing;
    truncate public.wallet_ledger cascade;
    delete from public.tenant_wallets;
  `);
});

async function as<T>(settings: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  for (const [key, value] of Object.entries(settings)) {
    await db.query(`select set_config($1, $2, false)`, [key, value]);
  }
  try {
    return await fn();
  } finally {
    await resetSession(db);
  }
}

const asService = <T>(fn: () => Promise<T>) => as({ "test.role": "service_role" }, fn);

async function setClock(iso: string) {
  await db.exec(`set app.allow_test_clock = 'on'; set test.now = '${iso}'`);
}

async function claim(tenant: string, kind: string, interval: string, at: string) {
  return asService(async () => {
    await setClock(at);
    const { rows } = await db.query<{ v: boolean }>(
      "select public.billing_claim_wallet_alert($1, $2, $3::interval) v",
      [tenant, kind, interval],
    );
    return rows[0].v;
  });
}

async function setBalance(tenant: string, amount: number) {
  await as({ "test.super": "on" }, () =>
    db.query("select public.admin_adjust_wallet($1, $2, $3, $4)", [
      tenant,
      amount,
      "saldo de teste",
      `seed:${tenant}:${amount}`,
    ]),
  );
}

async function setThreshold(tenant: string, value: number | string | null) {
  const { rows } = await db.query<{ v: Record<string, unknown> }>(
    "select public.billing_set_low_balance_threshold($1, $2::numeric) v",
    [tenant, value],
  );
  return rows[0].v;
}

async function setThresholdAs(
  uid: string,
  tenant: string,
  value: number | string | null,
  extra: Record<string, string> = {},
) {
  return as({ "test.uid": uid, ...extra }, () => setThreshold(tenant, value));
}

async function candidates(after: string | null = null, limit = 500) {
  return asService(async () => {
    const { rows } = await db.query<{
      tenant_id: string;
      tenant_name: string;
      balance: string;
      low_balance_threshold: string;
    }>("select * from public.billing_low_balance_candidates($1::uuid, $2::int)", [after, limit]);
    return rows;
  });
}

describe("billing_claim_wallet_alert", () => {
  it("returns true to the first claim and false to a second one inside the interval", async () => {
    expect(await claim(NORMAL, "low_balance", "24 hours", "2026-10-23T12:00:00Z")).toBe(true);
    expect(await claim(NORMAL, "low_balance", "24 hours", "2026-10-23T12:00:00Z")).toBe(false);
    expect(await claim(NORMAL, "low_balance", "24 hours", "2026-10-24T11:59:59Z")).toBe(false);
  });

  it("returns true again once the interval has fully elapsed, and moves last_sent_at", async () => {
    expect(await claim(NORMAL, "low_balance", "24 hours", "2026-10-23T12:00:00Z")).toBe(true);
    expect(await claim(NORMAL, "low_balance", "24 hours", "2026-10-24T12:00:00Z")).toBe(true);
    const { rows } = await db.query<{ last_sent_at: Date }>(
      "select last_sent_at from public.wallet_alerts where tenant_id = $1 and kind = 'low_balance'",
      [NORMAL],
    );
    expect(rows[0].last_sent_at.toISOString()).toBe("2026-10-24T12:00:00.000Z");
    // A losing claim never moves it.
    expect(await claim(NORMAL, "low_balance", "24 hours", "2026-10-24T13:00:00Z")).toBe(false);
    const after = await db.query<{ last_sent_at: Date }>(
      "select last_sent_at from public.wallet_alerts where tenant_id = $1 and kind = 'low_balance'",
      [NORMAL],
    );
    expect(after.rows[0].last_sent_at.toISOString()).toBe("2026-10-24T12:00:00.000Z");
  });

  it("honours the interval it is given (1 hour for the no-balance alert)", async () => {
    expect(await claim(NORMAL, "no_balance", "1 hour", "2026-10-23T12:00:00Z")).toBe(true);
    expect(await claim(NORMAL, "no_balance", "1 hour", "2026-10-23T12:59:00Z")).toBe(false);
    expect(await claim(NORMAL, "no_balance", "1 hour", "2026-10-23T13:00:00Z")).toBe(true);
  });

  it("throttles each (house, kind) pair independently", async () => {
    expect(await claim(NORMAL, "low_balance", "24 hours", "2026-10-23T12:00:00Z")).toBe(true);
    expect(await claim(NORMAL, "no_balance", "1 hour", "2026-10-23T12:00:00Z")).toBe(true);
    expect(await claim(OTHER, "low_balance", "24 hours", "2026-10-23T12:00:00Z")).toBe(true);
  });

  it("is service_role only", async () => {
    await expect(
      as({ "test.super": "on" }, () =>
        db.query("select public.billing_claim_wallet_alert($1, 'low_balance', '24 hours')", [
          NORMAL,
        ]),
      ),
    ).rejects.toThrow(/forbidden/);
    await expect(
      db.query("select public.billing_claim_wallet_alert($1, 'low_balance', '24 hours')", [NORMAL]),
    ).rejects.toThrow(/forbidden/);
  });

  it("rejects a missing house, an empty kind or a non-positive interval", async () => {
    await expect(claim(NORMAL, "", "24 hours", "2026-10-23T12:00:00Z")).rejects.toThrow(
      /invalid_wallet_alert/,
    );
    await expect(claim(NORMAL, "low_balance", "0 seconds", "2026-10-23T12:00:00Z")).rejects.toThrow(
      /invalid_wallet_alert/,
    );
    await expect(
      asService(() =>
        db.query("select public.billing_claim_wallet_alert(null, 'low_balance', '24 hours')"),
      ),
    ).rejects.toThrow(/invalid_wallet_alert/);
  });
});

describe("billing_set_low_balance_threshold", () => {
  it("lets the house admin, owner and gestor set it, and writes an audit row", async () => {
    const result = await setThresholdAs(ADMIN_USER, NORMAL, 350.5);
    expect(Number(result.low_balance_threshold)).toBe(350.5);
    await setThresholdAs(OWNER_USER, NORMAL, 300);
    await setThresholdAs(GESTOR_USER, NORMAL, 250);

    const { rows } = await db.query<{ low_balance_threshold: string }>(
      "select low_balance_threshold from public.tenant_wallets where tenant_id = $1",
      [NORMAL],
    );
    expect(Number(rows[0].low_balance_threshold)).toBe(250);

    const audit = await db.query<{
      actor_user_id: string;
      action: string;
      entity_type: string;
      before_data: { low_balance_threshold: number };
      after_data: { low_balance_threshold: number };
    }>(
      "select actor_user_id, action, entity_type, before_data, after_data from public.tenant_audit_logs where tenant_id = $1 order by created_at, id",
      [NORMAL],
    );
    expect(audit.rows).toHaveLength(3);
    expect(audit.rows[0]).toMatchObject({
      actor_user_id: ADMIN_USER,
      action: "billing.low_balance_threshold.update",
      entity_type: "tenant_wallet",
    });
    expect(Number(audit.rows[0].before_data.low_balance_threshold)).toBe(200);
    expect(Number(audit.rows[0].after_data.low_balance_threshold)).toBe(350.5);
  });

  it("lets the superadmin set it for any house", async () => {
    const result = await as({ "test.super": "on", "test.access": "off" }, () =>
      setThreshold(OTHER, 0),
    );
    expect(Number(result.low_balance_threshold)).toBe(0);
  });

  it("refuses a member, an admin of another house and a caller without access", async () => {
    await expect(setThresholdAs(MEMBER_USER, NORMAL, 300)).rejects.toThrow(/forbidden/);
    await expect(setThresholdAs(OTHER_HOUSE_ADMIN, NORMAL, 300)).rejects.toThrow(/forbidden/);
    await expect(setThresholdAs(ADMIN_USER, NORMAL, 300, { "test.access": "off" })).rejects.toThrow(
      /forbidden/,
    );
  });

  it("accepts 0 and 100000, refuses below 0, above 100000, null and NaN", async () => {
    expect(Number((await setThresholdAs(ADMIN_USER, NORMAL, 0)).low_balance_threshold)).toBe(0);
    expect(Number((await setThresholdAs(ADMIN_USER, NORMAL, 100000)).low_balance_threshold)).toBe(
      100000,
    );
    await expect(setThresholdAs(ADMIN_USER, NORMAL, -0.01)).rejects.toThrow(/invalid_threshold/);
    await expect(setThresholdAs(ADMIN_USER, NORMAL, 100000.01)).rejects.toThrow(
      /invalid_threshold/,
    );
    await expect(setThresholdAs(ADMIN_USER, NORMAL, null)).rejects.toThrow(/invalid_threshold/);
    await expect(setThresholdAs(ADMIN_USER, NORMAL, "NaN")).rejects.toThrow(/invalid_threshold/);
  });

  it("never touches the balance or the ledger", async () => {
    await setBalance(NORMAL, 120);
    await setThresholdAs(ADMIN_USER, NORMAL, 500);
    const { rows } = await db.query<{ balance: string; n: number }>(
      "select w.balance, (select count(*)::int from public.wallet_ledger l where l.tenant_id = w.tenant_id) n from public.tenant_wallets w where w.tenant_id = $1",
      [NORMAL],
    );
    expect(Number(rows[0].balance)).toBe(120);
    expect(rows[0].n).toBe(1);
  });
});

describe("billing_low_balance_candidates", () => {
  it("lists a house at R$ 199,99 and not one at R$ 200,00 (default threshold)", async () => {
    await setBalance(NORMAL, 199.99);
    await setBalance(OTHER, 200);
    const rows = await candidates();
    expect(rows.map((row) => row.tenant_id)).toEqual([NORMAL]);
    expect(Number(rows[0].balance)).toBe(199.99);
    expect(Number(rows[0].low_balance_threshold)).toBe(200);
    expect(rows[0].tenant_name).toBe("casa-normal");
  });

  it("uses the house's own threshold; 0 turns the alert off", async () => {
    await setBalance(NORMAL, 250);
    await setBalance(OTHER, 10);
    await setThresholdAs(ADMIN_USER, NORMAL, 300);
    await as({ "test.super": "on" }, () => setThreshold(OTHER, 0));
    expect((await candidates()).map((row) => row.tenant_id)).toEqual([NORMAL]);
  });

  it("never lists an exempt, demo or suspended house", async () => {
    await setBalance(LEGACY_INTERNO, 1);
    await setBalance(INTERNO, 1);
    await setBalance(SUSPENDED, 1);
    expect(await candidates()).toEqual([]);
  });

  // Final fix m7: a house locked by billing cannot send anyway; the alert
  // would only add noise next to the invoice e-mails.
  it("never lists a house locked by billing (locked_unpaid, locked_manual, frozen)", async () => {
    await setBalance(NORMAL, 10);
    await setBalance(OTHER, 10);
    await setBalance(THIRD, 10);
    await db.exec(`
      insert into public.tenant_billing (tenant_id, access_state) values
        ('${NORMAL}', 'locked_unpaid'), ('${OTHER}', 'locked_manual'), ('${THIRD}', 'frozen');
    `);
    expect(await candidates()).toEqual([]);
    await db.exec(`
      update public.tenant_billing set access_state = 'overdue' where tenant_id = '${NORMAL}';
      update public.tenant_billing set access_state = 'due_soon' where tenant_id = '${OTHER}';
      delete from public.tenant_billing where tenant_id = '${THIRD}';
    `);
    expect((await candidates()).map((row) => row.tenant_id).sort()).toEqual(
      [NORMAL, OTHER, THIRD].sort(),
    );
  });

  it("never lists a house at zero balance (the no-balance alert owns it)", async () => {
    // A wallet row with balance 0 (created by the setter), and one drained to 0.
    await setThresholdAs(ADMIN_USER, NORMAL, 200);
    await setBalance(OTHER, 50);
    await setBalance(OTHER, -50);
    expect(await candidates()).toEqual([]);
    await setBalance(NORMAL, 0.01);
    expect((await candidates()).map((row) => row.tenant_id)).toEqual([NORMAL]);
  });

  it("pages by tenant_id (keyset) so the list is never silently capped", async () => {
    await setBalance(NORMAL, 10);
    await setBalance(OTHER, 10);
    await setBalance(THIRD, 10);
    const first = await candidates(null, 2);
    expect(first.map((row) => row.tenant_id)).toEqual([NORMAL, OTHER]);
    const second = await candidates(OTHER, 2);
    expect(second.map((row) => row.tenant_id)).toEqual([THIRD]);
    expect(await candidates(THIRD, 2)).toEqual([]);
  });

  it("rejects a limit outside 1-1000", async () => {
    await expect(candidates(null, 0)).rejects.toThrow(/invalid_limit/);
    await expect(candidates(null, 1001)).rejects.toThrow(/invalid_limit/);
  });

  it("is service_role only", async () => {
    await expect(
      as({ "test.super": "on" }, () =>
        db.query("select * from public.billing_low_balance_candidates(null, 500)"),
      ),
    ).rejects.toThrow(/forbidden/);
  });
});

// P0.5: supabase/migrations/20261115100000_billing_runway_alert_candidates.sql
describe("billing_runway_alert_candidates", () => {
  const NOW = "2026-10-29T15:00:00.000Z";
  const hoursBefore = (hours: number) => new Date(Date.parse(NOW) - hours * 3600_000).toISOString();

  async function ledger(tenant: string, entryType: string, amount: number, at: string) {
    await db.query(
      `insert into public.wallet_ledger (tenant_id, entry_type, item, units, amount, balance_after, created_at)
       values ($1, $2, 'sms', 1, $3, 0, $4)`,
      [tenant, entryType, amount, at],
    );
  }

  async function runway(after: string | null = null, limit = 500, hours: number | null = 24) {
    return asService(async () => {
      await setClock(NOW);
      const { rows } = await db.query<{
        tenant_id: string;
        tenant_name: string;
        balance: string;
        spend_24h: string;
        runway_hours: string;
      }>("select * from public.billing_runway_alert_candidates($1::uuid, $2::int, $3::numeric)", [
        after,
        limit,
        hours,
      ]);
      return rows;
    });
  }

  it("lists a house above its threshold whose balance lasts less than 24 h (betgreen on 29/10)", async () => {
    await setBalance(NORMAL, 552);
    await ledger(NORMAL, "usage_reservation", -1090.32, hoursBefore(5));
    // Plenty of balance for its pace: about 10 days.
    await setBalance(OTHER, 1000);
    await ledger(OTHER, "usage_reservation", -100, hoursBefore(2));
    // Balance but no spend in 24 h: no runway to speak of.
    await setBalance(THIRD, 50);

    const rows = await runway();
    expect(rows.map((row) => row.tenant_id)).toEqual([NORMAL]);
    expect(Number(rows[0].balance)).toBe(552);
    expect(Number(rows[0].spend_24h)).toBeCloseTo(1090.32, 2);
    expect(Number(rows[0].runway_hours)).toBe(12.2);
    expect(rows[0].tenant_name).toBe("casa-normal");
  });

  it("nets refunds and ignores spend older than 24 h", async () => {
    await setBalance(NORMAL, 100);
    await ledger(NORMAL, "usage_reservation", -300, hoursBefore(1));
    await ledger(NORMAL, "usage_refund", 200, hoursBefore(1));
    await ledger(NORMAL, "usage_reservation", -5000, hoursBefore(30));
    // Net 100 in 24 h: R$ 100 lasts exactly 24 h, not below it.
    expect(await runway()).toEqual([]);
    await ledger(NORMAL, "usage_reservation", -1, hoursBefore(1));
    const rows = await runway();
    expect(Number(rows[0].spend_24h)).toBe(101);
  });

  it("never lists a suspended, exempt or billing-locked house, nor one at zero balance", async () => {
    await setBalance(SUSPENDED, 10);
    await ledger(SUSPENDED, "usage_reservation", -100, hoursBefore(1));
    await setBalance(LEGACY_INTERNO, 10);
    await ledger(LEGACY_INTERNO, "usage_reservation", -100, hoursBefore(1));
    await setBalance(OTHER, 10);
    await ledger(OTHER, "usage_reservation", -100, hoursBefore(1));
    await db.exec(
      `insert into public.tenant_billing (tenant_id, access_state) values ('${OTHER}', 'frozen')`,
    );
    await ledger(THIRD, "usage_reservation", -100, hoursBefore(1));
    expect(await runway()).toEqual([]);
  });

  it("honours _hours and pages by tenant_id", async () => {
    await setBalance(NORMAL, 40);
    await ledger(NORMAL, "usage_reservation", -240, hoursBefore(1)); // 4 h
    await setBalance(OTHER, 200);
    await ledger(OTHER, "usage_reservation", -240, hoursBefore(1)); // 20 h
    expect((await runway(null, 500, 6)).map((row) => row.tenant_id)).toEqual([NORMAL]);
    expect((await runway(null, 1, 24)).map((row) => row.tenant_id)).toEqual([NORMAL]);
    expect((await runway(NORMAL, 1, 24)).map((row) => row.tenant_id)).toEqual([OTHER]);
  });

  it("rejects bad arguments and is service_role only", async () => {
    await expect(runway(null, 0)).rejects.toThrow(/invalid_limit/);
    await expect(runway(null, 500, 0)).rejects.toThrow(/invalid_hours/);
    await expect(
      as({ "test.super": "on" }, () =>
        db.query("select * from public.billing_runway_alert_candidates(null, 500, 24)"),
      ),
    ).rejects.toThrow(/forbidden/);
  });
});

describe("wallet_summary", () => {
  it("returns low_balance_threshold (200 for a house without a wallet row)", async () => {
    const before = await db.query<{ v: Record<string, unknown> }>(
      "select public.wallet_summary($1) v",
      [NORMAL],
    );
    expect(Number(before.rows[0].v.low_balance_threshold)).toBe(200);
    await setThresholdAs(ADMIN_USER, NORMAL, 75);
    // As a house user: billing_effective_price strips the supplier cost
    // whenever auth.uid() is set and the caller is not the superadmin.
    const after = await as({ "test.uid": ADMIN_USER }, () =>
      db.query<{ v: Record<string, unknown> }>("select public.wallet_summary($1) v", [NORMAL]),
    );
    expect(Number(after.rows[0].v.low_balance_threshold)).toBe(75);
    expect(after.rows[0].v).toHaveProperty("prices");
    expect(JSON.stringify(after.rows[0].v)).not.toContain("provider_unit_cost");
  });
});
