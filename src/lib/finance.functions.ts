// Grupos de casas: financial close of a house (month view, manual entries
// including retroactive ones, other costs, rates, viewer grants, goals) and
// the group overview/scoreboard. Spec:
// docs/superpowers/specs/2026-10-24-grupos-de-casas-design.md (sections 5-7).
//
// Every permission decision is taken by the SQL helpers (finance_can_* and
// group_ids_managed_by); this file only asks them before reading or writing
// with the service-role client. Writes refuse the demo house: its numbers
// come only from the demo seed.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  compareRange,
  computeDay,
  evaluateGoal,
  presetRange,
  round2,
  summarize,
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
import { assertTenantNotDemo } from "@/lib/tenant-access.server";
import { auditTenant } from "@/lib/tenant-audit.server";
import { listTenantMembers, managedGroupIds } from "@/lib/tenants.functions";
import { dbUuid } from "@/lib/zod-helpers";

type DbError = { message: string; code?: string };
type DbResult<T = unknown> = { data: T | null; error: DbError | null };
type QueryBuilder<T = unknown> = PromiseLike<DbResult<T>> & {
  select: (columns?: string) => QueryBuilder<T>;
  eq: (column: string, value: unknown) => QueryBuilder<T>;
  in: (column: string, values: unknown[]) => QueryBuilder<T>;
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
type ServerContext = { userId: string };

type FinanceDayRow = {
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
type GoalDayRow = {
  tenant_id: string;
  metric_date: string;
  metric: GoalMetric;
  direction: GoalDirection;
  daily_value: number | string;
};
type DailyRow = {
  tenant_id: string;
  metric_date: string;
  ad_spend: number | string | null;
  ggr: number | string | null;
};
type OtherCostRow = {
  id: string;
  tenant_id: string;
  month: string;
  descricao: string;
  valor: number | string;
};
type RateRow = {
  tenant_id: string;
  valid_from: string;
  ggr_fee_pct: number | string;
  movement_fee_pct: number | string;
};
type GoalRow = {
  tenant_id: string;
  metric: GoalMetric;
  valid_from: string;
  direction: GoalDirection;
  daily_value: number | string | null;
};
type TenantLite = { id: string; nome: string };

const db = () => supabaseAdmin as unknown as LooseDb;

/** Spreadsheet defaults when a house has no rate row (same as finance_days in SQL). */
const DEFAULT_GGR_FEE_PCT = 16;
const DEFAULT_MOVEMENT_FEE_PCT = 2.7;
const MAX_MONEY = 999_999_999_999.99;
const MAX_RANGE_DAYS = 366;

const GOAL_METRICS = [
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

const num = (value: number | string | null | undefined) => Number(value ?? 0);
const numOrNull = (value: number | string | null | undefined) =>
  value === null || value === undefined ? null : Number(value);

const byNome = <T extends { nome: string }>(a: T, b: T) => a.nome.localeCompare(b.nome, "pt-BR");

/** "YYYY-MM-DD" of today in São Paulo. */
const todaySaoPaulo = () => presetRange("today", new Date()).from;

function isRealDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function lastDayOfMonth(firstDay: string) {
  const [y, m] = firstDay.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function daysInclusive(range: DateRange) {
  return (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 + 1;
}

/** True when the range is exactly one calendar month (1st to last day). */
function isCalendarMonth(range: DateRange) {
  return range.from.endsWith("-01") && range.to === lastDayOfMonth(range.from);
}

/** The range cut at today (São Paulo); null when it starts in the future. */
function clampToToday(range: DateRange, today: string): DateRange | null {
  if (range.from > today) return null;
  return { from: range.from, to: range.to > today ? today : range.to };
}

const inRange = (date: string, range: DateRange | null) =>
  !!range && date >= range.from && date <= range.to;

async function can(fn: string, userId: string, tenantId: string) {
  const { data, error } = await db().rpc<boolean>(fn, { _user: userId, _tenant: tenantId });
  if (error) throw new Error(error.message);
  return data === true;
}

async function requirePermission(fn: string, userId: string, tenantId: string) {
  if (!(await can(fn, userId, tenantId))) throw new Error("Sem permissão");
}

function toFinanceDay(row: FinanceDayRow): FinanceDay {
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

async function fetchFinanceDays(tenantIds: string[], range: DateRange) {
  const { data, error } = await db().rpc<FinanceDayRow[]>("finance_days", {
    _tenants: tenantIds,
    _from: range.from,
    _to: range.to,
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function fetchGoalDays(tenantIds: string[], range: DateRange) {
  const { data, error } = await db().rpc<GoalDayRow[]>("finance_goal_days", {
    _tenants: tenantIds,
    _from: range.from,
    _to: range.to,
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * One evaluation per metric with a goal, over exactly the goal days inside
 * `range` (evaluateGoal sums every goal day it is given).
 */
function evaluateGoals(
  goalRows: GoalDayRow[],
  summary: PeriodSummary,
  range: DateRange,
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
    return goalDays ? evaluateGoal(goalDays, summary, range) : null;
  }).filter((goal): goal is GoalEvaluation => goal !== null);
}

async function getTenantLite(tenantId: string) {
  const { data, error } = await db()
    .from<TenantLite>("tenants")
    .select("id,nome")
    .eq("id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Casa não encontrada");
  return { id: data.id, nome: data.nome };
}

// ─── Input schemas ──────────────────────────────────────────────────────────

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida")
  .refine(isRealDate, "Data inválida");
const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mês inválido");
const money = z.number().finite().min(-MAX_MONEY).max(MAX_MONEY);
const percent = z.number().finite().min(0).max(100);
const goalMetric = z.enum(GOAL_METRICS);
const goalDirection = z.enum(["gte", "lte"]);

// ─── House month ────────────────────────────────────────────────────────────

const monthInput = z.object({ tenantId: dbUuid(), month: yearMonth });

export async function getTenantFinanceMonthFor(
  ctx: ServerContext,
  data: z.infer<typeof monthInput>,
) {
  const { tenantId } = data;
  await requirePermission("finance_can_view", ctx.userId, tenantId);

  const [canEditValues, canEditRates, canManageViewers, canManageGoals, tenant] = await Promise.all(
    [
      can("finance_can_edit_values", ctx.userId, tenantId),
      can("finance_can_edit_rates", ctx.userId, tenantId),
      can("finance_can_manage_viewers", ctx.userId, tenantId),
      can("finance_can_manage_goals", ctx.userId, tenantId),
      getTenantLite(tenantId),
    ],
  );

  const today = todaySaoPaulo();
  const monthStart = `${data.month}-01`;
  // Future days of the current month do not appear; a future month is empty.
  const range = clampToToday({ from: monthStart, to: lastDayOfMonth(monthStart) }, today);

  const [dayRows, goalRows, costsRes, ratesRes] = await Promise.all([
    range ? fetchFinanceDays([tenantId], range) : Promise.resolve([]),
    range ? fetchGoalDays([tenantId], range) : Promise.resolve([]),
    db()
      .from<OtherCostRow[]>("tenant_finance_other_costs")
      .select("id,tenant_id,month,descricao,valor")
      .eq("tenant_id", tenantId)
      .eq("month", monthStart)
      .order("created_at", { ascending: true }),
    db()
      .from<RateRow[]>("tenant_finance_rates")
      .select("tenant_id,valid_from,ggr_fee_pct,movement_fee_pct")
      .eq("tenant_id", tenantId)
      .order("valid_from", { ascending: false }),
  ]);
  if (costsRes.error) throw new Error(costsRes.error.message);
  if (ratesRes.error) throw new Error(ratesRes.error.message);

  const days = dayRows.map(toFinanceDay).sort((a, b) => a.date.localeCompare(b.date));
  const otherCosts = (costsRes.data ?? []).map((row) => ({
    id: row.id,
    descricao: row.descricao,
    valor: num(row.valor),
  }));
  const summary = summarize(
    days,
    round2(otherCosts.reduce((total, cost) => total + cost.valor, 0)),
  );

  const history = [...(ratesRes.data ?? [])]
    .sort((a, b) => b.valid_from.localeCompare(a.valid_from))
    .map((row) => ({
      validFrom: row.valid_from,
      ggrFeePct: num(row.ggr_fee_pct),
      movementFeePct: num(row.movement_fee_pct),
    }));
  const currentRate = history.find((rate) => rate.validFrom <= today);
  const current = currentRate
    ? { ...currentRate }
    : {
        ggrFeePct: DEFAULT_GGR_FEE_PCT,
        movementFeePct: DEFAULT_MOVEMENT_FEE_PCT,
        validFrom: null as string | null,
      };

  return {
    tenant,
    days,
    summary,
    otherCosts,
    rates: {
      current: {
        ggrFeePct: current.ggrFeePct,
        movementFeePct: current.movementFeePct,
        validFrom: current.validFrom,
      },
      history,
    },
    viewers: canManageViewers ? await listViewers(tenantId) : [],
    goals: range ? evaluateGoals(goalRows, summary, range) : [],
    permissions: { canEditValues, canEditRates, canManageViewers, canManageGoals },
  };
}

/** Gestores of the house with their e-mail and whether they may see the finance. */
async function listViewers(tenantId: string) {
  const [members, grantsRes] = await Promise.all([
    listTenantMembers(tenantId),
    db()
      .from<Array<{ user_id: string }>>("tenant_finance_viewers")
      .select("user_id")
      .eq("tenant_id", tenantId),
  ]);
  if (grantsRes.error) throw new Error(grantsRes.error.message);
  const granted = new Set((grantsRes.data ?? []).map((row) => row.user_id));
  return members
    .filter((member) => member.role === "gestor")
    .map((member) => ({
      user_id: member.user_id,
      email: member.email ?? null,
      canView: granted.has(member.user_id),
    }));
}

export const getTenantFinanceMonth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => monthInput.parse(data))
  .handler(async ({ data, context }) =>
    getTenantFinanceMonthFor(context as unknown as ServerContext, data),
  );

// ─── Manual daily entries ───────────────────────────────────────────────────

const saveDaysInput = z.object({
  tenantId: dbUuid(),
  entries: z
    .array(
      z.object({
        date: isoDate,
        adSpend: money.nonnegative().nullable().optional(),
        ggr: money.nullable().optional(),
      }),
    )
    .min(1)
    .max(62)
    .refine(
      (entries) => new Set(entries.map((entry) => entry.date)).size === entries.length,
      "Datas repetidas",
    ),
});

/**
 * Upserts manual values for any day up to today (retroactive allowed, no
 * month lock). A missing field keeps the stored value; null clears it. One
 * audit row per day whose values actually changed.
 */
export async function saveFinanceDaysFor(ctx: ServerContext, data: z.infer<typeof saveDaysInput>) {
  await requirePermission("finance_can_edit_values", ctx.userId, data.tenantId);
  await assertTenantNotDemo(data.tenantId);

  const today = todaySaoPaulo();
  if (data.entries.some((entry) => entry.date > today)) {
    throw new Error("Data futura não permitida");
  }

  const { data: existingRows, error } = await db()
    .from<DailyRow[]>("tenant_finance_daily")
    .select("tenant_id,metric_date,ad_spend,ggr")
    .eq("tenant_id", data.tenantId)
    .in(
      "metric_date",
      data.entries.map((entry) => entry.date),
    );
  if (error) throw new Error(error.message);
  const existing = new Map((existingRows ?? []).map((row) => [row.metric_date, row]));

  const changes = data.entries.flatMap((entry) => {
    const row = existing.get(entry.date);
    const before = {
      date: entry.date,
      ad_spend: numOrNull(row?.ad_spend),
      ggr: numOrNull(row?.ggr),
    };
    const pick = (value: number | null | undefined, current: number | null) =>
      value === undefined ? current : value === null ? null : round2(value);
    const after = {
      date: entry.date,
      ad_spend: pick(entry.adSpend, before.ad_spend),
      ggr: pick(entry.ggr, before.ggr),
    };
    return after.ad_spend === before.ad_spend && after.ggr === before.ggr
      ? []
      : [{ before, after }];
  });

  if (changes.length) {
    const updatedAt = new Date().toISOString();
    const { error: upsertErr } = await db()
      .from("tenant_finance_daily")
      .upsert(
        changes.map(({ after }) => ({
          tenant_id: data.tenantId,
          metric_date: after.date,
          ad_spend: after.ad_spend,
          ggr: after.ggr,
          updated_by: ctx.userId,
          updated_at: updatedAt,
        })),
        { onConflict: "tenant_id,metric_date" },
      );
    if (upsertErr) throw new Error(upsertErr.message);

    for (const { before, after } of changes) {
      await auditTenant({
        tenantId: data.tenantId,
        actorUserId: ctx.userId,
        action: "finance.day_updated",
        entityType: "tenant_finance_daily",
        entityId: after.date,
        before,
        after,
      });
    }
  }

  return { changed: changes.length };
}

export const saveFinanceDays = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => saveDaysInput.parse(data))
  .handler(async ({ data, context }) =>
    saveFinanceDaysFor(context as unknown as ServerContext, data),
  );

// ─── Other costs of the month ───────────────────────────────────────────────

const saveOtherCostInput = z.object({
  tenantId: dbUuid(),
  id: dbUuid().optional(),
  month: yearMonth,
  descricao: z.string().trim().min(1).max(200),
  valor: money.nonnegative(),
});

async function getOtherCost(tenantId: string, id: string) {
  const { data, error } = await db()
    .from<OtherCostRow>("tenant_finance_other_costs")
    .select("id,tenant_id,month,descricao,valor")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Custo não encontrado");
  return { ...data, valor: num(data.valor) };
}

export async function saveOtherCostFor(
  ctx: ServerContext,
  data: z.infer<typeof saveOtherCostInput>,
) {
  await requirePermission("finance_can_edit_values", ctx.userId, data.tenantId);
  await assertTenantNotDemo(data.tenantId);

  const values = {
    month: `${data.month}-01`,
    descricao: data.descricao,
    valor: round2(data.valor),
  };
  let id: string;
  let before: OtherCostRow | null = null;

  if (data.id) {
    before = await getOtherCost(data.tenantId, data.id);
    const { error } = await db()
      .from("tenant_finance_other_costs")
      .update({ ...values, updated_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("tenant_id", data.tenantId);
    if (error) throw new Error(error.message);
    id = data.id;
  } else {
    const { data: created, error } = await db()
      .from<{ id: string }>("tenant_finance_other_costs")
      .insert({ tenant_id: data.tenantId, ...values, created_by: ctx.userId })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    if (!created) throw new Error("Falha ao salvar custo");
    id = created.id;
  }

  await auditTenant({
    tenantId: data.tenantId,
    actorUserId: ctx.userId,
    action: "finance.other_cost_saved",
    entityType: "tenant_finance_other_cost",
    entityId: id,
    before,
    after: { id, tenant_id: data.tenantId, ...values },
  });
  return { id };
}

export const saveOtherCost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => saveOtherCostInput.parse(data))
  .handler(async ({ data, context }) =>
    saveOtherCostFor(context as unknown as ServerContext, data),
  );

const deleteOtherCostInput = z.object({ tenantId: dbUuid(), id: dbUuid() });

export async function deleteOtherCostFor(
  ctx: ServerContext,
  data: z.infer<typeof deleteOtherCostInput>,
) {
  await requirePermission("finance_can_edit_values", ctx.userId, data.tenantId);
  await assertTenantNotDemo(data.tenantId);

  const before = await getOtherCost(data.tenantId, data.id);
  const { error } = await db()
    .from("tenant_finance_other_costs")
    .delete()
    .eq("id", data.id)
    .eq("tenant_id", data.tenantId);
  if (error) throw new Error(error.message);

  await auditTenant({
    tenantId: data.tenantId,
    actorUserId: ctx.userId,
    action: "finance.other_cost_deleted",
    entityType: "tenant_finance_other_cost",
    entityId: data.id,
    before,
  });
  return { ok: true };
}

export const deleteOtherCost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => deleteOtherCostInput.parse(data))
  .handler(async ({ data, context }) =>
    deleteOtherCostFor(context as unknown as ServerContext, data),
  );

// ─── Rates ──────────────────────────────────────────────────────────────────

const setRatesInput = z.object({
  tenantId: dbUuid(),
  validFrom: isoDate.optional(),
  ggrFeePct: percent,
  movementFeePct: percent,
});

/** The new rates apply from `validFrom` (default today) on; earlier days keep theirs. */
export async function setFinanceRatesFor(ctx: ServerContext, data: z.infer<typeof setRatesInput>) {
  await requirePermission("finance_can_edit_rates", ctx.userId, data.tenantId);
  await assertTenantNotDemo(data.tenantId);

  const validFrom = data.validFrom ?? todaySaoPaulo();
  const { data: before, error: beforeErr } = await db()
    .from<RateRow>("tenant_finance_rates")
    .select("tenant_id,valid_from,ggr_fee_pct,movement_fee_pct")
    .eq("tenant_id", data.tenantId)
    .eq("valid_from", validFrom)
    .maybeSingle();
  if (beforeErr) throw new Error(beforeErr.message);

  const after = {
    tenant_id: data.tenantId,
    valid_from: validFrom,
    ggr_fee_pct: data.ggrFeePct,
    movement_fee_pct: data.movementFeePct,
  };
  const { error } = await db()
    .from("tenant_finance_rates")
    .upsert(
      { ...after, updated_by: ctx.userId, updated_at: new Date().toISOString() },
      { onConflict: "tenant_id,valid_from" },
    );
  if (error) throw new Error(error.message);

  await auditTenant({
    tenantId: data.tenantId,
    actorUserId: ctx.userId,
    action: "finance.rates_changed",
    entityType: "tenant_finance_rates",
    entityId: validFrom,
    before: before ?? null,
    after,
  });
  return { ok: true, validFrom };
}

export const setFinanceRates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => setRatesInput.parse(data))
  .handler(async ({ data, context }) =>
    setFinanceRatesFor(context as unknown as ServerContext, data),
  );

// ─── Viewer grants ──────────────────────────────────────────────────────────

const setViewerInput = z.object({ tenantId: dbUuid(), userId: dbUuid(), canView: z.boolean() });

export async function setFinanceViewerFor(
  ctx: ServerContext,
  data: z.infer<typeof setViewerInput>,
) {
  await requirePermission("finance_can_manage_viewers", ctx.userId, data.tenantId);
  await assertTenantNotDemo(data.tenantId);

  // Only granting needs a current gestor; revoking must also clear a stale
  // grant left behind after the person stopped being gestor of the house.
  if (data.canView) {
    const { data: gestor, error: roleErr } = await db()
      .from<{ user_id: string }>("user_roles")
      .select("user_id")
      .eq("tenant_id", data.tenantId)
      .eq("user_id", data.userId)
      .eq("role", "gestor")
      .maybeSingle();
    if (roleErr) throw new Error(roleErr.message);
    if (!gestor) throw new Error("Só gestores da casa podem ser liberados");
  }

  const { data: grant, error: grantErr } = await db()
    .from<{ user_id: string }>("tenant_finance_viewers")
    .select("user_id")
    .eq("tenant_id", data.tenantId)
    .eq("user_id", data.userId)
    .maybeSingle();
  if (grantErr) throw new Error(grantErr.message);
  const before = !!grant;
  if (before === data.canView) return { ok: true, changed: false };

  const { error } = data.canView
    ? await db()
        .from("tenant_finance_viewers")
        .insert({ tenant_id: data.tenantId, user_id: data.userId, granted_by: ctx.userId })
    : await db()
        .from("tenant_finance_viewers")
        .delete()
        .eq("tenant_id", data.tenantId)
        .eq("user_id", data.userId);
  if (error) throw new Error(error.message);

  await auditTenant({
    tenantId: data.tenantId,
    actorUserId: ctx.userId,
    action: "finance.viewer_changed",
    entityType: "tenant_finance_viewer",
    entityId: data.userId,
    before: { user_id: data.userId, can_view: before },
    after: { user_id: data.userId, can_view: data.canView },
  });
  return { ok: true, changed: true };
}

export const setFinanceViewer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => setViewerInput.parse(data))
  .handler(async ({ data, context }) =>
    setFinanceViewerFor(context as unknown as ServerContext, data),
  );

// ─── Goals ──────────────────────────────────────────────────────────────────

const setGoalInput = z.object({
  tenantId: dbUuid(),
  metric: goalMetric,
  direction: goalDirection,
  /** null removes the goal from `validFrom` on. */
  dailyValue: z.number().finite().min(-9_999_999_999).max(9_999_999_999).nullable(),
  validFrom: isoDate.optional(),
});

export async function setTenantGoalFor(ctx: ServerContext, data: z.infer<typeof setGoalInput>) {
  await requirePermission("finance_can_manage_goals", ctx.userId, data.tenantId);
  await assertTenantNotDemo(data.tenantId);

  const validFrom = data.validFrom ?? todaySaoPaulo();
  const { data: before, error: beforeErr } = await db()
    .from<GoalRow>("tenant_goals")
    .select("tenant_id,metric,valid_from,direction,daily_value")
    .eq("tenant_id", data.tenantId)
    .eq("metric", data.metric)
    .eq("valid_from", validFrom)
    .maybeSingle();
  if (beforeErr) throw new Error(beforeErr.message);

  const after = {
    tenant_id: data.tenantId,
    metric: data.metric,
    valid_from: validFrom,
    direction: data.direction,
    daily_value: data.dailyValue,
  };
  const { error } = await db()
    .from("tenant_goals")
    .upsert(
      { ...after, updated_by: ctx.userId, updated_at: new Date().toISOString() },
      { onConflict: "tenant_id,metric,valid_from" },
    );
  if (error) throw new Error(error.message);

  await auditTenant({
    tenantId: data.tenantId,
    actorUserId: ctx.userId,
    action: "finance.goal_changed",
    entityType: "tenant_goal",
    entityId: `${data.metric}:${validFrom}`,
    before: before ?? null,
    after,
  });
  return { ok: true, validFrom };
}

export const setTenantGoal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => setGoalInput.parse(data))
  .handler(async ({ data, context }) =>
    setTenantGoalFor(context as unknown as ServerContext, data),
  );

const tenantIdInput = z.object({ tenantId: dbUuid() });

export type TenantGoalCurrent = {
  metric: GoalMetric;
  direction: GoalDirection;
  dailyValue: number | null;
  validFrom: string | null;
};

/**
 * The goal in force today for every metric (Task 7 /grupo/metas editor):
 * the most recent `tenant_goals` row with `valid_from <= today`, per metric.
 * A metric with no row at all comes back with `dailyValue: null` ("sem
 * meta"). Read-only — added for this task because neither
 * `getTenantFinanceMonth` nor `getGroupOverview` exposes the raw goal value
 * outside of a date range's evaluation.
 */
export async function getTenantGoalsFor(
  ctx: ServerContext,
  data: z.infer<typeof tenantIdInput>,
): Promise<TenantGoalCurrent[]> {
  await requirePermission("finance_can_view", ctx.userId, data.tenantId);

  const { data: rows, error } = await db()
    .from<GoalRow[]>("tenant_goals")
    .select("tenant_id,metric,valid_from,direction,daily_value")
    .eq("tenant_id", data.tenantId)
    .order("valid_from", { ascending: false });
  if (error) throw new Error(error.message);

  const today = todaySaoPaulo();
  const byMetric = new Map<GoalMetric, GoalRow>();
  for (const row of rows ?? []) {
    if (row.valid_from > today) continue;
    if (!byMetric.has(row.metric)) byMetric.set(row.metric, row);
  }

  return GOAL_METRICS.map((metric) => {
    const row = byMetric.get(metric);
    return {
      metric,
      direction: row?.direction ?? "gte",
      dailyValue: row ? numOrNull(row.daily_value) : null,
      validFrom: row?.valid_from ?? null,
    };
  });
}

export const getTenantGoals = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => tenantIdInput.parse(data))
  .handler(async ({ data, context }) =>
    getTenantGoalsFor(context as unknown as ServerContext, data),
  );

// ─── Group overview ─────────────────────────────────────────────────────────

const dateRange = z
  .object({ from: isoDate, to: isoDate })
  .refine((range) => range.from <= range.to, "Período inválido")
  .refine((range) => daysInclusive(range) <= MAX_RANGE_DAYS, "Período longo demais");

const overviewInput = z.object({
  groupId: dbUuid(),
  range: dateRange,
  compare: z.enum(["previous", "same_weekday_last_week", "last_week"]),
  preset: z.enum(["today", "yesterday", "7d", "month", "custom"]),
});

type OverviewInput = {
  groupId: string;
  range: DateRange;
  compare: CompareMode;
  preset: PeriodPreset;
};

/**
 * Scoreboard of a group the caller manages (super admin: any group). One
 * finance_days call covers both windows; days after today are left out.
 * Other costs enter a window's result only for the "Mês" preset or a range
 * that is exactly a calendar month. Group totals are summarize() over every house's days, so ratios
 * (ROI, cost per unit) come from the sums, never from averaging houses.
 */
export async function getGroupOverviewFor(ctx: ServerContext, data: OverviewInput) {
  const managed = await managedGroupIds(ctx.userId);
  if (!managed.includes(data.groupId)) throw new Error("Sem permissão");

  const { data: group, error: groupErr } = await db()
    .from<TenantLite>("tenant_groups")
    .select("id,nome")
    .eq("id", data.groupId)
    .maybeSingle();
  if (groupErr) throw new Error(groupErr.message);
  if (!group) throw new Error("Grupo não encontrado");

  const { data: links, error: linksErr } = await db()
    .from<Array<{ tenant_id: string }>>("tenant_group_tenants")
    .select("tenant_id")
    .eq("group_id", data.groupId);
  if (linksErr) throw new Error(linksErr.message);
  const linkedIds = (links ?? []).map((link) => link.tenant_id);

  let tenants: TenantLite[] = [];
  if (linkedIds.length) {
    const { data: tenantRows, error } = await db()
      .from<TenantLite[]>("tenants")
      .select("id,nome")
      .in("id", linkedIds);
    if (error) throw new Error(error.message);
    tenants = [...(tenantRows ?? [])].sort(byNome);
  }
  const tenantIds = tenants.map((tenant) => tenant.id);

  const today = todaySaoPaulo();
  const previousRange = compareRange(data.range, data.compare, data.preset);
  const current = clampToToday(data.range, today);
  const previous = clampToToday(previousRange, today);
  const windows = [current, previous].filter((range): range is DateRange => range !== null);
  const span =
    windows.length && tenantIds.length
      ? {
          from: windows.map((range) => range.from).sort()[0],
          to: windows
            .map((range) => range.to)
            .sort()
            .at(-1) as string,
        }
      : null;

  // Spec §5: other costs enter a window's result only for a closed calendar
  // month: a range covering exactly one month, or the "Mês" preset (also
  // while in progress). The preset is only trusted when the range really is
  // a month-to-date window, and its comparison window counts only for
  // "previous" (the previous month to the same day), never a 7-day shift.
  const monthToDate =
    data.preset === "month" &&
    data.range.from.endsWith("-01") &&
    data.range.to.slice(0, 7) === data.range.from.slice(0, 7);
  const monthOf = (range: DateRange) => `${range.from.slice(0, 7)}-01`;
  const currentCostMonth = monthToDate || isCalendarMonth(data.range) ? monthOf(data.range) : null;
  const previousCostMonth =
    (monthToDate && data.compare === "previous") || isCalendarMonth(previousRange)
      ? monthOf(previousRange)
      : null;
  const costMonths = [currentCostMonth, previousCostMonth].filter(
    (month): month is string => month !== null,
  );

  const [dayRows, goalRows, costRows] = await Promise.all([
    span ? fetchFinanceDays(tenantIds, span) : Promise.resolve([]),
    current && tenantIds.length ? fetchGoalDays(tenantIds, current) : Promise.resolve([]),
    costMonths.length && tenantIds.length
      ? db()
          .from<OtherCostRow[]>("tenant_finance_other_costs")
          .select("id,tenant_id,month,descricao,valor")
          .in("tenant_id", tenantIds)
          .in("month", costMonths)
          .then((res) => {
            if (res.error) throw new Error(res.error.message);
            return res.data ?? [];
          })
      : Promise.resolve([] as OtherCostRow[]),
  ]);

  const days = dayRows.map((row) => ({ tenantId: row.tenant_id, day: toFinanceDay(row) }));
  const otherCostsFor = (tenantIdsToSum: string[], month: string | null) =>
    month === null
      ? null
      : round2(
          costRows
            .filter((row) => tenantIdsToSum.includes(row.tenant_id) && row.month === month)
            .reduce((total, row) => total + num(row.valor), 0),
        );
  const windowDays = (window: DateRange | null, tenantId?: string) =>
    days
      .filter((entry) => (tenantId ? entry.tenantId === tenantId : true))
      .filter((entry) => inRange(entry.day.date, window))
      .map((entry) => entry.day)
      .sort((a, b) => a.date.localeCompare(b.date));

  const rows = tenants.map((tenant) => {
    const currentSummary = summarize(
      windowDays(current, tenant.id),
      otherCostsFor([tenant.id], currentCostMonth),
    );
    const previousSummary = summarize(
      windowDays(previous, tenant.id),
      otherCostsFor([tenant.id], previousCostMonth),
    );
    return {
      id: tenant.id,
      nome: tenant.nome,
      current: currentSummary,
      previous: previousSummary,
      goals: current
        ? evaluateGoals(
            goalRows.filter((row) => row.tenant_id === tenant.id),
            currentSummary,
            current,
          )
        : [],
    };
  });

  const totalOtherCurrent = otherCostsFor(tenantIds, currentCostMonth);
  const totalOtherPrevious = otherCostsFor(tenantIds, previousCostMonth);

  return {
    group: { id: group.id, nome: group.nome },
    range: data.range,
    compareRange: previousRange,
    totals: {
      current: summarize(windowDays(current), totalOtherCurrent),
      previous: summarize(windowDays(previous), totalOtherPrevious),
    },
    tenants: rows,
  };
}

export const getGroupOverview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => overviewInput.parse(data))
  .handler(async ({ data, context }) =>
    getGroupOverviewFor(context as unknown as ServerContext, data),
  );
