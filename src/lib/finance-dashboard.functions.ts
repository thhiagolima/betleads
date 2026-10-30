// Financeiro — painel de resultado: one dashboard for a house, a group or
// every house (super admin). Spec:
// docs/superpowers/specs/2026-10-27-financeiro-painel-design.md (§3–§8).
//
// Permissions are unchanged and decided by SQL helpers: tenant scope →
// finance_can_view; group scope → group_ids_managed_by (super admin: any
// group); all scope → is_super_admin. Totals are summarize() over every
// house's days, so ratios (ROI, cost per unit) come from the sums, never from
// averaging houses.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  compareRange,
  costBreakdown,
  hasPartialGgrEstimate,
  monthlyGgrPendingThrough,
  round2,
  summarize,
} from "@/lib/finance/calc";
import { categoryKey, categoryLabel, looksLikeBetleadsCost } from "@/lib/finance/categories";
import {
  computeKpis,
  hasMissingSendCost,
  marginOf,
  sendLines,
  sumActivity,
  waterfallSteps,
} from "@/lib/finance/kpis";
import {
  OTHER_COST_COLUMNS,
  clampToToday,
  compareMode,
  costMonthsFor,
  dateRange,
  db,
  evaluateGoals,
  fetchBetleadsFees,
  fetchBetleadsSince,
  fetchActivityDays,
  fetchSendUsage,
  fetchTenantsExempt,
  fetchFinanceDays,
  fetchGoalDays,
  fetchMonthlyGgr,
  financeDaysWithMonthlyGgr,
  inRange,
  num,
  periodPreset,
  requirePermission,
  sendUsageTotal,
  sumSendUsage,
  todaySaoPaulo,
  toDayActivity,
  toMonthlyGgr,
  type ActivityDayRow,
  type GoalDayRow,
  type OtherCostRow,
  type SendUsageRow,
} from "@/lib/finance/finance-data.server";
import type {
  CompareMode,
  CostLine,
  DateRange,
  FinanceDay,
  FinanceKpis,
  GoalEvaluation,
  MonthlyGgr,
  MonthPoint,
  PeriodPreset,
  PeriodSummary,
  SendLine,
  WaterfallStep,
} from "@/lib/finance/types";
import { managedGroupIds } from "@/lib/tenants.functions";
import { dbUuid } from "@/lib/zod-helpers";

type ServerContext = { userId: string };
type TenantLite = { id: string; nome: string };

export type DashboardScope =
  { kind: "tenant"; tenantId: string } | { kind: "group"; groupId: string } | { kind: "all" };

export type DashboardInput = {
  scope: DashboardScope;
  range: DateRange;
  compare: CompareMode;
  preset: PeriodPreset;
};

export type DashboardTenantRow = {
  id: string;
  nome: string;
  current: PeriodSummary;
  previous: PeriodSummary;
  goals: GoalEvaluation[];
  /** The house is exempt now: its Betleads cost is the provider cost of its sends. */
  exempt: boolean;
  /** Past dates in the current window missing GGR or Anúncios (today left out). */
  pendingDates: string[];
  /**
   * When every pending date comes after the "atualizado até" of its month's
   * GGR do mês, that date (the pending banner asks to update it); else null.
   */
  ggrUpdatedThrough: string | null;
  /** Lucro líquido ÷ net of the current window; null when net is 0 or negative. */
  margin: number | null;
  /** Envios of the current window (= current.betleadsUsage). */
  sendCost: number;
};

export type FinanceDashboard = {
  scope: DashboardScope;
  /** House name, group name or "Todas as casas". */
  label: string;
  range: DateRange;
  /** The comparison window; null for "Sem comparação" (previous values are then empty). */
  compareRange: DateRange | null;
  totals: { current: PeriodSummary; previous: PeriodSummary };
  costs: CostLine[];
  /** 12 points, oldest first, ending at the month of range.to; empty for a scope with no house. */
  months: MonthPoint[];
  /** One row per house (one row for tenant scope), sorted by name. */
  tenants: DashboardTenantRow[];
  /** Earliest Betleads data date across the scope; null when none. */
  betleadsSince: string | null;
  /** Other costs of the current cost month that look like a Betleads charge, from the house's since month on. */
  duplicateBetleadsCosts: number;
  /** One line per channel of the current window, with the comparison window's amount. */
  sends: SendLine[];
  kpis: { current: FinanceKpis; previous: FinanceKpis };
  /** Depósitos down to Lucro líquido for the current window; ends at totals.current.cashResult. */
  waterfall: WaterfallStep[];
  /**
   * ROI of the calendar month before range.to's month (spec §4.5), cut at the
   * same day while range.to's month is in progress.
   */
  roiReference: { roi: number | null; range: DateRange };
  /** Tenant scope of a house that is exempt now; false for group and all scopes. */
  exemptHouse: boolean;
};

