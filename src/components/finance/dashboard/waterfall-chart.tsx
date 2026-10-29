// "Do depósito ao lucro" (spec §3.2.2): the waterfall from Depósitos down
// through Saques to Net, then the fees, Anúncios, Envios, Mensalidade and
// other costs down to Lucro líquido. Recharts has no waterfall, so each step
// is two stacked bars: a transparent base and the visible step on top
// (waterfallBars). Horizontal bars keep the step names readable on a phone.
// Down steps are red, start/subtotal neutral, the total green or red by sign.
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatBRL } from "@/components/finance/format";
import { CHART_COLORS, chartAxisProps, chartTooltipStyle } from "@/lib/chart-theme";
import type { WaterfallStep } from "@/lib/finance/types";

/** Spec §4.3: the plan fee only enters a closed month (other costs enter by date). */
export const NO_FEE_NOTE = "Resultado sem a mensalidade do mês (entra no fechamento do mês).";

export type WaterfallTone = "neutral" | "down" | "up" | "positive" | "negative";

export type WaterfallBar = {
  key: string;
  label: string;
  /** Invisible bar the visible one stacks on. */
  base: number;
  /** Visible bar size (always ≥ 0). */
  value: number;
  /** Signed amount of the step: the change for down/up, the level for start/subtotal/total. */
  amount: number;
  tone: WaterfallTone;
};

const TONE_COLOR: Record<WaterfallTone, string> = {
  neutral: CHART_COLORS.muted,
  down: CHART_COLORS.danger,
  up: CHART_COLORS.success,
  positive: CHART_COLORS.success,
  negative: CHART_COLORS.danger,
};

/** The chart rows, one per step and in the steps' order. */
export function waterfallBars(steps: WaterfallStep[]): WaterfallBar[] {
  return steps.map((step) => {
    const moving = step.kind === "down" || step.kind === "up";
    // Start, subtotal and total are levels: they grow from zero.
    const from = moving ? step.start : 0;
    const to = step.end;
    const tone: WaterfallTone =
      step.kind === "down"
        ? "down"
        : step.kind === "up"
          ? "up"
          : step.kind === "total"
            ? step.end < 0
              ? "negative"
              : "positive"
            : "neutral";
    return {
      key: step.key,
      label: step.label,
      base: Math.min(from, to),
      value: Math.abs(to - from),
      amount: Math.round((to - from) * 100) / 100,
      tone,
    };
  });
}

type TooltipPayload = { payload?: WaterfallBar };

function StepTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload[] }) {
  const bar = active ? payload?.[0]?.payload : undefined;
  if (!bar) return null;
  return (
    <div style={chartTooltipStyle} className="px-3 py-2">
      <p className="text-muted-foreground">{bar.label}</p>
      <p>{formatBRL(bar.amount)}</p>
    </div>
  );
}

const shortBRL = (value: number) => formatBRL(value).replace(/,\d\d$/, "");

export function WaterfallChart({
  steps,
  withoutFee = false,
}: {
  steps: WaterfallStep[];
  /** The window is not a closed month: no Mensalidade step, say so. */
  withoutFee?: boolean;
}) {
  if (!steps.length) {
    return <p className="py-4 text-sm text-muted-foreground">Sem dados no período.</p>;
  }
  const data = waterfallBars(steps);

  return (
    <div className="space-y-2">
      <div style={{ height: data.length * 34 + 32 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout="vertical"
            margin={{ left: 0, right: 72, top: 4, bottom: 4 }}
          >
            <CartesianGrid stroke="var(--color-border)" horizontal={false} />
            <XAxis
              type="number"
              {...chartAxisProps}
              tickFormatter={(value) => shortBRL(Number(value))}
            />
            <YAxis type="category" dataKey="label" {...chartAxisProps} width={128} interval={0} />
            <ReferenceLine x={0} stroke="var(--color-border)" />
            <Tooltip
              content={<StepTooltip />}
              cursor={{ fill: "var(--color-secondary)", opacity: 0.5 }}
            />
            <Bar dataKey="base" stackId="waterfall" fill="transparent" isAnimationActive={false} />
            <Bar
              dataKey="value"
              stackId="waterfall"
              radius={[0, 3, 3, 0]}
              isAnimationActive={false}
            >
              {data.map((bar) => (
                <Cell key={bar.key} fill={TONE_COLOR[bar.tone]} />
              ))}
              <LabelList
                dataKey="amount"
                position="right"
                fontSize={11}
                fill="var(--color-muted-foreground)"
                formatter={(value: unknown) => shortBRL(Number(value))}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {withoutFee && (
        <p data-note="no-fee" className="text-xs text-muted-foreground">
          {NO_FEE_NOTE}
        </p>
      )}
    </div>
  );
}
