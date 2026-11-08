// Blocos do "Início": usados pelo Início da casa (src/routes/index.tsx) e pelo
// Início do expert (src/routes/expert.index.tsx), que tem a mesma cara mas só
// os números dos leads dele. O que é só da casa (gasto em SMS, retorno sobre
// o envio, jornadas ativas/total, saldo, links para telas da casa) só aparece
// quando a casa passa esses dados (`house` no CrmCard, `showAllEventsLink` no
// LiveFeed).
import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
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
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useMoney } from "@/hooks/use-tenant-currency";
import { useEnabledChannels } from "@/hooks/use-enabled-channels";
import type { LeadScopedDashboard, mapDashboardRpc } from "@/lib/dashboard.functions";
import { brl, num, timeAgo } from "@/lib/format";
import { fmtPct, trendDisplay } from "@/lib/home-dashboard";
import { chartAxisProps, chartGridProps, chartTooltipStyle } from "@/lib/chart-theme";
import { cn } from "@/lib/utils";

/** Números do Início que dependem só dos jogadores (casa inteira ou leads do expert). */
export type HomeDashboardData = LeadScopedDashboard;

/** Campos do Recuperado que só a casa tem (custo de SMS, jornadas, carteira). */
export type HouseCrmFields = Pick<
  ReturnType<typeof mapDashboardRpc>,
  "messageCost" | "messageRoi" | "activeFlows" | "totalFlows" | "walletBalance" | "exempt"
>;

/** Quanto cada R$ 1 em SMS trouxe, em reais ("R$ 7,90"). */
function fmtRoi(value: number) {
  return brl(value);
}

function comparisonText(periodDays: number) {
  return `vs ${periodDays === 1 ? "dia anterior" : `${periodDays} dias anteriores`}`;
}

export function HomeHeader({
  title,
  meta,
  rangeText,
  isFetching,
  updatedAgo,
  includesToday,
  picker,
}: {
  title: ReactNode;
  /** Itens extras no começo da linha de baixo (ex.: tipo de acesso e casa do expert). */
  meta?: ReactNode;
  rangeText: string;
  isFetching: boolean;
  updatedAgo: string;
  includesToday: boolean;
  picker: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight sm:text-[26px]">{title}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[13px] text-muted-foreground">
          {meta && (
            <>
              {meta}
              <span aria-hidden="true">·</span>
            </>
          )}
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
      {picker}
    </header>
  );
}

export function HomeKpiCards({
  data,
  sparkline,
}: {
  data: HomeDashboardData;
  sparkline: Array<{ value: number }>;
}) {
  const { money } = useMoney();
  const comparison = comparisonText(data.periodDays);
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <KpiCard
        className="col-span-2 xl:col-span-1"
        title="Depositado"
        value={money(data.depositAmount)}
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
  );
}

