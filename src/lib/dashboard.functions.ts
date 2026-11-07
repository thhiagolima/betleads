import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { brtDayEnd, brtDayStart } from "@/lib/tz";
import { withServerResultCache } from "@/lib/server-result-cache";
import { resolveOperationalTenantForRequest } from "@/lib/tenant-access.server";

const inputSchema = z.object({
  tenantId: z.string().uuid(),
  from: z.string().datetime(),
  to: z.string().datetime(),
});

export type DashboardRpc = {
  depositAmount?: number | string;
  previousDepositAmount?: number | string;
  depositCount?: number;
  previousDepositCount?: number;
  depositors?: number;
  previousDepositors?: number;
  newPlayers?: number;
  previousNewPlayers?: number;
  ftd?: number;
  previousFtd?: number;
  withdrawalAmount?: number | string;
  redepositAmount?: number | string;
  previousRedepositAmount?: number | string;
  redepositCount?: number;
  redepositPlayers?: number;
  recoveredAmount?: number | string;
  recoveredPlayers?: number;
  recoveredNew?: number | string;
  recoveredReactivated?: number | string;
  smsSent?: number;
  messageCost?: number | string;
  walletBalance?: number | string;
  exempt?: boolean;
  pixGenerated?: number;
  previousPixGenerated?: number;
  reactivationQueue?: number;
  activeFlows?: number;
  totalFlows?: number;
  pausedFlows?: number;
  cashflowChart?: Array<{
    key: string;
    label: string;
    deposits: number | string;
    withdrawals: number | string;
  }>;
  liveEvents?: Array<{
    id: string;
    tone: "blue" | "green" | "orange" | "purple";
    player: string;
    action: string;
    amount?: number | string | null;
    at: string;
  }>;
};

type DbResult<T = unknown> = {
  data: T | null;
  error: { message: string } | null;
};

type DashboardQuery<T = unknown> = PromiseLike<DbResult<T>> & {
  select: (columns: string) => DashboardQuery<T>;
  eq: (column: string, value: unknown) => DashboardQuery<T>;
  maybeSingle: () => PromiseLike<DbResult<T>>;
};

type DashboardDb = {
  rpc: <T = unknown>(name: string, args: Record<string, unknown>) => PromiseLike<DbResult<T>>;
  from: <T = unknown>(table: string) => DashboardQuery<T>;
};

export const DASHBOARD_REQUEST_TIMEOUT_MS = 25_000;

/**
 * A agregação diária pode aguardar locks do banco durante picos de ingestão.
 * Não deixamos uma requisição HTTP (nem o cache de promises pendentes) prender
 * o dashboard indefinidamente nesse caso.
 */