const ALL_LABEL = "Todas as casas";
const MONTHS_IN_SERIES = 12;

const byNome = <T extends { nome: string }>(a: T, b: T) => a.nome.localeCompare(b.nome, "pt-BR");

/** "YYYY-MM-01" shifted by `delta` months. */
function addMonths(monthStart: string, delta: number) {
  const [y, m] = monthStart.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 10);
}

function lastDayOfMonth(monthStart: string) {
  const [y, m] = monthStart.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

const monthStartOf = (date: string) => `${date.slice(0, 7)}-01`;

/** The smallest range covering every given range; null when none. */
function spanOf(ranges: Array<DateRange | null>): DateRange | null {
  const present = ranges.filter((range): range is DateRange => range !== null);
  if (!present.length) return null;
  return {
    from: present.map((range) => range.from).sort()[0],
    to: present
      .map((range) => range.to)
      .sort()
      .at(-1) as string,
  };
}

async function isSuperAdmin(userId: string) {
  const { data, error } = await db().rpc<boolean>("is_super_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  return data === true;
}

async function requireSuperAdmin(userId: string) {
  if (!(await isSuperAdmin(userId))) throw new Error("Sem permissão");
}

async function selectTenants(ids: string[]): Promise<TenantLite[]> {
  if (!ids.length) return [];
  const { data, error } = await db().from<TenantLite[]>("tenants").select("id,nome").in("id", ids);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({ id: row.id, nome: row.nome }));
}

/** "Todas as casas": active houses, demo left out (spec §6). */
async function activeRealTenants(): Promise<TenantLite[]> {
  const { data, error } = await db()
    .from<Array<TenantLite & { is_demo: boolean | null }>>("tenants")
    .select("id,nome,is_demo")
    .eq("status", "active");
  if (error) throw new Error(error.message);
  return (data ?? [])
    .filter((row) => row.is_demo !== true)
    .map((row) => ({ id: row.id, nome: row.nome }));
}

/** The scope's label and houses, after checking the caller may see it. */
async function resolveScope(
  userId: string,
  scope: DashboardScope,
): Promise<{ label: string; tenants: TenantLite[] }> {
  if (scope.kind === "tenant") {
    await requirePermission("finance_can_view", userId, scope.tenantId);
    const tenants = await selectTenants([scope.tenantId]);
    if (!tenants.length) throw new Error("Casa não encontrada");
    return { label: tenants[0].nome, tenants };
  }

  if (scope.kind === "group") {
    const managed = await managedGroupIds(userId);
    if (!managed.includes(scope.groupId)) throw new Error("Sem permissão");

    const { data: group, error: groupErr } = await db()
      .from<TenantLite>("tenant_groups")
      .select("id,nome")
      .eq("id", scope.groupId)
      .maybeSingle();
    if (groupErr) throw new Error(groupErr.message);
    if (!group) throw new Error("Grupo não encontrado");

    const { data: links, error: linksErr } = await db()
      .from<Array<{ tenant_id: string }>>("tenant_group_tenants")
      .select("tenant_id")
      .eq("group_id", scope.groupId);
    if (linksErr) throw new Error(linksErr.message);
    const tenants = await selectTenants((links ?? []).map((link) => link.tenant_id));
    return { label: group.nome, tenants };
  }

  await requireSuperAdmin(userId);
  return { label: ALL_LABEL, tenants: await activeRealTenants() };
}

const OTHER_COSTS_PAGE = 1000;

/**
 * Other costs of the given houses dated inside `span`, oldest entry first.
 * Paged, since PostgREST returns at most 1000 rows per request without an
 * error.
 */
async function fetchOtherCosts(tenantIds: string[], span: DateRange | null) {
  if (!tenantIds.length || !span) return [];
  const rows: OtherCostRow[] = [];
  for (let offset = 0; ; offset += OTHER_COSTS_PAGE) {
    const { data, error } = await db()
      .from<OtherCostRow[]>("tenant_finance_other_costs")
      .select(OTHER_COST_COLUMNS)
      .in("tenant_id", tenantIds)
      .gte("cost_date", span.from)
      .lte("cost_date", span.to)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + OTHER_COSTS_PAGE - 1);
    if (error) throw new Error(error.message);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < OTHER_COSTS_PAGE) return rows;
  }
}

