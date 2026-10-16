import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
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
import { brtDayStart } from "@/lib/tz";
import { getDashboardSummary } from "@/lib/dashboard.functions";
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

type LiveEvent = {
  id: string;
  tone: "blue" | "green" | "orange" | "purple";
  player: string;
  action: string;
  amount?: number;
  at: string;
};

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

function fmtPct(value: number, digits = 1) {
  return `${value.toLocaleString("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;
}

function fmtRoi(value: number) {
  return `${value.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}x`;
}

function comparisonLabel(value: number) {
  const direction = value > 0 ? "↑" : value < 0 ? "↓" : "→";
  return `${direction} ${fmtPct(Math.abs(value))} vs. período anterior`;
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
      className={`card-premium group relative min-h-[156px] overflow-hidden border-0 ${
        featured ? "ring-1 ring-emerald-500/35" : ""
      }`}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
      <CardContent className="relative flex h-full flex-col p-5">
        <div className="flex items-start justify-between gap-4">
          <p className="text-xs font-medium text-muted-foreground">{title}</p>
          <div
            className={`flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/50 transition-transform duration-200 group-hover:scale-105 ${toneClass}`}
          >
            <Icon className="h-5 w-5" />
          </div>
        </div>
        <div className="mt-1 flex flex-1 items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="text-3xl font-semibold tracking-[-0.04em] text-foreground tabular-nums">
              {value}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
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
  to,
}: {
  icon: ElementType;
  label: string;
  value: string;
  detail?: string;
  tone?: "blue" | "green" | "orange" | "red" | "purple";
  trend?: string;
  /** Destination of the row; only navigable rows show an arrow. */
  to?: "/jornadas" | "/relatorios/conversao";
}) {
  const toneClass = {
    blue: "bg-blue-500/15 text-blue-400",
    green: "bg-emerald-500/15 text-emerald-400",
    orange: "bg-amber-500/15 text-amber-400",
    red: "bg-red-500/15 text-red-400",
    purple: "bg-violet-500/15 text-violet-400",
  }[tone];
  const content = (
    <>
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
        {to && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </div>
    </>
  );
  return to ? (
    <Link to={to} className="-mx-2 flex items-center gap-4 rounded-xl px-2 py-3 hover:bg-muted/40">
      {content}
    </Link>
  ) : (
    <div className="flex items-center gap-4 py-3">{content}</div>
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

  const {
    data: tenants,
    isLoading: tenantsLoading,
    error: tenantsError,
    refetch: refetchTenants,
  } = useQuery({
    queryKey: ["accessible-tenants"],
    queryFn: async () => {
      const { data, error } = await supabase.from("tenants").select("id, nome").order("nome");
      if (error) throw new Error(error.message);
      return (data ?? []) as Array<{ id: string; nome: string }>;
    },
    staleTime: 5 * 60_000,
  });
  const {
    data: sessionTenantId,
    isLoading: sessionTenantLoading,
    error: sessionTenantError,
    refetch: refetchSessionTenant,
  } = useQuery({
    queryKey: ["current-tenant-id-dashboard"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("current_tenant_id");
      if (error) throw new Error(error.message);
      return (data as string | null) ?? null;
    },
    staleTime: 5 * 60_000,
  });

  const STORAGE_KEY = "dashboard:active_tenant";
  // A seleção explícita da sessão começa no tenant retornado pelo JWT/RPC;
  // não reutilizamos um tenant antigo do localStorage antes dessa validação.
  const [activeTenantId, setActiveTenantIdRaw] = useState<string | null>(null);
  const tenantId =
    tenants && tenants.length > 0
      ? activeTenantId && tenants.some((t) => t.id === activeTenantId)
        ? activeTenantId
        : sessionTenantId && tenants.some((t) => t.id === sessionTenantId)
          ? sessionTenantId
          : tenants[0].id
      : null;
  const activeTenant = tenants?.find((t) => t.id === tenantId);
  const tenantName = activeTenant?.nome ?? "SorteAlta";
  const setActiveTenantId = (id: string) => {
    setActiveTenantIdRaw(id);
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, id);
  };

  const fetchDashboard = useServerFn(getDashboardSummary);
  const includesToday = brtDayStart(to).getTime() >= brtDayStart(new Date()).getTime();
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["dashboard", tenantId, brtDayKeyLocal(from), brtDayKeyLocal(to)],
    queryFn: () =>
      fetchDashboard({
        data: {
          tenantId: tenantId as string,
          from: from.toISOString(),
          to: to.toISOString(),
        },
      }),
    enabled: !!tenantId,
    staleTime: includesToday ? 20_000 : 5 * 60_000,
    refetchInterval: includesToday ? 30_000 : false,
    placeholderData: (previous) => previous,
    retry: 1,
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

  if (tenantsLoading || sessionTenantLoading || (Boolean(tenantId) && isLoading)) {
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

  const loadError = tenantsError ?? sessionTenantError ?? error;
  if (loadError || !tenantId || !data) {
    const message =
      loadError instanceof Error
        ? loadError.message
        : !tenantId
          ? "Nenhuma conta disponível para este usuário."
          : "Não foi possível carregar os dados do painel.";

    return (
      <Card>
        <CardContent className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-base font-medium">Não foi possível carregar o painel</p>
          <p className="max-w-lg text-sm text-muted-foreground">{message}</p>
          <Button
            variant="outline"
            onClick={() => {
              void refetchTenants();
              void refetchSessionTenant();
              void refetch();
            }}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Tentar novamente
          </Button>
        </CardContent>
      </Card>
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
    <div className="relative space-y-6 pb-8" aria-busy={isFetching}>
      {isFetching && (
        <div className="sticky top-2 z-30 flex justify-center" role="status" aria-live="polite">
          <div className="flex items-center gap-2 rounded-full border border-primary/25 bg-card/95 px-3 py-1.5 text-xs font-medium text-primary shadow-lg backdrop-blur">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            Atualizando painel…
          </div>
        </div>
      )}
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
                <SelectValue placeholder="Selecione uma conta" />
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
              <strong className="text-emerald-400">Insight</strong>{" "}
              {data.recoveredAmount > 0 ? (
                <>
                  Jornadas e campanhas trouxeram {num(data.recoveredPlayers)} jogador(es) de volta:{" "}
                  {brl(data.recoveredAmount)} em depósitos após clique no link, com{" "}
                  {brl(data.messageCost)} em SMS
                  {data.messageRoi > 0 ? ` (retorno de ${fmtRoi(data.messageRoi)})` : ""}.
                </>
              ) : (
                <>
                  Ainda não há depósitos após clique em link no período. Foram{" "}
                  {brl(data.messageCost)} em SMS.
                </>
              )}
            </p>
          </div>
          <Button asChild variant="outline" className="h-12 rounded-xl px-6 font-semibold">
            <Link to="/relatorios/conversao">Ver relatórios completos</Link>
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
          detail={`${num(data.recoveredPlayers)} jogador(es) · depósito até 7 dias após clique no link`}
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
              detail={comparisonLabel(data.pixGeneratedGrowth)}
              tone="orange"
            />
            <InfoRow
              icon={Target}
              label="Taxa de pagamento"
              value={fmtPct(data.pixPayRate)}
              detail={`${num(data.depositCount)} pagamentos aprovados no período`}
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
              detail={comparisonLabel(data.redepositGrowth)}
              tone="green"
            />
            <InfoRow
              icon={Target}
              label="Recuperado pelo CRM"
              value={brl(data.recoveredAmount)}
              detail="depósitos após clique em link"
              tone="green"
              to="/relatorios/conversao"
            />
            <InfoRow
              icon={Users}
              label="Clicaram e depositaram"
              value={num(data.recoveredPlayers)}
              tone="green"
            />
            <InfoRow
              icon={CreditCard}
              label="Gasto em SMS"
              value={brl(data.messageCost)}
              detail={`${num(data.smsSent)} SMS cobrados no período`}
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
              label="Em jornada agora"
              value={num(data.reactivationQueue)}
              detail="jogadores em alguma régua"
              tone="blue"
              to="/jornadas"
            />
            <InfoRow
              icon={MessageSquare}
              label="Jornadas ativas"
              value={`${num(data.activeFlows)}/${num(data.totalFlows)}`}
              detail={data.pausedFlows ? `${num(data.pausedFlows)} pausada(s)` : undefined}
              tone="blue"
              to="/jornadas"
            />
            <InfoRow
              icon={TrendingUp}
              label="Retorno sobre o envio"
              value={data.messageRoi > 0 ? fmtRoi(data.messageRoi) : "—"}
              detail="recuperado ÷ gasto em SMS"
              tone="green"
              to="/relatorios/conversao"
            />
          </div>
        </ShellCard>
      </div>

      <LiveFeed events={data.liveEvents} />

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <LayoutDashboard className="h-4 w-4" />
        Dados do período da sua operação. Recuperado pelo CRM considera depósitos feitos em até 7
        dias depois de um clique humano em link de campanha ou jornada; gasto em SMS é o valor
        cobrado em créditos.
      </div>
    </div>
  );
}
