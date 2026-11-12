// SQL test for supabase/migrations/20261227100000_billing_spacepay_gateway.sql:
// the provider CHECK on payment_charges and payment_webhook_events (only
// 'upper' | 'spacepay'), the webhook events provider default, and the
// 'spacepay' payment_fee_settings row copied from the current 'upper' one.
//
// Applies the PG1 price book + wallet and the PG2 Pix charges migrations
// first (the tables it alters), seeds an 'upper' fee row (the migrations
// never seed one), then applies the SpacePay migration twice to check it is
// idempotent.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NORMAL, readMigration, resetSession, SCHEMA, SEED } from "./billing-db-test-support";

const PRICE_BOOK_MIGRATION = readMigration(
  "supabase/migrations/20261022100000_billing_price_book.sql",
);
const WALLET_MIGRATION = readMigration("supabase/migrations/20261022100100_billing_wallet.sql");
const PIX_CHARGES_MIGRATION = readMigration(
  "supabase/migrations/20261022110000_billing_pix_charges.sql",
);
const SPACEPAY_MIGRATION = readMigration(
  "supabase/migrations/20261227100000_billing_spacepay_gateway.sql",
);

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  await db.exec(PRICE_BOOK_MIGRATION);
  await db.exec(WALLET_MIGRATION);
  await db.exec(PIX_CHARGES_MIGRATION);
  // An older 'upper' rate and the current one: the migration must copy the
  // current one.
  await db.exec(`
    insert into public.payment_fee_settings (provider, fee_percent, fee_fixed_cents, valid_from)
    values ('upper', 1.5, 10, now() - interval '30 days'),
           ('upper', 0.99, 35, now() - interval '1 day');
    insert into public.payment_webhook_events (event_id, event) values ('evt-before', 'charge.paid');
  `);
  await db.exec(SPACEPAY_MIGRATION);
  await db.exec(SPACEPAY_MIGRATION);
  await resetSession(db);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

async function insertCharge(provider: string, externalId: string) {
  return db.query(
    `insert into public.payment_charges (
       tenant_id, kind, ref_id, provider, external_id, status, amount_cents
     ) values ($1, 'credit_topup', gen_random_uuid(), $2, $3, 'PENDING', 10000)
     returning provider`,
    [NORMAL, provider, externalId],
  );
}

describe("billing_spacepay_gateway migration", () => {
  it("payment_charges.provider accepts 'spacepay' and 'upper', rejects anything else", async () => {
    const sp = await insertCharge("spacepay", "bl-sp-1");
    expect(sp.rows).toEqual([{ provider: "spacepay" }]);
    const up = await insertCharge("upper", "bl-up-1");
    expect(up.rows).toEqual([{ provider: "upper" }]);
    await expect(insertCharge("foo", "bl-foo-1")).rejects.toThrow(
      /payment_charges_provider_check/,
    );
  });

  it("has the (provider, status) index on payment_charges", async () => {
    const r = await db.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where indexname = 'idx_payment_charges_provider_status'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].indexdef).toMatch(/\(provider, status\)/);
  });

  it("payment_webhook_events.provider defaults to 'upper' (old rows too) and is checked", async () => {
    await db.query(`insert into public.payment_webhook_events (event_id) values ('evt-new')`);
    await db.query(
      `insert into public.payment_webhook_events (event_id, provider) values ('evt-sp', 'spacepay')`,
    );
    const r = await db.query<{ event_id: string; provider: string }>(
      `select event_id, provider from public.payment_webhook_events order by event_id`,
    );
    expect(r.rows).toEqual([
      { event_id: "evt-before", provider: "upper" },
      { event_id: "evt-new", provider: "upper" },
      { event_id: "evt-sp", provider: "spacepay" },
    ]);
    await expect(
      db.query(
        `insert into public.payment_webhook_events (event_id, provider) values ('evt-foo', 'foo')`,
      ),
    ).rejects.toThrow(/payment_webhook_events_provider_check/);
  });

  it("copies the current 'upper' fee to exactly one 'spacepay' row, even when applied twice", async () => {
    const r = await db.query<{ fee_percent: string; fee_fixed_cents: string | number }>(
      `select fee_percent::text as fee_percent, fee_fixed_cents
         from public.payment_fee_settings where provider = 'spacepay'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].fee_percent).toBe("0.9900");
    expect(Number(r.rows[0].fee_fixed_cents)).toBe(35);
  });
});
