// Relatório de rendimento, bloco 3 ("Evolução por dia", spec §4): barras
// empilhadas FTD × redepósito (valor creditado) e uma linha com os
// depositantes distintos do dia. Mesmo visual do gráfico do Início do expert.
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { CHART_COLORS, chartAxisProps, chartGridProps } from "@/lib/chart-theme";
import { brl, num } from "@/lib/format";

export type ReportSeriePoint = {
  dia: string;
  valorFtd: number;
  valorRedeposito: number;
  depositantes: number;
};

const CHART_CONFIG: ChartConfig = {
  valorFtd: { label: "FTD", color: CHART_COLORS.primary },
  valorRedeposito: { label: "Redepósito", color: CHART_COLORS.green },
  depositantes: { label: "Depositantes", color: CHART_COLORS.orange },
};

/** "aaaa-mm-dd" (dia da série) -> "dd/mm". */
function dayLabel(dia: string): string {
  return `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
}

export function ReportChart({ serie }: { serie: ReportSeriePoint[] }) {
  const empty = serie.every((d) => d.valorFtd === 0 && d.valorRedeposito === 0);
  const points = serie.map((d) => ({ ...d, label: dayLabel(d.dia) }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Evolução por dia</CardTitle>
      </CardHeader>
      <CardContent>
        {empty ? (
          <p className="py-10 text-center text-muted-foreground">Nenhum crédito neste período.</p>
        ) : (
          <ChartContainer config={CHART_CONFIG} className="aspect-auto h-72 w-full">
            <ComposedChart data={points}>
              <CartesianGrid {...chartGridProps} />
              <XAxis dataKey="label" {...chartAxisProps} />
              <YAxis
                yAxisId="valor"
                {...chartAxisProps}
                width={80}
                tickFormatter={(value) => brl(Number(value))}
              />
              <YAxis
                yAxisId="depositantes"
                orientation="right"
                {...chartAxisProps}
                width={32}
                allowDecimals={false}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelKey="label"
                    formatter={(value, name) => (
                      <span className="flex w-full justify-between gap-3">
                        <span className="text-muted-foreground">
                          {CHART_CONFIG[String(name)]?.label ?? String(name)}
                        </span>
                        <span className="font-medium tabular-nums">
                          {name === "depositantes" ? num(Number(value)) : brl(Number(value))}
                        </span>
                      </span>
                    )}
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar yAxisId="valor" dataKey="valorFtd" stackId="valor" fill={CHART_COLORS.primary} />
              <Bar
                yAxisId="valor"
                dataKey="valorRedeposito"
                stackId="valor"
                fill={CHART_COLORS.green}
                radius={[4, 4, 0, 0]}
              />
              <Line
                yAxisId="depositantes"
                dataKey="depositantes"
                stroke={CHART_COLORS.orange}
                strokeWidth={2}
                dot={false}
              />
            </ComposedChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
