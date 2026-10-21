import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { getTenantComparison } from "@/lib/tenant-comparison.functions";
import { brl, num } from "@/lib/format";
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

type Row = Awaited<ReturnType<typeof getTenantComparison>>["rows"][number];

const pctFine = (value: number | null) =>
  value == null
    ? "—"
    : `${(value * 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;

type Metric = {
  label: string;
  hint?: string;
  raw: (row: Row) => number | null;
  format: (value: number | null) => string;
  /** Which end is better; the best house in the row is highlighted. */
  better?: "high" | "low";
};

const count = (value: number | null) => (value == null ? "—" : num(value));
const currency = (value: number | null) => money(value);

const GROUPS: Array<{ title: string; metrics: Metric[] }> = [
  {
    title: "Recuperado pelo CRM",
    metrics: [
      { label: "SMS enviados", raw: (row) => row.sent, format: count },
      { label: "Custo em SMS", raw: (row) => row.cost, format: currency },
      {
        label: "Taxa de clique",
        hint: "SMS clicados ÷ SMS enviados.",
        raw: (row) => row.clickRate,
        format: pctFine,
        better: "high",
      },
      {
        label: "Jogadores convertidos",
        hint: "Depositaram até 7 dias depois de clicar.",
        raw: (row) => row.directPlayers,
        format: count,
        better: "high",
      },
      {
        label: "Conversão do clique",
        hint: "Jogadores convertidos ÷ SMS clicados.",
        raw: (row) => row.conversionRate,
        format: pct,
        better: "high",
      },
      {
        label: "Recuperado pelo CRM",
        raw: (row) => row.directRevenue,
        format: currency,
        better: "high",
      },
      {
        label: "Custo por jogador convertido",
        raw: (row) => row.costPerConversion,
        format: currency,
        better: "low",
      },
      {
        label: "Retorno",
        hint: "Recuperado pelo CRM ÷ custo.",
        raw: (row) => row.clickRoi,
        format: ratio,
        better: "high",
      },
    ],
  },
  {
    title: "Recuperados (visão ampla)",
    metrics: [
      {
        label: "Jogadores recuperados",
        hint: "Parados há 2+ dias que voltaram até 3 dias após um SMS, com ou sem clique.",
        raw: (row) => row.influencedPlayers,
        format: count,
        better: "high",
      },
      { label: "Valor recuperado", raw: (row) => row.influencedRevenue, format: currency },
      {
        label: "Custo por recuperado",
        raw: (row) => row.costPerRecovered,
        format: currency,
        better: "low",
      },
      {
        label: "Custo gasto com ativos",
        hint: "Parte do custo enviada a quem depositou nas últimas 48 h.",
        raw: (row) => row.costOnActiveShare,
        format: pct,
        better: "low",
      },
    ],
  },
  {
    title: "Base de jogadores (agora)",
    metrics: [
      { label: "Ativos (48 h)", raw: (row) => row.base.ativo, format: count },
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
    <main className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link
            to="/resultados"
            className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> Resultados do CRM
          </Link>
          <h1 className="text-2xl font-bold">Comparar casas</h1>
          <p className="text-sm text-muted-foreground">
            Mesmas métricas lado a lado, apenas nas casas em que você é administrador.
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
        <Skeleton className="h-96 rounded-xl" />
      ) : query.isError || !query.data ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            {query.error instanceof Error && query.error.message.includes("duas ou mais casas")
              ? "A comparação está disponível apenas para administradores de duas ou mais casas."
              : "Não foi possível carregar a comparação. Tente novamente em instantes."}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Últimos {query.data.days} dias</CardTitle>
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
                        className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
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
                                index === best
                                  ? "font-semibold text-emerald-600 dark:text-emerald-400"
                                  : ""
                              }`}
                            >
                              {metric.format(metric.raw(row))}
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
    </main>
  );
}
