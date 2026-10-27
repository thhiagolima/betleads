import { Link, Navigate, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { type DateRange } from "react-day-picker";
import { ChevronRight, RefreshCw } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { HomeCard, KpiCard, MetricRow, TrendText } from "@/components/home/home-cards";
import { PeriodPicker } from "@/components/home/period-picker";
import { DomainVerifiedNotice } from "@/components/onboarding/domain-verified-notice";
import { HouseSetupChecklist } from "@/components/onboarding/house-setup-checklist";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useActiveTenant } from "@/hooks/use-active-tenant";
import { POLL_INTERVALS, useUpdatedAgo } from "@/hooks/use-updated-ago";
import { getDashboardSummary } from "@/lib/dashboard.functions";
import { brl, num, timeAgo } from "@/lib/format";
import {
  fmtPct,
  greetingFor,
  periodRange,
  trendDisplay,
  type PeriodPreset,
} from "@/lib/home-dashboard";
import { homeRedirect } from "@/lib/navigation";
import { brtDayStart } from "@/lib/tz";
import { chartAxisProps, chartGridProps, chartTooltipStyle } from "@/lib/chart-theme";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

type DashboardData = Awaited<ReturnType<typeof getDashboardSummary>>;

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

function shortDate(date: Date) {
  return date.toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
  });
}

function fmtRoi(value: number) {
  return `${value.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}x`;
}

function CashflowChart({ data }: { data: DashboardData }) {
  return (
    <HomeCard className="flex h-full flex-col p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold">Depósitos e saques</h2>
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-[3px] w-2.5 rounded-full bg-chart-1" aria-hidden="true" />
            Depósitos <strong className="text-foreground">{brl(data.depositAmount)}</strong>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-[3px] w-2.5 rounded-full bg-chart-5" aria-hidden="true" />
            Saques <strong className="text-foreground">{brl(data.withdrawalAmount)}</strong>
          </span>
        </div>
      </div>
      <div className="mt-4 h-[220px] sm:h-[260px] lg:h-auto lg:min-h-[260px] lg:flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data.cashflowChart} margin={{ left: 0, right: 4, top: 4, bottom: 0 }}>
            <defs>
              <linearGradient id="depositGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-chart-1)" stopOpacity={0.28} />
                <stop offset="100%" stopColor="var(--color-chart-1)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid {...chartGridProps} />
            <XAxis dataKey="label" {...chartAxisProps} minTickGap={16} />
            <YAxis {...chartAxisProps} tickFormatter={(v) => brl(Number(v))} width={78} />
            <Tooltip
              contentStyle={chartTooltipStyle}
              formatter={(value: number, name: string) => [
                brl(Number(value)),
                name === "deposits" ? "Depósitos" : "Saques",
              ]}
            />
            <Area
              type="monotone"
              dataKey="deposits"
              stroke="var(--color-chart-1)"
              strokeWidth={2.5}
              fill="url(#depositGrad)"
              dot={false}
            />
            <Area
              type="monotone"
              dataKey="withdrawals"
              stroke="var(--color-chart-5)"
              strokeWidth={2.5}
              fill="transparent"
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </HomeCard>
  );
}

function CrmCard({ data }: { data: DashboardData }) {
  return (
    <HomeCard className="flex h-full flex-col border-success/30 p-4 sm:p-5">
      <h2 className="text-[12.5px] font-semibold text-success">Recuperado pelo CRM</h2>
      <p className="mt-1.5 text-[28px] font-semibold tracking-[-0.03em] tabular-nums sm:text-[32px]">
        {brl(data.recoveredAmount)}
      </p>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
        {data.recoveredPlayers > 0
          ? `${num(data.recoveredPlayers)} jogador(es) que estavam parados depositaram até 7 dias depois de clicar num link de campanha ou jornada.`
          : "Ainda não há depósitos após clique em link no período."}
      </p>
      <div className="mt-3">
        <MetricRow label="Gasto em SMS" value={brl(data.messageCost)} />
        <MetricRow
          label="Retorno sobre o envio"
          value={data.messageRoi > 0 ? fmtRoi(data.messageRoi) : "—"}
          valueClassName={data.messageRoi > 0 ? "text-success" : undefined}
        />
        <MetricRow
          label="Em jornada agora"
          value={`${num(data.reactivationQueue)} · ${num(data.activeFlows)}/${num(data.totalFlows)} ativas`}
          to="/jornadas"
        />
        <MetricRow label="Saldo" value={data.exempt ? "Isenta" : brl(data.walletBalance)} />
      </div>
      <Button
        asChild
        variant="secondary"
        className="mt-4 h-10 w-full bg-success/12 font-semibold text-success hover:bg-success/20 lg:mt-auto"
      >
        <Link to="/resultados">
          Ver resultados do CRM
          <ChevronRight className="size-4" aria-hidden="true" />
        </Link>
      </Button>
    </HomeCard>
  );
}

