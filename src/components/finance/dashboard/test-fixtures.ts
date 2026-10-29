import type { FinanceKpis, PeriodSummary } from "@/lib/finance/types";

/** A zeroed PeriodSummary for the dashboard component tests. */
export function summary(overrides: Partial<PeriodSummary> = {}): PeriodSummary {
  return {
    days: 1,
    pendingDays: 0,
    pendingToday: false,
    registrations: 0,
    ftds: 0,
    ftdDepositAmount: 0,
    depositAmount: 0,
    withdrawalAmount: 0,
    adSpend: 0,
    ggr: 0,
    net: 0,
    ggrFee: 0,
    movementFee: 0,
    otherCosts: 0,
    cashResult: 0,
    roi: null,
    costPerRegistration: null,
    costPerFtd: null,
    avgDailyCashResult: null,
    betleadsUsage: 0,
    betleadsFee: null,
    ggrEstimated: false,
    ...overrides,
  };
}

/** A zeroed FinanceKpis (ratios null) for the dashboard component tests. */
export function kpis(overrides: Partial<FinanceKpis> = {}): FinanceKpis {
  return {
    depositCount: 0,
    withdrawalCount: 0,
    margin: null,
    ticketMedio: null,
    saqueMedio: null,
    depositorsPerDay: null,
    withdrawalShare: null,
    pixConversion: null,
    registrationToFtd: null,
    ftdMedio: null,
    ggrShareOfDeposits: null,
    cpm: null,
    ctr: null,
    costPerClick: null,
    sendCost: 0,
    crmDirectRevenue: 0,
    crmInfluencedRevenue: 0,
    crmDirectReturn: null,
    crmInfluencedReturn: null,
    ...overrides,
  };
}
