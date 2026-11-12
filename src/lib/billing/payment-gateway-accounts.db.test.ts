// SQL test for supabase/migrations/20261227100100_payment_gateway_accounts.sql:
// provider/settings CHECKs, single-row settings, no seed rows, idempotent
// re-apply, and service-role-only access (anon/authenticated revoked).

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readMigration, resetSession, SCHEMA } from "./billing-db-test-support";

const MIGRATION = readMigration("supabase/migrations/20261227100100_payment_gateway_accounts.sql");

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
  await resetSession(db);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

async function asRole<T>(role: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

describe("payment gateway accounts migration", () => {
  it("seeds nothing", async () => {
    const accounts = await db.query<{ n: number }>(
      "select count(*)::int as n from public.payment_gateway_accounts",
    );
    const settings = await db.query<{ n: number }>(
      "select count(*)::int as n from public.payment_gateway_settings",
    );
    expect(accounts.rows[0].n).toBe(0);
    expect(settings.rows[0].n).toBe(0);
  });

  it("accounts: only upper/spacepay, one row per provider, non-empty ciphertext, object hints", async () => {
    await db.exec(`
      insert into public.payment_gateway_accounts (provider, credentials_encrypted)
      values ('upper', 'v1.a.b');
    `);
    const row = await db.query<{
      hints: unknown;
      created_at: string | null;
      updated_at: string | null;
    }>(
      "select hints, created_at, updated_at from public.payment_gateway_accounts where provider = 'upper'",
    );
    expect(row.rows[0].hints).toEqual({});
    expect(row.rows[0].created_at).not.toBeNull();
    expect(row.rows[0].updated_at).not.toBeNull();

    await expect(
      db.exec(
        `insert into public.payment_gateway_accounts (provider, credentials_encrypted) values ('upper', 'v1.c.d')`,
      ),
    ).rejects.toThrow(/duplicate key/);
    await expect(
      db.exec(
        `insert into public.payment_gateway_accounts (provider, credentials_encrypted) values ('pagbank', 'v1.c.d')`,
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.exec(
        `insert into public.payment_gateway_accounts (provider, credentials_encrypted) values ('spacepay', null)`,
      ),
    ).rejects.toThrow(/null value/);
    await expect(
      db.exec(
        `insert into public.payment_gateway_accounts (provider, credentials_encrypted) values ('spacepay', '  ')`,
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.exec(
        `insert into public.payment_gateway_accounts (provider, credentials_encrypted, hints) values ('spacepay', 'v1.x.y', '[]')`,
      ),
    ).rejects.toThrow(/check constraint/);
    await db.exec(`delete from public.payment_gateway_accounts`);
  });

  it("settings: a single row with a valid provider", async () => {
    await db.exec(
      `insert into public.payment_gateway_settings (active_provider) values ('spacepay')`,
    );
    const row = await db.query<{ id: boolean; active_provider: string }>(
      "select id, active_provider from public.payment_gateway_settings",
    );
    expect(row.rows).toEqual([{ id: true, active_provider: "spacepay" }]);

    await expect(
      db.exec(`insert into public.payment_gateway_settings (active_provider) values ('upper')`),
    ).rejects.toThrow(/duplicate key/);
    await expect(
      db.exec(
        `insert into public.payment_gateway_settings (id, active_provider) values (false, 'upper')`,
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.exec(`update public.payment_gateway_settings set active_provider = 'pagbank'`),
    ).rejects.toThrow(/check constraint/);

    await db.exec(`
      insert into public.payment_gateway_settings (id, active_provider) values (true, 'upper')
      on conflict (id) do update set active_provider = excluded.active_provider
    `);
    const after = await db.query<{ active_provider: string }>(
      "select active_provider from public.payment_gateway_settings",
    );
    expect(after.rows).toEqual([{ active_provider: "upper" }]);
    await db.exec(`delete from public.payment_gateway_settings`);
  });

  it("RLS on, anon/authenticated revoked, service_role granted", async () => {
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
       where relname in ('payment_gateway_accounts', 'payment_gateway_settings') order by relname`,
    );
    expect(rls.rows).toEqual([
      { relname: "payment_gateway_accounts", relrowsecurity: true },
      { relname: "payment_gateway_settings", relrowsecurity: true },
    ]);

    for (const table of ["payment_gateway_accounts", "payment_gateway_settings"]) {
      for (const role of ["anon", "authenticated"]) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          const res = await db.query<{ ok: boolean }>(
            `select has_table_privilege($1, $2, $3) as ok`,
            [role, `public.${table}`, privilege],
          );
          expect(res.rows[0].ok, `${role} ${privilege} ${table}`).toBe(false);
        }
        await expect(asRole(role, () => db.query(`select * from public.${table}`))).rejects.toThrow(
          /permission denied/,
        );
      }
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const res = await db.query<{ ok: boolean }>(
          `select has_table_privilege('service_role', $1, $2) as ok`,
          [`public.${table}`, privilege],
        );
        expect(res.rows[0].ok, `service_role ${privilege} ${table}`).toBe(true);
      }
    }
  });
});
