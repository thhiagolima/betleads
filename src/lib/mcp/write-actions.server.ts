// MCP financeiro, Task 7: the five write actions behind preparar_* /
// confirmar_alteracao. Each action pairs the real panel schema with the
// existing `*For` core (apply), a read-only "before" snapshot and a pt-BR
// description of the change. Spec:
// docs/superpowers/specs/2026-10-30-mcp-financeiro-design.md §7.
//
// The snapshots are the only direct reads of tenant_finance_* / tenant_goals
// in MCP code (global-constraints.md); preview.server.ts runs them only after
// requirePermission has passed for the action's permission.
import type { ZodType } from "zod";
import { z } from "zod";

import { FINANCE_TERMS } from "@/components/finance/definitions";
import type { Json } from "@/integrations/supabase/types";
import { round2 } from "@/lib/finance/calc";
import { categoryKey, categoryLabel } from "@/lib/finance/categories";
import {
  OTHER_COST_COLUMNS,
  db,
  num,
  numOrNull,
  todaySaoPaulo,
  type OtherCostRow,
} from "@/lib/finance/finance-data.server";
import type { GoalMetric } from "@/lib/finance/types";
import {
  deleteOtherCostFor,
  deleteOtherCostInput,
  saveFinanceDaysFor,
  saveDaysInput,
  saveOtherCostFor,
  saveOtherCostInput,
  setGoalInput,
  setMonthlyGgrFor,
  setMonthlyGgrInput,
  setTenantGoalFor,
} from "@/lib/finance.functions";

import { MAX_DAY_ENTRIES } from "./config.server";

export type ServerContext = Parameters<typeof saveFinanceDaysFor>[0];

export type WriteActionName =
  "lancamento_dias" | "ggr_mensal" | "custo" | "exclusao_custo" | "meta";

export type WriteAction<I> = {
  schema: ZodType<I>;
  permission: "finance_can_edit_values" | "finance_can_manage_goals";
  snapshot(tenantId: string, input: I): Promise<Json>;
  describe(before: Json, input: I, houseName: string): { linhas: string[]; avisos: string[] };
  apply(ctx: ServerContext, input: I): Promise<unknown>;
};

const OVERWRITE = "Sobrescreve um valor existente";
const EMPTY = "vazio";

// ─── Formatting ─────────────────────────────────────────────────────────────

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

/** "R$ 12.345,00" with a plain space (Intl puts a NBSP after "R$"). */
export function formatMoney(value: number | null): string {
  if (value === null) return EMPTY;
  return brl.format(value).replace(/\s/g, " ");
}

/** "2026-10-15" -> "15/10". */
export const formatDay = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** "2026-10" -> "10/2026". */
const formatMonth = (yearMonth: string) => `${yearMonth.slice(5, 7)}/${yearMonth.slice(0, 4)}`;

const arrow = (before: string, after: string) => `${before} → ${after}`;

// ─── lancamento_dias ────────────────────────────────────────────────────────

const daysSchema = saveDaysInput.extend({
  entries: saveDaysInput.shape.entries
    .max(MAX_DAY_ENTRIES, `No máximo ${MAX_DAY_ENTRIES} dias por chamada`)
    .refine(
      (entries) => entries.every((entry) => entry.date <= todaySaoPaulo()),
      "Data futura não permitida",
    ),
});
type DaysInput = z.infer<typeof daysSchema>;
type DaySnapshot = Array<{ date: string; ad_spend: number | null; ggr: number | null }>;

const DAY_FIELDS = [
  { key: "adSpend", column: "ad_spend", label: "Anúncios" },
  { key: "ggr", column: "ggr", label: "GGR" },
] as const;

const lancamentoDias: WriteAction<DaysInput> = {
  schema: daysSchema,
  permission: "finance_can_edit_values",
  async snapshot(tenantId, input) {
    const { data, error } = await db()
      .from<
        Array<{
          metric_date: string;
          ad_spend: number | string | null;
          ggr: number | string | null;
        }>
      >("tenant_finance_daily")
      .select("metric_date,ad_spend,ggr")
      .eq("tenant_id", tenantId)
      .in(
        "metric_date",
        input.entries.map((entry) => entry.date),
      );
    if (error) throw new Error(error.message);
    const byDate = new Map((data ?? []).map((row) => [row.metric_date, row]));
    const snapshot: DaySnapshot = input.entries.map((entry) => {
      const row = byDate.get(entry.date);
      return { date: entry.date, ad_spend: numOrNull(row?.ad_spend), ggr: numOrNull(row?.ggr) };
    });
    return snapshot;
  },
  describe(before, input, houseName) {
    const snapshot = before as DaySnapshot;
    const linhas: string[] = [];
    const avisos: string[] = [];
    let overwrites = false;
    input.entries.forEach((entry, index) => {
      const current = snapshot[index];
      for (const field of DAY_FIELDS) {
        const value = entry[field.key];
        if (value === undefined) continue;
        const was = current[field.column];
        const next = value === null ? null : round2(value);
        if (was === next) continue;
        linhas.push(
          `${formatDay(entry.date)} ${houseName} — ${field.label}: ${arrow(formatMoney(was), formatMoney(next))}`,
        );
        if (next === null)
          avisos.push(`Vai apagar o valor de ${field.label} de ${formatDay(entry.date)}`);
        else if (was !== null) overwrites = true;
      }
    });
    if (overwrites) avisos.push(OVERWRITE);
    if (!linhas.length) avisos.push("Nenhum valor muda.");
    return { linhas, avisos };
  },
  apply: (ctx, input) => saveFinanceDaysFor(ctx, input),
};