/** Calendar days of a window; 0 for none. */
const daysOf = (window: DateRange | null) =>
  window ? (Date.parse(window.to) - Date.parse(window.from)) / 86_400_000 + 1 : 0;

/** "YYYY-MM-01" of every month the window touches, oldest first. */
function monthsOfWindow(window: DateRange): string[] {
  const months: string[] = [];
  const last = monthStartOf(window.to);
  for (let month = monthStartOf(window.from); month <= last; month = addMonths(month, 1)) {
    months.push(month);
  }
  return months;
}

const ALL_TENANTS = "*";
const bucketKey = (tenantId: string, month: string) => `${tenantId}|${month}`;

/** Pushes `item` under its house and month, and under every house (ALL_TENANTS) of that month. */
function addToBuckets<T>(buckets: Map<string, T[]>, tenantId: string, month: string, item: T) {
  for (const key of [bucketKey(tenantId, month), bucketKey(ALL_TENANTS, month)]) {
    const list = buckets.get(key);
    if (list) list.push(item);
    else buckets.set(key, [item]);
  }
}

/** Adds `amount` under its house and month, and under every house (ALL_TENANTS) of that month. */
function addToSums(sums: Map<string, number>, tenantId: string, month: string, amount: number) {
  for (const key of [bucketKey(tenantId, month), bucketKey(ALL_TENANTS, month)]) {
    sums.set(key, (sums.get(key) ?? 0) + amount);
  }
}

/**
 * Dashboard of a house, a group or every house. One call per data source
 * (finance_days, goals, other costs, Betleads usage, fees, since) covers the
 * current and comparison windows and the 12-month series; days after today
 * are left out. Other costs enter any window that contains their cost_date;
 * the plan fee only a closed month (costMonthsFor); Betleads usage enters any
 * window, per day.
 */
