// PG1 final review, item 1 — dashboard_summary_v2 stopped returning the
// legacy credit balance (tenant_sms_credit_balances) and now returns the
// wallet balance + exempt flag, plus smsSent/messageCost straight from
// crm_results_daily. A full PGlite test of dashboard_summary_v2 itself isn't
// practical here: the function reads a dozen+ production tables (deposits,
// withdrawals, players, journeys, journey_enrollments, click_events, events,
// conversion_attributions, tenant_daily_metrics, crm_results_daily,
// tenant_wallets, billing_plans/billing_price_book via billing_tenant_exempt)
// that would need a much larger stub schema/seed than the existing
// billing-db-test-support.ts provides for Tasks 2/3. Instead, this is a TS
// test of the consumer mapping (mapDashboardRpc, extracted from the
// createServerFn handler precisely so it's testable this way): given a raw
// RPC payload, does it map walletBalance/exempt/messageCost correctly and
// never fall back to a computed cost (the old `smsSent * price` fallback,
// which depended on the legacy ledger/flat price, is gone).

import { describe, expect, it } from "vitest";

import { mapDashboardRpc } from "./dashboard.functions";

describe("mapDashboardRpc", () => {
  it("maps the wallet balance and exempt flag for a normal house", () => {
    const result = mapDashboardRpc(
      {
        smsSent: 120,
        messageCost: 9.6,
        walletBalance: 84.32,
        exempt: false,
      },
      7,
    );
    expect(result.smsSent).toBe(120);
    expect(result.messageCost).toBe(9.6);
    expect(result.walletBalance).toBe(84.32);
    expect(result.exempt).toBe(false);
    expect(result.messageRoi).toBe(0);
  });

  it("maps an exempt (interno/demo) house with a zero balance and zero cost", () => {
    const result = mapDashboardRpc(
      {
        smsSent: 40,
        messageCost: 0,
        walletBalance: 0,
        exempt: true,
      },
      7,
    );
    expect(result.smsSent).toBe(40);
    expect(result.messageCost).toBe(0);
    expect(result.walletBalance).toBe(0);
    expect(result.exempt).toBe(true);
  });

  it("never falls back to smsSent x a computed price: messageCost is read as-is from the RPC, including 0", () => {
    const result = mapDashboardRpc({ smsSent: 50, messageCost: 0, walletBalance: 10 }, 7);
    expect(result.messageCost).toBe(0);
  });

  it("treats a missing/non-true exempt as false, and missing walletBalance as 0", () => {
    const result = mapDashboardRpc({}, 7);
    expect(result.exempt).toBe(false);
    expect(result.walletBalance).toBe(0);
  });

  it("computes messageRoi from recoveredAmount / messageCost when cost is positive", () => {
    const result = mapDashboardRpc({ recoveredAmount: 200, messageCost: 10 }, 7);
    expect(result.messageRoi).toBe(20);
  });
});
