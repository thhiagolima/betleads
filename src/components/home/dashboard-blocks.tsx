// Blocos do "Início": usados pelo Início da casa (src/routes/index.tsx) e pelo
// Início do expert (src/routes/expert.index.tsx), que tem a mesma cara mas só
// os números dos leads dele. O que é só da casa (gasto em SMS, retorno sobre
// o envio, jornadas ativas/total, saldo, links para telas da casa) só aparece
// quando a casa passa esses dados (`house` no CrmCard, `showAllEventsLink` no
// LiveFeed).
import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronRight,
  QrCode,
  RefreshCw,
  UserPlus,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatCount } from "@/components/finance/format";
import { HomeCard, KpiCard, MetricRow, TrendText } from "@/components/home/home-cards";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Term } from "@/components/help/term";
import { tourAnchor } from "@/help/anchor";
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
  | "messageCost"
  | "messageRoi"
  | "activeFlows"
  | "totalFlows"
  | "walletBalance"
  | "exempt"
  | "smsSent"
  | "smsClicks"
  | "smsCtr"
>;

/** Quanto cada R$ 1 em SMS trouxe, em reais ("R$ 7,90"). */
function fmtRoi(value: number) {
  return brl(value);
}

/** Número com 1 casa decimal no padrão pt-BR ("1,3"). */
function fmtDecimal(value: number) {
  return value.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** "1,3 depósito por jogador" (singular abaixo de 2, como se lê "1,5 depósito"). */
function depositsPerPlayerText(value: number) {
  const rounded = Math.round(value * 10) / 10;
  return `${fmtDecimal(rounded)} ${rounded < 2 ? "depósito" : "depósitos"} por jogador`;
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
    <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4" {...tourAnchor("inicio.kpis")}>
      <KpiCard
        className="col-span-2 xl:col-span-1"
        title="Depositado"
        value={money(data.depositAmount)}
        meta={
          formatCount(data.depositCount, "depósito", "depósitos") +
          (data.ticket > 0 ? ` · ticket ${money(data.ticket)}` : "")
        }
        trend={trendDisplay(data.depositGrowth)}
        detail={comparison}
        sparkline={sparkline}
      />
      <KpiCard
        title="Depositantes"
        value={num(data.depositors)}
        meta={
          data.depositsPerDepositor > 0
            ? depositsPerPlayerText(data.depositsPerDepositor)
            : undefined
        }
        trend={trendDisplay(data.depositorsGrowth)}
        detail={comparison}
      />
      <KpiCard
        title={
          <>
            Primeiros depósitos (<Term id="ftd">FTD</Term>)
          </>
        }
        value={num(data.ftd)}
        meta={
          data.ftd > 0
            ? // FTD já contado mas o valor do depósito ainda não sincronizou: "—", não R$ 0,00.
              data.ftdAmount > 0
              ? `${money(data.ftdAmount)} · ticket ${money(data.ftdTicket)}`
              : "—"
            : undefined
        }
        trend={trendDisplay(data.ftdGrowth)}
        detail={comparison}
      />
      <KpiCard
        className="col-span-2 sm:col-span-1"
        title={
          <>
            Conversão cadastro → <Term id="ftd">FTD</Term>
          </>
        }
        value={fmtPct(data.conversion)}
        meta={`${num(data.ftd)} de ${formatCount(data.newPlayers, "cadastro", "cadastros")}`}
        trend={trendDisplay(data.conversionGrowth, "pp")}
        detail={comparison}
      />
    </div>
  );
}

/** Com menos de 2 pontos não há linha para desenhar: o gráfico some. */
export function hasCashflowChart(data: HomeDashboardData) {
  return data.cashflowChart.length >= 2;
}

/**
 * Linha do gráfico "Depósitos e saques" + "Recuperado pelo CRM". Sem gráfico
 * (menos de 2 pontos), o Recuperado ocupa a linha inteira.
 */
export function CashflowCrmRow({
  data,
  house,
}: {
  data: HomeDashboardData;
  house?: HouseCrmFields;
}) {
  if (!hasCashflowChart(data)) return <CrmCard data={data} house={house} />;
  return (
    <div className="grid gap-3 sm:gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="order-2 min-w-0 lg:order-1">
        <CashflowChart data={data} />
      </div>
      <div className="order-1 lg:order-2">
        <CrmCard data={data} house={house} />
      </div>
    </div>
  );
}

