import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useRealtimeInvalidate } from "@/hooks/use-realtime-invalidate";
import {
  Phone,
  PhoneCall,
  PhoneOff,
  PhoneForwarded,
  XCircle,
  Clock,
  Timer,
  TrendingUp,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { cn } from "@/lib/utils";
import { getCallsDashboard } from "@/lib/calls.functions";
import { HISTORY_STATUS_LABEL } from "./shared";
import {
  DashboardDateRangePicker,
  defaultTodayRange,
  rangeToKey,
  type DashboardRange,
} from "@/components/dashboard-date-range-picker";


function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = "default",
}: {
  icon: any;
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "success" | "danger" | "warning" | "info" | "muted";
}) {
  const tones: Record<string, string> = {
    default: "text-primary bg-primary/10",
    success: "text-emerald-400 bg-emerald-400/10",
    danger: "text-rose-400 bg-rose-400/10",
    warning: "text-amber-400 bg-amber-400/10",
    info: "text-sky-400 bg-sky-400/10",
    muted: "text-muted-foreground bg-muted",
  };
  return (
    <Card className="border-border/60">
      <CardContent className="flex items-center gap-4 p-4">
        <div
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-lg",
            tones[tone],
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <p className="text-2xl font-bold leading-tight">{value}</p>
          {hint && (
            <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function statusBadgeTone(status: string) {
  switch (status) {
    case "answered":
    case "completed":
    case "converted":
      return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
    case "not_answered":
      return "bg-amber-500/15 text-amber-400 border-amber-500/30";
    case "busy":
      return "bg-sky-500/15 text-sky-400 border-sky-500/30";
    case "failed":
      return "bg-rose-500/15 text-rose-400 border-rose-500/30";
    case "calling":
    case "pending":
      return "bg-primary/15 text-primary border-primary/30";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function formatDate(iso: string, sameDay: boolean) {
  const d = new Date(iso);
  if (sameDay) return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

export function DashboardTab() {
  const [range, setRange] = useState<DashboardRange>(() => defaultTodayRange());
  const rk = rangeToKey(range);
  const sameDay = rk.from === rk.to;
  const fn = useServerFn(getCallsDashboard);
  useRealtimeInvalidate(
    "calls-dashboard-realtime",
    ["call_history", "call_queue"],
    [["calls-dashboard"]],
  );
  const { data, isLoading } = useQuery({
    queryKey: ["calls-dashboard", rk.from, rk.to],
    queryFn: () => fn({ data: rk }),
    refetchInterval: 30_000,
  });

  const totals = data?.totals;
  const answeredCount = totals
    ? totals.answered + totals.completed + totals.converted
    : 0;
  const answerRate = totals?.total
    ? Math.round((answeredCount / totals.total) * 100)
    : 0;

  return (
    <div className="space-y-6">
      {/* Filtro de período */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Visão geral</h2>
          <p className="text-xs text-muted-foreground">
            Métricas atualizadas a cada 30s · provedor BusinessCode
          </p>
        </div>
        <DashboardDateRangePicker range={range} onChange={setRange} />
      </div>

      {/* StatCards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <StatCard
          icon={Phone}
          label="Total"
          value={String(totals?.total ?? 0)}
          hint={`Hoje: ${data?.today.total ?? 0}`}
          tone="info"
        />
        <StatCard
          icon={PhoneCall}
          label="Atendidas"
          value={String(answeredCount)}
          hint={`Taxa: ${answerRate}%`}
          tone="success"
        />
        <StatCard
          icon={PhoneOff}
          label="Não atendidas"
          value={String(totals?.not_answered ?? 0)}
          tone="warning"
        />
        <StatCard
          icon={PhoneForwarded}
          label="Ocupado"
          value={String(totals?.busy ?? 0)}
          tone="info"
        />
        <StatCard
          icon={XCircle}
          label="Falhas"
          value={String(totals?.failed ?? 0)}
          tone="danger"
        />
        <StatCard
          icon={Clock}
          label="Na fila"
          value={String(totals?.pending ?? 0)}
          hint="aguardando"
          tone="muted"
        />
        <StatCard
          icon={Timer}
          label="Duração média"
          value={`${totals?.avg_duration_seconds ?? 0}s`}
          tone="default"
        />
      </div>

      {/* Gráfico */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="h-4 w-4 text-primary" />
            Ligações por dia
          </CardTitle>
          <CardDescription>
            Total disparado × atendidas no período selecionado.
          </CardDescription>
        </CardHeader>
        <CardContent className="h-72">
          {isLoading || !data ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              Carregando…
            </p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.by_day}>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(v) => formatDate(v + "T00:00:00", sameDay)}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                />
                <YAxis
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelFormatter={(v) => formatDate(v + "T00:00:00", sameDay)}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line
                  type="monotone"
                  dataKey="total"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={false}
                  name="Total"
                />
                <Line
                  type="monotone"
                  dataKey="answered"
                  stroke="#34d399"
                  strokeWidth={2}
                  dot={false}
                  name="Atendidas"
                />
                <Line
                  type="monotone"
                  dataKey="failed"
                  stroke="#fb7185"
                  strokeWidth={2}
                  dot={false}
                  name="Falhas"
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Top scripts */}
        <Card className="lg:col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Top scripts</CardTitle>
            <CardDescription>
              Mais disparados no período (com taxa de atendimento).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {(data?.top_scripts ?? []).length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                Sem dados ainda.
              </p>
            ) : (
              data!.top_scripts.map((s) => {
                const rate = s.total ? Math.round((s.answered / s.total) * 100) : 0;
                return (
                  <div key={s.script_id} className="space-y-1.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="truncate font-medium">{s.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {s.answered}/{s.total} · {rate}%
                      </span>
                    </div>
                    <Progress value={rate} className="h-1.5" />
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>

        {/* Últimas 10 */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Últimas ligações</CardTitle>
            <CardDescription>10 mais recentes — atualizadas em tempo real.</CardDescription>
          </CardHeader>
          <CardContent>
            {(data?.recent ?? []).length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">
                Nenhuma ligação no período.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Lead</TableHead>
                    <TableHead>Script</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Duração</TableHead>
                    <TableHead>Quando</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data!.recent.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-sm font-medium">
                        {r.lead_nome}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.script_name}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={cn("text-xs", statusBadgeTone(r.status))}
                        >
                          {HISTORY_STATUS_LABEL[r.status] ?? r.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.duration_seconds ? `${r.duration_seconds}s` : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(r.created_at).toLocaleString("pt-BR")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}