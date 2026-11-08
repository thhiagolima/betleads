import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { getTenantComparison } from "@/lib/tenant-comparison.functions";
import { formatMoney } from "@/lib/currency";
import { brl, num } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const PERIODS = [7, 30, 90] as const;

const pct = (value: number | null) =>
  value == null
    ? "—"
    : `${(value * 100).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
/** Quanto cada R$ 1 em SMS trouxe, em reais ("R$ 7,90"). */
const perReal = (value: number | null) => (value == null ? "—" : brl(value));
type Row = Awaited<ReturnType<typeof getTenantComparison>>["rows"][number];

const pctFine = (value: number | null) =>
  value == null
    ? "—"
    : `${(value * 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;

type Metric = {
  label: string;
  hint?: string;
  raw: (row: Row) => number | null;
  format: (value: number | null, row: Row) => string;
  /** Which end is better; the best house in the row is highlighted. */
  better?: "high" | "low";
  /** Valor na moeda da casa: só compara (destaca a melhor) entre casas da mesma moeda. */
  houseMoney?: boolean;
};

const count = (value: number | null) => (value == null ? "—" : num(value));
/** Custo da plataforma, sempre BRL. */
const cost = (value: number | null) => (value == null ? "—" : brl(value));
/** Valor da casa (depósitos recuperados) na moeda de cada casa. */
const houseMoney = (value: number | null, row: Row) =>
  value == null ? "—" : formatMoney(value, row.moeda);
const CROSS_CURRENCY_NOTE = "receita e custo em moedas diferentes";
/** "Cada R$ 1 em SMS trouxe" só existe quando a receita também está em BRL (sem câmbio entre moedas). */
const sameCurrencyRoi = (value: (row: Row) => number | null) => (row: Row) =>
  row.moeda === "BRL" ? value(row) : null;
const roiFormat = (value: number | null, row: Row) => (row.moeda === "BRL" ? perReal(value) : "—");

const GROUPS: Array<{ title: string; metrics: Metric[] }> = [
  {
    title: "Recuperado pelo CRM",
    metrics: [
      { label: "SMS enviados", raw: (row) => row.sent, format: count },
      { label: "Custo em SMS", raw: (row) => row.cost, format: cost },
      {
        label: "Taxa de clique",
        hint: "Cliques no link ÷ SMS enviados.",
        raw: (row) => row.clickRate,
        format: pctFine,
        better: "high",
      },
      {
        label: "Jogadores que voltaram pelo link",
        hint: "Depositaram até 7 dias depois de clicar.",
        raw: (row) => row.directPlayers,
        format: count,
        better: "high",
      },
      {
        label: "Cliques que viraram depósito",
        hint: "Cliques do período que levaram a um depósito em até 7 dias ÷ cliques no link.",
        raw: (row) => row.conversionRate,
        format: pct,
        better: "high",
      },
      {
        label: "Recuperado pelo CRM",
        raw: (row) => row.directRevenue,
        format: houseMoney,
        better: "high",
        houseMoney: true,
      },
      {
        label: "Custo por jogador que voltou",
        raw: (row) => row.costPerConversion,
        format: cost,
        better: "low",
      },
      {
        label: "Cada R$ 1 em SMS trouxe",
        hint: `Recuperado pelo CRM ÷ custo. Só em casas em BRL (${CROSS_CURRENCY_NOTE} nas demais).`,
        raw: sameCurrencyRoi((row) => row.clickRoi),
        format: roiFormat,
        better: "high",
      },
    ],
  },
  {
    title: "Reativações após SMS",
    metrics: [
      {
        label: "Reativações após SMS",
        hint: "Jogadores que estavam há 2 dias ou mais sem depositar (ou que nunca depositaram), receberam um SMS e voltaram a depositar em até 3 dias, mesmo sem clicar no link. O valor é tudo o que depositaram nesses 3 dias. Já inclui o Recuperado pelo CRM (quem clicou), por isso é sempre igual ou maior: não some os dois.",
        raw: (row) => row.influencedPlayers,
        format: count,
        better: "high",
      },
      {
        label: "Depositaram em até 3 dias",
        raw: (row) => row.influencedRevenue,
        format: houseMoney,
        houseMoney: true,
      },
      {
        label: "Custo por reativação",
        raw: (row) => row.costPerRecovered,
        format: cost,
        better: "low",
      },
      {
        label: "Custo em quem já estava jogando",
        hint: "Parte do custo enviada a quem depositou nos últimos 2 dias.",
        raw: (row) => row.costOnActiveShare,
        format: pct,
        better: "low",
      },
    ],
  },
  {
    title: "Base de jogadores (agora)",
    metrics: [
      { label: "Ativos (até 2 dias)", raw: (row) => row.base.ativo, format: count },
      { label: "Esfriando (2–7 dias)", raw: (row) => row.base.esfriando, format: count },
      { label: "Dormindo (7–30 dias)", raw: (row) => row.base.dormindo, format: count },
      { label: "Perdidos (30+ dias)", raw: (row) => row.base.perdido, format: count },
      { label: "Cadastros no período", raw: (row) => row.signups, format: count },
      {
        label: "Cadastro → 1º depósito",
        raw: (row) => row.signupToFtd,
        format: pct,
        better: "high",
      },
      {
        label: "2º depósito em 7 dias",
        hint: "Última coorte semanal já fechada.",
        raw: (row) => row.secondDeposit7d,
        format: pct,
        better: "high",
      },
    ],
  },
];

/** Index of the best house for a metric, or -1 when there is no clear best. */
function bestIndex(metric: Metric, rows: Row[]) {
  if (!metric.better) return -1;
  if (metric.houseMoney && new Set(rows.map((row) => row.moeda)).size > 1) return -1;
  const values = rows.map(metric.raw);
  const present = values.filter((value): value is number => value != null);
  if (present.length < 2 || new Set(present).size === 1) return -1;
  const target = metric.better === "high" ? Math.max(...present) : Math.min(...present);
  return values.indexOf(target);
}

export function TenantComparison() {
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30);
  const load = useServerFn(getTenantComparison);
  const query = useQuery({
    queryKey: ["tenant-comparison", days],
    queryFn: () => load({ data: { days } }),
    staleTime: 60_000,
    retry: false,
  });

  return (
    <Page>
      <PageHeader
        subtitle="Mesmas métricas lado a lado, apenas nas casas em que você é administrador."
        actions={
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
        }
      />

      {query.isLoading ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : query.isError || !query.data ? (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground sm:p-5">
            {query.error instanceof Error && query.error.message.includes("duas ou mais casas")
              ? "A comparação está disponível apenas para administradores de duas ou mais casas."
              : "Não foi possível carregar a comparação. Tente novamente em instantes."}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Últimos {query.data.days} dias</CardTitle>
            <CardDescription>
              Recuperado pelo CRM primeiro. Em verde, a melhor casa em cada linha. A base de
              jogadores é a de agora, não a do período.
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Métrica</TableHead>
                  {query.data.rows.map((row) => (
                    <TableHead key={row.tenant} className="text-right">
                      {row.tenant}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {GROUPS.map((group) => (
                  <Fragment key={group.title}>
                    <TableRow className="bg-muted/30 hover:bg-muted/30">
                      <TableCell
                        colSpan={query.data.rows.length + 1}
                        className="text-label font-semibold text-muted-foreground"
                      >
                        {group.title}
                      </TableCell>
                    </TableRow>
                    {group.metrics.map((metric) => {
                      const best = bestIndex(metric, query.data.rows);
                      return (
                        <TableRow key={metric.label}>
                          <TableCell>
                            <div className="font-medium">{metric.label}</div>
                            {metric.hint && (
                              <div className="text-xs text-muted-foreground">{metric.hint}</div>
                            )}
                          </TableCell>
                          {query.data.rows.map((row, index) => (
                            <TableCell
                              key={row.tenant}
                              className={`text-right tabular-nums ${
                                index === best ? "font-semibold text-success" : ""
                              }`}
                            >
                              {metric.format(metric.raw(row), row)}
                              {index === best && <span className="sr-only"> (melhor)</span>}
                            </TableCell>
                          ))}
                        </TableRow>
                      );
                    })}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </Page>
  );
}
