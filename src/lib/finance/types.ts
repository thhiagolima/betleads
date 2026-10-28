export type GoalMetric =
  | "registrations"
  | "ftds"
  | "deposits"
  | "net"
  | "cash_result"
  | "cost_per_registration"
  | "cost_per_ftd"
  | "roi";

export type GoalDirection = "gte" | "lte";

export type GoalStatus = "green" | "yellow" | "red" | "gray";

export type FinanceDayInput = {
  date: string;
  registrations: number;
  ftds: number;
  ftdDepositAmount: number;
  depositAmount: number;
  withdrawalAmount: number;
  adSpend: number | null;
  adSpendSuggested: number | null;
  ggr: number | null;
  ggrFeePct: number;
  movementFeePct: number;
  /** True when `ggr` was allocated from the month's accumulated total (allocateMonthlyGgr); absent = false. */
  ggrEstimated?: boolean;
};

/** A house's accumulated GGR ("Perdas na casa") for one month, valid up to `validThrough`. */
export type MonthlyGgr = { month: string /* "YYYY-MM-01" */; ggr: number; validThrough: string };

export type FinanceDay = FinanceDayInput & {
  ggrEstimated: boolean;
  pending: boolean;
  net: number | null;
  ggrFee: number | null;
  movementFee: number | null;
  cashResult: number | null;
  roi: number | null;
  costPerRegistration: number | null;
  costPerFtd: number | null;
};

export type PeriodSummary = {
  days: number;
  /** Distinct pending dates, not counting today (expected to be incomplete). */
  pendingDays: number;
  /** True when today ("today" passed to summarize) has a pending house-day. */
  pendingToday: boolean;
  registrations: number;
  ftds: number;
  ftdDepositAmount: number;
  depositAmount: number;
  withdrawalAmount: number;
  adSpend: number;
  ggr: number;
  net: number;
  ggrFee: number;
  movementFee: number;
  otherCosts: number | null;
  cashResult: number;
  roi: number | null;
  costPerRegistration: number | null;
  costPerFtd: number | null;
  avgDailyCashResult: number | null;
  /** Sum of wallet usage (SMS, voz, e-mail...) for the window; 0 when not given. */
  betleadsUsage: number;
  /** Plan fee for the window's closed month; null when the window is not a closed month. */
  betleadsFee: number | null;
  /**
   * True when the window holds some but not all of the days a monthly GGR
   * total was allocated to (its GGR is an estimate); see hasPartialGgrEstimate.
   */
  ggrEstimated: boolean;
};

/** The Betleads cost for a window, passed into summarize() by the caller. */
export type BetleadsCost = { usage: number; fee: number | null };

/** A row of the cost breakdown shown next to the period summary. */
export type CostLineKey =
  "ad_spend" | "ggr_fee" | "movement_fee" | "betleads" | `category:${string}`;

export type CostLine = {
  key: CostLineKey;
  label: string;
  amount: number;
  previous: number | null;
  auto: boolean;
};

/** One point of the monthly cashResult series (filled by a server function in a later task). */
export type MonthPoint = {
  month: string; // "YYYY-MM"
  cashResult: number;
  adSpend: number;
  roi: number | null;
  incomplete: boolean; // pendingDays > 0 or pendingToday
  inProgress: boolean; // the current month
  betleadsMissing: boolean;
  byTenant: Record<string, number>; // tenantId -> cashResult
};

export type GoalDay = {
  date: string;
  metric: GoalMetric;
  direction: GoalDirection;
  dailyValue: number;
};

export type GoalEvaluation = {
  metric: GoalMetric;
  direction: GoalDirection;
  target: number;
  value: number | null;
  status: GoalStatus;
};

/** "YYYY-MM-DD", inclusivo em ambas as pontas. */
export type DateRange = { from: string; to: string };

export type PeriodPreset = "today" | "yesterday" | "7d" | "month" | "custom";

export type CompareMode = "previous" | "same_weekday_last_week" | "last_week";
