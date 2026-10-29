import type { PeriodSummary } from "@/lib/finance/types";

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
