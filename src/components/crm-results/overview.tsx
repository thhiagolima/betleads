import { AlertTriangle, ChevronRight, Clock, TrendingUp } from "lucide-react";
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
import type { CrmSource } from "@/lib/crm-results";
import { brl, num } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RecommendationList } from "./recommendations";
import { type Data, dayLabel, isWaste, money, pct, ratio } from "./format";
import { Delta, EmptyCard, InfoTip, Kpi } from "./shared";

/** Conversions arrive up to 7 days after the click: the last week is still filling in. */

export function Overview({
  data,
  onOpenOrigin,
  onOpenRecommendations,
}: {
  data: Data;
  onOpenOrigin: (name: string) => void;
  onOpenRecommendations: () => void;
}) {
  const { totals } = data;
  const previous = data.previous.totals;
  if (totals.sent === 0 && totals.directPlayers === 0 && totals.influencedPlayers === 0)
    return (
      <EmptyCard>
        Nenhum envio de jornada ou campanha neste período. Os resultados aparecem até 10 minutos
        depois dos primeiros envios. Retenção e aquisição continuam na aba “Base de jogadores”.
      </EmptyCard>
    );

  const funnel = [
    { label: "SMS cobrados", value: num(totals.sent), rate: null },
    {
      label: "SMS clicados",
      value: num(totals.humanClicks),
      rate: totals.clickRate == null ? null : `${pct(totals.clickRate)} dos SMS`,
    },
    {
      label: "Jogadores convertidos",
      value: num(totals.directPlayers),
      rate:
        totals.conversionRate == null
          ? null
          : `${pct(totals.conversionRate)} dos cliques converteram`,
    },
  ];
  const recommendations = buildRecommendations(data, data.holdout);

  return (
    <div className="space-y-4">
      <section aria-labelledby="click-title" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="click-title" className="flex items-center gap-1.5 text-base font-semibold">
              Recuperado pelo CRM
              <InfoTip text="Jogadores que não depositavam havia 2+ dias (ou nunca depositaram), clicaram no link do SMS e depositaram em até 7 dias. Quem já estava ativo ia depositar de qualquer jeito e fica fora da conta. Conta jogadores, não depósitos: quem deposita 3 vezes conta 1, no dia do primeiro depósito. A taxa compara os cliques do período com quantos deles converteram." />
            </h2>
            <p className="text-sm text-muted-foreground">
              Parados há 2+ dias ou sem depósito que clicaram no link do SMS e depositaram em até 7
              dias.
            </p>
          </div>
          {previous && (
            <p className="text-xs text-muted-foreground">
              ▲▼ comparado a {dayLabel(data.previous.from)}
              {data.previous.from !== data.previous.to && ` a ${dayLabel(data.previous.to)}`}
            </p>
          )}
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
              <p className="text-sm text-muted-foreground">Valor recuperado pelo CRM</p>
              <div className="flex items-baseline gap-2 lg:justify-end">
                <p className="text-3xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                  {brl(totals.directRevenue)}
                </p>
                <Delta current={totals.directRevenue} previous={previous?.directRevenue} />
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-3 sm:grid-cols-3">
          <Kpi
            label="Custo em SMS"
            value={brl(totals.cost)}
            detail={`${num(totals.sent)} mensagens cobradas`}
            info="Só SMS. WhatsApp, e-mail e voz ainda não têm preço cadastrado e não entram no custo."
            delta={<Delta current={totals.cost} previous={previous?.cost} better="low" />}
          />
          <Kpi
            label="Custo por jogador convertido"
            value={money(totals.costPerConversion)}
            detail="custo ÷ jogadores convertidos"
            delta={
              <Delta
                current={totals.costPerConversion}
                previous={previous?.costPerConversion}
                better="low"
              />
            }
          />
          <Kpi
            label="Retorno"
            value={ratio(totals.clickRoi)}
            detail="recuperado pelo CRM ÷ custo"
            delta={<Delta current={totals.clickRoi} previous={previous?.clickRoi} />}
          />
        </div>

        {totals.directActivePlayers > 0 && (
          <p className="text-xs text-muted-foreground">
            Fora da conta: {num(totals.directActivePlayers)}{" "}
            {totals.directActivePlayers === 1 ? "jogador já ativo" : "jogadores já ativos"}{" "}
            (depositaram nas 48 h antes do clique) somaram {brl(totals.directActiveRevenue)} depois
            de clicar. Esse valor não entra no retorno.
          </p>
        )}

        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Jogadores e valor contam no dia do depósito. A taxa de conversão dos cliques dos últimos 7
          dias ainda pode subir: quem clicou tem até 7 dias para depositar.
        </p>
      </section>

      <Card className="bg-muted/20">
        <CardContent className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-0.5">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              Recuperados (visão ampla)
              <InfoTip text="Retornos, não pessoas: quem parou e voltou duas vezes no período conta duas. O valor é só o depósito de retorno. Voltar depois do SMS não prova que foi por causa dele; o efeito real está no Teste de controle." />
            </p>
            <p className="text-xs text-muted-foreground">
              Parados há 2+ dias que voltaram a depositar até 3 dias depois de um SMS, com ou sem
              clique. Inclui boa parte do Recuperado pelo CRM: não some os dois.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-6 tabular-nums">
            {[
              [num(totals.influencedPlayers), "recuperados"],
              [brl(totals.influencedRevenue), "valor"],
              [money(totals.costPerRecovered), "por recuperado"],
              [ratio(totals.roi), "retorno"],
            ].map(([value, label]) => (
              <div key={label}>
                <p className="text-lg font-semibold">{value}</p>
                <p className="text-xs text-muted-foreground">{label}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <DailyChart data={data} />
        <Highlights data={data} onOpenOrigin={onOpenOrigin} />
      </div>

      {recommendations.length > 0 && (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">O que fazer agora</CardTitle>
            {recommendations.length > 3 && (
              <Button size="sm" variant="ghost" onClick={onOpenRecommendations}>
                Ver todas ({recommendations.length})
              </Button>
            )}
          </CardHeader>
          <CardContent>
            <RecommendationList items={recommendations.slice(0, 3)} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function DailyChart({ data }: { data: Data }) {
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
    recovered: day.influencedRevenue,
  }));
  const names: Record<string, string> = {
    cost: "Custo em SMS",
    converted: "Recuperado pelo CRM",
    recovered: "Recuperados (visão ampla)",
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Custo × recuperado pelo CRM por dia</CardTitle>
        <CardDescription>Recuperado pelo CRM pelo dia do depósito.</CardDescription>
      </CardHeader>
      <CardContent className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points}>
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
              formatter={(value: number, name: string) => [brl(Number(value)), names[name] ?? name]}
            />
            <Legend formatter={(name: string) => names[name] ?? name} />
            <Bar dataKey="cost" fill="oklch(0.75 0.15 75 / 0.6)" radius={[4, 4, 0, 0]} />
            <Line
              dataKey="recovered"
              stroke="oklch(0.6 0.03 260)"
              strokeWidth={1.5}
              strokeDasharray="2 3"
              dot={false}
            />
            <Line dataKey="converted" stroke="oklch(0.72 0.18 150)" strokeWidth={3} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function Highlights({ data, onOpenOrigin }: { data: Data; onOpenOrigin: (name: string) => void }) {
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
        <CardTitle className="text-base">Destaques do período</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {best ? (
          <p className="flex gap-2">
            <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />
            <span>
              <button type="button" className={linkClass} onClick={() => onOpenOrigin(best.name)}>
                {best.name}
              </button>{" "}
              converte mais barato: {money(best.costPerConversion)} por jogador (
              {num(best.directPlayers)} jogadores, {brl(best.directRevenue)}).
            </span>
          </p>
        ) : (
          <p className="text-muted-foreground">
            Ainda não há origem com 5 ou mais jogadores convertidos para comparar eficiência.
          </p>
        )}
        {waste.length > 0 && (
          <p className="flex gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
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
                  gastou {brl(wasteCost)} sem nenhuma conversão.
                </>
              ) : (
                <>
                  {num(waste.length)} origens gastaram {brl(wasteCost)} sem nenhuma conversão.
                </>
              )}
            </span>
          </p>
        )}
        {activeShare != null && activeShare > 0.2 && (
          <p className="flex gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
            <span>
              {pct(activeShare)} do custo ({brl(totals.costOnActive)}) foi para jogadores que já
              estavam ativos (depositaram há menos de 2 dias).
            </span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
