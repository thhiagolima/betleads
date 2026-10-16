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
import { PLAYER_STATE_LABELS, RECOVERABLE_STATES, type CrmSource } from "@/lib/crm-results";
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

const PERIODS = [7, 30, 90] as const;

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
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30);
  const load = useServerFn(getCrmResults);
  const query = useQuery({
    queryKey: ["crm-results", days],
    queryFn: () => load({ data: { days } }),
    staleTime: 60_000,
  });

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Resultados do CRM</h1>
          <p className="text-sm text-muted-foreground">
            Onde jornadas e campanhas recuperam jogadores, e quanto custa cada recuperação.
            {query.data &&
              ` ${dayLabel(query.data.from)} a ${dayLabel(query.data.to)} · horário de Brasília`}
          </p>
        </div>
        <div className="flex gap-2" role="group" aria-label="Período">
          {PERIODS.map((value) => (
            <Button
              key={value}
              size="sm"
              variant={days === value ? "default" : "outline"}
              onClick={() => setDays(value)}
            >
              {value} dias
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
        <Retention days={data.days} />
      </TabsContent>
      <TabsContent value="acquisition">
        <Acquisition days={data.days} />
      </TabsContent>
      <TabsContent value="health">
        <Health data={data} />
      </TabsContent>
    </Tabs>
  );
}

function Kpi({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
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

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi
          label="Recuperado (influenciado)"
          value={brl(totals.influencedRevenue)}
          detail={`${num(totals.influencedPlayers)} retorno(s) de jogadores parados`}
        />
        <Kpi
          label="Recuperado (clique no link)"
          value={brl(totals.directRevenue)}
          detail={`${num(totals.directConversions)} depósito(s) após clique`}
        />
        <Kpi
          label="Custo em SMS"
          value={brl(totals.cost)}
          detail={`${num(totals.sent)} mensagens cobradas`}
        />
        <Kpi
          label="Custo por recuperado"
          value={money(totals.costPerRecovered)}
          detail="custo ÷ retornos influenciados"
        />
        <Kpi label="Retorno" value={ratio(totals.roi)} detail="recuperado ÷ custo" />
      </div>

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        Influenciado: jogador parado há 2+ dias (ou sem 1º depósito) que depositou até 3 dias depois
        de um SMS, creditado só ao último SMS. Clique: depósito até 7 dias depois de clicar no link.
        São medidas diferentes e não se somam; nenhuma prova sozinha que o jogador não voltaria sem
        a mensagem.
      </p>

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
                        ? "Recuperado (influenciado)"
                        : "Recuperado (clique)",
                  ]}
                />
                <Legend
                  formatter={(name: string) =>
                    name === "cost"
                      ? "Custo"
                      : name === "influencedRevenue"
                        ? "Recuperado (influenciado)"
                        : "Recuperado (clique)"
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
              <TableHead className="text-right">Cliques</TableHead>
              <TableHead className="text-right">Clique → depósito</TableHead>
              <TableHead className="text-right">Recuperados</TableHead>
              <TableHead className="text-right">Custo / recuperado</TableHead>
              <TableHead className="text-right">Retorno</TableHead>
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
                    <TableCell className="text-right tabular-nums">{num(source.sent)}</TableCell>
                    <TableCell className="text-right tabular-nums">{brl(source.cost)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {num(source.humanClicks)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {num(source.directConversions)} · {brl(source.directRevenue)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {num(source.influencedPlayers)} · {brl(source.influencedRevenue)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(source.costPerRecovered)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{ratio(source.roi)}</TableCell>
                  </TableRow>
                  {expanded &&
                    source.steps.map((step) => (
                      <TableRow key={`${id}:${step.position}`} className="bg-muted/30 text-xs">
                        <TableCell />
                        <TableCell className="pl-6 text-muted-foreground">
                          {STEP_LABEL(step.position)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{num(step.sent)}</TableCell>
                        <TableCell className="text-right tabular-nums">{brl(step.cost)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {num(step.humanClicks)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {num(step.directConversions)} · {brl(step.directRevenue)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {num(step.influencedPlayers)} · {brl(step.influencedRevenue)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(step.costPerRecovered)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{ratio(step.roi)}</TableCell>
                      </TableRow>
                    ))}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
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
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Teste de controle</CardTitle>
        <CardDescription>
          Em jornadas com grupo de controle, uma parte sorteada dos jogadores não recebe mensagens.
          A diferença na volta em até 7 dias entre os dois grupos é o efeito real da jornada.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        {data.holdout.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            Nenhuma jornada com grupo de controle neste período. Ative em Jornadas → editar → Grupo
            de controle; os primeiros resultados aparecem 7 dias depois das primeiras entradas.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Jornada</TableHead>
                <TableHead className="text-right">Receberam</TableHead>
                <TableHead className="text-right">Controle</TableHead>
                <TableHead className="text-right">Diferença (lift)</TableHead>
                <TableHead className="text-right">Jogadores a mais</TableHead>
                <TableHead className="text-right">Receita a mais</TableHead>
                <TableHead>Leitura</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.holdout.map((row) => (
                <TableRow key={row.journeyId}>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {pct(row.treatedRate)} de {num(row.treated.players)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {pct(row.controlRate)} de {num(row.control.players)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.lift == null
                      ? "—"
                      : `${row.lift >= 0 ? "+" : ""}${pct(row.lift)} (${pct(row.ciLow)} a ${pct(row.ciHigh)})`}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.incrementalPlayers == null ? "—" : num(Math.round(row.incrementalPlayers))}
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
        )}
        <p className="px-6 py-3 text-xs text-muted-foreground">
          Intervalo de 95%. “Amostra insuficiente” abaixo de 100 jogadores por grupo ou 10 retornos.
          Jogadores do controle ainda podem receber campanhas, o que tende a subestimar o efeito.
        </p>
      </CardContent>
    </Card>
  );
}

function useRetention(days: number) {
  const load = useServerFn(getCrmRetention);
  return useQuery({
    queryKey: ["crm-retention", days],
    queryFn: () => load({ data: { days } }),
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

function Retention({ days }: { days: number }) {
  const query = useRetention(days);
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

function Acquisition({ days }: { days: number }) {
  const query = useRetention(days);
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
            Quem se cadastrou nos últimos {num(days)} dias e até onde chegou. Mediana do cadastro ao
            1º depósito: {hours(total.medianHoursToFtd)}.
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
