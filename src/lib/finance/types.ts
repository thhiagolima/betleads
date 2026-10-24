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
};

export type FinanceDay = FinanceDayInput & {
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
  pendingDays: number;
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