function SecondaryMetrics({ data }: { data: DashboardData }) {
  const cells = [
    {
      label: "Novos clientes",
      value: num(data.newPlayers),
      trend: trendDisplay(data.newPlayersGrowth),
    },
    { label: "Ticket médio", value: brl(data.ticket), trend: trendDisplay(data.ticketGrowth) },
    {
      label: "Redepósitos",
      value: brl(data.redepositAmount),
      trend: trendDisplay(data.redepositGrowth),
      detail: `${num(data.redepositPlayers)} jogadores`,
    },
    {
      label: "PIX pagos",
      value: fmtPct(data.pixPayRate),
      detail: `${num(data.depositCount)} de ${num(data.pixGenerated)}`,
    },
    {
      label: "PIX não pagos",
      value: num(data.pixUnpaid),
      valueClassName: data.pixUnpaid > 0 ? "text-warning" : undefined,
    },
  ];
  return (
    <HomeCard className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5">
      {cells.map((cell, index) => (
        <div
          key={cell.label}
          className={cn(
            "border-border/70 p-4 sm:px-5",
            // Hairlines between cells on every breakpoint without doubling them up.
            "border-b xl:border-b-0",
            index < cells.length - 1 && "xl:border-r",
            index % 2 === 0 && "max-sm:border-r",
            index === cells.length - 1 && "max-sm:col-span-2 max-sm:border-b-0",
          )}
        >
          <p className="text-[12.5px] text-muted-foreground">{cell.label}</p>
          <p className={cn("mt-1 text-xl font-semibold tabular-nums", cell.valueClassName)}>
            {cell.value}
          </p>
          <p className="mt-1 flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
            <TrendText trend={cell.trend ?? null} />
            {cell.detail && <span>{cell.detail}</span>}
          </p>
        </div>
      ))}
    </HomeCard>
  );
}

const eventDot = {
  blue: "bg-sky-400",
  green: "bg-emerald-400",
  orange: "bg-amber-400",
  purple: "bg-violet-400",
} as const;

