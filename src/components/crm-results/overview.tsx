import { AlertTriangle, ChevronRight, Clock, ShieldCheck, TrendingUp } from "lucide-react";
import { useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { buildRecommendations } from "@/lib/crm-recommendations";
import { isComparable } from "@/lib/crm-results";
import { useMoney } from "@/hooks/use-tenant-currency";
import { brl, num } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  CHART_COLORS,
  chartAxisProps,
  chartGridProps,
  chartLegendProps,
  chartTooltipProps,
} from "@/lib/chart-theme";
import { tourAnchor } from "@/help/anchor";
import { Term } from "@/components/help/term";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RecommendationList } from "./recommendations";
import {
  type Data,
  compareLabel,
  cost,
  crossCurrencyNote,
  dayLabel,
  isCrossCurrency,
  isWaste,
  pct,
  perReal,
  periodLabel,
  proofSeal,
} from "./format";
import { Delta, EmptyCard, InfoTip, RoiValue } from "./shared";

const TITLE_INFO =
  "Conta quem estava há 2 dias ou mais sem depositar (ou nunca depositou), clicou no link do SMS e depositou em até 7 dias depois do clique. Soma todos os depósitos desses 7 dias. Cada jogador conta uma vez, no dia do primeiro depósito. Quem já estava jogando não entra. O custo considera só SMS.";
const PARTIAL_INFO =
  "Quem clicou tem até 7 dias para depositar. Os números deste período ainda podem subir.";
const ACTIVE_INFO =
  "Clicaram, mas tinham depositado nos 2 dias anteriores e iam depositar de qualquer forma. Por isso não entram no Recuperado pelo CRM nem no retorno. O efeito do SMS sobre eles aparece em Prova e método.";
const ROLLING_INFO =
  "Em períodos curtos, o custo do dia e os depósitos vêm de envios diferentes (quem deposita hoje pode ter clicado em um SMS de dias atrás). Por isso o retorno usa os últimos 7 dias.";