export function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([work, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function number(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pctChange(current: number, previous: number) {
  if (previous <= 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

/**
 * Período atual e anterior do Início, a partir do intervalo escolhido no
 * PeriodPicker: dias inteiros de Brasília, o período anterior com o mesmo
 * número de dias logo antes, e o TTL do cache (curto quando inclui hoje).
 * Compartilhado com o Início do expert (expert-home.functions.ts).
 */
export function dashboardPeriodBounds(from: string, to: string, now: Date = new Date()) {
  const startDate = brtDayStart(new Date(from));
  const endDate = brtDayEnd(new Date(to));
  const periodMs = brtDayStart(endDate).getTime() - brtDayStart(startDate).getTime();
  const periodDays = Math.max(1, Math.round(periodMs / 86_400_000) + 1);
  const prevEndDate = new Date(startDate.getTime() - 1);
  const prevStartDate = new Date(prevEndDate.getTime() - (periodDays - 1) * 86_400_000);
  const currentDay = brtDayStart(now).getTime();
  const includesToday = brtDayStart(endDate).getTime() >= currentDay;
  return {
    startDate,
    endDate,
    periodDays,
    prevFrom: brtDayStart(prevStartDate).toISOString(),
    prevTo: brtDayEnd(prevEndDate).toISOString(),
    ttlMs: includesToday ? 20_000 : 5 * 60_000,
  };
}

/**
 * The part of the home payload that only depends on players and their
 * money (deposits, withdrawals, PIX, recovered, journeys queue, live feed).
 * Shared by the house home (`mapDashboardRpc`) and the expert home
 * (`expert_home_summary`, already scoped to the expert's leads), which has
 * none of the house-only fields (SMS cost, wallet, journey counts).
 */
export function mapLeadScopedDashboardRpc(value: DashboardRpc, periodDays: number) {
  const depositAmount = number(value.depositAmount);
  const previousDepositAmount = number(value.previousDepositAmount);
  const depositCount = number(value.depositCount);
  const previousDepositCount = number(value.previousDepositCount);
  const depositors = number(value.depositors);
  const previousDepositors = number(value.previousDepositors);
  const newPlayers = number(value.newPlayers);
  const previousNewPlayers = number(value.previousNewPlayers);
  const ftd = number(value.ftd);
  const previousFtd = number(value.previousFtd);
  const conversion = newPlayers > 0 ? (ftd / newPlayers) * 100 : 0;
  const previousConversion = previousNewPlayers > 0 ? (previousFtd / previousNewPlayers) * 100 : 0;
  const ticket = depositCount > 0 ? depositAmount / depositCount : 0;
  const previousTicket =
    previousDepositCount > 0 ? previousDepositAmount / previousDepositCount : 0;
  const redepositAmount = number(value.redepositAmount);
  const recoveredAmount = number(value.recoveredAmount);
  const recoveredNew = number(value.recoveredNew);
  const recoveredReactivated = number(value.recoveredReactivated);

  return {
    periodDays,
    depositAmount,
    depositGrowth: pctChange(depositAmount, previousDepositAmount),
    depositCount,
    depositors,
    depositorsGrowth: pctChange(depositors, previousDepositors),
    newPlayers,
    newPlayersGrowth: pctChange(newPlayers, previousNewPlayers),
    ftd,
    ftdGrowth: pctChange(ftd, previousFtd),
    conversion,
    conversionGrowth: conversion - previousConversion,
    ticket,
    ticketGrowth: pctChange(ticket, previousTicket),
    redepositAmount,
    redepositCount: number(value.redepositCount),
    redepositPlayers: number(value.redepositPlayers),
    redepositGrowth: pctChange(redepositAmount, number(value.previousRedepositAmount)),
    recoveredAmount,
    recoveredNew,
    recoveredReactivated,
    recoveredReturning: Math.max(0, recoveredAmount - recoveredNew - recoveredReactivated),
    recoveredPlayers: number(value.recoveredPlayers),
    withdrawalAmount: number(value.withdrawalAmount),
    cashflowChart: (value.cashflowChart ?? []).map((row) => ({
      ...row,
      deposits: number(row.deposits),
      withdrawals: number(row.withdrawals),
    })),
    pixGenerated: number(value.pixGenerated),
    pixGeneratedGrowth: pctChange(number(value.pixGenerated), number(value.previousPixGenerated)),
    pixPayRate:
      number(value.pixGenerated) > 0 ? (depositCount / number(value.pixGenerated)) * 100 : 0,
    pixUnpaid: Math.max(0, number(value.pixGenerated) - depositCount),
    reactivationQueue: number(value.reactivationQueue),
    liveEvents: (value.liveEvents ?? []).slice(0, 8).map((event) => ({
      ...event,
      amount: event.amount == null ? undefined : number(event.amount),
    })),
  };
}

export type LeadScopedDashboard = ReturnType<typeof mapLeadScopedDashboardRpc>;

/**
 * Maps the raw `dashboard_summary_v2` RPC payload to the shape the home
 * dashboard consumes. Pulled out of the handler (PG1 final review, item 1)
 * so the new wallet/exempt fields and the removed legacy-credit fallback
 * can be unit tested without going through requireSupabaseAuth/Supabase.
 * The lead-scoped part lives in `mapLeadScopedDashboardRpc` (shared with
 * the expert home); this adds the house-only fields on top.
 */
export function mapDashboardRpc(value: DashboardRpc, periodDays: number) {
  const base = mapLeadScopedDashboardRpc(value, periodDays);
  const smsSent = number(value.smsSent);
  // smsSent/messageCost now come straight from crm_results_daily
  // (already on the price book and billed_units -- segments, not
  // sends -- since Task 6), so there's no fallback to compute here.
  const messageCost = number(value.messageCost);

  return {
    ...base,
    messageCost,
    messageRoi: messageCost > 0 ? base.recoveredAmount / messageCost : 0,
    activeFlows: number(value.activeFlows),
    totalFlows: number(value.totalFlows),
    pausedFlows: number(value.pausedFlows),
    smsSent,
    walletBalance: number(value.walletBalance),
    exempt: value.exempt === true,
  };
}

export const getDashboardSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => inputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantForRequest(
      context.supabase,
      context.userId,
      data.tenantId,
    );
    const { startDate, endDate, periodDays, prevFrom, prevTo, ttlMs } = dashboardPeriodBounds(
      data.from,
      data.to,
    );
    const cacheKey = ["dashboard", tenantId, startDate.toISOString(), endDate.toISOString()].join(
      ":",
    );

    return withServerResultCache(cacheKey, ttlMs, () =>
      withTimeout(
        (async () => {
          const supabase = context.supabase as unknown as DashboardDb;
          const { data: settings, error: settingsError } = await supabase
            .from("dashboard_settings")
            .select("reset_at")
            .eq("tenant_id", tenantId)
            .eq("id", "global")
            .maybeSingle();
          if (settingsError) throw new Error(settingsError.message);

          const { data: raw, error } = await supabase.rpc("dashboard_summary_v2", {
            _tenant: tenantId,
            _from: startDate.toISOString(),
            _to: endDate.toISOString(),
            _prev_from: prevFrom,
            _prev_to: prevTo,
            _reset_at:
              (settings as { reset_at?: string } | null)?.reset_at ?? "1970-01-01T00:00:00Z",
          });
          if (error) throw new Error(error.message);
          if (!raw) throw new Error("Sem acesso aos dados desta conta.");

          return mapDashboardRpc(raw as DashboardRpc, periodDays);
        })(),
        DASHBOARD_REQUEST_TIMEOUT_MS,
        "O painel demorou mais que o esperado para responder. Tente novamente.",
      ),
    );
  });
