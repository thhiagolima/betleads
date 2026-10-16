import { useState } from "react";
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

const METRICS: Array<{ label: string; hint?: string; value: (row: Row) => string }> = [
  { label: "SMS enviados", value: (row) => num(row.sent) },
  { label: "Custo", value: (row) => brl(row.cost) },
  {
    label: "Jogadores recuperados",
    hint: "Influenciados: voltaram a depositar até 72 h após um SMS.",
    value: (row) => num(row.influencedPlayers),
  },
  { label: "Receita influenciada", value: (row) => brl(row.influencedRevenue) },
  { label: "Custo por recuperado", value: (row) => money(row.costPerRecovered) },
  { label: "Retorno (receita ÷ custo)", value: (row) => ratio(row.roi) },
  { label: "Receita direta (clique)", value: (row) => brl(row.directRevenue) },
  {
    label: "Custo gasto com ativos",
    hint: "Parte do custo enviada a quem já depositou nas últimas 48 h.",
    value: (row) => pct(row.costOnActiveShare),
  },
  { label: "Base ativa (48 h)", value: (row) => num(row.base.ativo) },
  { label: "Esfriando (2–7 dias)", value: (row) => num(row.base.esfriando) },
  { label: "Dormindo (7–30 dias)", value: (row) => num(row.base.dormindo) },
  { label: "Perdidos (30+ dias)", value: (row) => num(row.base.perdido) },
  { label: "Cadastros no período", value: (row) => num(row.signups) },
  { label: "Cadastro → 1º depósito", value: (row) => pct(row.signupToFtd) },
  {
    label: "2º depósito em 7 dias",
    hint: "Última coorte semanal já fechada.",
    value: (row) => pct(row.secondDeposit7d),
  },
];

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
              Recuperado = jogador parado há 48 h ou mais que voltou a depositar até 72 h após um
              SMS. A situação da base é a de agora, não a do período.
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
                {METRICS.map((metric) => (
                  <TableRow key={metric.label}>
                    <TableCell>
                      <div className="font-medium">{metric.label}</div>
                      {metric.hint && (
                        <div className="text-xs text-muted-foreground">{metric.hint}</div>
                      )}
                    </TableCell>
                    {query.data.rows.map((row) => (
                      <TableCell key={row.tenant} className="text-right tabular-nums">
                        {metric.value(row)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
