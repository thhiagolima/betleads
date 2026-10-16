import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ChevronDown, ChevronRight, Info, TrendingUp } from "lucide-react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { getCrmResults, getCrmRetention } from "@/lib/crm-results.functions";
import { getComparisonAccess } from "@/lib/tenant-comparison.functions";
import { buildRecommendations } from "@/lib/crm-recommendations";
import { crmResultsCsv } from "@/lib/crm-results-csv";
import {
  PLAYER_STATE_LABELS,
  RECOVERABLE_STATES,
  HOLDOUT_MIN_PLAYERS,
  HOLDOUT_MIN_RETURNS,
  type CrmMetricsWithRatios,
  type CrmSource,
} from "@/lib/crm-results";
import { brl, num } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const PERIODS = [
  { key: "today", label: "Hoje", days: 1, endOffset: 0 },
  { key: "yesterday", label: "Ontem", days: 1, endOffset: 1 },
  { key: "7", label: "7 dias", days: 7, endOffset: 0 },
  { key: "30", label: "30 dias", days: 30, endOffset: 0 },
  { key: "90", label: "90 dias", days: 90, endOffset: 0 },
] as const;
type Period = (typeof PERIODS)[number];

const pct = (value: number | null) =>
  value == null
    ? "—"
    : `${(value * 100).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
const ratio = (value: number | null) =>
  value == null
    ? "—"
    : `${value.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}x`;
const money = (value: number | null) => (value == null ? "—" : brl(value));
const dayLabel = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;

const STEP_LABEL = (position: number) => (position < 0 ? "Sem etapa" : `Etapa ${position + 1}`);

/** Origin with real spend and no recovered player: shown as waste. */
const isWaste = (source: CrmSource) => source.cost >= 50 && source.influencedPlayers === 0;

export function CentralResults() {
  const [period, setPeriod] = useState<Period>(PERIODS[3]);
  const load = useServerFn(getCrmResults);
  const query = useQuery({
    queryKey: ["crm-results", period.key],
    queryFn: () => load({ data: { days: period.days, endOffset: period.endOffset } }),
    staleTime: 60_000,
  });
  const loadAccess = useServerFn(getComparisonAccess);
  const access = useQuery({
    queryKey: ["tenant-comparison-access"],
    queryFn: () => loadAccess(),
    staleTime: 5 * 60_000,
  });

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Resultados do CRM</h1>
          <p className="text-sm text-muted-foreground">
            Onde jornadas e campanhas recuperam jogadores, e quanto custa cada recuperação.
            {query.data &&
              ` ${
                query.data.from === query.data.to
                  ? dayLabel(query.data.from)
                  : `${dayLabel(query.data.from)} a ${dayLabel(query.data.to)}`
              } · horário de Brasília`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Período">
          {query.data && (
            <Button size="sm" variant="outline" onClick={() => downloadCsv(query.data)}>
              Exportar CSV
            </Button>
          )}
          {access.data?.allowed && (
            <Button size="sm" variant="outline" asChild>
              <Link to="/resultados/comparar">Comparar casas</Link>
            </Button>
          )}
          {PERIODS.map((value) => (
            <Button
              key={value.key}
              size="sm"
              variant={period.key === value.key ? "default" : "outline"}
              onClick={() => setPeriod(value)}
            >
              {value.label}
            </Button>
          ))}
        </div>
      </header>

      {query.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : query.isError || !query.data ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Não foi possível carregar os resultados. Tente novamente em instantes.
          </CardContent>
        </Card>
      ) : (
        <Results data={query.data} />
      )}
    </main>
  );
}

type Data = Awaited<ReturnType<typeof getCrmResults>>;

function downloadCsv(data: Data) {
  const url = URL.createObjectURL(
    new Blob([crmResultsCsv(data, data)], { type: "text/csv;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `resultados-crm-${data.from}-a-${data.to}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function Results({ data }: { data: Data }) {
  const { totals } = data;
  if (totals.sent === 0 && totals.directConversions === 0 && totals.influencedPlayers === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Nenhum envio de jornada ou campanha neste período. Os resultados aparecem até 10 minutos
          depois dos primeiros envios.
        </CardContent>
      </Card>
    );
  }
  return (
    <Tabs defaultValue="overview" className="space-y-4">
      <TabsList className="flex h-auto flex-wrap justify-start">
        <TabsTrigger value="overview">Visão geral</TabsTrigger>
        <TabsTrigger value="recommendations">Recomendações</TabsTrigger>
        <TabsTrigger value="sources">Onde recupera</TabsTrigger>
        <TabsTrigger value="states">Situação do jogador</TabsTrigger>
        <TabsTrigger value="holdout">Teste de controle</TabsTrigger>
        <TabsTrigger value="retention">Retenção</TabsTrigger>
        <TabsTrigger value="acquisition">Aquisição</TabsTrigger>
        <TabsTrigger value="health">Saúde dos dados</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">
        <Overview data={data} />
      </TabsContent>
      <TabsContent value="recommendations">
        <Recommendations data={data} />
      </TabsContent>
      <TabsContent value="sources">
        <Sources sources={data.sources} />
      </TabsContent>
      <TabsContent value="states">
        <States states={data.states} />
      </TabsContent>
      <TabsContent value="holdout">
        <Holdout data={data} />
      </TabsContent>
      <TabsContent value="retention">
        <Retention days={data.days} endOffset={data.endOffset} />
      </TabsContent>
      <TabsContent value="acquisition">
        <Acquisition days={data.days} endOffset={data.endOffset} />
      </TabsContent>
      <TabsContent value="health">
        <Health data={data} />
      </TabsContent>
    </Tabs>
  );
}

