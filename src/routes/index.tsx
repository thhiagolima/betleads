import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { ElementType, ReactNode } from "react";
import { type DateRange } from "react-day-picker";
import {
  CalendarIcon,
  ChevronRight,
  CircleDollarSign,
  CreditCard,
  Filter,
  Gem,
  Home,
  LayoutDashboard,
  Layers,
  MessageSquare,
  RefreshCw,
  Repeat2,
  Sparkles,
  Target,
  TrendingUp,
  UserPlus,
  Users,
  Zap,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { supabase } from "@/integrations/supabase/client";
import { brl, num, timeAgo } from "@/lib/format";
import { brtDayEnd, brtDayStart } from "@/lib/tz";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

type PeriodPreset = "today" | "yesterday" | "7d" | "30d" | "this_month" | "last_month";

type TotalsRpc = {
  deposits_period_sum?: number | string;
  deposits_period_count?: number | string;
  depositantes_period?: number | string;
  sacado_total_since_reset?: number | string;
  deposits_series_30d?: Array<{ day: string; value: number | string }>;
  top_depositante_period?: { nome: string; total: number | string } | null;
};

type PlayerRow = {
  id: string;
  nome: string;
  created_at: string;
  ftd_em: string | null;
  ultimo_login: string | null;
  total_depositado: number | string | null;
  total_sacado: number | string | null;
};

type MoneyRow = {
  id?: string;
  player_id: string | null;
  valor: number | string | null;
  created_at: string;
  status?: string | null;
};

type LiveEvent = {
  id: string;
  tone: "blue" | "green" | "orange" | "purple";
  player: string;
  action: string;
  amount?: number;
  at: string;
};

type LooseRpcClient = {
  rpc: <T = unknown>(
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: T | null; error: { message: string } | null }>;
};

const SMS_UNIT_COST = 0.196;
const DEFAULT_SMS_CREDITS = 6500;

function looseRpc(client: unknown) {
  return client as LooseRpcClient;
}

function brtDayKeyLocal(d: Date) {
  return d
    .toLocaleString("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    .slice(0, 10);
}

function dayLabel(date: Date | string) {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
  });
}

function fullDate(date: Date) {
  return date.toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
  });
}

function periodRange(preset: PeriodPreset): DateRange {
  const today = new Date();
  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);

  if (preset === "today") return { from: today, to: today };
  if (preset === "yesterday") {
    const d = new Date(Date.now() - 86400000);
    return { from: d, to: d };
  }
  if (preset === "30d") {
    return { from: new Date(Date.now() - 29 * 86400000), to: today };
  }
  if (preset === "this_month") return { from: startOfMonth, to: today };
  if (preset === "last_month") return { from: lastMonthStart, to: lastMonthEnd };
  return { from: new Date(Date.now() - 6 * 86400000), to: today };
}

