import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { RefreshCw } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { DateRange } from "react-day-picker";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { HomeCard, KpiCard } from "@/components/home/home-cards";
import { PeriodPicker } from "@/components/home/period-picker";
import { Skeleton } from "@/components/ui/skeleton";
import { useUpdatedAgo } from "@/hooks/use-updated-ago";
import { chartAxisProps, chartGridProps, chartTooltipStyle } from "@/lib/chart-theme";
import { num } from "@/lib/format";
import { getChannelDispatchTimeline, type ChannelKey } from "@/lib/history.functions";
import { periodRange, type PeriodPreset } from "@/lib/home-dashboard";
import { brtDayKey } from "@/lib/tz";

import { historyWindow, periodQuery, type ChannelPeriodQuery } from "./channel-period";

export type ChannelPeriod = {
  preset: PeriodPreset;
  range: DateRange | undefined;
  query: ChannelPeriodQuery;
  setPeriod: (preset: PeriodPreset, range: DateRange | undefined) => void;
};

/** Period state of a channel overview, same presets as the Início. Starts on "Hoje". */
export function useChannelPeriod(
  initial: Exclude<PeriodPreset, "custom"> = "today",
): ChannelPeriod {
  const [preset, setPreset] = useState<PeriodPreset>(initial);
  const [range, setRange] = useState<DateRange | undefined>(() => periodRange(initial));
  // Recomputed on a new BRT day too, so "Hoje" follows midnight.
  const today = brtDayKey(new Date());
  const query = useMemo(
    () => periodQuery(range, new Date()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range, today],
  );
  return {
    preset,
    range,
    query,
    setPeriod: (nextPreset, nextRange) => {
      setPreset(nextPreset);
      setRange(nextRange);
    },
  };
}

export type ChannelKpi = {
  title: string;
  value: string;
  detail?: string;
  className?: string;
};

export type ChartSeries = { key: string; label: string; color: string };

/**
 * The overview every channel shows: period row, four KPI cards, the
 * "Envios por dia" chart and one channel block underneath.
 */
export function ChannelOverview({
  period,
  updatedAt,
  isFetching,
  isLoading,
  kpis,
  notice,
  chart,
  children,
}: {
  period: ChannelPeriod;
  updatedAt?: number;
  isFetching?: boolean;
  isLoading?: boolean;
  kpis: ChannelKpi[];
  /** Warning shown between the period row and the KPIs (e.g. low balance). */
  notice?: ReactNode;
  chart: ReactNode;
  children?: ReactNode;
}) {
  const updatedAgo = useUpdatedAgo(updatedAt || undefined);
  return (
    <div className="space-y-4 sm:space-y-5" aria-busy={isFetching}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <PeriodPicker preset={period.preset} range={period.range} onChange={period.setPeriod} />
        {updatedAt ? (
          <p className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            {isFetching && <RefreshCw className="size-3 animate-spin" aria-hidden="true" />}
            atualizado {updatedAgo}
          </p>
        ) : null}
      </div>

      {notice}

      {isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-28 rounded-2xl" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
          {kpis.map((kpi) => (
            <KpiCard
              key={kpi.title}
              title={kpi.title}
              value={kpi.value}
              detail={kpi.detail}
              className={kpi.className}
            />
          ))}
        </div>
      )}

      {chart}

      {children}
    </div>
  );
}

type DailyRow = { date: string } & Record<string, unknown>;

function dayLabel(yyyyMmDd: string) {
  const [, m, d] = yyyyMmDd.split("-");
  return d && m ? `${d}/${m}` : yyyyMmDd;
}

function hourLabel(iso: string) {
  const hour = new Date(iso).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    hour12: false,
  });
  return `${hour.padStart(2, "0")}h`;
}

/**
 * "Envios por dia". For a single day (Hoje, Ontem, one date) the dashboards
 * only have one daily bucket, so the chart switches to attempts per hour in
 * Brasília time from the history timeline (all attempts, one series).
 */
export function ChannelSendsChart({
  historyChannel,
  period,
  daily,
  series,
}: {
  historyChannel: ChannelKey;
  period: ChannelPeriod;
  daily: DailyRow[] | undefined;
  series: ChartSeries[];
}) {
  const { query } = period;
  const timelineFn = useServerFn(getChannelDispatchTimeline);
  const hourly = useQuery({
    queryKey: ["channel-hourly", historyChannel, query.from, query.to],
    queryFn: () => {
      const { from, to } = historyWindow(period.range);
      return timelineFn({ data: { channel: historyChannel, from, to, bucket: "hour" } });
    },
    enabled: query.sameDay,
    refetchInterval: query.includesToday ? 60_000 : false,
    placeholderData: (previous) => previous,
  });

  const byHour = query.sameDay;
  const hourlyPoints = hourly.data?.points ?? [];
  const data: Array<Record<string, unknown>> = byHour
    ? hourlyPoints.map((point) => ({ label: hourLabel(point.t), disparos: point.count }))
    : (daily ?? []).map((row) => ({ ...row, label: dayLabel(row.date) }));
  const shownSeries: ChartSeries[] = byHour
    ? [{ key: "disparos", label: "Disparos", color: "var(--color-chart-1)" }]
    : series;
  const loading = byHour ? hourly.isLoading : daily === undefined;
  const total = byHour ? hourlyPoints.reduce((sum, point) => sum + point.count, 0) : null;

  return (
    <HomeCard className="p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold">
          {byHour ? "Envios por hora" : "Envios por dia"}
        </h2>
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          {shownSeries.map((item) => (
            <span key={item.key} className="flex items-center gap-1.5">
              <span
                className="h-[3px] w-2.5 rounded-full"
                style={{ background: item.color }}
                aria-hidden="true"
              />
              {item.label}
              {total !== null && <strong className="text-foreground">{num(total)}</strong>}
            </span>
          ))}
        </div>
      </div>
      {byHour && (
        <p className="mt-1 text-xs text-muted-foreground">
          Todas as tentativas de envio, por hora no horário de Brasília.
        </p>
      )}
      <div className="mt-4 h-[220px] sm:h-[260px]">
        {loading ? (
          <Skeleton className="h-full w-full" />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ left: 0, right: 4, top: 4, bottom: 0 }}>
              <defs>
                <linearGradient id={`sendsGrad-${historyChannel}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={shownSeries[0]?.color} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={shownSeries[0]?.color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...chartGridProps} />
              <XAxis dataKey="label" {...chartAxisProps} minTickGap={16} />
              <YAxis {...chartAxisProps} allowDecimals={false} width={40} />
              <Tooltip
                contentStyle={chartTooltipStyle}
                formatter={(value: number, name: string) => [
                  num(Number(value)),
                  shownSeries.find((item) => item.key === name)?.label ?? name,
                ]}
              />
              {shownSeries.map((item, index) => (
                <Area
                  key={item.key}
                  type="monotone"
                  dataKey={item.key}
                  stroke={item.color}
                  strokeWidth={2.5}
                  fill={index === 0 ? `url(#sendsGrad-${historyChannel})` : "transparent"}
                  dot={data.length === 1}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </HomeCard>
  );
}

/** Card + heading used by each channel's block under the chart. */
export function ChannelBlock({
  title,
  description,
  action,
  className,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <HomeCard className={className ?? "p-4 sm:p-5"}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </HomeCard>
  );
}
