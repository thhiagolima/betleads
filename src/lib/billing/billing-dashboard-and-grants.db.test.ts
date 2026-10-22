// PG1 final review — SQL/behavior test for
// supabase/migrations/20261022100400_billing_dashboard_and_grants.sql:
//   1. dashboard_summary_v2 no longer reads the legacy credit balance/ledger
//      for smsSent/messageCost/the balance field (text check: the migration
//      must not reference the legacy tables, and must read the new ones).
//      The JSON-field-mapping side (walletBalance/exempt/messageCost) is
//      covered by src/lib/dashboard.functions.test.ts (mapDashboardRpc) --
//      a full PGlite run of dashboard_summary_v2 itself isn't practical here,
//      see that file's header comment for why.
//   3. billing_report_unit_price reports the SALE price for a demo tenant
//      and the supplier cost for a real (non-demo) `interno` house, and
//      `authenticated` can no longer execute it at all.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  INTERNO,
  LEGACY_INTERNO,
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
const FIX_MIGRATION_PATH = "supabase/migrations/20261022100400_billing_dashboard_and_grants.sql";
const FIX_MIGRATION = readMigration(FIX_MIGRATION_PATH);

// dashboard_summary_v2 (the first half of the migration) touches a dozen+
// production tables (tenant_daily_metrics, deposits, players, journeys,
// click_events, conversion_attributions, ...) that aren't worth stubbing
// here -- see dashboard.functions.test.ts for why. The billing-db-test-support
// stub schema only has what Tasks 2/3 need (tenants, billing_*, wallet_*), so
// the behavioral part of this test applies only the billing_report_unit_price
// redefinition (the part after the marker comment), not the whole file.
const REPORT_PRICE_MARKER = "-- billing_report_unit_price: copied whole from";
const reportPriceStart = FIX_MIGRATION.indexOf(REPORT_PRICE_MARKER);
if (reportPriceStart === -1) {
  throw new Error(`${FIX_MIGRATION_PATH}: marker comment not found, test needs updating`);
}
const REPORT_PRICE_MIGRATION = FIX_MIGRATION.slice(reportPriceStart);

// Strip SQL line comments before asserting on absence: the migration's own
// header explains the removal by naming the legacy tables in prose, which
// would otherwise make this check trip on its own comment.
const FIX_MIGRATION_CODE = FIX_MIGRATION.replace(/--.*$/gm, "");

describe("migration text: dashboard_summary_v2 drops the legacy credit ledger/balance", () => {
  it("does not reference the legacy credit tables outside of comments", () => {
    expect(FIX_MIGRATION_CODE).not.toContain("tenant_sms_credit_balances");
    expect(FIX_MIGRATION_CODE).not.toContain("sms_credit_ledger");
  });

  it("reads smsSent/messageCost from crm_results_daily", () => {
    expect(FIX_MIGRATION).toContain("crm_results_daily");
    expect(FIX_MIGRATION).toContain("'smsSent', sr.sent");
    expect(FIX_MIGRATION).toContain("'messageCost', sr.cost");
  });

  it("replaces the legacy credits field with the wallet balance and the exempt flag", () => {
    expect(FIX_MIGRATION).toContain("tenant_wallets");
    expect(FIX_MIGRATION).toContain("billing_tenant_exempt");
    expect(FIX_MIGRATION).toContain("'walletBalance', w.balance");
    expect(FIX_MIGRATION).toContain("'exempt', w.exempt");
  });

  it("revokes authenticated's execute grant on billing_report_unit_price, keeping service_role", () => {
    expect(FIX_MIGRATION).toContain(
      "revoke execute on function public.billing_report_unit_price(uuid, text, timestamptz) from public, anon, authenticated;",
    );
    expect(FIX_MIGRATION).toContain(
      "grant execute on function public.billing_report_unit_price(uuid, text, timestamptz) to service_role;",
    );
  });
});

describe("billing_report_unit_price: demo sale price vs. real interno supplier cost", () => {
  let db: PGlite;

  async function resetSession() {
    await resetDbSession(db);
  }

  async function reportPrice(tenant: string, item: string) {
    const { rows } = await db.query<{ v: string }>(
      "select public.billing_report_unit_price($1, $2) v",
      [tenant, item],
    );
    return Number(rows[0].v);
  }

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(SCHEMA);
    await db.exec(SEED);
    await db.exec(PRICE_BOOK_MIGRATION);
    await db.exec(WALLET_MIGRATION);
    await db.exec(REPORT_PRICE_MIGRATION);
    await resetSession();
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("a demo house (is_demo = true, plano = interno) reports the SALE price for sms (0.08), not the supplier cost", async () => {
    // INTERNO (billing-db-test-support) is the seeded demo tenant: slug
    // 'minha-demo', is_demo = true, flipped to plano = 'interno' by the
    // Task 2 migration's data block.
    expect(await reportPrice(INTERNO, "sms")).toBeCloseTo(0.08, 4);
  });

  it("a real interno house that isn't the demo tenant still reports the supplier cost (0.059)", async () => {
    // LEGACY_INTERNO: slug 'ja-era-interno', is_demo = false, plano =
    // 'interno' from the seed (the "already interno before this phase" case).
    expect(await reportPrice(LEGACY_INTERNO, "sms")).toBeCloseTo(0.059, 4);
  });

  it("a normal (non-exempt) house still reports the sale price", async () => {
    expect(await reportPrice(NORMAL, "sms")).toBeCloseTo(0.08, 4);
  });

  it("authenticated cannot execute billing_report_unit_price at all", async () => {
    await db.exec(`set role authenticated;`);
    try {
      await expect(
        db.query("select public.billing_report_unit_price($1, $2)", [NORMAL, "sms"]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("reset role");
    }
  });
});