function pctChange(current: number, previous: number) {
  if (previous <= 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

function fmtPct(value: number, digits = 1) {
  return `${value.toLocaleString("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;
}

function sumMoney(rows: MoneyRow[]) {
  return rows.reduce((acc, row) => acc + Number(row.valor ?? 0), 0);
}

function buildDaySeries(from: Date, to: Date) {
  const days: Array<{ key: string; label: string; deposits: number; withdrawals: number }> = [];
  const cursor = new Date(brtDayStart(from));
  const end = brtDayStart(to).getTime();

  while (cursor.getTime() <= end) {
    days.push({
      key: brtDayKeyLocal(cursor),
      label: dayLabel(cursor),
      deposits: 0,
      withdrawals: 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  return days;
}

function playerName(id: string | null, names: Map<string, string>) {
  if (!id) return "jogador";
  return names.get(id) ?? "jogador";
}

async function fetchDashboard(range: { from: Date; to: Date }, tenantId: string) {
  const startDate = brtDayStart(range.from);
  const endDate = brtDayEnd(range.to);
  const iso = startDate.toISOString();
  const isoEnd = endDate.toISOString();
  const periodMs = brtDayStart(range.to).getTime() - brtDayStart(range.from).getTime();
  const periodDays = Math.max(1, Math.round(periodMs / 86400000) + 1);
  const prevEndDate = new Date(startDate.getTime() - 1);
  const prevStartDate = new Date(prevEndDate.getTime() - (periodDays - 1) * 86400000);
  const prevIso = brtDayStart(prevStartDate).toISOString();
  const prevIsoEnd = brtDayEnd(prevEndDate).toISOString();
  const T = tenantId;

  const resetRes = await supabase
    .from("dashboard_settings")
    .select("reset_at")
    .eq("id", "global")
    .maybeSingle();
  const resetAt = (resetRes.data?.reset_at as string) ?? "1970-01-01T00:00:00Z";

  const [
    totalsAgg,
    prevTotalsAgg,
    playersPeriod,
    prevPlayersPeriod,
    ftdPeriod,
    prevFtdPeriod,
    allPlayersRes,
    depositsPeriodRes,
    withdrawalsPeriodRes,
    smsLogsRes,
    smsCreditSummaryRes,
    followupsRes,
    flowsRes,
    recentPlayersRes,
    recentDepositsRes,
    recentWithdrawalsRes,
    recentEventsRes,
  ] = await Promise.all([
    supabase.rpc("dashboard_totals", {
      _tenant: T,
      _from: iso,
      _to: isoEnd,
      _reset_at: resetAt,
    }),
    supabase.rpc("dashboard_totals", {
      _tenant: T,
      _from: prevIso,
      _to: prevIsoEnd,
      _reset_at: resetAt,
    }),
    supabase
      .from("players")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", T)
      .gte("created_at", iso)
      .lte("created_at", isoEnd),
    supabase
      .from("players")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", T)
      .gte("created_at", prevIso)
      .lte("created_at", prevIsoEnd),
    supabase
      .from("players")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", T)
      .not("ftd_em", "is", null)
      .gte("ftd_em", iso)
      .lte("ftd_em", isoEnd),
    supabase
      .from("players")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", T)
      .not("ftd_em", "is", null)
      .gte("ftd_em", prevIso)
      .lte("ftd_em", prevIsoEnd),
    supabase
      .from("players")
      .select("id,nome,created_at,ftd_em,ultimo_login,total_depositado,total_sacado")
      .eq("tenant_id", T)
      .range(0, 19999),
    supabase
      .from("deposits")
      .select("id,player_id,valor,created_at,status")
      .eq("tenant_id", T)
      .eq("status", "aprovado")
      .gte("created_at", iso)
      .lte("created_at", isoEnd)
      .limit(50000),
    supabase
      .from("withdrawals")
      .select("id,player_id,valor,created_at,status")
      .eq("tenant_id", T)
      .eq("status", "aprovado")
      .gte("created_at", iso)
      .lte("created_at", isoEnd)
      .limit(50000),
    supabase
      .from("sms_send_logs")
      .select("id,player_id,created_at,status,delivery_status")
      .eq("tenant_id", T)
      .gte("created_at", iso)
      .lte("created_at", isoEnd)
      .limit(50000),
    looseRpc(supabase).rpc("sms_credit_summary", { _tenant: T }),
    supabase
      .from("lead_followups")
      .select("id,player_id,created_at,acao")
      .eq("tenant_id", T)
      .lte("created_at", isoEnd)
      .gte("created_at", new Date(startDate.getTime() - 30 * 86400000).toISOString())
      .limit(50000),
    supabase.from("sms_flows").select("id,is_active").eq("tenant_id", T),
    supabase
      .from("players")
      .select("id,nome,created_at")
      .eq("tenant_id", T)
      .order("created_at", { ascending: false })
      .limit(12),
    supabase
      .from("deposits")
      .select("id,player_id,valor,created_at")
      .eq("tenant_id", T)
      .eq("status", "aprovado")
      .order("created_at", { ascending: false })
      .limit(12),
    supabase
      .from("withdrawals")
      .select("id,player_id,valor,created_at")
      .eq("tenant_id", T)
      .eq("status", "aprovado")
      .order("created_at", { ascending: false })
      .limit(12),
    supabase
      .from("events")
      .select("id,player_id,valor,created_at,tipo")
      .eq("tenant_id", T)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const totals = (totalsAgg.data ?? {}) as TotalsRpc;
  const prevTotals = (prevTotalsAgg.data ?? {}) as TotalsRpc;
  const allPlayers = (allPlayersRes.data ?? []) as PlayerRow[];
  const deposits = (depositsPeriodRes.data ?? []) as MoneyRow[];
  const withdrawals = (withdrawalsPeriodRes.data ?? []) as MoneyRow[];
  const smsLogs = smsLogsRes.data ?? [];
  const smsCreditSummary = (smsCreditSummaryRes.data ?? {}) as {
    balance_credits?: number | string;
  };
  const followups = followupsRes.data ?? [];
  const flows = flowsRes.data ?? [];

  const names = new Map<string, string>();
  allPlayers.forEach((p) => names.set(p.id, p.nome));
  (recentPlayersRes.data ?? []).forEach((p) => names.set(p.id, p.nome));

  const depositAmount = Number(totals.deposits_period_sum ?? 0);
  const previousDepositAmount = Number(prevTotals.deposits_period_sum ?? 0);
  const depositCount = Number(totals.deposits_period_count ?? deposits.length);
  const previousDepositCount = Number(prevTotals.deposits_period_count ?? 0);
  const depositors = Number(totals.depositantes_period ?? 0);
  const previousDepositors = Number(prevTotals.depositantes_period ?? 0);
  const newPlayers = playersPeriod.count ?? 0;
  const previousNewPlayers = prevPlayersPeriod.count ?? 0;
  const ftd = ftdPeriod.count ?? 0;
  const previousFtd = prevFtdPeriod.count ?? 0;
  const withdrawalAmount = sumMoney(withdrawals);
  const ticket = depositCount > 0 ? depositAmount / depositCount : 0;
  const prevTicket = previousDepositCount > 0 ? previousDepositAmount / previousDepositCount : 0;
  const conversion = newPlayers > 0 ? (ftd / newPlayers) * 100 : 0;
  const prevConversion = previousNewPlayers > 0 ? (previousFtd / previousNewPlayers) * 100 : 0;

  const playersById = new Map(allPlayers.map((p) => [p.id, p]));
  const redeposits = deposits.filter((d) => {
    if (!d.player_id) return false;
    const p = playersById.get(d.player_id);
    if (!p?.ftd_em) return false;
    return new Date(d.created_at).getTime() - new Date(p.ftd_em).getTime() > 60000;
  });
  const redepositAmount = sumMoney(redeposits);
  const redepositCount = redeposits.length;
  const redepositPlayers = new Set(redeposits.map((d) => d.player_id).filter(Boolean)).size;

  const followupByPlayer = new Map<string, string>();
  followups.forEach((f) => {
    const previous = followupByPlayer.get(f.player_id);
    if (!previous || f.created_at < previous) followupByPlayer.set(f.player_id, f.created_at);
  });
  const recoveredDeposits = deposits.filter((d) => {
    if (!d.player_id) return false;
    const firstFollowup = followupByPlayer.get(d.player_id);
    return !!firstFollowup && firstFollowup <= d.created_at;
  });
  const recoveredAmount = sumMoney(recoveredDeposits);
  const recoveredPlayers = new Set(recoveredDeposits.map((d) => d.player_id).filter(Boolean)).size;
  const recoveredNew = recoveredDeposits
    .filter((d) => d.player_id && playersById.get(d.player_id)?.created_at >= iso)
    .reduce((acc, d) => acc + Number(d.valor ?? 0), 0);
  const recoveredReactivated = recoveredDeposits
    .filter((d) => d.player_id && !playersById.get(d.player_id)?.ftd_em)
    .reduce((acc, d) => acc + Number(d.valor ?? 0), 0);
  const recoveredReturning = Math.max(0, recoveredAmount - recoveredNew - recoveredReactivated);
  const messageCost = smsLogs.length * SMS_UNIT_COST;
  const messageRoi = messageCost > 0 ? recoveredAmount / messageCost : 0;

  const daySeries = buildDaySeries(startDate, endDate);
  const dayMap = new Map(daySeries.map((row) => [row.key, row]));
  deposits.forEach((d) => {
    const row = dayMap.get(brtDayKeyLocal(new Date(d.created_at)));
    if (row) row.deposits += Number(d.valor ?? 0);
  });
  withdrawals.forEach((w) => {
    const row = dayMap.get(brtDayKeyLocal(new Date(w.created_at)));
    if (row) row.withdrawals += Number(w.valor ?? 0);
  });

  const eventRows = recentEventsRes.data ?? [];
  const pixEvents = eventRows.filter((e) => {
    const kind = String(e.tipo ?? "").toLowerCase();
    return kind.includes("pix") || kind.includes("deposit");
  });
  const pixGenerated = Math.max(depositCount, pixEvents.length);
  const pixUnpaid = Math.max(0, pixGenerated - depositCount);
  const pixPayRate = pixGenerated > 0 ? (depositCount / pixGenerated) * 100 : 0;

  const liveEvents: LiveEvent[] = [
    ...(recentPlayersRes.data ?? []).map((p) => ({
      id: `player-${p.id}`,
      tone: "blue" as const,
      player: p.nome,
      action: "criou conta",
      at: p.created_at,
    })),
    ...(recentDepositsRes.data ?? []).map((d) => ({
      id: `deposit-${d.id}`,
      tone: "green" as const,
      player: playerName(d.player_id, names),
      action: "depositou",
      amount: Number(d.valor ?? 0),
      at: d.created_at,
    })),
    ...(recentWithdrawalsRes.data ?? []).map((w) => ({
      id: `withdrawal-${w.id}`,
      tone: "purple" as const,
      player: playerName(w.player_id, names),
      action: "sacou",
      amount: Number(w.valor ?? 0),
      at: w.created_at,
    })),
    ...pixEvents.slice(0, 8).map((e) => ({
      id: `event-${e.id}`,
      tone: "orange" as const,
      player: playerName(e.player_id, names),
      action: "gerou um PIX",
      amount: Number(e.valor ?? 0),
      at: e.created_at,
    })),
  ]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 8);

  const activeFlows = flows.filter((flow) => flow.is_active).length;
  const totalFlows = flows.length;
  const reactivationQueue = allPlayers.filter((p) => {
    if (!p.ultimo_login) return false;
    const lastLogin = new Date(p.ultimo_login).getTime();
    return Date.now() - lastLogin > 7 * 86400000;
  }).length;

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
    conversionGrowth: conversion - prevConversion,
    ticket,
    ticketGrowth: pctChange(ticket, prevTicket),
    redepositAmount,
    redepositCount,
    redepositPlayers,
    redepositGrowth: pctChange(redepositAmount, previousDepositAmount),
    recoveredAmount,
    recoveredNew,
    recoveredReactivated,
    recoveredReturning,
    recoveredPlayers,
    messageCost,
    messageRoi,
    withdrawalAmount,
    cashflowChart: daySeries,
    pixGenerated,
    pixPayRate,
    pixUnpaid,
    reactivationQueue,
    activeFlows,
    totalFlows,
    smsSent: smsLogs.length,
    smsCredits: Number(
      smsCreditSummary.balance_credits ?? Math.max(0, DEFAULT_SMS_CREDITS - smsLogs.length),
    ),
    liveEvents,
  };
}

function ShellCard({
  title,
  subtitle,
  icon: Icon,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  icon?: ElementType;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={`border-border/70 bg-card/70 ${className}`}>
      <CardHeader className="border-b border-border/60 pb-4">
        <div className="flex items-start gap-3">
          {Icon && (
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <Icon className="h-5 w-5" />
            </div>
          )}
          <div>
            <CardTitle className="text-lg">{title}</CardTitle>
            {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-5">{children}</CardContent>
    </Card>
  );
}

function KpiCard({
  title,
  value,
  detail,
  trend,
  icon: Icon,
  tone = "blue",
  featured = false,
  children,
}: {
  title: string;
  value: string;
  detail: string;
  trend?: number;
  icon: ElementType;
  tone?: "blue" | "green" | "purple" | "orange";
  featured?: boolean;
  children?: ReactNode;
}) {
  const toneClass = {
    blue: "bg-blue-500/15 text-blue-400",
    green: "bg-emerald-500/15 text-emerald-400",
    purple: "bg-violet-500/15 text-violet-400",
    orange: "bg-amber-500/15 text-amber-400",
  }[tone];

  return (
    <Card
      className={`min-h-[150px] border-border/70 bg-card/80 ${
        featured ? "border-emerald-500/50 bg-emerald-950/20" : ""
      }`}
    >
      <CardContent className="relative h-full p-5">
        <div className="flex items-center gap-3">
          <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${toneClass}`}>
            <Icon className="h-5 w-5" />
          </div>
          <p className="text-sm font-semibold text-primary-foreground/80">{title}</p>
        </div>
        <div className="mt-4 flex items-end justify-between gap-4">
          <div>
            <p className="text-3xl font-bold tracking-tight text-foreground">{value}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              {typeof trend === "number" && (
                <span className="font-semibold text-emerald-400">
                  ↑ {fmtPct(Math.max(0, trend))}
                </span>
              )}
              <span>{detail}</span>
            </div>
          </div>
          {children}
        </div>
      </CardContent>
    </Card>
  );
}