// ─── ggr_mensal ─────────────────────────────────────────────────────────────

type MonthlyGgrInput = z.infer<typeof setMonthlyGgrInput>;
type MonthlyGgrSnapshot = { ggr: number; valid_through: string } | null;

/** Same date checks (and messages) as setMonthlyGgrFor, at preview time. */
const monthlyGgrSchema = setMonthlyGgrInput.superRefine((input, ctx) => {
  if (input.ggr === null || input.validThrough === undefined) return;
  const monthStart = `${input.month}-01`;
  const [y, m] = input.month.split("-").map(Number);
  const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  if (input.validThrough < monthStart || input.validThrough > monthEnd) {
    ctx.addIssue({
      code: "custom",
      message: "A data deve estar dentro do mês",
      path: ["validThrough"],
    });
  } else if (input.validThrough > todaySaoPaulo()) {
    ctx.addIssue({ code: "custom", message: "Data futura não permitida", path: ["validThrough"] });
  }
});

const ggrMensal: WriteAction<MonthlyGgrInput> = {
  schema: monthlyGgrSchema,
  permission: "finance_can_edit_values",
  async snapshot(tenantId, input) {
    const { data, error } = await db()
      .from<{ ggr: number | string; valid_through: string }>("tenant_finance_monthly_ggr")
      .select("ggr,valid_through")
      .eq("tenant_id", tenantId)
      .eq("month", `${input.month}-01`)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const snapshot: MonthlyGgrSnapshot = data
      ? { ggr: num(data.ggr), valid_through: data.valid_through }
      : null;
    return snapshot;
  },
  describe(before, input, houseName) {
    const current = before as MonthlyGgrSnapshot;
    const prefix = `${formatMonth(input.month)} ${houseName} —`;
    const next = input.ggr === null ? null : round2(input.ggr);
    const linhas: string[] = [];
    const avisos: string[] = [];
    if ((current?.ggr ?? null) !== next) {
      linhas.push(
        `${prefix} GGR do mês: ${arrow(formatMoney(current?.ggr ?? null), formatMoney(next))}`,
      );
    }
    if (next !== null && current?.valid_through !== input.validThrough) {
      const was = current ? formatDay(current.valid_through) : EMPTY;
      linhas.push(
        `${prefix} Atualizado até: ${arrow(was, formatDay(input.validThrough as string))}`,
      );
    }
    if (next === null && current) {
      avisos.push(`Vai apagar o valor de GGR do mês de ${formatMonth(input.month)}`);
    } else if (current && linhas.length) {
      avisos.push(OVERWRITE);
    }
    if (!linhas.length) avisos.push("Nenhum valor muda.");
    return { linhas, avisos };
  },
  apply: (ctx, input) => setMonthlyGgrFor(ctx, input),
};

// ─── custo / exclusao_custo ─────────────────────────────────────────────────

type CostRow = {
  id: string;
  cost_date: string;
  descricao: string;
  valor: number;
  categoria: string | null;
  repeat_monthly: boolean;
  series_id: string | null;
};
/**
 * The cost row plus, for a row of a repeating series, the series' two newest
 * rows (newest first) — exactly what saveOtherCostFor (newest 1) and
 * deleteOtherCostFor (newest 2) read before flipping `repeat_monthly` on
 * another row of the series. Part of the snapshot, so a concurrent change to
 * the series also trips the "mudaram" check at confirm.
 */
type CostSnapshot = { row: CostRow; series: CostRow[] };

const toCostRow = (data: OtherCostRow): CostRow => ({
  id: data.id,
  cost_date: data.cost_date,
  descricao: data.descricao,
  valor: num(data.valor),
  categoria: data.categoria ?? null,
  repeat_monthly: data.repeat_monthly === true,
  series_id: data.series_id ?? null,
});