export function CashflowChart({ data }: { data: HomeDashboardData }) {
  const { money } = useMoney();
  return (
    <HomeCard className="flex h-full flex-col p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold">Depósitos e saques</h2>
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-[3px] w-2.5 rounded-full bg-chart-1" aria-hidden="true" />
            Depósitos <strong className="text-foreground">{money(data.depositAmount)}</strong>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-[3px] w-2.5 rounded-full bg-chart-5" aria-hidden="true" />
            Saques <strong className="text-foreground">{money(data.withdrawalAmount)}</strong>
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
            <YAxis {...chartAxisProps} tickFormatter={(v) => money(Number(v))} width={78} />
            <Tooltip
              contentStyle={chartTooltipStyle}
              formatter={(value: number, name: string) => [
                money(Number(value)),
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

/** Linhas e botão do Recuperado que só a casa tem. */
function HouseCrmDetails({ data, house }: { data: HomeDashboardData; house: HouseCrmFields }) {
  const { currency } = useMoney();
  const { isEnabled } = useEnabledChannels();
  // Recuperado vem na moeda da casa e o gasto em SMS é sempre BRL: só faz
  // sentido dividir um pelo outro quando a casa também opera em BRL.
  const roi = currency === "BRL" ? house.messageRoi : 0;
  return (
    <>
      <div className="mt-3">
        {isEnabled("sms") && <MetricRow label="Custo em SMS" value={brl(house.messageCost)} />}
        <MetricRow
          label="Cada R$ 1 em SMS trouxe"
          value={roi > 0 ? fmtRoi(roi) : "—"}
          valueClassName={roi > 0 ? "text-success" : undefined}
        />
        <MetricRow
          label="Em jornada agora"
          value={`${num(data.reactivationQueue)} · ${num(house.activeFlows)}/${num(house.totalFlows)} ativas`}
          to="/jornadas"
        />
        <MetricRow label="Saldo" value={house.exempt ? "Isenta" : brl(house.walletBalance)} />
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
    </>
  );
}

/**
 * "Recuperado pelo CRM". Com `house`, mostra também o que é só da casa:
 * custo em SMS, quanto cada R$ 1 em SMS trouxe, jornadas ativas/total, saldo e o
 * botão para a Central de Resultados. Sem `house` (expert), fica só o
 * recuperado e "Em jornada agora" dos leads.
 */
export function CrmCard({ data, house }: { data: HomeDashboardData; house?: HouseCrmFields }) {
  const { money } = useMoney();
  return (
    <HomeCard className="flex h-full flex-col border-success/30 p-4 sm:p-5">
      <h2 className="text-[12.5px] font-semibold text-success">Recuperado pelo CRM</h2>
      <p className="mt-1.5 text-[28px] font-semibold tracking-[-0.03em] tabular-nums sm:text-[32px]">
        {money(data.recoveredAmount)}
      </p>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
        {data.recoveredPlayers > 0
          ? `${num(data.recoveredPlayers)} jogador(es) que estavam parados depositaram até 7 dias depois de clicar num link de campanha ou jornada.`
          : "Ainda não há depósitos após clique em link no período."}
      </p>
      {house ? (
        <HouseCrmDetails data={data} house={house} />
      ) : (
        <div className="mt-3">
          <MetricRow label="Em jornada agora" value={num(data.reactivationQueue)} />
        </div>
      )}
    </HomeCard>
  );
}

export function SecondaryMetrics({ data }: { data: HomeDashboardData }) {
  const { money } = useMoney();
  const cells = [
    {
      label: "Novos clientes",
      value: num(data.newPlayers),
      trend: trendDisplay(data.newPlayersGrowth),
    },
    { label: "Ticket médio", value: money(data.ticket), trend: trendDisplay(data.ticketGrowth) },
    {
      label: "Redepósitos",
      value: money(data.redepositAmount),
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

export function LiveFeed({
  events,
  showAllEventsLink = false,
}: {
  events: HomeDashboardData["liveEvents"];
  /** Link "Ver todos os eventos" (/eventos), uma tela só da casa. */
  showAllEventsLink?: boolean;
}) {
  const { money } = useMoney();
  return (
    <HomeCard className="p-4 sm:px-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold">Ao vivo</h2>
        {showAllEventsLink && (
          <Link to="/eventos" className="text-[12.5px] text-primary hover:underline">
            Ver todos os eventos
          </Link>
        )}
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
                <strong className="shrink-0 font-semibold tabular-nums">
                  {money(event.amount)}
                </strong>
              )}
              <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(event.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </HomeCard>
  );
}

export function DashboardSkeleton() {
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

/** Erro ao carregar o painel, com "Tentar novamente". */
export function DashboardError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <HomeCard className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-base font-medium">Não foi possível carregar o painel</p>
      <p className="max-w-lg text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" onClick={onRetry}>
        <RefreshCw className="mr-2 size-4" aria-hidden="true" />
        Tentar novamente
      </Button>
    </HomeCard>
  );
}
