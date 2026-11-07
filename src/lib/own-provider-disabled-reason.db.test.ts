// PGlite test for
// supabase/migrations/20261217100400_own_provider_disabled_reason.sql:
// provider_accounts.disabled_reason check and the partial unique index of one
// owned account per house and channel. Full migrated database.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migratedPglitePath = "../../scripts/demo/test-support/migrated-pglite.mjs";
const { createMigratedDb } = (await import(/* @vite-ignore */ migratedPglitePath)) as {
  createMigratedDb: () => Promise<{ db: PGlite }>;
};

const TENANT_A = "7a3f4d5c-0002-4000-9000-000000000001";
const TENANT_B = "7a3f4d5c-0002-4000-9000-000000000002";

let db: PGlite;

const insertOwned = (tenantId: string | null, channel: string, label: string) =>
  db.query<{ id: string }>(
    `insert into public.provider_accounts
       (provider, label, channels, credentials_source, credentials_encrypted, owner_tenant_id)
     values ('infobip', $3, array[$2], 'db', 'x', $1)
     returning id`,
    [tenantId, channel, label],
  );

beforeAll(async () => {
  ({ db } = await createMigratedDb());
  for (const [id, slug] of [
    [TENANT_A, "own-reason-a"],
    [TENANT_B, "own-reason-b"],
  ]) {
    await db.query(
      `insert into public.tenants (id, nome, slug, status, plano, is_demo)
       values ($1, $2, $2, 'active', 'starter', false)`,
      [id, slug],
    );
  }
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe("one owned account per house and channel", () => {
  it("refuses a second owned account of the same house in the same channel (23505)", async () => {
    await insertOwned(TENANT_A, "sms", "A sms 1");
    await expect(insertOwned(TENANT_A, "sms", "A sms 2")).rejects.toMatchObject({ code: "23505" });
  });

  it("allows another channel, another house, and any number of platform accounts", async () => {
    await expect(insertOwned(TENANT_A, "email", "A email")).resolves.toBeDefined();
    await expect(insertOwned(TENANT_B, "sms", "B sms")).resolves.toBeDefined();
    await expect(insertOwned(null, "sms", "Plataforma 1")).resolves.toBeDefined();
    await expect(insertOwned(null, "sms", "Plataforma 2")).resolves.toBeDefined();
  });
});

describe("disabled_reason", () => {
  it("accepts platform, revoked and null; refuses anything else", async () => {
    const { rows } = await insertOwned(TENANT_B, "voice", "B voice");
    const id = rows[0].id;
    for (const reason of ["platform", "revoked", null]) {
      await expect(
        db.query(`update public.provider_accounts set disabled_reason = $2 where id = $1`, [id, reason]),
      ).resolves.toBeDefined();
    }
    await expect(
      db.query(`update public.provider_accounts set disabled_reason = 'outro' where id = $1`, [id]),
    ).rejects.toThrow(/check/i);
  });
});