async function costSnapshot(tenantId: string, id: string): Promise<CostSnapshot> {
  const { data, error } = await db()
    .from<OtherCostRow>("tenant_finance_other_costs")
    .select(OTHER_COST_COLUMNS)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Custo não encontrado");
  const row = toCostRow(data);
  if (!row.series_id) return { row, series: [] };

  const { data: newest, error: seriesError } = await db()
    .from<OtherCostRow[]>("tenant_finance_other_costs")
    .select(OTHER_COST_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("series_id", row.series_id)
    .order("cost_date", { ascending: false })
    .range(0, 1);
  if (seriesError) throw new Error(seriesError.message);
  return { row, series: (newest ?? []).map(toCostRow) };
}

const yesNo = (value: boolean) => (value ? "sim" : "não");

/** Same normalization as saveOtherCostFor: "Outros" (any case) is stored as null. */
function storedCategory(categoria: string | null) {
  const label = categoryLabel(categoria);
  return categoryKey(label) === categoryKey("Outros") ? null : label;
}

/** Same check (and message) as saveOtherCostFor, at preview time (before the code is spent). */
const costSchema = saveOtherCostInput.refine((input) => input.costDate <= todaySaoPaulo(), {
  message: "Data futura não permitida",
  path: ["costDate"],
});
type CostInput = z.infer<typeof costSchema>;

const custo: WriteAction<CostInput> = {
  schema: costSchema,
  permission: "finance_can_edit_values",
  async snapshot(tenantId, input) {
    return input.id ? await costSnapshot(tenantId, input.id) : null;
  },
  describe(before, input, houseName) {
    const snapshot = before as CostSnapshot | null;
    const linhas: string[] = [];
    const avisos: string[] = [];
    if (!snapshot) {
      linhas.push(
        `${formatDay(input.costDate)} ${houseName} — Custo "${input.descricao}": ${arrow(EMPTY, formatMoney(round2(input.valor)))}`,
      );
      if (input.repeatMonthly) avisos.push("Repete todo mês");
      return { linhas, avisos };
    }
    const current = snapshot.row;
    const prefix = `${formatDay(current.cost_date)} ${houseName} — Custo "${current.descricao}":`;
    linhas.push(`${prefix} ${arrow(formatMoney(current.valor), formatMoney(round2(input.valor)))}`);
    if (input.descricao !== current.descricao) {
      linhas.push(
        `${prefix} Descrição: ${arrow(`"${current.descricao}"`, `"${input.descricao}"`)}`,
      );
    }
    if (input.costDate !== current.cost_date) {
      linhas.push(
        `${prefix} Data: ${arrow(formatDay(current.cost_date), formatDay(input.costDate))}`,
      );
    }
    if (input.categoria !== undefined && storedCategory(input.categoria) !== current.categoria) {
      linhas.push(
        `${prefix} Categoria: ${arrow(categoryLabel(current.categoria), categoryLabel(input.categoria))}`,
      );
    }
    if (input.repeatMonthly !== current.repeat_monthly) {
      linhas.push(
        `${prefix} Repetir todo mês: ${arrow(yesNo(current.repeat_monthly), yesNo(input.repeatMonthly))}`,
      );
      // saveOtherCostFor applies the change to the series' newest row too.
      const [newest] = snapshot.series;
      if (
        current.series_id &&
        newest &&
        newest.id !== current.id &&
        newest.repeat_monthly !== input.repeatMonthly
      ) {
        avisos.push(
          `A mudança de "Repetir todo mês" vale também para a repetição de ${formatDay(newest.cost_date)}`,
        );
      }
    }
    avisos.push(OVERWRITE);
    return { linhas, avisos };
  },
  apply: (ctx, input) => saveOtherCostFor(ctx, input),
};

type DeleteCostInput = z.infer<typeof deleteOtherCostInput>;

const exclusaoCusto: WriteAction<DeleteCostInput> = {
  schema: deleteOtherCostInput,
  permission: "finance_can_edit_values",
  async snapshot(tenantId, input) {
    const snapshot = await costSnapshot(tenantId, input.id);
    // Same check (and message) as deleteOtherCostFor, at preview time.
    if (input.mode === "skip_month" && (!snapshot.row.series_id || !snapshot.row.repeat_monthly)) {
      throw new Error("Só um custo recorrente pode pular um mês");
    }
    return snapshot;
  },
  describe(before, input, houseName) {
    const { row: current, series } = before as CostSnapshot;
    const day = formatDay(current.cost_date);
    const prefix = `${day} ${houseName} — Custo "${current.descricao}":`;
    if (input.mode === "skip_month") {
      return {
        linhas: [`${prefix} ${arrow(formatMoney(current.valor), formatMoney(0))}`],
        avisos: [`Pula o custo "${current.descricao}" neste mês; a repetição continua`],
      };
    }
    const avisos = [`Vai apagar o custo "${current.descricao}" de ${day}`];
    // Mirrors deleteOtherCostFor: the newest other row of the series stops
    // repeating when the series ends or when the newest row is removed.
    const remaining = current.series_id ? series.find((row) => row.id !== current.id) : undefined;
    const stopRemaining =
      remaining?.repeat_monthly === true &&
      (input.mode === "end_series" || remaining.cost_date < current.cost_date);
    if (stopRemaining && remaining) {
      avisos.push(
        `Encerra a repetição da série: o lançamento de ${formatDay(remaining.cost_date)} deixa de repetir todo mês`,
      );
    } else if (input.mode === "end_series") {
      avisos.push("Encerra a repetição da série");
    }
    return { linhas: [`${prefix} ${arrow(formatMoney(current.valor), EMPTY)}`], avisos };
  },
  apply: (ctx, input) => deleteOtherCostFor(ctx, input),
};

// ─── meta ───────────────────────────────────────────────────────────────────

const METRIC_LABEL: Record<GoalMetric, string> = {
  registrations: "Cadastros",
  ftds: "FTDs",
  deposits: "Depósitos totais",
  net: FINANCE_TERMS.net.label,
  cash_result: FINANCE_TERMS.cashResult.label,
  cost_per_registration: "Custo por cadastro",
  cost_per_ftd: "Custo por FTD",
  roi: "ROI caixa",
};

function formatGoal(metric: GoalMetric, value: number | null) {
  if (value === null) return EMPTY;
  if (metric === "registrations" || metric === "ftds") return value.toLocaleString("pt-BR");
  // ROI is stored as a fraction (0.3 = 30%), see components/group/goal-units.ts.
  if (metric === "roi") return `${Number((value * 100).toFixed(2)).toLocaleString("pt-BR")}%`;
  return formatMoney(value);
}

/**
 * `validFrom` resolved at preview time (default today, São Paulo) so the
 * stored input never moves to another day between preview and confirm; a
 * past date is refused here, as setTenantGoalFor would at confirm.
 */
const goalSchema = setGoalInput
  .transform((input) => ({ ...input, validFrom: input.validFrom ?? todaySaoPaulo() }))
  .refine((input) => input.validFrom >= todaySaoPaulo(), {
    message: "A data de início não pode ser no passado",
    path: ["validFrom"],
  });
type GoalInput = z.infer<typeof goalSchema>;
type GoalSnapshot = { valid_from: string; direction: string; daily_value: number | null } | null;

const meta: WriteAction<GoalInput> = {
  schema: goalSchema,
  permission: "finance_can_manage_goals",
  async snapshot(tenantId, input) {
    // The goal in force on validFrom: the newest row starting on or before it.
    const { data, error } = await db()
      .from<Array<{ valid_from: string; direction: string; daily_value: number | string | null }>>(
        "tenant_goals",
      )
      .select("valid_from,direction,daily_value")
      .eq("tenant_id", tenantId)
      .eq("metric", input.metric)
      .lte("valid_from", input.validFrom)
      .order("valid_from", { ascending: false })
      .range(0, 0);
    if (error) throw new Error(error.message);
    const row = data?.[0];
    const snapshot: GoalSnapshot = row
      ? {
          valid_from: row.valid_from,
          direction: row.direction,
          daily_value: numOrNull(row.daily_value),
        }
      : null;
    return snapshot;
  },
  describe(before, input, houseName) {
    const current = before as GoalSnapshot;
    const was = current?.daily_value ?? null;
    const label = METRIC_LABEL[input.metric];
    const direction = input.direction === "gte" ? "no mínimo" : "no máximo";
    const linhas = [
      `A partir de ${formatDay(input.validFrom)} ${houseName} — Meta diária de ${label} (${direction}): ${arrow(formatGoal(input.metric, was), formatGoal(input.metric, input.dailyValue))}`,
    ];
    const avisos: string[] = [];
    if (input.dailyValue === null && was !== null) {
      avisos.push(`Vai apagar a meta de ${label} a partir de ${formatDay(input.validFrom)}`);
    } else if (was !== null) {
      avisos.push(OVERWRITE);
    }
    return { linhas, avisos };
  },
  apply: (ctx, input) => setTenantGoalFor(ctx, input),
};

// ─── Registry ───────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any -- heterogeneous registry, each entry is typed above. */
export const WRITE_ACTIONS: Record<WriteActionName, WriteAction<any>> = {
  lancamento_dias: lancamentoDias,
  ggr_mensal: ggrMensal,
  custo,
  exclusao_custo: exclusaoCusto,
  meta,
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export const isWriteActionName = (value: string): value is WriteActionName =>
  Object.prototype.hasOwnProperty.call(WRITE_ACTIONS, value);