function Kpi({
  label,
  value,
  detail,
  highlight = false,
}: {
  label: string;
  value: string;
  detail?: string;
  highlight?: boolean;
}) {
  return (
    <Card className={highlight ? "border-emerald-500/40 bg-emerald-500/[0.06]" : undefined}>
      <CardContent className="space-y-1 p-4">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p
          className={`text-2xl font-semibold tabular-nums ${
            highlight ? "text-emerald-600 dark:text-emerald-400" : ""
          }`}
        >
          {value}
        </p>
        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      </CardContent>
    </Card>
  );
}

function Overview({ data }: { data: Data }) {
  const { totals, sources } = data;
  const ranked = sources.filter(
    (source) => source.influencedPlayers >= 3 && source.costPerRecovered,
  );
  const best = [...ranked].sort((a, b) => (a.costPerRecovered ?? 0) - (b.costPerRecovered ?? 0))[0];
  const waste = sources.filter(isWaste);
  const wasteCost = waste.reduce((sum, source) => sum + source.cost, 0);
  const activeShare = totals.cost > 0 ? totals.costOnActive / totals.cost : null;
  const clickRoi = totals.cost > 0 ? totals.directRevenue / totals.cost : null;
  const costPerConversion =
    totals.directConversions > 0 ? totals.cost / totals.directConversions : null;
  const funnel = [
    { label: "SMS cobrados", value: num(totals.sent), rate: null },
    {
      label: "Cliques",
      value: num(totals.humanClicks),
      rate: totals.sent > 0 ? `${pct(totals.humanClicks / totals.sent)} dos SMS` : null,
    },
    {
      label: "Depósitos",
      value: num(totals.directConversions),
      rate:
        totals.humanClicks > 0
          ? `${pct(totals.directConversions / totals.humanClicks)} dos cliques`
          : null,
    },
  ];

  return (
    <div className="space-y-4">
      <section aria-labelledby="click-title" className="space-y-3">
        <div>
          <h2 id="click-title" className="text-base font-semibold">
            Conversão por clique
          </h2>
          <p className="text-sm text-muted-foreground">
            Jogadores que clicaram no link do SMS e depositaram em até 7 dias.
          </p>
        </div>
        <Card className="border-emerald-500/40 bg-emerald-500/[0.06]">
          <CardContent className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between">
            <ol
              className="flex flex-wrap items-center gap-x-3 gap-y-2"
              aria-label="Funil do clique"
            >
              {funnel.map((step, index) => (
                <li key={step.label} className="flex items-center gap-3">
                  {index > 0 && (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  )}
                  <div>
                    <p className="text-xs text-muted-foreground">{step.label}</p>
                    <p className="text-xl font-semibold tabular-nums">{step.value}</p>
                    {step.rate && <p className="text-xs text-muted-foreground">{step.rate}</p>}
                  </div>
                </li>
              ))}
            </ol>
            <div className="lg:text-right">
              <p className="text-sm text-muted-foreground">Valor convertido</p>
              <p className="text-3xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                {brl(totals.directRevenue)}
              </p>
            </div>
          </CardContent>
        </Card>
        <div className="grid gap-3 sm:grid-cols-3">
          <Kpi
            label="Custo em SMS"
            value={brl(totals.cost)}
            detail={`${num(totals.sent)} mensagens cobradas`}
          />
          <Kpi
            label="Custo por depósito"
            value={money(costPerConversion)}
            detail="custo ÷ depósitos após clique"
          />
          <Kpi label="Retorno" value={ratio(clickRoi)} detail="valor convertido ÷ custo" />
        </div>
      </section>

      <Card className="bg-muted/20">
        <CardContent className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Visão ampla: jogadores recuperados</p>
            <p className="text-xs text-muted-foreground">
              Parados há 2+ dias que voltaram a depositar até 3 dias depois de um SMS, com ou sem
              clique. Inclui boa parte das conversões por clique: não some os dois.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-6 tabular-nums">
            <div>
              <p className="text-lg font-semibold">{num(totals.influencedPlayers)}</p>
              <p className="text-xs text-muted-foreground">recuperados</p>
            </div>
            <div>
              <p className="text-lg font-semibold">{brl(totals.influencedRevenue)}</p>
              <p className="text-xs text-muted-foreground">valor</p>
            </div>
            <div>
              <p className="text-lg font-semibold">{money(totals.costPerRecovered)}</p>
              <p className="text-xs text-muted-foreground">por recuperado</p>
            </div>
            <div>
              <p className="text-lg font-semibold">{ratio(totals.roi)}</p>
              <p className="text-xs text-muted-foreground">retorno</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <RecoveryNote />

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Custo × recuperado por dia</CardTitle>
          </CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={data.daily.map((day) => ({ ...day, label: dayLabel(day.date) }))}
              >
                <CartesianGrid strokeOpacity={0.15} vertical={false} />
                <XAxis dataKey="label" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                  width={80}
                  tickFormatter={(value) => brl(Number(value))}
                />
                <Tooltip
                  formatter={(value: number, name: string) => [
                    brl(Number(value)),
                    name === "cost"
                      ? "Custo"
                      : name === "influencedRevenue"
                        ? "Recuperado"
                        : "Conversão por clique",
                  ]}
                />
                <Legend
                  formatter={(name: string) =>
                    name === "cost"
                      ? "Custo"
                      : name === "influencedRevenue"
                        ? "Recuperado"
                        : "Conversão por clique"
                  }
                />
                <Bar dataKey="cost" fill="oklch(0.75 0.15 75)" radius={[4, 4, 0, 0]} />
                <Line
                  dataKey="influencedRevenue"
                  stroke="oklch(0.72 0.18 150)"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  dataKey="directRevenue"
                  stroke="oklch(0.68 0.21 253)"
                  strokeWidth={2}
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Destaques do período</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {best ? (
              <p className="flex gap-2">
                <TrendingUp
                  className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500"
                  aria-hidden="true"
                />
                <span>
                  <strong>{best.name}</strong> é a origem mais eficiente:{" "}
                  {money(best.costPerRecovered)} por jogador recuperado (
                  {num(best.influencedPlayers)} retornos, {brl(best.influencedRevenue)}).
                </span>
              </p>
            ) : (
              <p className="text-muted-foreground">
                Ainda não há origem com 3 ou mais recuperações para comparar eficiência.
              </p>
            )}
            {waste.length > 0 && (
              <p className="flex gap-2">
                <AlertTriangle
                  className="mt-0.5 h-4 w-4 shrink-0 text-amber-500"
                  aria-hidden="true"
                />
                <span>
                  {num(waste.length)} origem(ns) gastaram {brl(wasteCost)} sem recuperar nenhum
                  jogador parado. Veja em “Onde recupera”.
                </span>
              </p>
            )}
            {activeShare != null && activeShare > 0.2 && (
              <p className="flex gap-2">
                <AlertTriangle
                  className="mt-0.5 h-4 w-4 shrink-0 text-amber-500"
                  aria-hidden="true"
                />
                <span>
                  {pct(activeShare)} do custo ({brl(totals.costOnActive)}) foi para jogadores que já
                  estavam ativos (depositaram há menos de 2 dias).
                </span>
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SourceName({ source }: { source: CrmSource }) {
  const label =
    source.type === "journey" ? "Jornada" : source.type === "campaign" ? "Campanha" : "Outro";
  return (
    <div className="min-w-0">
      {source.type === "journey" && source.sourceId ? (
        <Link
          to="/jornadas/$journeyId/relatorio"
          params={{ journeyId: source.sourceId }}
          className="font-medium hover:underline"
        >
          {source.name}
        </Link>
      ) : source.type === "campaign" && source.sourceId ? (
        <Link
          to="/campanhas/$campaignId/relatorio"
          params={{ campaignId: source.sourceId }}
          className="font-medium hover:underline"
        >
          {source.name}
        </Link>
      ) : (
        <span className="font-medium">{source.name}</span>
      )}
      <div className="mt-0.5 flex flex-wrap gap-1">
        <Badge variant="outline" className="text-[10px]">
          {label}
        </Badge>
        {isWaste(source) && (
          <Badge
            variant="outline"
            className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-600 dark:text-amber-400"
          >
            gasta sem recuperar
          </Badge>
        )}
      </div>
    </div>
  );
}

function Sources({ sources }: { sources: CrmSource[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const maxRecovered = Math.max(0, ...sources.map((source) => source.influencedRevenue));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Onde recupera</CardTitle>
        <CardDescription>
          Ordenado por valor recuperado. Abra uma jornada para ver o resultado de cada etapa.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Origem</TableHead>
              <TableHead className="text-right">Envios</TableHead>
              <TableHead className="text-right">Custo</TableHead>
              <TableHead className="min-w-40">Recuperados</TableHead>
              <TableHead className="text-right">Custo / recuperado</TableHead>
              <TableHead className="text-right">Retorno</TableHead>
              <TableHead className="text-right">Conversão por clique</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sources.map((source) => {
              const id = `${source.type}:${source.key}`;
              const expandable = source.type === "journey" && source.steps.length > 1;
              const expanded = open === id;
              return (
                <Fragment key={id}>
                  <TableRow>
                    <TableCell>
                      {expandable && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          aria-expanded={expanded}
                          aria-label={`${expanded ? "Fechar" : "Ver"} etapas de ${source.name}`}
                          onClick={() => setOpen(expanded ? null : id)}
                        >
                          {expanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </Button>
                      )}
                    </TableCell>
                    <TableCell>
                      <SourceName source={source} />
                    </TableCell>
                    <MetricCells metrics={source} maxRecovered={maxRecovered} />
                  </TableRow>
                  {expanded &&
                    source.steps.map((step) => (
                      <TableRow key={`${id}:${step.position}`} className="bg-muted/30 text-xs">
                        <TableCell />
                        <TableCell className="pl-6 text-muted-foreground">
                          {STEP_LABEL(step.position)}
                        </TableCell>
                        <MetricCells metrics={step} maxRecovered={maxRecovered} compact />
                      </TableRow>
                    ))}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
        <div className="border-t p-4">
          <RecoveryNote />
        </div>
      </CardContent>
    </Card>
  );
}

/** Return multiple coloured by whether it pays back: green ≥ 1x, red below. */
function RoiValue({ roi, cost }: { roi: number | null; cost: number }) {
  if (roi == null || (roi === 0 && cost > 0)) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span
      className={`font-medium ${
        roi >= 1 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
      }`}
    >
      {ratio(roi)}
    </span>
  );
}

function MetricCells({
  metrics,
  maxRecovered,
  compact = false,
}: {
  metrics: CrmMetricsWithRatios;
  maxRecovered: number;
  compact?: boolean;
}) {
  const share = maxRecovered > 0 ? metrics.influencedRevenue / maxRecovered : 0;
  const none = metrics.influencedPlayers === 0;
  return (
    <>
      <TableCell className="text-right tabular-nums">{num(metrics.sent)}</TableCell>
      <TableCell className="text-right tabular-nums">{brl(metrics.cost)}</TableCell>
      <TableCell className="tabular-nums">
        {none ? (
          <span className="text-muted-foreground">nenhum</span>
        ) : (
          <div className="space-y-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className={compact ? "font-medium" : "font-semibold"}>
                {num(metrics.influencedPlayers)}
              </span>
              <span className="text-muted-foreground">{brl(metrics.influencedRevenue)}</span>
            </div>
            <div className="h-1 rounded-full bg-muted" aria-hidden="true">
              <div
                className="h-1 rounded-full bg-emerald-500/70"
                style={{ width: `${Math.max(2, share * 100)}%` }}
              />
            </div>
          </div>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {metrics.costPerRecovered == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          money(metrics.costPerRecovered)
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <RoiValue roi={metrics.roi} cost={metrics.cost} />
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {metrics.directConversions > 0 ? (
          <>
            {num(metrics.directConversions)} · {brl(metrics.directRevenue)}
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
        <div className="text-xs text-muted-foreground">{num(metrics.humanClicks)} clique(s)</div>
      </TableCell>
    </>
  );
}

/** How to read "recuperado": shown wherever the number appears, folded by default. */
function RecoveryNote() {
  return (
    <details className="group text-xs text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-foreground [&::-webkit-details-marker]:hidden">
        <Info className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        Como ler os números
        <ChevronRight
          className="h-3.5 w-3.5 transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <ul className="mt-2 list-disc space-y-1 pl-9">
        <li>
          <strong>Recuperados</strong>: jogador parado há 2+ dias (ou sem 1º depósito) que depositou
          até 3 dias depois de um SMS. O crédito vai só para o último SMS antes do depósito, então
          nenhuma origem divide ou repete o mesmo retorno.
        </li>
        <li>
          O valor é só o <strong>depósito de retorno</strong>, não tudo o que o jogador depositou
          depois.
        </li>
        <li>
          Conta <strong>retornos, não pessoas</strong>: quem parou e voltou duas vezes no período
          conta duas.
        </li>
        <li>
          <strong>Retorno</strong> = valor recuperado ÷ custo. Verde quando paga o envio (1x ou
          mais), vermelho quando não paga.
        </li>
        <li>
          <strong>Conversão por clique</strong> é a medida principal e mais rígida: clicou no link e
          depositou em até 7 dias. Boa parte já está nos recuperados, por isso não se somam.
        </li>
        <li>
          Voltar depois do SMS não prova que voltou <strong>por causa</strong> do SMS; parte
          voltaria de qualquer jeito. O efeito real aparece na aba “Teste de controle”, que compara
          com quem não recebeu nada.
        </li>
      </ul>
    </details>
  );
}

function States({ states }: { states: Data["states"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Situação do jogador no envio</CardTitle>
        <CardDescription>
          Em que momento o jogador estava quando recebeu a mensagem. Só jogadores parados ou sem 1º
          depósito podem ser recuperados; envios a ativos são custo de relacionamento.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Situação</TableHead>
              <TableHead className="text-right">Envios</TableHead>
              <TableHead className="text-right">Jogadores</TableHead>
              <TableHead className="text-right">Custo</TableHead>
              <TableHead className="text-right">Recuperados</TableHead>
              <TableHead className="text-right">Taxa</TableHead>
              <TableHead className="text-right">Custo / recuperado</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {states.map((state) => (
              <TableRow key={state.state}>
                <TableCell>
                  {state.label}
                  {!RECOVERABLE_STATES.has(state.state) && (
                    <span className="ml-2 text-xs text-muted-foreground">(não recuperável)</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{num(state.sent)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(state.recipients)}</TableCell>
                <TableCell className="text-right tabular-nums">{brl(state.cost)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {num(state.influencedPlayers)} · {brl(state.influencedRevenue)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{pct(state.recoveryRate)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {money(state.costPerRecovered)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Health({ data }: { data: Data }) {
  const { health } = data;
  const diff =
    health.rawSent != null && health.rawSent > 0
      ? Math.abs(health.tableSent - health.rawSent) / health.rawSent
      : null;
  const updated = health.updatedAt ? new Date(health.updatedAt) : null;
  const minutesAgo = updated ? Math.round((Date.now() - updated.getTime()) / 60_000) : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Saúde dos dados</CardTitle>
        <CardDescription>Os números desta tela são recalculados a cada 10 minutos.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <HealthLine
          ok={minutesAgo != null && minutesAgo <= 30}
          label="Última atualização"
          value={
            updated
              ? `${updated.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} (há ${num(minutesAgo ?? 0)} min)`
              : "sem atualização"
          }
        />
        <HealthLine
          ok={diff != null && diff <= 0.01}
          label="Envios conferidos com o registro de SMS"
          value={
            health.rawSent == null
              ? "não disponível"
              : `${num(health.tableSent)} na tela · ${num(health.rawSent)} no registro (${pct(diff)} de diferença)`
          }
        />
        <ConsistencyChecks checks={health.checks} />
        {health.truncated && (
          <HealthLine
            ok={false}
            label="Volume"
            value="período muito longo: parte dos dados não foi carregada"
          />
        )}
        <p className="text-xs text-muted-foreground">
          O registro inclui mensagens de hoje que entram na próxima atualização; diferenças pequenas
          nas últimas horas são esperadas. Custo considera o preço do SMS da sua conta. WhatsApp,
          e-mail e voz ainda não entram no custo.
        </p>
      </CardContent>
    </Card>
  );
}

function HealthLine({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <span
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${ok ? "bg-emerald-500" : "bg-amber-500"}`}
        aria-hidden="true"
      />
      <div>
        <p className="font-medium">
          {label} <span className="sr-only">{ok ? "(ok)" : "(atenção)"}</span>
        </p>
        <p className="text-muted-foreground">{value}</p>
      </div>
    </div>
  );
}

function Holdout({ data }: { data: Data }) {
  const withResults = new Set(data.holdout.map((row) => row.journeyId));
  const pending = data.holdoutSetup.filter((journey) => !withResults.has(journey.journeyId));
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Teste de controle</CardTitle>
          <CardDescription>
            Uma parte sorteada dos jogadores que entram na jornada não recebe mensagens. Comparar a
            volta dos dois grupos em até 7 dias mostra o efeito real da jornada, sem contar quem
            voltaria de qualquer jeito.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
          {[
            ["1", "Sorteio", "Na entrada, cada jogador cai no grupo que recebe ou no controle."],
            ["2", "7 dias", "Os dois grupos são acompanhados por 7 dias depois da entrada."],
            ["3", "Resultado", "A diferença na volta entre os grupos é o que a jornada causou."],
          ].map(([step, title, text]) => (
            <div key={step} className="flex gap-3 rounded-lg border p-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                {step}
              </span>
              <div>
                <p className="font-medium">{title}</p>
                <p className="text-xs text-muted-foreground">{text}</p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {data.holdout.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Resultados</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Jornada</TableHead>
                  <TableHead className="text-right">Receberam: voltaram</TableHead>
                  <TableHead className="text-right">Controle: voltaram</TableHead>
                  <TableHead className="text-right">Diferença</TableHead>
                  <TableHead className="text-right">Jogadores a mais</TableHead>
                  <TableHead className="text-right">Valor a mais</TableHead>
                  <TableHead>Leitura</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.holdout.map((row) => (
                  <TableRow key={row.journeyId}>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {pct(row.treatedRate)}
                      <div className="text-xs text-muted-foreground">
                        de {num(row.treated.players)}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {pct(row.controlRate)}
                      <div className="text-xs text-muted-foreground">
                        de {num(row.control.players)}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.lift == null ? (
                        "—"
                      ) : (
                        <>
                          <span
                            className={
                              !row.significant
                                ? ""
                                : row.lift > 0
                                  ? "font-medium text-emerald-600 dark:text-emerald-400"
                                  : "font-medium text-red-600 dark:text-red-400"
                            }
                          >
                            {row.lift >= 0 ? "+" : ""}
                            {pct(row.lift)}
                          </span>
                          <div className="text-xs text-muted-foreground">
                            {pct(row.ciLow)} a {pct(row.ciHigh)}
                          </div>
                        </>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.incrementalPlayers == null
                        ? "—"
                        : num(Math.round(row.incrementalPlayers))}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(row.incrementalRevenue)}
                    </TableCell>
                    <TableCell>
                      {!row.sufficient ? (
                        <Badge variant="outline">amostra insuficiente</Badge>
                      ) : row.significant && (row.lift ?? 0) > 0 ? (
                        <Badge
                          variant="outline"
                          className="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        >
                          traz jogadores de volta
                        </Badge>
                      ) : row.significant ? (
                        <Badge
                          variant="outline"
                          className="border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400"
                        >
                          pior que não enviar
                        </Badge>
                      ) : (
                        <Badge variant="outline">sem diferença comprovada</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {pending.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Testes em andamento</CardTitle>
            <CardDescription>
              Ainda sem resultado: nenhum jogador destas jornadas completou os 7 dias. Para uma
              leitura confiável, cada grupo precisa de pelo menos {HOLDOUT_MIN_PLAYERS} jogadores.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {pending.map((journey) => {
              const progress = Math.min(1, journey.control / HOLDOUT_MIN_PLAYERS);
              return (
                <div key={journey.journeyId} className="space-y-3 rounded-lg border p-4">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium leading-tight">{journey.name}</p>
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      controle {journey.percent}%
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm tabular-nums">
                    <div>
                      <p className="text-lg font-semibold">{num(journey.treated)}</p>
                      <p className="text-xs text-muted-foreground">recebem mensagens</p>
                    </div>
                    <div>
                      <p className="text-lg font-semibold">{num(journey.control)}</p>
                      <p className="text-xs text-muted-foreground">no controle</p>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="h-1.5 rounded-full bg-muted" aria-hidden="true">
                      <div
                        className="h-1.5 rounded-full bg-primary"
                        style={{ width: `${Math.max(2, progress * 100)}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Amostra do controle: {num(journey.control)} de {HOLDOUT_MIN_PLAYERS}
                      {journey.firstResultAt
                        ? ` · primeiro resultado em ${new Date(journey.firstResultAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}`
                        : " · aguardando a primeira entrada"}
                      {journey.status !== "active" ? " · jornada desligada" : ""}
                    </p>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {data.holdout.length === 0 && pending.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-8 text-center text-sm">
            <p className="font-medium">Nenhuma jornada com grupo de controle</p>
            <p className="max-w-md text-muted-foreground">
              Ative em Jornadas → editar → Grupo de controle. Os primeiros resultados aparecem 7
              dias depois das primeiras entradas.
            </p>
            <Button size="sm" variant="outline" asChild>
              <Link to="/jornadas">Ir para Jornadas</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        Intervalo de 95%. “Amostra insuficiente” abaixo de {HOLDOUT_MIN_PLAYERS} jogadores por grupo
        ou {HOLDOUT_MIN_RETURNS} retornos. Jogadores do controle ficam fora das campanhas em massa,
        mas ainda recebem envios individuais.
      </p>
    </div>
  );
}

function useRetention(days: number, endOffset: number) {
  const load = useServerFn(getCrmRetention);
  return useQuery({
    queryKey: ["crm-retention", days, endOffset],
    queryFn: () => load({ data: { days, endOffset } }),
    staleTime: 5 * 60_000,
  });
}

const LIFECYCLE_ORDER = ["ativo", "esfriando", "dormindo", "perdido", "sem_ftd", "sem_historico"];
const percentOf = (value: number, total: number) => (total > 0 ? pct(value / total) : "—");
const pctValue = (value: number | null) =>
  value == null
    ? "—"
    : `${value.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
const hours = (value: number | null) =>
  value == null
    ? "—"
    : value < 24
      ? `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} h`
      : `${(value / 24).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} dias`;

function LoadFailed({ what }: { what: string }) {
  return (
    <Card>
      <CardContent className="p-6 text-sm text-muted-foreground">
        Não foi possível carregar {what}.
      </CardContent>
    </Card>
  );
}

function Bars({ items, total }: { items: Array<{ label: string; value: number }>; total: number }) {
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <div key={item.label} className="space-y-1">
          <div className="flex justify-between text-sm">
            <span>{item.label}</span>
            <span className="tabular-nums text-muted-foreground">
              {num(item.value)} · {percentOf(item.value, total)}
            </span>
          </div>
          <div className="h-2 rounded-full bg-muted/40">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${total ? (item.value / total) * 100 : 0}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function Retention({ days, endOffset }: { days: number; endOffset: number }) {
  const query = useRetention(days, endOffset);
  if (query.isLoading) return <Skeleton className="h-64 rounded-xl" />;
  if (query.isError || !query.data) return <LoadFailed what="a retenção" />;
  const { lifecycle, cohorts } = query.data;
  const totalPlayers = lifecycle.reduce((sum, row) => sum + row.players, 0);
  const ordered = [...lifecycle].sort(
    (a, b) => LIFECYCLE_ORDER.indexOf(a.state) - LIFECYCLE_ORDER.indexOf(b.state),
  );
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Onde a base está agora</CardTitle>
          <CardDescription>Pelo tempo desde o último depósito de cada jogador.</CardDescription>
        </CardHeader>
        <CardContent>
          <Bars
            total={totalPlayers}
            items={ordered.map((row) => ({
              label: PLAYER_STATE_LABELS[row.state] ?? row.state,
              value: row.players,
            }))}
          />
        </CardContent>
      </Card>
      {query.data.lifecycleDaily.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Evolução da base</CardTitle>
            <CardDescription>
              Jogadores em cada situação ao fim de cada dia. Ativos que viram “esfriando” são os que
              o CRM precisa trazer de volta.
            </CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={query.data.lifecycleDaily.map((day) => ({
                  ...day,
                  label: dayLabel(day.date),
                }))}
              >
                <CartesianGrid strokeOpacity={0.15} vertical={false} />
                <XAxis dataKey="label" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis fontSize={12} tickLine={false} axisLine={false} width={60} />
                <Tooltip
                  formatter={(value: number, name: string) => [
                    num(Number(value)),
                    PLAYER_STATE_LABELS[name] ?? name,
                  ]}
                />
                <Legend formatter={(name: string) => PLAYER_STATE_LABELS[name] ?? name} />
                <Line dataKey="ativo" stroke="oklch(0.72 0.18 150)" strokeWidth={2} dot={false} />
                <Line
                  dataKey="esfriando"
                  stroke="oklch(0.75 0.15 75)"
                  strokeWidth={2}
                  dot={false}
                />
                <Line dataKey="dormindo" stroke="oklch(0.65 0.2 30)" strokeWidth={2} dot={false} />
                <Line dataKey="perdido" stroke="oklch(0.6 0.03 260)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Retenção dos novos depositantes</CardTitle>
          <CardDescription>
            Jogadores agrupados pela semana do 1º depósito. A taxa só aparece depois que a janela se
            fecha para todos do grupo.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {cohorts.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">Sem primeiros depósitos no período.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Semana do 1º depósito</TableHead>
                  <TableHead className="text-right">Jogadores</TableHead>
                  <TableHead className="text-right">2º depósito em 7 dias</TableHead>
                  <TableHead className="text-right">em 14 dias</TableHead>
                  <TableHead className="text-right">em 30 dias</TableHead>
                  <TableHead className="text-right">Tempo até o 2º (mediana)</TableHead>
                  <TableHead className="text-right">Depositado em 30 dias</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cohorts.map((row) => (
                  <TableRow key={row.week}>
                    <TableCell>{dayLabel(row.week)}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(row.size)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {pctValue(row.second7d)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {pctValue(row.second14d)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {pctValue(row.second30d)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {hours(row.medianHoursToSecond)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(row.revenue30d)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <p className="px-6 py-3 text-xs text-muted-foreground">
            O histórico de depósitos começa em 02/09/2026; jogadores que já depositavam antes disso
            não entram como novos.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Acquisition({ days, endOffset }: { days: number; endOffset: number }) {
  const query = useRetention(days, endOffset);
  if (query.isLoading) return <Skeleton className="h-64 rounded-xl" />;
  if (query.isError || !query.data) return <LoadFailed what="a aquisição" />;
  const { total, byOrigin } = query.data.funnel;
  if (!total || total.signups === 0)
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Nenhum cadastro neste período.
        </CardContent>
      </Card>
    );
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Funil dos cadastros do período</CardTitle>
          <CardDescription>
            Quem se cadastrou{" "}
            {days === 1 ? (endOffset === 1 ? "ontem" : "hoje") : `nos últimos ${num(days)} dias`} e
            até onde chegou. Mediana do cadastro ao 1º depósito: {hours(total.medianHoursToFtd)}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Bars
            total={total.signups}
            items={[
              { label: "Cadastros", value: total.signups },
              { label: "1º depósito", value: total.firstDeposit },
              { label: "2º depósito", value: total.secondDeposit },
              { label: "3 ou mais depósitos", value: total.thirdPlus },
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Por origem do cadastro</CardTitle>
          <CardDescription>Origem informada no cadastro (utm_source).</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Origem</TableHead>
                <TableHead className="text-right">Cadastros</TableHead>
                <TableHead className="text-right">1º depósito</TableHead>
                <TableHead className="text-right">2º depósito</TableHead>
                <TableHead className="text-right">Tempo até o 1º (mediana)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byOrigin.slice(0, 15).map((row) => (
                <TableRow key={row.origin}>
                  <TableCell>{row.origin}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(row.signups)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {num(row.firstDeposit)} · {percentOf(row.firstDeposit, row.signups)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {num(row.secondDeposit)} · {percentOf(row.secondDeposit, row.signups)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {hours(row.medianHoursToFtd)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

const CHECK_LABELS: Record<string, string> = {
  sends: "Envios conferem com o registro de SMS",
  cost: "Custo confere com os créditos cobrados",
  direct: "Conversões por clique conferem com as atribuições",
};

function ConsistencyChecks({ checks }: { checks: Data["health"]["checks"] }) {
  if (checks.length === 0)
    return (
      <HealthLine
        ok={false}
        label="Checagem diária de consistência"
        value="ainda não rodou (roda todo dia às 03h40 para o dia anterior)"
      />
    );
  const latestDate = checks[0].date;
  const latest = checks.filter((check) => check.date === latestDate);
  const failures = checks.filter((check) => !check.ok);
  const format = (name: string, value: number) => (name === "cost" ? brl(value) : num(value));
  return (
    <>
      {latest.map((check) => (
        <HealthLine
          key={check.name}
          ok={check.ok}
          label={`${CHECK_LABELS[check.name] ?? check.name} (${dayLabel(check.date)})`}
          value={`tela ${format(check.name, check.actual)} · origem ${format(check.name, check.expected)}`}
        />
      ))}
      {failures.length > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {num(failures.length)} checagem(ns) com divergência nos últimos 14 dias:{" "}
          {failures
            .slice(0, 5)
            .map((check) => `${CHECK_LABELS[check.name] ?? check.name} em ${dayLabel(check.date)}`)
            .join("; ")}
          .
        </p>
      )}
    </>
  );
}

const SEVERITY_STYLE = {
  acao: {
    label: "Ação",
    className: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400",
  },
  atencao: {
    label: "Atenção",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  oportunidade: {
    label: "Oportunidade",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
} as const;

function Recommendations({ data }: { data: Data }) {
  const items = buildRecommendations(data, data.holdout);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recomendações</CardTitle>
        <CardDescription>
          Regras aplicadas aos resultados do período. Cada uma traz o número que a justifica.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nada a recomendar neste período: nenhuma origem gasta sem recuperar e não há dados
            suficientes para comparar eficiência.
          </p>
        ) : (
          <ul className="space-y-3">
            {items.map((item) => (
              <li key={item.title} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={SEVERITY_STYLE[item.severity].className}>
                    {SEVERITY_STYLE[item.severity].label}
                  </Badge>
                  <span className="font-medium">{item.title}</span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{item.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