/**
 * Evolução de depósitos e saques. Em período de 1 dia os pontos vêm por hora
 * ("14h"); nos demais, por dia. O eixo X só usa o rótulo pronto.
 */
export function CashflowChart({ data }: { data: HomeDashboardData }) {
  const { money } = useMoney();
  return (
    <HomeCard className="flex h-full flex-col p-4 sm:p-5" {...tourAnchor("inicio.fluxo.grafico")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold">Depósitos e saques</h2>
        {/* Só os nomes: os totais já estão nos indicadores e em "Líquido". */}
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-[3px] w-2.5 rounded-full bg-chart-1" aria-hidden="true" />
            Depósitos
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-[3px] w-2.5 rounded-full bg-chart-5" aria-hidden="true" />
            Saques
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
  const smsEnabled = isEnabled("sms");
  return (
    <>
      <div className="mt-3">
        {smsEnabled && <MetricRow label="Custo em SMS" value={brl(house.messageCost)} />}
        {smsEnabled && (
          <MetricRow
            label="SMS enviados"
            value={
              num(house.smsSent) +
              (house.smsSent > 0
                ? ` · ${formatCount(house.smsClicks, "clique", "cliques")} (${fmtPct(house.smsCtr)})`
                : "")
            }
          />
        )}
        {/* Sem retorno para mostrar ("—"), a linha some. */}
        {roi > 0 && (
          <MetricRow
            label="Cada R$ 1 em SMS trouxe"
            value={fmtRoi(roi)}
            valueClassName="text-success"
          />
        )}
        <MetricRow
          label="Em jornada agora"
          value={`${num(data.reactivationQueue)} · ${num(house.activeFlows)}/${num(house.totalFlows)} ativas`}
          to="/jornadas"
          {...tourAnchor("inicio.recuperado.em-jornada")}
        />
        {!house.exempt && <MetricRow label="Saldo" value={brl(house.walletBalance)} />}
      </div>
      <Button
        asChild
        variant="secondary"
        className="mt-4 h-10 w-full bg-success/12 font-semibold text-success hover:bg-success/20 lg:mt-auto"
        {...tourAnchor("inicio.recuperado.ver-resultados")}
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
 * custo e envios/cliques de SMS (canal liberado), quanto cada R$ 1 em SMS
 * trouxe (só quando há retorno), jornadas ativas/total, saldo (não isenta) e o
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
      {/* A regra dos 7 dias fica na nota do rodapé e na ajuda. */}
      <p className="mt-1.5 text-[12.5px] text-muted-foreground">
        {formatCount(data.recoveredPlayers, "jogador recuperado", "jogadores recuperados")}
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
  const hasFtdCohort = data.ftdCohort > 0;
  const cells: Array<{
    label: ReactNode;
    value: ReactNode;
    trend?: ReturnType<typeof trendDisplay>;
    detail?: string;
    valueClassName?: string;
  }> = [
    {
      label: "Líquido",
      value: money(data.netAmount),
      trend: data.netGrowth === null ? null : trendDisplay(data.netGrowth),
      detail: `saques ${money(data.withdrawalAmount)} · ${formatCount(data.withdrawalCount, "saque", "saques")}`,
      valueClassName: data.netAmount < 0 ? "text-danger" : undefined,
    },
    {
      label: <Term id="redeposito">Redepósitos</Term>,
      value: money(data.redepositAmount),
      trend: trendDisplay(data.redepositGrowth),
      detail: formatCount(data.redepositPlayers, "jogador", "jogadores"),
    },
    {
      label: <Term id="ftd-redeposito">FTDs que redepositaram</Term>,
      // Sem FTD no período não há taxa: "—" e sem seta.
      value: hasFtdCohort ? fmtPct(data.ftdRedepositRate) : "—",
      trend:
        hasFtdCohort && data.ftdRedepositRateGrowth != null
          ? trendDisplay(data.ftdRedepositRateGrowth, "pp")
          : null,
      detail: hasFtdCohort
        ? `${num(data.ftdCohortRedeposited)} de ${formatCount(data.ftdCohort, "FTD", "FTDs")}`
        : "nenhum FTD no período",
    },
    {
      label: (
        <>
          <Term id="pix-gerado-pago">PIX</Term> não pagos
        </>
      ),
      value: num(data.pixUnpaid),
      detail:
        data.pixGenerated > 0
          ? `${money(data.pixUnpaidAmount)} · ${fmtPct(data.pixPayRate)} pagos`
          : undefined,
      valueClassName: data.pixUnpaid > 0 ? "text-warning" : undefined,
    },
  ];
  return (
    <HomeCard
      className="grid grid-cols-2 xl:grid-cols-4"
      {...tourAnchor("inicio.metricas-secundarias")}
    >
      {cells.map((cell, index) => (
        <div
          key={index}
          className={cn(
            "border-border/70 p-4 sm:px-5",
            // Hairlines between cells (2x2 below xl, one row on xl) without doubling them up.
            index < 2 && "max-xl:border-b",
            index % 2 === 0 && "max-xl:border-r",
            index < cells.length - 1 && "xl:border-r",
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

// Um ícone por tipo de evento (o tom vem do SQL), para não depender de
// legenda de cor: criou conta, gerou PIX, depositou, sacou.
const eventKind = {
  blue: { icon: UserPlus, className: "bg-sky-400/12 text-sky-400" },
  orange: { icon: QrCode, className: "bg-amber-400/12 text-amber-400" },
  green: { icon: ArrowDownLeft, className: "bg-emerald-400/12 text-emerald-400" },
  purple: { icon: ArrowUpRight, className: "bg-violet-400/12 text-violet-400" },
} as const;

// Linhas por coluna no desktop (até 6 eventos em 2 colunas).
const feedRows = { 1: "md:grid-rows-1", 2: "md:grid-rows-2", 3: "md:grid-rows-3" } as const;

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function LiveFeed({
  events,
  showAllEventsLink = false,
  playerLink = "house",
}: {
  events: HomeDashboardData["liveEvents"];
  /** Link "Ver todos os eventos" (/eventos), uma tela só da casa. */
  showAllEventsLink?: boolean;
  /** Para onde o nome do jogador leva: ficha da casa ou ficha do lead do expert. */
  playerLink?: "house" | "expert";
}) {
  const { money } = useMoney();
  const shown = events.slice(0, 6);
  return (
    <HomeCard className="p-4 sm:px-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold">Ao vivo</h2>
        {showAllEventsLink && (
          <Link
            to="/eventos"
            className="text-[12.5px] text-primary hover:underline"
            {...tourAnchor("inicio.ao-vivo.ver-todos")}
          >
            Ver todos os eventos
          </Link>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          Ainda sem eventos recentes para exibir.
        </p>
      ) : (
        // No desktop, duas colunas lidas de cima para baixo (a mais recente no
        // topo da esquerda), em vez de zigue-zague entre as colunas.
        <ul
          className={cn(
            "mt-1 grid grid-cols-[minmax(0,1fr)] gap-x-8",
            "md:grid-flow-col md:grid-cols-2",
            feedRows[Math.ceil(shown.length / 2) as 1 | 2 | 3],
          )}
        >
          {shown.map((event) => {
            const kind = eventKind[event.tone] ?? eventKind.blue;
            const Icon = kind.icon;
            const hasAmount = typeof event.amount === "number" && event.amount > 0;
            return (
              <li
                key={event.id}
                className="flex items-center gap-3 border-b border-border/70 py-2.5"
              >
                <span
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-lg",
                    kind.className,
                  )}
                  aria-hidden="true"
                >
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-semibold">
                    {event.playerId ? (
                      playerLink === "expert" ? (
                        <Link
                          to="/expert/leads/$playerId"
                          params={{ playerId: event.playerId }}
                          className="underline-offset-2 hover:underline focus-visible:underline"
                        >
                          {event.player}
                        </Link>
                      ) : (
                        <Link
                          to="/players/$playerId"
                          params={{ playerId: event.playerId }}
                          search={{ id: undefined, focus: undefined }}
                          className="underline-offset-2 hover:underline focus-visible:underline"
                        >
                          {event.player}
                        </Link>
                      )
                    ) : (
                      event.player
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {capitalize(event.action)} · {timeAgo(event.at)}
                  </p>
                </div>
                {hasAmount && (
                  <strong
                    className={cn(
                      "shrink-0 text-[13.5px] font-semibold tabular-nums",
                      event.tone === "green" && "text-success",
                    )}
                  >
                    {money(event.amount as number)}
                  </strong>
                )}
              </li>
            );
          })}
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