export async function getFinanceDashboardFor(
  ctx: ServerContext,
  data: DashboardInput,
): Promise<FinanceDashboard> {
  const { label, tenants: unsorted } = await resolveScope(ctx.userId, data.scope);
  const tenants = [...unsorted].sort(byNome);
  const tenantIds = tenants.map((tenant) => tenant.id);

  const today = todaySaoPaulo();
  const previousRange = compareRange(data.range, data.compare, data.preset);
  const current = clampToToday(data.range, today);
  // "none": no comparison window, so every previous summary is empty (no days).
  const previous = previousRange ? clampToToday(previousRange, today) : null;
  const feeMonths = costMonthsFor(data.range, data.compare, data.preset);

  const lastMonth = monthStartOf(data.range.to);
  const seriesMonths = tenantIds.length
    ? Array.from({ length: MONTHS_IN_SERIES }, (_, index) =>
        addMonths(lastMonth, index - (MONTHS_IN_SERIES - 1)),
      )
    : [];
  const monthWindow = (month: string) =>
    clampToToday({ from: month, to: lastDayOfMonth(month) }, today);
  const seriesSpan = seriesMonths.length
    ? clampToToday({ from: seriesMonths[0], to: lastDayOfMonth(lastMonth) }, today)
    : null;

  // ROI reference (spec §4.5): the month before range.to's, compared like the
  // "Mês" preset (cut at the same day while range.to's month is in progress).
  // It lies inside the 12-month series, so the series' data covers it.
  const referenceMonth = { from: lastMonth, to: lastDayOfMonth(lastMonth) };
  const roiReferenceRange = compareRange(
    clampToToday(referenceMonth, today) ?? referenceMonth,
    "previous",
    "month",
  );

  const span = tenantIds.length ? spanOf([current, previous, seriesSpan]) : null;
  const activitySpan = tenantIds.length ? spanOf([current, previous]) : null;
  const allFeeMonths = tenantIds.length
    ? [
        ...new Set(
          [...seriesMonths, feeMonths.current, feeMonths.previous].filter(
            (month): month is string => month !== null,
          ),
        ),
      ].sort()
    : [];

  const [
    dayRows,
    goalRows,
    costRows,
    sendRows,
    activityRows,
    feeRows,
    sinceRows,
    monthlyRows,
    exemptByTenant,
  ] = await Promise.all([
    span ? fetchFinanceDays(tenantIds, span) : Promise.resolve([]),
    current && tenantIds.length ? fetchGoalDays(tenantIds, current) : Promise.resolve([]),
    fetchOtherCosts(tenantIds, span),
    span ? fetchSendUsage(tenantIds, span) : Promise.resolve([]),
    activitySpan ? fetchActivityDays(tenantIds, activitySpan) : Promise.resolve([]),
    allFeeMonths.length
      ? fetchBetleadsFees(tenantIds, allFeeMonths[0], allFeeMonths.at(-1) as string)
      : Promise.resolve([]),
    tenantIds.length ? fetchBetleadsSince(tenantIds) : Promise.resolve([]),
    span
      ? fetchMonthlyGgr(tenantIds, monthStartOf(span.from), monthStartOf(span.to))
      : Promise.resolve([]),
    tenantIds.length ? fetchTenantsExempt(tenantIds) : Promise.resolve(new Map<string, boolean>()),
  ]);

  // A monthly GGR total is split over its month's days from the 1st, so when
  // the span starts mid-month the houses with a total for that month also
  // need the days before span.from (only for the allocation: windows never
  // reach them).
  const firstMonth = span ? monthStartOf(span.from) : null;
  const partialMonthTenants =
    span && firstMonth !== span.from
      ? monthlyRows.filter((row) => row.month === firstMonth).map((row) => row.tenant_id)
      : [];
  const leadingDayRows =
    span && firstMonth && partialMonthTenants.length
      ? await fetchFinanceDays(partialMonthTenants, {
          from: firstMonth,
          to: new Date(Date.parse(`${span.from}T00:00:00Z`) - 86_400_000)
            .toISOString()
            .slice(0, 10),
        })
      : [];

  const allocationsByTenant = new Map<string, MonthlyGgr[]>();
  for (const row of monthlyRows) {
    const list = allocationsByTenant.get(row.tenant_id) ?? [];
    list.push(toMonthlyGgr(row));
    allocationsByTenant.set(row.tenant_id, list);
  }
  const allAllocations = monthlyRows.map(toMonthlyGgr);

  // Days, usage, other costs and fees are indexed once by house and month
  // (and by month for every house), so each window reads only its months.
  const allDays: FinanceDay[] = [];
  const dayBuckets = new Map<string, FinanceDay[]>();
  for (const { tenantId, day } of financeDaysWithMonthlyGgr(
    [...leadingDayRows, ...dayRows],
    monthlyRows,
  )) {
    allDays.push(day);
    addToBuckets(dayBuckets, tenantId, monthStartOf(day.date), day);
  }
  const sendBuckets = new Map<string, SendUsageRow[]>();
  for (const row of sendRows) {
    addToBuckets(sendBuckets, row.tenant_id, monthStartOf(row.metric_date), row);
  }
  const activityBuckets = new Map<string, ActivityDayRow[]>();
  for (const row of activityRows) {
    addToBuckets(activityBuckets, row.tenant_id, monthStartOf(row.metric_date), row);
  }
  const costBuckets = new Map<string, OtherCostRow[]>();
  for (const row of costRows) {
    addToBuckets(costBuckets, row.tenant_id, monthStartOf(row.cost_date), row);
  }
  const feeSums = new Map<string, number>();
  for (const row of feeRows) addToSums(feeSums, row.tenant_id, row.month, num(row.amount));
  const goalRowsByTenant = new Map<string, GoalDayRow[]>();
  for (const row of goalRows) {
    const list = goalRowsByTenant.get(row.tenant_id);
    if (list) list.push(row);
    else goalRowsByTenant.set(row.tenant_id, [row]);
  }

  /** The window's entries of one house, or of every house when `tenantId` is omitted. */
  const inWindow = <T>(
    buckets: Map<string, T[]>,
    window: DateRange | null,
    dateOf: (item: T) => string,
    tenantId?: string,
  ): T[] =>
    window
      ? monthsOfWindow(window).flatMap((month) =>
          (buckets.get(bucketKey(tenantId ?? ALL_TENANTS, month)) ?? []).filter((item) =>
            inRange(dateOf(item), window),
          ),
        )
      : [];
  const windowDays = (window: DateRange | null, tenantId?: string): FinanceDay[] =>
    inWindow(dayBuckets, window, (day) => day.date, tenantId).sort((a, b) =>
      a.date.localeCompare(b.date),
    );
  const monthSum = (sums: Map<string, number>, month: string | null, tenantId?: string) =>
    month === null ? null : round2(sums.get(bucketKey(tenantId ?? ALL_TENANTS, month)) ?? 0);
  /** The window's other costs (dated inside it), oldest entry first. */
  const costsIn = (window: DateRange | null, tenantId?: string) =>
    inWindow(costBuckets, window, (row) => row.cost_date, tenantId);
  const otherCostsFor = (window: DateRange | null, tenantId?: string) =>
    round2(costsIn(window, tenantId).reduce((total, row) => total + num(row.valor), 0));
  /** The window's sends summed per channel (the month view sums them the same way). */
  const sendsFor = (window: DateRange | null, tenantId?: string) =>
    sumSendUsage(inWindow(sendBuckets, window, (row) => row.metric_date, tenantId));
  const usageFor = (window: DateRange | null, tenantId?: string) =>
    sendUsageTotal(sendsFor(window, tenantId));
  const activityFor = (window: DateRange | null) =>
    sumActivity(inWindow(activityBuckets, window, (row) => row.metric_date).map(toDayActivity));
  /** Σ Meta spend (adSpendSuggested) of the scope's days in the window: CPM / CPC divide it. */
  const metaSpendFor = (window: DateRange | null) =>
    round2(windowDays(window).reduce((total, day) => total + (day.adSpendSuggested ?? 0), 0));
  const feeFor = (month: string | null, tenantId?: string) => monthSum(feeSums, month, tenantId);
  const allocationsOf = (tenantId?: string) =>
    tenantId === undefined ? allAllocations : (allocationsByTenant.get(tenantId) ?? []);
  const summarizeWindow = (window: DateRange | null, feeMonth: string | null, tenantId?: string) =>
    summarize(
      windowDays(window, tenantId),
      otherCostsFor(window, tenantId),
      today,
      { usage: usageFor(window, tenantId), fee: feeFor(feeMonth, tenantId) },
      { ggrEstimated: hasPartialGgrEstimate(window, allocationsOf(tenantId)) },
    );

  const rows: DashboardTenantRow[] = tenants.map((tenant) => {
    const currentSummary = summarizeWindow(current, feeMonths.current, tenant.id);
    const pendingDays = windowDays(current, tenant.id).filter(
      (day) => day.pending && day.date < today,
    );
    const pendingDates = [...new Set(pendingDays.map((day) => day.date))];
    return {
      id: tenant.id,
      nome: tenant.nome,
      current: currentSummary,
      previous: summarizeWindow(previous, feeMonths.previous, tenant.id),
      goals: current
        ? evaluateGoals(goalRowsByTenant.get(tenant.id) ?? [], currentSummary, current)
        : [],
      exempt: exemptByTenant.get(tenant.id) ?? false,
      pendingDates,
      ggrUpdatedThrough: monthlyGgrPendingThrough(pendingDays, allocationsOf(tenant.id)),
      margin: marginOf(currentSummary.cashResult, currentSummary.net),
      sendCost: currentSummary.betleadsUsage,
    };
  });

  const totals = {
    current: summarizeWindow(current, feeMonths.current),
    previous: summarizeWindow(previous, feeMonths.previous),
  };

  const sinceByTenant = new Map(sinceRows.map((row) => [row.tenant_id, row.since]));
  const betleadsSince = sinceRows.map((row) => row.since).sort()[0] ?? null;

  const todayMonth = monthStartOf(today);
  const months: MonthPoint[] = seriesMonths.map((month) => {
    const window = monthWindow(month);
    const summary = summarizeWindow(window, month);
    return {
      month: month.slice(0, 7),
      cashResult: summary.cashResult,
      adSpend: summary.adSpend,
      net: summary.net,
      depositAmount: summary.depositAmount,
      roi: summary.roi,
      incomplete: summary.pendingDays > 0 || summary.pendingToday,
      inProgress: month === todayMonth,
      betleadsMissing: betleadsSince === null || month < monthStartOf(betleadsSince),
      byTenant: Object.fromEntries(
        tenants.map((tenant) => [tenant.id, summarizeWindow(window, month, tenant.id).cashResult]),
      ),
    };
  });

  // Categories merge by name across houses (spec §6); the first label seen
  // (current month first, oldest entry first) is the one displayed.
  const labels = new Map<string, string>();
  const categoryOf = (row: OtherCostRow) => {
    const label = categoryLabel(row.categoria);
    const key = categoryKey(label);
    if (!labels.has(key)) labels.set(key, label);
    return labels.get(key) as string;
  };
  const categoriesFor = (window: DateRange) => {
    const totalsByLabel: Record<string, number> = {};
    for (const row of costsIn(window)) {
      const label = categoryOf(row);
      totalsByLabel[label] = round2((totalsByLabel[label] ?? 0) + num(row.valor));
    }
    return totalsByLabel;
  };
  const currentCategories = current ? categoriesFor(current) : {};
  // The waterfall's categories: exactly the scope's other costs that entered
  // totals.current (costRows only hold the scope's houses).
  const waterfall = waterfallSteps(
    totals.current,
    totals.current.betleadsUsage,
    { ...currentCategories },
    { sendCostIncomplete: hasMissingSendCost(sendsFor(current)) },
  );
  const previousCategories = previous ? categoriesFor(previous) : null;
  // A category that dropped to zero this window still shows, with its
  // variation: the current window lists the union of both windows' categories.
  if (current && previousCategories) {
    for (const label of Object.keys(previousCategories)) currentCategories[label] ??= 0;
  }

  // Tenant scope labels the GGR fee with the house's rate on range.to (or
  // the last day shown, when range.to is after today).
  const rateDay =
    data.scope.kind === "tenant" && current
      ? allDays.find((day) => day.date === current.to)
      : undefined;
  const ggrFeePct = rateDay ? rateDay.ggrFeePct : null;

  const costs = tenantIds.length
    ? costBreakdown(
        totals.current,
        totals.previous,
        currentCategories,
        previousCategories,
        ggrFeePct,
      )
    : [];

  // Spec §7.3: a manual cost that looks like a Betleads charge is flagged only
  // from the month the house has Betleads data on; before it, it is the only data.
  const duplicateBetleadsCosts = costsIn(current).filter((row) => {
    const since = sinceByTenant.get(row.tenant_id);
    return (
      since !== undefined &&
      row.month >= monthStartOf(since) &&
      looksLikeBetleadsCost(row.descricao, row.categoria)
    );
  }).length;

  return {
    scope: data.scope,
    label,
    range: data.range,
    compareRange: previousRange,
    totals,
    costs,
    months,
    tenants: rows,
    betleadsSince,
    duplicateBetleadsCosts,
    sends: sendLines(sendsFor(current), previous ? sendsFor(previous) : null),
    kpis: {
      current: computeKpis(
        totals.current,
        activityFor(current),
        sendsFor(current),
        daysOf(current),
        metaSpendFor(current),
      ),
      previous: computeKpis(
        totals.previous,
        activityFor(previous),
        sendsFor(previous),
        daysOf(previous),
        metaSpendFor(previous),
      ),
    },
    waterfall,
    roiReference: {
      roi: summarizeWindow(
        clampToToday(roiReferenceRange, today),
        monthStartOf(roiReferenceRange.from),
      ).roi,
      range: roiReferenceRange,
    },
    exemptHouse: data.scope.kind === "tenant" && (exemptByTenant.get(data.scope.tenantId) ?? false),
  };
}