export function Overview({
  data,
  onOpenOrigin,
  onOpenProof,
}: {
  data: Data;
  onOpenOrigin: (name: string) => void;
  onOpenProof: () => void;
}) {
  const [showAllRecommendations, setShowAllRecommendations] = useState(false);
  const { currency, money } = useMoney();
  // Casa fora de BRL: receita na moeda dela, custo em BRL, retorno não calculado.
  const crossCurrency = isCrossCurrency(currency);
  const { totals } = data;
  const previous = data.previous.totals;
  if (totals.sent === 0 && totals.directPlayers === 0 && totals.influencedPlayers === 0)
    return (
      <EmptyCard>
        Nenhum envio de jornada ou campanha neste período. Os resultados aparecem até 10 minutos
        depois dos primeiros envios. Retenção e cadastros ficam em Aquisição e LTV, aba “Retenção”.
      </EmptyCard>
    );

  const versus = compareLabel(data.previous.from, data.previous.to);
  const comparable = previous ? isComparable(totals, previous) : false;
  // Deposits arrive up to 7 days after the click: a period ending in the last week still grows.
  const partial = data.endOffset < 7;
  // Short periods read the return over the 7 days ending on the same day.
  const efficiency = data.rolling?.totals ?? totals;
  const sendDrop =
    previous && previous.sent > 0 && totals.sent < previous.sent * 0.5
      ? 1 - totals.sent / previous.sent
      : null;
  // "hoje" / "ontem" / "no período": every number says when it happened.
  const when = data.days === 1 ? (data.endOffset === 0 ? "hoje" : "ontem") : "no período";
  const afterClickPlayers = totals.directPlayers + totals.directActivePlayers;
  const afterClickRevenue = totals.directRevenue + totals.directActiveRevenue;
  const recoveredShare = afterClickRevenue > 0 ? totals.directRevenue / afterClickRevenue : 0;
  const seal = proofSeal(data.holdout, data.holdoutSetup.length);
  const recommendations = buildRecommendations(data, data.holdout);

  return (
    <div className="space-y-4">
      <section aria-labelledby="click-title" className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 id="click-title" className="flex items-center gap-1.5 text-section">
              Recuperado pelo CRM
              <InfoTip text={TITLE_INFO} />
            </h2>
            <p className="text-sm text-muted-foreground">
              Jogadores parados que clicaram no SMS e voltaram a depositar.
            </p>
          </div>
          {partial && (
            <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-meta text-muted-foreground">
              <Clock className="h-3 w-3" aria-hidden="true" />
              Parcial
              <InfoTip text={PARTIAL_INFO} />
            </span>
          )}
        </div>

        {sendDrop != null && (
          <p
            role="status"
            className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs"
          >
            <AlertTriangle
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning"
              aria-hidden="true"
            />
            Foram enviados {Math.round(sendDrop * 100)}% menos SMS que em {versus}. Custo e retorno
            mudam por isso.
          </p>
        )}

        <Card className="border-success/40 bg-success/[0.06]">
          <CardContent className="space-y-4 p-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-0.5">
                <p className="text-kpi tabular-nums text-success">{money(totals.directRevenue)}</p>
                <p className="text-sm">
                  {num(totals.directPlayers)}{" "}
                  {totals.directPlayers === 1
                    ? "jogador parado voltou"
                    : "jogadores parados voltaram"}{" "}
                  a depositar {when} pelo link do SMS
                </p>
                {previous && (
                  <Delta
                    current={totals.directRevenue}
                    previous={previous.directRevenue}
                    comparable={comparable}
                    formatDiff={(value) => money(value)}
                    versus={versus}
                  />
                )}
              </div>
              <div className="space-y-0.5 sm:text-right">
                <p className="text-label text-muted-foreground">
                  <Term id="retorno-do-envio">Cada R$ 1 em SMS trouxe</Term>
                </p>
                <p className="text-kpi-sm tabular-nums">
                  <RoiValue
                    roi={efficiency.clickRoi}
                    smallSample={efficiency.smallSample}
                    currency={currency}
                  />
                </p>
                <p className="text-xs text-muted-foreground">
                  {brl(efficiency.cost)} em SMS · {cost(efficiency.costPerConversion)} por jogador
                  recuperado
                </p>
                {crossCurrency ? (
                  <p className="text-xs text-muted-foreground">{crossCurrencyNote(currency)}</p>
                ) : data.rolling ? (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground sm:justify-end">
                    conta dos últimos 7 dias ({periodLabel(data.rolling.from, data.rolling.to)})
                    <InfoTip text={ROLLING_INFO} />
                  </p>
                ) : (
                  previous && (
                    <Delta
                      current={totals.clickRoi}
                      previous={previous.clickRoi}
                      comparable={comparable}
                      formatDiff={perReal}
                      versus={versus}
                    />
                  )
                )}
              </div>
            </div>

            <div className="border-t border-success/20 pt-3">
              <p className="text-label text-muted-foreground">SMS e cliques {when}</p>
              <ol
                className="mt-1 flex flex-col gap-1 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-2"
                aria-label={`SMS e cliques ${when}`}
              >
                <li>
                  <span className="font-medium tabular-nums">{num(totals.sent)}</span> SMS enviados{" "}
                  <span className="text-muted-foreground">({brl(totals.cost)})</span>
                </li>
                <li className="flex items-center gap-2">
                  <ChevronRight
                    className="hidden h-4 w-4 text-muted-foreground sm:block"
                    aria-hidden="true"
                  />
                  <span>
                    <span className="font-medium tabular-nums">{num(totals.humanClicks)}</span>{" "}
                    cliques no link{" "}
                    {totals.clickRate != null && (
                      <span className="text-muted-foreground">
                        ({pct(totals.clickRate)} dos SMS)
                      </span>
                    )}
                  </span>
                </li>
                <li className="flex items-center gap-2">
                  <ChevronRight
                    className="hidden h-4 w-4 text-muted-foreground sm:block"
                    aria-hidden="true"
                  />
                  <span>
                    <span className="font-medium tabular-nums">{num(totals.convertedClicks)}</span>{" "}
                    {totals.convertedClicks === 1
                      ? "desses cliques já virou depósito"
                      : "desses cliques já viraram depósito"}{" "}
                    {totals.conversionRate != null && (
                      <span className="text-muted-foreground">
                        ({pct(totals.conversionRate)}
                        {partial && " · pode aumentar: quem clicou tem 7 dias para depositar"})
                      </span>
                    )}
                  </span>
                </li>
              </ol>
            </div>

            {totals.directActivePlayers > 0 && (
              <div className="space-y-2 border-t border-success/20 pt-3">
                <p className="text-sm">
                  Depositaram {when} depois de clicar em um SMS dos últimos 7 dias:{" "}
                  <span className="font-medium tabular-nums">{num(afterClickPlayers)}</span>{" "}
                  jogadores ·{" "}
                  <span className="font-medium tabular-nums">{money(afterClickRevenue)}</span>
                </p>
                <div
                  className="flex h-2 overflow-hidden rounded-full bg-muted-foreground/30"
                  role="img"
                  aria-label={`${pct(recoveredShare)} do valor depositado depois do clique é Recuperado pelo CRM`}
                >
                  <div className="bg-success" style={{ width: `${recoveredShare * 100}%` }} />
                </div>
                <div className="flex flex-col gap-1 text-xs sm:flex-row sm:flex-wrap sm:gap-x-4">
                  <span className="flex items-center gap-1.5">
                    <span className="size-2 rounded-sm bg-success" aria-hidden="true" />
                    Estavam parados (Recuperado pelo CRM): {money(totals.directRevenue)} ·{" "}
                    {num(totals.directPlayers)} jogadores
                  </span>
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="size-2 rounded-sm bg-muted-foreground/30" aria-hidden="true" />
                    Já estavam jogando (não contam): {money(totals.directActiveRevenue)} ·{" "}
                    {num(totals.directActivePlayers)} jogadores
                    <InfoTip text={ACTIVE_INFO} />
                  </span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <ShieldCheck
            className={cn(
              "h-3.5 w-3.5 shrink-0",
              seal.tone === "success"
                ? "text-success"
                : seal.tone === "danger"
                  ? "text-danger"
                  : "text-muted-foreground",
            )}
            aria-hidden="true"
          />
          <span className={seal.tone === "muted" ? "text-muted-foreground" : undefined}>
            {seal.text}
          </span>
          <button
            type="button"
            className="font-medium text-primary underline-offset-2 hover:underline"
            onClick={onOpenProof}
            {...tourAnchor("resultados.visao.ver-prova")}
          >
            Ver prova e método
          </button>
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <DailyChart data={data} />
        <Highlights data={data} onOpenOrigin={onOpenOrigin} />
      </div>

      {recommendations.length > 0 && (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>O que fazer agora</CardTitle>
            {recommendations.length > 3 && (
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={showAllRecommendations}
                onClick={() => setShowAllRecommendations((value) => !value)}
                {...tourAnchor("resultados.visao.recomendacoes.ver-todas")}
              >
                {showAllRecommendations ? "Ver menos" : `Ver todas (${recommendations.length})`}
              </Button>
            )}
          </CardHeader>
          <CardContent>
            <RecommendationList
              items={showAllRecommendations ? recommendations : recommendations.slice(0, 3)}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function DailyChart({ data }: { data: Data }) {
  const { currency, money } = useMoney();
  // Fora de BRL, custo (BRL) e recuperado (moeda da casa) ganham eixos separados.
  const crossCurrency = isCrossCurrency(currency);
  if (data.days === 1)
    return (
      <EmptyCard>
        O gráfico diário aparece a partir de 7 dias. Para um único dia, veja o resultado de cada
        origem na aba “Origens”.
      </EmptyCard>
    );
  // Revenue counts on the day of the deposit, so a closed day does not grow.
  const points = data.daily.map((day) => ({
    label: dayLabel(day.date),
    cost: day.cost,
    converted: day.directRevenue,
  }));
  const names: Record<string, string> = {
    cost: "Custo em SMS",
    converted: "Recuperado pelo CRM",
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Custo × recuperado pelo CRM por dia</CardTitle>
        <CardDescription>Recuperado pelo CRM pelo dia do depósito.</CardDescription>
      </CardHeader>
      <CardContent className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points}>
            <CartesianGrid {...chartGridProps} />
            <XAxis dataKey="label" {...chartAxisProps} />
            <YAxis
              yAxisId="cost"
              {...chartAxisProps}
              width={80}
              tickFormatter={(value) => brl(Number(value))}
            />
            {crossCurrency && (
              <YAxis
                yAxisId="revenue"
                orientation="right"
                {...chartAxisProps}
                width={90}
                tickFormatter={(value) => money(Number(value), { compact: true })}
              />
            )}
            <Tooltip
              {...chartTooltipProps}
              formatter={(value: number, name: string) => [
                name === "cost" ? brl(Number(value)) : money(Number(value)),
                names[name] ?? name,
              ]}
            />
            <Legend {...chartLegendProps} formatter={(name: string) => names[name] ?? name} />
            <Bar
              yAxisId="cost"
              dataKey="cost"
              fill={CHART_COLORS.warning}
              fillOpacity={0.6}
              radius={[4, 4, 0, 0]}
            />
            <Line
              yAxisId={crossCurrency ? "revenue" : "cost"}
              dataKey="converted"
              stroke={CHART_COLORS.success}
              strokeWidth={3}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function Highlights({ data, onOpenOrigin }: { data: Data; onOpenOrigin: (name: string) => void }) {
  const { money } = useMoney();
  const { totals, sources } = data;
  const best = [...sources]
    .filter((source) => !source.smallSample && source.costPerConversion != null)
    .sort((a, b) => (a.costPerConversion ?? 0) - (b.costPerConversion ?? 0))[0];
  const waste = sources.filter(isWaste);
  const wasteCost = waste.reduce((sum, source) => sum + source.cost, 0);
  const activeShare = totals.cost > 0 ? totals.costOnActive / totals.cost : null;
  const linkClass = "font-semibold underline-offset-2 hover:underline";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Destaques do período</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {best ? (
          <p className="flex gap-2">
            <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
            <span>
              <button type="button" className={linkClass} onClick={() => onOpenOrigin(best.name)}>
                {best.name}
              </button>{" "}
              traz jogadores de volta mais barato: {cost(best.costPerConversion)} por jogador (
              {num(best.directPlayers)} jogadores, {money(best.directRevenue)}).
            </span>
          </p>
        ) : (
          <p className="text-muted-foreground">
            Ainda não há origem com 5 ou mais jogadores que voltaram pelo link para comparar
            eficiência.
          </p>
        )}
        {waste.length > 0 && (
          <p className="flex gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <span>
              {waste.length === 1 ? (
                <>
                  <button
                    type="button"
                    className={linkClass}
                    onClick={() => onOpenOrigin(waste[0].name)}
                  >
                    {waste[0].name}
                  </button>{" "}
                  gastou {brl(wasteCost)} sem trazer nenhum jogador de volta.
                </>
              ) : (
                <>
                  {num(waste.length)} origens gastaram {brl(wasteCost)} sem trazer nenhum jogador de
                  volta.
                </>
              )}
            </span>
          </p>
        )}
        {activeShare != null && activeShare > 0.2 && (
          <p className="flex gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <span>
              {pct(activeShare)} do custo ({brl(totals.costOnActive)}) foi para jogadores que já
              estavam jogando (depositaram nos 2 dias anteriores).
            </span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