function TinySparkline({
  data,
  color = "oklch(0.68 0.21 253)",
}: {
  data: Array<{ value: number }>;
  color?: string;
}) {
  return (
    <div className="h-16 w-28 shrink-0">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2.4} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function PeriodButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant={active ? "default" : "secondary"}
      className={`h-14 rounded-xl px-6 text-base font-semibold ${
        active ? "bg-blue-600 hover:bg-blue-600/90" : "bg-card"
      }`}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function InfoRow({
  icon: Icon,
  label,
  value,
  detail,
  tone = "blue",
  trend,
  chevron = false,
}: {
  icon: ElementType;
  label: string;
  value: string;
  detail?: string;
  tone?: "blue" | "green" | "orange" | "red" | "purple";
  trend?: string;
  chevron?: boolean;
}) {
  const toneClass = {
    blue: "bg-blue-500/15 text-blue-400",
    green: "bg-emerald-500/15 text-emerald-400",
    orange: "bg-amber-500/15 text-amber-400",
    red: "bg-red-500/15 text-red-400",
    purple: "bg-violet-500/15 text-violet-400",
  }[tone];
  return (
    <div className="flex items-center gap-4 py-3">
      <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${toneClass}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-base text-foreground/90">{label}</p>
        {detail && <p className="text-sm text-muted-foreground">{detail}</p>}
      </div>
      <div className="flex items-center gap-3 text-right">
        <p className="text-lg font-bold text-foreground">{value}</p>
        {trend && <span className="text-sm font-semibold text-emerald-400">{trend}</span>}
        {chevron && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </div>
    </div>
  );
}

function LiveFeed({ events }: { events: LiveEvent[] }) {
  const dotClass = {
    blue: "bg-blue-400",
    green: "bg-emerald-400",
    orange: "bg-amber-400",
    purple: "bg-violet-400",
  };
  return (
    <Card className="border-border/70 bg-card/80">
      <CardHeader className="border-b border-border/60">
        <CardTitle className="text-lg">Ao vivo</CardTitle>
        <p className="text-sm text-muted-foreground">Evento cru da plataforma, sem espera</p>
      </CardHeader>
      <CardContent className="grid gap-x-8 p-0 md:grid-cols-2">
        {events.length === 0 ? (
          <div className="p-5 text-sm text-muted-foreground">
            Ainda sem eventos recentes para exibir.
          </div>
        ) : (
          events.map((event) => (
            <div
              key={event.id}
              className="flex items-center gap-3 border-b border-border/60 px-5 py-4"
            >
              <span className={`h-2 w-2 rounded-full ${dotClass[event.tone]}`} />
              <p className="min-w-0 flex-1 truncate text-base">
                <strong>{event.player}</strong> {event.action}
              </p>
              {typeof event.amount === "number" && event.amount > 0 && (
                <strong>{brl(event.amount)}</strong>
              )}
              <span className="text-sm text-muted-foreground">{timeAgo(event.at)}</span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function Dashboard() {
  const [preset, setPreset] = useState<PeriodPreset>("7d");
  const [range, setRange] = useState<DateRange | undefined>(() => periodRange("7d"));
  const [open, setOpen] = useState(false);

  const from = range?.from ?? new Date();
  const to = range?.to ?? from;

  const { data: tenants } = useQuery({
    queryKey: ["accessible-tenants"],
    queryFn: async () => {
      const { data } = await supabase.from("tenants").select("id, nome").order("nome");
      return (data ?? []) as Array<{ id: string; nome: string }>;
    },
    staleTime: 5 * 60_000,
  });

  const STORAGE_KEY = "dashboard:active_tenant";
  const [activeTenantId, setActiveTenantIdRaw] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(STORAGE_KEY);
  });
  const tenantId =
    tenants && tenants.length > 0
      ? activeTenantId && tenants.some((t) => t.id === activeTenantId)
        ? activeTenantId
        : tenants[0].id
      : null;
  const activeTenant = tenants?.find((t) => t.id === tenantId);
  const tenantName = activeTenant?.nome ?? "SorteAlta";
  const setActiveTenantId = (id: string) => {
    setActiveTenantIdRaw(id);
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, id);
  };

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["dashboard", tenantId, brtDayKeyLocal(from), brtDayKeyLocal(to)],
    queryFn: () => fetchDashboard({ from, to }, tenantId as string),
    enabled: !!tenantId,
    refetchInterval: 15000,
  });

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return "Bom dia";
    if (hour < 18) return "Boa tarde";
    return "Boa noite";
  }, []);

  const sparkline = useMemo(
    () => (data?.cashflowChart ?? []).map((row) => ({ value: row.deposits })),
    [data?.cashflowChart],
  );

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24" />
        <div className="grid gap-4 md:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      </div>
    );
  }

  const applyPreset = (next: PeriodPreset) => {
    setPreset(next);
    setRange(periodRange(next));
    setOpen(false);
  };

  const rangeText = `${fullDate(from)} a ${fullDate(to)}`;
  const readText = `lido às ${new Date().toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;

  return (
    <div className="space-y-6 pb-8">
      <header className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-white">
              <Home className="h-5 w-5" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight">
              {greeting}, {tenantName}
            </h1>
          </div>
          <p className="mt-2 text-base text-muted-foreground">
            Aqui está o resumo da sua operação {rangeText}.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {tenants && tenants.length > 1 && (
            <Select value={tenantId ?? undefined} onValueChange={setActiveTenantId}>
              <SelectTrigger className="h-11 w-[220px] rounded-xl">
                <SelectValue placeholder="Selecione o tenant" />
              </SelectTrigger>
              <SelectContent>
                {tenants.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.nome}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            variant="secondary"
            size="icon"
            className="h-11 w-11 rounded-full"
            onClick={() => void refetch()}
          >
            <RefreshCw className={`h-5 w-5 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
          <Badge className="h-9 gap-2 rounded-full bg-emerald-500/15 px-4 text-emerald-400 hover:bg-emerald-500/15">
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            Ao vivo
          </Badge>
          <Badge
            variant="outline"
            className="h-11 gap-2 rounded-xl border-border/80 bg-card px-4 text-sm text-muted-foreground"
          >
            <CreditCard className="h-4 w-4" />
            {num(data.smsCredits)} créditos de SMS
          </Badge>
          <Button variant="outline" size="icon" className="h-11 w-11 rounded-xl">
            <Sparkles className="h-5 w-5" />
          </Button>
        </div>
      </header>

      <Card className="border-emerald-500/35 bg-emerald-950/25">
        <CardContent className="flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
              <Target className="h-6 w-6" />
            </div>
            <p className="text-base text-foreground/90">
              <strong className="text-emerald-400">Insight</strong> O CRM recuperou{" "}
              {brl(data.recoveredAmount)} com {brl(data.messageCost)} de mensagem —{" "}
              {data.messageRoi > 0 ? `${data.messageRoi.toFixed(1)}x` : "0x"} o que custou.
            </p>
          </div>
          <Button variant="outline" className="h-12 rounded-xl px-6 font-semibold">
            Ver relatórios completos
          </Button>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <PeriodButton active={preset === "today"} onClick={() => applyPreset("today")}>
          Hoje
        </PeriodButton>
        <PeriodButton active={preset === "yesterday"} onClick={() => applyPreset("yesterday")}>
          Ontem
        </PeriodButton>
        <PeriodButton active={preset === "7d"} onClick={() => applyPreset("7d")}>
          7 dias
        </PeriodButton>
        <PeriodButton active={preset === "30d"} onClick={() => applyPreset("30d")}>
          30 dias
        </PeriodButton>
        <PeriodButton active={preset === "this_month"} onClick={() => applyPreset("this_month")}>
          Este mês
        </PeriodButton>
        <PeriodButton active={preset === "last_month"} onClick={() => applyPreset("last_month")}>
          Mês passado
        </PeriodButton>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="secondary"
              className="h-14 gap-2 rounded-xl bg-card px-6 text-base font-semibold"
            >
              <CalendarIcon className="h-4 w-4" />
              Escolher datas
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-0">
            <Calendar
              mode="range"
              selected={range}
              onSelect={(next) => {
                setRange(next);
                setPreset("7d");
              }}
              numberOfMonths={2}
              initialFocus
            />
          </PopoverContent>
        </Popover>
        <p className="text-sm text-muted-foreground">
          {rangeText} · {readText} · ainda entrando
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          title="Depositado"
          value={brl(data.depositAmount)}
          trend={data.depositGrowth}
          detail={`vs ${data.periodDays} dias anteriores`}
          icon={CircleDollarSign}
          tone="blue"
        >
          <TinySparkline data={sparkline} />
        </KpiCard>
        <KpiCard
          title="Depositantes"
          value={num(data.depositors)}
          trend={data.depositorsGrowth}
          detail={`vs os ${data.periodDays} dias anteriores`}
          icon={Users}
          tone="blue"
        />
        <KpiCard
          title="Novos clientes"
          value={num(data.newPlayers)}
          trend={data.newPlayersGrowth}
          detail={`vs os ${data.periodDays} dias anteriores`}
          icon={UserPlus}
          tone="purple"
        />
        <KpiCard
          title="Primeiros depósitos (FTD)"
          value={num(data.ftd)}
          trend={data.ftdGrowth}
          detail={`vs os ${data.periodDays} dias anteriores`}
          icon={Gem}
          tone="purple"
        />
        <KpiCard
          title="Conversão cadastro → FTD"
          value={fmtPct(data.conversion)}
          trend={data.conversionGrowth}
          detail={`${num(data.ftd)} de ${num(data.newPlayers)} cadastros`}
          icon={Filter}
          tone="purple"
        />
        <KpiCard
          title="Ticket médio"
          value={brl(data.ticket)}
          trend={data.ticketGrowth}
          detail={`${num(data.depositCount)} depósitos`}
          icon={CreditCard}
          tone="blue"
        />
        <KpiCard
          title="Redepósitos"
          value={brl(data.redepositAmount)}
          trend={data.redepositGrowth}
          detail={`${num(data.redepositCount)} depósitos · ${num(data.redepositPlayers)} jogadores`}
          icon={Repeat2}
          tone="green"
        />
        <KpiCard
          title="Recuperado pelo CRM"
          value={brl(data.recoveredAmount)}
          detail={`${brl(data.recoveredNew)} novos · ${brl(data.recoveredReactivated)} reativados · ${brl(data.recoveredReturning)} de quem já jogava`}
          icon={Target}
          tone="green"
          featured
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <ShellCard
          title="Depósitos e saques ao longo do período"
          subtitle={`${data.periodDays} dias · fuso de São Paulo`}
        >
          <div className="h-[360px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.cashflowChart}>
                <defs>
                  <linearGradient id="depositGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="oklch(0.68 0.21 253)" stopOpacity={0.32} />
                    <stop offset="100%" stopColor="oklch(0.68 0.21 253)" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="withdrawGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="oklch(0.72 0.18 150)" stopOpacity={0.22} />
                    <stop offset="100%" stopColor="oklch(0.72 0.18 150)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="oklch(1 0 0 / 0.07)" vertical={false} />
                <XAxis
                  dataKey="label"
                  stroke="oklch(0.65 0.03 250)"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke="oklch(0.65 0.03 250)"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => brl(Number(v))}
                  width={82}
                />
                <Tooltip
                  contentStyle={{
                    background: "oklch(0.16 0.025 260)",
                    border: "1px solid oklch(1 0 0 / 0.1)",
                    borderRadius: 10,
                    fontSize: 12,
                  }}
                  formatter={(value: number, name: string) => [
                    brl(Number(value)),
                    name === "deposits" ? "Depósitos" : "Saques",
                  ]}
                />
                <Area
                  type="monotone"
                  dataKey="deposits"
                  stroke="oklch(0.68 0.21 253)"
                  strokeWidth={3}
                  fill="url(#depositGrad)"
                  dot={{ r: 3, fill: "oklch(0.68 0.21 253)" }}
                />
                <Area
                  type="monotone"
                  dataKey="withdrawals"
                  stroke="oklch(0.72 0.18 150)"
                  strokeWidth={3}
                  fill="url(#withdrawGrad)"
                  dot={{ r: 3, fill: "oklch(0.72 0.18 150)" }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </ShellCard>

        <ShellCard title="Funil de aquisição" subtitle="do cadastro ao depósito" icon={Filter}>
          <div className="space-y-7">
            {[
              {
                label: "Cadastros",
                value: data.newPlayers,
                pct: 100,
                color: "bg-violet-500",
              },
              {
                label: "Primeiros depósitos",
                value: data.ftd,
                pct: data.conversion,
                color: "bg-blue-500",
              },
              {
                label: "Depositantes",
                value: data.depositors,
                pct: data.newPlayers > 0 ? (data.depositors / data.newPlayers) * 100 : 0,
                color: "bg-emerald-500",
              },
            ].map((row) => (
              <div key={row.label} className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-foreground/90">{row.label}</span>
                  <span className="text-sm font-semibold text-muted-foreground">
                    {fmtPct(row.pct)}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <strong className="w-20 text-2xl">{num(row.value)}</strong>
                  <div className="h-2 flex-1 rounded-full bg-muted/40">
                    <div
                      className={`h-full rounded-full ${row.color}`}
                      style={{ width: `${Math.min(100, Math.max(0, row.pct))}%` }}
                    />
                  </div>
                </div>
              </div>
            ))}
            <p className="text-sm leading-relaxed text-muted-foreground">
              Depositantes passa de 100% quando quem já era da base deposita no período — é a base
              antiga trabalhando, não erro de conta.
            </p>
          </div>
        </ShellCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <ShellCard title="Operação PIX" subtitle="fluxo de depósitos via PIX" icon={Zap}>
          <div className="space-y-2">
            <InfoRow
              icon={Filter}
              label="PIX gerados"
              value={num(data.pixGenerated)}
              trend="↑ 98,1%"
              tone="orange"
            />
            <InfoRow
              icon={Target}
              label="Taxa de pagamento"
              value={fmtPct(data.pixPayRate)}
              trend="↑ 1,1%"
              tone="green"
            />
            <InfoRow icon={Zap} label="PIX não pagos" value={num(data.pixUnpaid)} tone="red" />
          </div>
        </ShellCard>

        <ShellCard
          title="Retenção & CRM"
          subtitle="seu CRM trazendo jogadores de volta"
          icon={Repeat2}
        >
          <div className="space-y-2">
            <InfoRow
              icon={Repeat2}
              label="Redepósitos"
              value={brl(data.redepositAmount)}
              trend={`↑ ${fmtPct(Math.max(0, data.redepositGrowth))}`}
              tone="green"
            />
            <InfoRow
              icon={Target}
              label="Recuperado pelo CRM"
              value={brl(data.recoveredAmount)}
              tone="green"
            />
            <InfoRow
              icon={Users}
              label="Clicaram e depositaram"
              value={num(data.recoveredPlayers)}
              tone="green"
            />
            <InfoRow
              icon={CreditCard}
              label="Gasto em mensagem"
              value={brl(data.messageCost)}
              tone="orange"
            />
          </div>
        </ShellCard>

        <ShellCard
          title="Régua de reativação"
          subtitle="status da sua base em automações"
          icon={Layers}
        >
          <div className="space-y-2">
            <InfoRow
              icon={Users}
              label="Na fila da régua"
              value={num(data.reactivationQueue)}
              tone="blue"
              chevron
            />
            <InfoRow
              icon={MessageSquare}
              label="Réguas ligadas"
              value={`${num(data.activeFlows)}/${num(data.totalFlows)}`}
              tone="blue"
              chevron
            />
            <InfoRow
              icon={TrendingUp}
              label="Retorno sobre o envio"
              value={data.messageRoi > 0 ? `${data.messageRoi.toFixed(1)}x` : "0x"}
              tone="green"
              chevron
            />
          </div>
        </ShellCard>
      </div>

      <LiveFeed events={data.liveEvents} />

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <LayoutDashboard className="h-4 w-4" />
        Dados do período por tenant. Recuperado pelo CRM considera depósitos feitos depois de um
        followup registrado para o jogador.
      </div>
    </div>
  );
}