function LiveFeed({ events }: { events: DashboardData["liveEvents"] }) {
  return (
    <HomeCard className="p-4 sm:px-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold">Ao vivo</h2>
        <Link to="/eventos" className="text-[12.5px] text-primary hover:underline">
          Ver todos os eventos
        </Link>
      </div>
      {events.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          Ainda sem eventos recentes para exibir.
        </p>
      ) : (
        <ul className="mt-1 grid grid-cols-[minmax(0,1fr)] gap-x-8 md:grid-cols-2">
          {events.slice(0, 6).map((event) => (
            <li
              key={event.id}
              className="flex items-center gap-3 border-b border-border/70 py-2.5 text-[13.5px]"
            >
              <span
                className={cn(
                  "size-[7px] shrink-0 rounded-full",
                  eventDot[event.tone] ?? "bg-sky-400",
                )}
                aria-hidden="true"
              />
              <p className="min-w-0 flex-1 truncate">
                <strong className="font-semibold">{event.player}</strong> {event.action}
              </p>
              {typeof event.amount === "number" && event.amount > 0 && (
                <strong className="shrink-0 font-semibold tabular-nums">{brl(event.amount)}</strong>
              )}
              <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(event.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </HomeCard>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Carregando o painel">
      <Skeleton className="h-16" />
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-32" />
        ))}
      </div>
      <Skeleton className="h-72" />
    </div>
  );
}

function Dashboard() {
  const [preset, setPreset] = useState<PeriodPreset>("7d");
  const [range, setRange] = useState<DateRange | undefined>(() => periodRange("7d"));

  const from = range?.from ?? new Date();
  const to = range?.to ?? from;

  // The house is chosen only in the header; the home follows it.
  const tenant = useActiveTenant();
  const tenantId = tenant.data?.activeTenantId ?? null;

  const fetchDashboard = useServerFn(getDashboardSummary);
  const includesToday = brtDayStart(to).getTime() >= brtDayStart(new Date()).getTime();
  const { data, isLoading, isFetching, error, refetch, dataUpdatedAt } = useQuery({
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
    refetchInterval: includesToday ? POLL_INTERVALS.dashboard : false,
    placeholderData: (previous) => previous,
    retry: 1,
  });
  const updatedAgo = useUpdatedAgo(dataUpdatedAt || undefined);
  const greeting = useMemo(() => greetingFor(), []);
  const sparkline = useMemo(
    () => (data?.cashflowChart ?? []).map((row) => ({ value: row.deposits })),
    [data?.cashflowChart],
  );

  if (tenant.isLoading || (Boolean(tenantId) && isLoading)) return <DashboardSkeleton />;

  // A group manager with no house role has nothing here: send them to the group panel.
  const redirectTo = homeRedirect(tenant.tenants.length, tenant.data?.groups?.length ?? 0);
  if (redirectTo) return <Navigate to={redirectTo} replace />;

  const loadError = tenant.error ?? error;
  if (loadError || !tenantId || !data) {
    const message =
      loadError instanceof Error
        ? loadError.message
        : !tenantId
          ? "Nenhuma casa disponível para este usuário."
          : "Não foi possível carregar os dados do painel.";
    return (
      <HomeCard className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-base font-medium">Não foi possível carregar o painel</p>
        <p className="max-w-lg text-sm text-muted-foreground">{message}</p>
        <Button
          variant="outline"
          onClick={() => {
            void tenant.refetch();
            void refetch();
          }}
        >
          <RefreshCw className="mr-2 size-4" aria-hidden="true" />
          Tentar novamente
        </Button>
      </HomeCard>
    );
  }

  const comparison = `vs ${data.periodDays === 1 ? "dia anterior" : `${data.periodDays} dias anteriores`}`;
  const rangeText =
    brtDayKeyLocal(from) === brtDayKeyLocal(to)
      ? shortDate(from)
      : `${shortDate(from)} a ${shortDate(to)}`;

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 pb-4 sm:space-y-5" aria-busy={isFetching}>
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight sm:text-[26px]">{greeting}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[13px] text-muted-foreground">
            <span>Operação de {rangeText}</span>
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1.5">
              {isFetching && <RefreshCw className="size-3 animate-spin" aria-hidden="true" />}
              atualizado {updatedAgo}
            </span>
            {includesToday && (
              <>
                <span aria-hidden="true">·</span>
                <span>hoje ainda está entrando</span>
              </>
            )}
          </p>
        </div>
        <PeriodPicker
          preset={preset}
          range={range}
          onChange={(nextPreset, nextRange) => {
            setPreset(nextPreset);
            setRange(nextRange);
          }}
        />
      </header>

      <DomainVerifiedNotice />
      <HouseSetupChecklist />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <KpiCard
          className="col-span-2 xl:col-span-1"
          title="Depositado"
          value={brl(data.depositAmount)}
          trend={trendDisplay(data.depositGrowth)}
          detail={comparison}
          sparkline={sparkline}
        />
        <KpiCard
          title="Depositantes"
          value={num(data.depositors)}
          trend={trendDisplay(data.depositorsGrowth)}
          detail={comparison}
        />
        <KpiCard
          title="Primeiros depósitos (FTD)"
          value={num(data.ftd)}
          trend={trendDisplay(data.ftdGrowth)}
          detail={comparison}
        />
        <KpiCard
          className="col-span-2 sm:col-span-1"
          title="Conversão cadastro → FTD"
          value={fmtPct(data.conversion)}
          trend={trendDisplay(data.conversionGrowth, "pp")}
          detail={`${num(data.ftd)} de ${num(data.newPlayers)} cadastros`}
        />
      </div>

      <div className="grid gap-3 sm:gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="order-2 min-w-0 lg:order-1">
          <CashflowChart data={data} />
        </div>
        <div className="order-1 lg:order-2">
          <CrmCard data={data} />
        </div>
      </div>

      <SecondaryMetrics data={data} />

      <LiveFeed events={data.liveEvents} />

      <p className="text-xs leading-relaxed text-muted-foreground">
        Recuperado pelo CRM considera depósitos feitos em até 7 dias depois de um clique humano em
        link de campanha ou jornada, sem quem já estava ativo; gasto em SMS é o preço por segmento
        vezes os segmentos enviados. Datas no fuso de Brasília.
      </p>
    </div>
  );
}