const dashboardInput = z.object({
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("tenant"), tenantId: dbUuid() }),
    z.object({ kind: z.literal("group"), groupId: dbUuid() }),
    z.object({ kind: z.literal("all") }),
  ]),
  range: dateRange,
  compare: compareMode,
  preset: periodPreset,
});

export const getFinanceDashboard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => dashboardInput.parse(data))
  .handler(async ({ data, context }) =>
    getFinanceDashboardFor(context as unknown as ServerContext, data),
  );

/**
 * Options of the super admin's "Ver:" picker: every group and the houses of
 * "Todas as casas" (active, demo left out), each sorted by name.
 */
export async function listDashboardScopesFor(
  ctx: ServerContext,
): Promise<{ groups: TenantLite[]; tenants: TenantLite[] }> {
  await requireSuperAdmin(ctx.userId);
  const [groupsRes, tenants] = await Promise.all([
    db().from<TenantLite[]>("tenant_groups").select("id,nome"),
    activeRealTenants(),
  ]);
  if (groupsRes.error) throw new Error(groupsRes.error.message);
  return {
    groups: (groupsRes.data ?? []).map((row) => ({ id: row.id, nome: row.nome })).sort(byNome),
    tenants: tenants.sort(byNome),
  };
}

export const listDashboardScopes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => listDashboardScopesFor(context as unknown as ServerContext));
