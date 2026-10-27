import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import {
  ChannelBlock,
  ChannelOverview,
  ChannelSendsChart,
  useChannelPeriod,
} from "@/components/channels/channel-overview";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useRealtimeInvalidate } from "@/hooks/use-realtime-invalidate";
import { getCallsDashboard } from "@/lib/calls.functions";
import { CHART_COLORS } from "@/lib/chart-theme";
import { num, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

import { HISTORY_STATUS_LABEL } from "./shared";

function statusBadgeTone(status: string) {
  switch (status) {
    case "answered":
    case "completed":
    case "converted":
      return "bg-success/15 text-success border-success/30";
    case "not_answered":
      return "bg-warning/15 text-warning border-warning/30";
    case "busy":
      return "bg-info/15 text-info border-info/30";
    case "failed":
      return "bg-danger/15 text-danger border-danger/30";
    case "calling":
    case "pending":
      return "bg-primary/15 text-primary border-primary/30";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function pct(part: number, total: number) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

/** Visão geral de Voz: same layout as SMS and Email, with "Atendidas" as the channel KPI. */
export function DashboardTab() {
  const period = useChannelPeriod();
  const { query } = period;
  const fn = useServerFn(getCallsDashboard);
  useRealtimeInvalidate(
    "calls-dashboard-realtime",
    ["call_history", "call_queue"],
    [["calls-dashboard"]],
  );
  const { data, isLoading, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ["calls-dashboard", query.from, query.to],
    queryFn: () => fn({ data: { from: query.from, to: query.to } }),
    refetchInterval: query.includesToday ? 30_000 : false,
    placeholderData: (previous) => previous,
  });

  const totals = data?.totals;
  const total = totals?.total ?? 0;
  const answered = totals ? totals.answered + totals.completed + totals.converted : 0;
  const notAnswered = (totals?.not_answered ?? 0) + (totals?.busy ?? 0);
  const topScripts = data?.top_scripts ?? [];
  const recent = data?.recent ?? [];

  return (
    <ChannelOverview
      period={period}
      updatedAt={dataUpdatedAt}
      isFetching={isFetching}
      isLoading={isLoading}
      kpis={[
        {
          title: "Enviados",
          value: num(total),
          detail: `${num(notAnswered)} não atendidas ou ocupado`,
        },
        { title: "Falhas", value: num(totals?.failed ?? 0), detail: "a ligação não completou" },
        { title: "Na fila", value: num(totals?.pending ?? 0), detail: "aguardando para ligar" },
        {
          title: "Atendidas",
          value: num(answered),
          detail: total > 0 ? `${pct(answered, total)}% das ligações` : undefined,
        },
      ]}
      chart={
        <ChannelSendsChart
          historyChannel="calls"
          period={period}
          daily={data?.by_day}
          series={[
            { key: "total", label: "Total", color: CHART_COLORS.primary },
            { key: "answered", label: "Atendidas", color: CHART_COLORS.success },
            { key: "failed", label: "Falhas", color: CHART_COLORS.danger },
          ]}
        />
      }
    >
      <div className="grid gap-3 sm:gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <ChannelBlock
          title="Top roteiros"
          description="Os mais usados no período e quantos atenderam."
        >
          {topScripts.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nenhuma ligação com roteiro no período.
            </p>
          ) : (
            <ul className="space-y-4">
              {topScripts.map((script) => {
                const rate = pct(script.answered, script.total);
                return (
                  <li key={script.script_id} className="space-y-1.5">
                    <div className="flex items-center justify-between gap-3 text-[13.5px]">
                      <span className="truncate font-medium">
                        {script.name === "Script removido" ? "Roteiro excluído" : script.name}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {num(script.answered)} de {num(script.total)} · {rate}%
                      </span>
                    </div>
                    <Progress value={rate} className="h-1.5" />
                  </li>
                );
              })}
            </ul>
          )}
        </ChannelBlock>

        <ChannelBlock title="Últimas ligações" description="As 10 mais recentes do período.">
          {recent.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nenhuma ligação no período.
            </p>
          ) : (
            <ul>
              {recent.map((call) => (
                <li
                  key={call.id}
                  className="flex items-center gap-3 border-b border-border/70 py-2.5 text-[13.5px] last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {call.lead_nome === "Avulso" ? "Número avulso" : call.lead_nome}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {call.script_name === "—" ? "Sem roteiro" : call.script_name}
                      {call.duration_seconds ? ` · ${call.duration_seconds}s` : ""}
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className={cn("shrink-0 text-xs", statusBadgeTone(call.status))}
                  >
                    {HISTORY_STATUS_LABEL[call.status] ?? call.status}
                  </Badge>
                  <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                    {timeAgo(call.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </ChannelBlock>
      </div>
    </ChannelOverview>
  );
}
