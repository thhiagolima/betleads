import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { brtDayEnd, brtDayKey, brtDayStart } from "@/lib/tz";
import { withServerResultCache } from "@/lib/server-result-cache";
import { resolveOperationalTenantForRequest } from "@/lib/tenant-access.server";

const inputSchema = z.object({
  tenantId: z.string().uuid(),
  from: z.string().datetime(),
  to: z.string().datetime(),
});

type DashboardRpc = {
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
  smsCredits?: number;
  pixGenerated?: number;
  previousPixGenerated?: number;
  reactivationQueue?: number;
  activeFlows?: number;
  totalFlows?: number;
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

const SMS_UNIT_COST = 0.196;

function number(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pctChange(current: number, previous: number) {
  if (previous <= 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
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
    const startDate = brtDayStart(new Date(data.from));
    const endDate = brtDayEnd(new Date(data.to));
    const periodMs = brtDayStart(endDate).getTime() - brtDayStart(startDate).getTime();
    const periodDays = Math.max(1, Math.round(periodMs / 86_400_000) + 1);
    const prevEndDate = new Date(startDate.getTime() - 1);
    const prevStartDate = new Date(prevEndDate.getTime() - (periodDays - 1) * 86_400_000);
    const currentDay = brtDayStart(new Date()).getTime();
    const includesToday = brtDayStart(endDate).getTime() >= currentDay;
    const ttlMs = includesToday ? 20_000 : 5 * 60_000;
    const cacheKey = ["dashboard", tenantId, startDate.toISOString(), endDate.toISOString()].join(
      ":",
    );

    return withServerResultCache(cacheKey, ttlMs, async () => {
      const supabase = context.supabase as unknown as DashboardDb;
      if (includesToday) {
        const { error: refreshError } = await supabase.rpc("refresh_dashboard_daily_metric", {
          _tenant: tenantId,
          _date: brtDayKey(new Date()),
        });
        if (refreshError) throw new Error(refreshError.message);
      }

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
        _prev_from: brtDayStart(prevStartDate).toISOString(),
        _prev_to: brtDayEnd(prevEndDate).toISOString(),
        _reset_at: settings?.reset_at ?? "1970-01-01T00:00:00Z",
      });
      if (error) throw new Error(error.message);
      if (!raw) throw new Error("Sem acesso aos dados desta conta.");

      const value = raw as DashboardRpc;
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
      const previousConversion =
        previousNewPlayers > 0 ? (previousFtd / previousNewPlayers) * 100 : 0;
      const ticket = depositCount > 0 ? depositAmount / depositCount : 0;
      const previousTicket =
        previousDepositCount > 0 ? previousDepositAmount / previousDepositCount : 0;
      const redepositAmount = number(value.redepositAmount);
      const recoveredAmount = number(value.recoveredAmount);
      const recoveredNew = number(value.recoveredNew);
      const recoveredReactivated = number(value.recoveredReactivated);
      const smsSent = number(value.smsSent);
      const messageCost = smsSent * SMS_UNIT_COST;

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
        messageCost,
        messageRoi: messageCost > 0 ? recoveredAmount / messageCost : 0,
        withdrawalAmount: number(value.withdrawalAmount),
        cashflowChart: (value.cashflowChart ?? []).map((row) => ({
          ...row,
          deposits: number(row.deposits),
          withdrawals: number(row.withdrawals),
        })),
        pixGenerated: number(value.pixGenerated),
        pixGeneratedGrowth: pctChange(
          number(value.pixGenerated),
          number(value.previousPixGenerated),
        ),
        pixPayRate:
          number(value.pixGenerated) > 0 ? (depositCount / number(value.pixGenerated)) * 100 : 0,
        pixUnpaid: Math.max(0, number(value.pixGenerated) - depositCount),
        reactivationQueue: number(value.reactivationQueue),
        activeFlows: number(value.activeFlows),
        totalFlows: number(value.totalFlows),
        smsSent,
        smsCredits: number(value.smsCredits),
        liveEvents: (value.liveEvents ?? []).slice(0, 8).map((event) => ({
          ...event,
          amount: event.amount == null ? undefined : number(event.amount),
        })),
      };
    });
  });
