// Server-only data helpers shared by the house finance functions
// (finance.functions.ts) and the finance dashboard
// (finance-dashboard.functions.ts): the service-role client, permission
// checks, the finance_days / finance_goal_days / Betleads cost RPCs and the
// cost-month rule. Permission decisions stay in the SQL helpers
// (finance_can_*, group_ids_managed_by, is_super_admin).
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  compareRange,
  computeDay,
  evaluateGoal,
  isWholeMonth,
  presetRange,
} from "@/lib/finance/calc";
import type {
  CompareMode,
  DateRange,
  FinanceDay,
  GoalDay,
  GoalDirection,
  GoalEvaluation,
  GoalMetric,
  PeriodPreset,
  PeriodSummary,
} from "@/lib/finance/types";

type DbError = { message: string; code?: string };
type DbResult<T = unknown> = { data: T | null; error: DbError | null };
type QueryBuilder<T = unknown> = PromiseLike<DbResult<T>> & {
  select: (columns?: string) => QueryBuilder<T>;
  eq: (column: string, value: unknown) => QueryBuilder<T>;
  in: (column: string, values: unknown[]) => QueryBuilder<T>;
  not: (column: string, operator: string, value: unknown) => QueryBuilder<T>;
  order: (column: string, options?: unknown) => QueryBuilder<T>;
  maybeSingle: () => Promise<DbResult<T>>;
  single: () => Promise<DbResult<T>>;
  insert: (values: unknown) => QueryBuilder<T>;
  update: (values: unknown) => QueryBuilder<T>;
  upsert: (values: unknown, options?: unknown) => QueryBuilder<T>;
  delete: () => QueryBuilder<T>;
};
type LooseDb = {
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<DbResult<T>>;
  from: <T = unknown>(table: string) => QueryBuilder<T>;
};

export type FinanceDayRow = {
  tenant_id: string;
  metric_date: string;
  registrations: number | string | null;
  ftds: number | string | null;
  ftd_deposit_amount: number | string | null;
  deposit_amount: number | string | null;
  withdrawal_amount: number | string | null;
  ad_spend: number | string | null;
  ad_spend_suggested: number | string | null;
  ggr: number | string | null;
  ggr_fee_pct: number | string;
  movement_fee_pct: number | string;
};
export type GoalDayRow = {
  tenant_id: string;
  metric_date: string;
  metric: GoalMetric;
  direction: GoalDirection;
  daily_value: number | string;
};
export type OtherCostRow = {
  id: string;
  tenant_id: string;
  month: string;
  descricao: string;
  valor: number | string;
  categoria: string | null;
};
export type BetleadsUsageRow = { tenant_id: string; metric_date: string; amount: number | string };
export type BetleadsFeeRow = { tenant_id: string; month: string; amount: number | string };
export type BetleadsSinceRow = { tenant_id: string; since: string };

export const db = () => supabaseAdmin as unknown as LooseDb;

const MAX_RANGE_DAYS = 366;

export const GOAL_METRICS = [
  "registrations",
  "ftds",
  "deposits",
  "net",
  "cash_result",
  "cost_per_registration",
  "cost_per_ftd",
  "roi",
] as const satisfies readonly GoalMetric[];

// ─── Small helpers ──────────────────────────────────────────────────────────

export const num = (value: number | string | null | undefined) => Number(value ?? 0);
export const numOrNull = (value: number | string | null | undefined) =>
  value === null || value === undefined ? null : Number(value);

/** "YYYY-MM-DD" of today in São Paulo. */
export const todaySaoPaulo = () => presetRange("today", new Date()).from;

function isRealDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function daysInclusive(range: DateRange) {
  return (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 + 1;
}

/** The range cut at today (São Paulo); null when it starts in the future. */
export function clampToToday(range: DateRange, today: string): DateRange | null {
  if (range.from > today) return null;
  return { from: range.from, to: range.to > today ? today : range.to };
}

export const inRange = (date: string, range: DateRange | null) =>
  !!range && date >= range.from && date <= range.to;

export async function can(fn: string, userId: string, tenantId: string) {
  const { data, error } = await db().rpc<boolean>(fn, { _user: userId, _tenant: tenantId });
  if (error) throw new Error(error.message);
  return data === true;
}

export async function requirePermission(fn: string, userId: string, tenantId: string) {
  if (!(await can(fn, userId, tenantId))) throw new Error("Sem permissão");
}

export function toFinanceDay(row: FinanceDayRow): FinanceDay {
  return computeDay({
    date: row.metric_date,
    registrations: num(row.registrations),
    ftds: num(row.ftds),
    ftdDepositAmount: num(row.ftd_deposit_amount),
    depositAmount: num(row.deposit_amount),
    withdrawalAmount: num(row.withdrawal_amount),
    adSpend: numOrNull(row.ad_spend),
    adSpendSuggested: numOrNull(row.ad_spend_suggested),
    ggr: numOrNull(row.ggr),
    // Stored and consumed as percent numbers (16 = 16%), see computeDay.
    ggrFeePct: num(row.ggr_fee_pct),
    movementFeePct: num(row.movement_fee_pct),
  });
}

// ─── RPCs ───────────────────────────────────────────────────────────────────

async function rpcRows<T>(fn: string, args: Record<string, unknown>) {
  const { data, error } = await db().rpc<T[]>(fn, args);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export function fetchFinanceDays(tenantIds: string[], range: DateRange) {
  return rpcRows<FinanceDayRow>("finance_days", {
    _tenants: tenantIds,
    _from: range.from,
    _to: range.to,
  });
}

export function fetchGoalDays(tenantIds: string[], range: DateRange) {
  return rpcRows<GoalDayRow>("finance_goal_days", {
    _tenants: tenantIds,
    _from: range.from,
    _to: range.to,
  });
}

/** Wallet usage (SMS, voz, e-mail) per house and São Paulo day; a day may be negative. */
export function fetchBetleadsUsage(tenantIds: string[], range: DateRange) {
  return rpcRows<BetleadsUsageRow>("finance_betleads_usage", {
    _tenants: tenantIds,
    _from: range.from,
    _to: range.to,
  });
}

/** Plan fee per house and month ("YYYY-MM-01"), both month bounds inclusive. */
export function fetchBetleadsFees(tenantIds: string[], fromMonth: string, toMonth: string) {
  return rpcRows<BetleadsFeeRow>("finance_betleads_fees", {
    _tenants: tenantIds,
    _from_month: fromMonth,
    _to_month: toMonth,
  });
}

/** First date with Betleads data per house; a house with none has no row. */
export function fetchBetleadsSince(tenantIds: string[]) {
  return rpcRows<BetleadsSinceRow>("finance_betleads_since", { _tenants: tenantIds });
}

// ─── Goals ──────────────────────────────────────────────────────────────────

/**
 * One evaluation per metric with a goal, over exactly the goal days inside
 * `range` (evaluateGoal sums every goal day it is given).
 */
export function evaluateGoals(
  goalRows: GoalDayRow[],
  summary: PeriodSummary,
  range: DateRange,
  today: string,
): GoalEvaluation[] {
  const byMetric = new Map<GoalMetric, GoalDay[]>();
  for (const row of goalRows) {
    if (!inRange(row.metric_date, range)) continue;
    const list = byMetric.get(row.metric) ?? [];
    list.push({
      date: row.metric_date,
      metric: row.metric,
      direction: row.direction,
      dailyValue: num(row.daily_value),
    });
    byMetric.set(row.metric, list);
  }
  return GOAL_METRICS.map((metric) => {
    const goalDays = byMetric.get(metric);
    return goalDays ? evaluateGoal(goalDays, summary, range, today) : null;
  }).filter((goal): goal is GoalEvaluation => goal !== null);
}

// ─── Cost months ────────────────────────────────────────────────────────────

/**
 * The month ("YYYY-MM-01") whose other costs and plan fee enter each window,
 * or null when that window is not a closed month.
 */
export function costMonthsFor(
  range: DateRange,
  compare: CompareMode,
  preset: PeriodPreset,
): { current: string | null; previous: string | null } {
  const previousRange = compareRange(range, compare, preset);
  // Spec §5: other costs enter a window's result only for a closed calendar
  // month: a range covering exactly one month, or the "Mês" preset (also
  // while in progress). The preset is only trusted when the range really is
  // a month-to-date window, and its comparison window counts only for
  // "previous" (the previous month to the same day), never a 7-day shift.
  const monthToDate =
    preset === "month" &&
    range.from.endsWith("-01") &&
    range.to.slice(0, 7) === range.from.slice(0, 7);
  const monthOf = (window: DateRange) => `${window.from.slice(0, 7)}-01`;
  return {
    current: monthToDate || isWholeMonth(range) ? monthOf(range) : null,
    previous:
      (monthToDate && compare === "previous") || isWholeMonth(previousRange)
        ? monthOf(previousRange)
        : null,
  };
}

// ─── Input schemas ──────────────────────────────────────────────────────────

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida")
  .refine(isRealDate, "Data inválida");

export const dateRange = z
  .object({ from: isoDate, to: isoDate })
  .refine((range) => range.from <= range.to, "Período inválido")
  .refine((range) => daysInclusive(range) <= MAX_RANGE_DAYS, "Período longo demais");

export const compareMode = z.enum(["previous", "same_weekday_last_week", "last_week"]);
export const periodPreset = z.enum(["today", "yesterday", "7d", "month", "custom"]);
