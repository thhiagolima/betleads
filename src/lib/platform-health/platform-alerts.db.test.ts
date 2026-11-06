// Task 1 — SQL test for
// supabase/migrations/20261212100000_platform_alerts.sql: platform_alerts
// (one open row per alert_key, enforced by a partial unique index) and
// platform_digest_log (one row per day). Both tables: RLS on, no policies —
// only service_role may read/write.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { readMigration, resetSession, SCHEMA, SEED } from "../billing/billing-db-test-support";

const PLATFORM_ALERTS_MIGRATION = readMigration(
  "supabase/migrations/20261212100000_platform_alerts.sql",
);

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  await db.exec(PLATFORM_ALERTS_MIGRATION);
  // The shared stub's service_role has no BYPASSRLS (see
  // billing-db-test-support.ts); these tables have RLS enabled and no
  // policies, so service_role needs BYPASSRLS to read/write them, same as
  // finance-monthly-ggr.db.test.ts.
  await db.exec(`ALTER ROLE service_role BYPASSRLS`);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec("reset role");
  await resetSession(db);
});

async function asServiceRole<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("set role service_role");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

let keyCounter = 0;
function freshKey(): string {
  keyCounter += 1;
  return `alert-key-${keyCounter}`;
}

describe("platform_alerts: one open row per alert_key", () => {
  it("a second open row with the same alert_key fails (unique violation)", async () => {
    const key = freshKey();
    await asServiceRole(() =>
      db.query(
        `insert into public.platform_alerts (alert_key, kind, severity, message)
         values ($1, 'sms_failure_rate', 'critical', 'SMS falhando acima do limite')`,
        [key],
      ),
    );

    await expect(
      asServiceRole(() =>
        db.query(
          `insert into public.platform_alerts (alert_key, kind, severity, message)
           values ($1, 'sms_failure_rate', 'critical', 'segunda ocorrência')`,
          [key],
        ),
      ),
    ).rejects.toThrow(/duplicate key|unique constraint/i);
  });

  it("a resolved row + a new open row with the same key is allowed", async () => {
    const key = freshKey();
    await asServiceRole(() =>
      db.query(
        `insert into public.platform_alerts (alert_key, kind, severity, message)
         values ($1, 'sms_failure_rate', 'warning', 'primeira ocorrência')`,
        [key],
      ),
    );
    await asServiceRole(() =>
      db.query(`update public.platform_alerts set resolved_at = now() where alert_key = $1`, [key]),
    );

    await expect(
      asServiceRole(() =>
        db.query(
          `insert into public.platform_alerts (alert_key, kind, severity, message)
           values ($1, 'sms_failure_rate', 'warning', 'nova ocorrência')`,
          [key],
        ),
      ),
    ).resolves.toBeDefined();

    const { rows } = await asServiceRole(() =>
      db.query<{ count: string }>(
        `select count(*)::text as count from public.platform_alerts where alert_key = $1`,
        [key],
      ),
    );
    expect(Number(rows[0].count)).toBe(2);
  });
});

describe("platform_alerts: permissions", () => {
  it.each(["anon", "authenticated"])("%s cannot select", async (role) => {
    await db.exec(`set role ${role}`);
    await expect(db.query(`select * from public.platform_alerts`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it.each(["anon", "authenticated"])("%s cannot insert", async (role) => {
    await db.exec(`set role ${role}`);
    await expect(
      db.query(
        `insert into public.platform_alerts (alert_key, kind, severity, message)
         values ($1, 'sms_failure_rate', 'critical', 'x')`,
        [freshKey()],
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("service_role can select and insert", async () => {
    const key = freshKey();
    await expect(
      asServiceRole(() =>
        db.query(
          `insert into public.platform_alerts (alert_key, kind, severity, message)
           values ($1, 'sms_failure_rate', 'critical', 'x')`,
          [key],
        ),
      ),
    ).resolves.toBeDefined();

    const { rows } = await asServiceRole(() =>
      db.query(`select * from public.platform_alerts where alert_key = $1`, [key]),
    );
    expect(rows).toHaveLength(1);
  });
});

describe("platform_digest_log", () => {
  it("the primary key rejects a second row for the same day", async () => {
    await asServiceRole(() =>
      db.query(`insert into public.platform_digest_log (digest_day) values ('2026-11-05')`),
    );

    await expect(
      asServiceRole(() =>
        db.query(
          `insert into public.platform_digest_log (digest_day, recipients) values ('2026-11-05', 3)`,
        ),
      ),
    ).rejects.toThrow(/duplicate key|unique constraint/i);
  });

  it.each(["anon", "authenticated"])("%s cannot select or insert", async (role) => {
    await db.exec(`set role ${role}`);
    await expect(db.query(`select * from public.platform_digest_log`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      db.query(`insert into public.platform_digest_log (digest_day) values ('2026-11-06')`),
    ).rejects.toThrow(/permission denied/);
  });

  it("service_role can select and insert", async () => {
    await expect(
      asServiceRole(() =>
        db.query(`insert into public.platform_digest_log (digest_day) values ('2026-11-07')`),
      ),
    ).resolves.toBeDefined();

    const { rows } = await asServiceRole(() =>
      db.query(`select * from public.platform_digest_log where digest_day = '2026-11-07'`),
    );
    expect(rows).toHaveLength(1);
  });
});
