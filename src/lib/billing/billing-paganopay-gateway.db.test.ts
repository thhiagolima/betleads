// SQL test for supabase/migrations/20261231101300_billing_paganopay_gateway.sql:
// the four provider CHECKs accept 'paganopay' (and still reject anything
// else), and the 'paganopay' fee row is copied from the current 'spacepay'
// one. Applied twice to check it is idempotent.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NORMAL, readMigration, resetSession, SCHEMA, SEED } from "./billing-db-test-support";

const MIGRATIONS = [
  "supabase/migrations/20261022100000_billing_price_book.sql",
  "supabase/migrations/20261022100100_billing_wallet.sql",
  "supabase/migrations/20261022110000_billing_pix_charges.sql",
  "supabase/migrations/20261227100000_billing_spacepay_gateway.sql",
  "supabase/migrations/20261227100100_payment_gateway_accounts.sql",
].map(readMigration);
const PAGANOPAY_MIGRATION = readMigration(
  "supabase/migrations/20261231101300_billing_paganopay_gateway.sql",
);

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  for (const sql of MIGRATIONS) await db.exec(sql);
  await db.exec(`
    insert into public.payment_fee_settings (provider, fee_percent, fee_fixed_cents, valid_from)
    values ('upper', 0.99, 35, now() - interval '2 days'),
           ('spacepay', 1.99, 0, now() - interval '1 day');
  `);
  await db.exec(PAGANOPAY_MIGRATION);
  await db.exec(PAGANOPAY_MIGRATION);
  await resetSession(db);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("billing_paganopay_gateway migration", () => {
  it("payment_charges.provider accepts 'paganopay', still rejects anything else", async () => {
    const r = await db.query(
      `insert into public.payment_charges (
         tenant_id, kind, ref_id, provider, external_id, status, amount_cents
       ) values ($1, 'credit_topup', gen_random_uuid(), 'paganopay', 'bl-pp-1', 'PENDING', 10000)
       returning provider`,
      [NORMAL],
    );
    expect(r.rows).toEqual([{ provider: "paganopay" }]);
    await expect(
      db.query(
        `insert into public.payment_charges (
           tenant_id, kind, ref_id, provider, external_id, status, amount_cents
         ) values ($1, 'credit_topup', gen_random_uuid(), 'foo', 'bl-foo-1', 'PENDING', 10000)`,
        [NORMAL],
      ),
    ).rejects.toThrow(/payment_charges_provider_check/);
  });

  it("payment_webhook_events.provider accepts 'paganopay'", async () => {
    await db.query(
      `insert into public.payment_webhook_events (event_id, provider) values ('pp-evt', 'paganopay')`,
    );
    await expect(
      db.query(
        `insert into public.payment_webhook_events (event_id, provider) values ('x-evt', 'foo')`,
      ),
    ).rejects.toThrow(/payment_webhook_events_provider_check/);
  });

  it("gateway accounts and settings accept 'paganopay'", async () => {
    await db.query(
      `insert into public.payment_gateway_accounts (provider, credentials_encrypted) values ('paganopay', 'enc')`,
    );
    await db.query(
      `insert into public.payment_gateway_settings (id, active_provider) values (true, 'paganopay')`,
    );
    await expect(
      db.query(
        `insert into public.payment_gateway_accounts (provider, credentials_encrypted) values ('foo', 'enc')`,
      ),
    ).rejects.toThrow(/payment_gateway_accounts_provider_check/);
    await expect(
      db.query(`update public.payment_gateway_settings set active_provider = 'foo'`),
    ).rejects.toThrow(/payment_gateway_settings_active_provider_check/);
  });

  it("copies the current SpacePay fee to exactly one 'paganopay' row", async () => {
    const r = await db.query<{ fee_percent: string; fee_fixed_cents: string | number }>(
      `select fee_percent::text as fee_percent, fee_fixed_cents
         from public.payment_fee_settings where provider = 'paganopay'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].fee_percent).toBe("1.9900");
    expect(Number(r.rows[0].fee_fixed_cents)).toBe(0);
  });
});
