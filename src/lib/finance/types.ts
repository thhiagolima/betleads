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
  /** Anúncios or GGR missing; the results below still count them as 0. */
  pending: boolean;
  net: number;
  ggrFee: number;
  movementFee: number;
  cashResult: number;
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
  /** Other costs dated inside the window (0 when none). */
  otherCosts: number;
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
  "ad_spend" | "ggr_fee" | "movement_fee" | "sends" | "fee" | `category:${string}`;

export type CostLine = {
  key: CostLineKey;
  label: string;
  amount: number;
  previous: number | null;
  auto: boolean;
};

export type SendItem = "sms" | "voice_30s" | "email";

export type SendUsage = {
  item: SendItem;
  units: number;
  amount: number;
  missingCostUnits: number;
};

export type DayActivity = {
  depositCount: number;
  depositorCount: number;
  withdrawalCount: number;
  generatedPixCount: number;
  crmSent: number;
  crmClicks: number;
  crmDirectConversions: number;
  crmDirectRevenue: number;
  crmInfluencedRevenue: number;
  adImpressions: number;
  adClicks: number;
};

export type SendLine = {
  item: SendItem;
  label: string;
  unitLabel: string;
  units: number;
  amount: number;
  unitCost: number | null;
  previousAmount: number | null;
  missingCost: boolean;
};

export type FinanceKpis = {
  depositCount: number; // Σ DayActivity.depositCount
  withdrawalCount: number; // Σ DayActivity.withdrawalCount
  margin: number | null; // cashResult / net
  ticketMedio: number | null; // depositAmount / depositCount
  saqueMedio: number | null; // withdrawalAmount / withdrawalCount
  depositorsPerDay: number | null; // Σ depositorCount / days
  withdrawalShare: number | null; // withdrawalAmount / depositAmount
  pixConversion: number | null; // depositCount / generatedPixCount
  registrationToFtd: number | null; // ftds / registrations
  ftdMedio: number | null; // ftdDepositAmount / ftds
  ggrShareOfDeposits: number | null; // ggr / depositAmount
  cpm: number | null;
  ctr: number | null;
  costPerClick: number | null; // only when adImpressions > 0, else null
  sendCost: number; // Σ SendUsage.amount
  crmDirectRevenue: number;
  crmInfluencedRevenue: number;
  crmDirectReturn: number | null; // crmDirectRevenue / sendCost
  crmInfluencedReturn: number | null; // crmInfluencedRevenue / sendCost
};

export type WaterfallStep = {
  key: string;
  label: string;
  kind: "start" | "down" | "up" | "subtotal" | "total";
  start: number;
  end: number;
};

/** One point of the monthly cashResult series (filled by a server function in a later task). */
export type MonthPoint = {
  month: string; // "YYYY-MM"
  cashResult: number;
  adSpend: number;
  net: number; // depósitos − saques
  depositAmount: number;
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
