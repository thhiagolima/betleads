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

// Reorganização do Início (20261225100000_inicio_kpis_reorg.sql): os campos
// novos do RPC e as contas derivadas que a tela usa.
describe("mapDashboardRpc — KPIs da reorganização do Início", () => {
  const raw = {
    depositAmount: "1000",
    previousDepositAmount: "800",
    depositCount: 20,
    depositors: 8,
    ftd: 4,
    ftdAmount: "200",
    previousFtdAmount: "100",
    ftdCohort: 4,
    ftdCohortRedeposited: 1,
    previousFtdCohort: 5,
    previousFtdCohortRedeposited: 2,
    withdrawalAmount: "400",
    previousWithdrawalAmount: "500",
    withdrawalCount: 6,
    pixGenerated: 25,
    pixUnpaidAmount: "321.5",
    smsSent: 200,
    smsClicks: 9,
  };

  it("maps FTD amount, ticket and the cohort redeposit rate (growth in p.p.)", () => {
    const r = mapDashboardRpc(raw, 7);
    expect(r.depositsPerDepositor).toBe(2.5);
    expect(r.ftdAmount).toBe(200);
    expect(r.ftdAmountGrowth).toBe(100);
    expect(r.ftdTicket).toBe(50);
    expect(r.ftdCohort).toBe(4);
    expect(r.ftdCohortRedeposited).toBe(1);
    expect(r.ftdRedepositRate).toBe(25);
    expect(r.ftdRedepositRateGrowth).toBeCloseTo(25 - 40);
  });

  it("maps withdrawals, net and the unpaid PIX amount", () => {
    const r = mapDashboardRpc(raw, 7);
    expect(r.withdrawalCount).toBe(6);
    expect(r.withdrawalGrowth).toBe(-20);
    expect(r.netAmount).toBe(600);
    expect(r.netGrowth).toBe(100); // 600 vs 300
    expect(r.pixUnpaid).toBe(5);
    expect(r.pixUnpaidAmount).toBe(321.5);
  });

  it("maps SMS clicks and CTR over sends", () => {
    const r = mapDashboardRpc(raw, 7);
    expect(r.smsClicks).toBe(9);
    expect(r.smsCtr).toBe(4.5);
  });

  it("netGrowth is null when the previous net isn't positive", () => {
    expect(mapDashboardRpc({ ...raw, previousWithdrawalAmount: "800" }, 7).netGrowth).toBeNull();
    expect(mapDashboardRpc({ ...raw, previousWithdrawalAmount: "900" }, 7).netGrowth).toBeNull();
  });

  it("is all zeros (no division by zero) on an empty payload", () => {
    const r = mapDashboardRpc({}, 7);
    expect(r.depositsPerDepositor).toBe(0);
    expect(r.ftdAmount).toBe(0);
    expect(r.ftdAmountGrowth).toBe(0);
    expect(r.ftdTicket).toBe(0);
    expect(r.ftdRedepositRate).toBe(0);
    expect(r.ftdRedepositRateGrowth).toBeNull();
    expect(r.withdrawalCount).toBe(0);
    expect(r.withdrawalGrowth).toBe(0);
    expect(r.netAmount).toBe(0);
    expect(r.netGrowth).toBeNull();
    expect(r.pixUnpaidAmount).toBe(0);
    expect(r.smsClicks).toBe(0);
    expect(r.smsCtr).toBe(0);
  });
});
