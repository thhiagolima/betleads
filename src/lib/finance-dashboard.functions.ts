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
import { compareRange, costBreakdown, round2, summarize } from "@/lib/finance/calc";
import { categoryKey, categoryLabel, looksLikeBetleadsCost } from "@/lib/finance/categories";
import {
  clampToToday,
  compareMode,
  costMonthsFor,
  dateRange,
  db,
  evaluateGoals,
  fetchBetleadsFees,
  fetchBetleadsSince,
  fetchBetleadsUsage,
  fetchFinanceDays,
  fetchGoalDays,
  inRange,
  num,
  periodPreset,
  requirePermission,
  todaySaoPaulo,
  toFinanceDay,
  type BetleadsUsageRow,
  type GoalDayRow,
  type OtherCostRow,
} from "@/lib/finance/finance-data.server";
import type {
  CompareMode,
  CostLine,
  DateRange,
  FinanceDay,
  GoalEvaluation,
  MonthPoint,
  PeriodPreset,
  PeriodSummary,
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
  /** Past dates in the current window missing GGR or Anúncios (today left out). */
  pendingDates: string[];
};

export type FinanceDashboard = {
  scope: DashboardScope;
  /** House name, group name or "Todas as casas". */
  label: string;
  range: DateRange;
  compareRange: DateRange;
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
 * Other costs of the given houses and months, oldest entry first. Paged, since
 * PostgREST returns at most 1000 rows per request without an error.
 */
async function fetchOtherCosts(tenantIds: string[], months: string[]) {
  if (!tenantIds.length || !months.length) return [];
  const rows: OtherCostRow[] = [];
  for (let offset = 0; ; offset += OTHER_COSTS_PAGE) {
    const { data, error } = await db()
      .from<OtherCostRow[]>("tenant_finance_other_costs")
      .select("id,tenant_id,month,descricao,valor,categoria")
      .in("tenant_id", tenantIds)
      .in("month", months)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + OTHER_COSTS_PAGE - 1);
    if (error) throw new Error(error.message);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < OTHER_COSTS_PAGE) return rows;
  }
}

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
 * are left out. Other costs and the plan fee enter a window only for a closed
 * month (costMonthsFor); Betleads usage enters any window, per day.
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
  const previous = clampToToday(previousRange, today);
  const costMonths = costMonthsFor(data.range, data.compare, data.preset);

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

  const span = tenantIds.length ? spanOf([current, previous, seriesSpan]) : null;
  const allCostMonths = [
    ...new Set(
      [...seriesMonths, costMonths.current, costMonths.previous].filter(
        (month): month is string => month !== null,
      ),
    ),
  ].sort();
  const feeMonths = tenantIds.length ? allCostMonths : [];

  const [dayRows, goalRows, costRows, usageRows, feeRows, sinceRows] = await Promise.all([
    span ? fetchFinanceDays(tenantIds, span) : Promise.resolve([]),
    current && tenantIds.length ? fetchGoalDays(tenantIds, current) : Promise.resolve([]),
    fetchOtherCosts(tenantIds, allCostMonths),
    span ? fetchBetleadsUsage(tenantIds, span) : Promise.resolve([]),
    feeMonths.length
      ? fetchBetleadsFees(tenantIds, feeMonths[0], feeMonths.at(-1) as string)
      : Promise.resolve([]),
    tenantIds.length ? fetchBetleadsSince(tenantIds) : Promise.resolve([]),
  ]);

  // Days, usage, other costs and fees are indexed once by house and month
  // (and by month for every house), so each window reads only its months.
  const allDays: FinanceDay[] = [];
  const dayBuckets = new Map<string, FinanceDay[]>();
  for (const row of dayRows) {
    const day = toFinanceDay(row);
    allDays.push(day);
    addToBuckets(dayBuckets, row.tenant_id, monthStartOf(day.date), day);
  }
  const usageBuckets = new Map<string, BetleadsUsageRow[]>();
  for (const row of usageRows) {
    addToBuckets(usageBuckets, row.tenant_id, monthStartOf(row.metric_date), row);
  }
  const costSums = new Map<string, number>();
  for (const row of costRows) addToSums(costSums, row.tenant_id, row.month, num(row.valor));
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
  const otherCostsFor = (month: string | null, tenantId?: string) =>
    monthSum(costSums, month, tenantId);
  const usageFor = (window: DateRange | null, tenantId?: string) =>
    round2(
      inWindow(usageBuckets, window, (row) => row.metric_date, tenantId).reduce(
        (total, row) => total + num(row.amount),
        0,
      ),
    );
  const feeFor = (month: string | null, tenantId?: string) => monthSum(feeSums, month, tenantId);
  const summarizeWindow = (window: DateRange | null, costMonth: string | null, tenantId?: string) =>
    summarize(windowDays(window, tenantId), otherCostsFor(costMonth, tenantId), today, {
      usage: usageFor(window, tenantId),
      fee: feeFor(costMonth, tenantId),
    });

  const rows: DashboardTenantRow[] = tenants.map((tenant) => {
    const currentSummary = summarizeWindow(current, costMonths.current, tenant.id);
    return {
      id: tenant.id,
      nome: tenant.nome,
      current: currentSummary,
      previous: summarizeWindow(previous, costMonths.previous, tenant.id),
      goals: current
        ? evaluateGoals(goalRowsByTenant.get(tenant.id) ?? [], currentSummary, current, today)
        : [],
      pendingDates: [
        ...new Set(
          windowDays(current, tenant.id)
            .filter((day) => day.pending && day.date < today)
            .map((day) => day.date),
        ),
      ],
    };
  });

  const totals = {
    current: summarizeWindow(current, costMonths.current),
    previous: summarizeWindow(previous, costMonths.previous),
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
  const categoriesFor = (month: string) => {
    const totalsByLabel: Record<string, number> = {};
    for (const row of costRows) {
      if (row.month !== month) continue;
      const label = categoryOf(row);
      totalsByLabel[label] = round2((totalsByLabel[label] ?? 0) + num(row.valor));
    }
    return totalsByLabel;
  };
  const currentCategories = costMonths.current ? categoriesFor(costMonths.current) : {};
  const previousCategories = costMonths.previous ? categoriesFor(costMonths.previous) : null;
  // A category that dropped to zero this month still shows, with its
  // variation: the current month lists the union of both months' categories.
  if (costMonths.current && previousCategories) {
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
  const duplicateBetleadsCosts = costMonths.current
    ? costRows.filter((row) => {
        const since = sinceByTenant.get(row.tenant_id);
        return (
          row.month === costMonths.current &&
          since !== undefined &&
          row.month >= monthStartOf(since) &&
          looksLikeBetleadsCost(row.descricao, row.categoria)
        );
      }).length
    : 0;

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
