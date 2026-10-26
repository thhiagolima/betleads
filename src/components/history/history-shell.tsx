import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DateRange } from "react-day-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Send,
  CheckCircle2,
  XCircle,
  Clock,
  TrendingUp,
  Search,
  Copy,
  ExternalLink,
  RefreshCw,
  ArrowUpRight,
  ArrowDownRight,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { CHART_COLORS, chartTooltipProps } from "@/lib/chart-theme";
import { POLL_INTERVALS, UpdatedAgo } from "@/hooks/use-updated-ago";
import {
  getChannelHistory,
  getChannelHistoryStats,
  getChannelFlowOptions,
  getChannelFlowSummary,
  getChannelDispatchTimeline,
  getChannelFlowSteps,
  type ChannelKey,
  type HistoryRow,
  type FlowSummaryItem,
} from "@/lib/history.functions";
import { historyWindow } from "@/components/channels/channel-period";
import { PeriodPicker } from "@/components/home/period-picker";
import { periodRange, type PeriodPreset } from "@/lib/home-dashboard";
import { brtDayKey } from "@/lib/tz";

import { StatusBadge } from "./status-badge";

const CHANNEL_LABEL: Record<ChannelKey, string> = {
  sms: "SMS",
  email: "Email",
  calls: "Ligação",
  whatsapp: "WhatsApp",
};

// Polling das telas de histórico: estatísticas pesadas, 60 s é suficiente.
const HISTORY_POLL = {
  staleTime: 30_000,
  refetchInterval: POLL_INTERVALS.stats,
  refetchOnWindowFocus: true,
} as const;

// O período usa o mesmo PeriodPicker do Início (dias no horário de Brasília).
// Janelas que chegam até hoje mandam `to: null`: o servidor usa "agora"
// (inclusive para a janela anterior do delta), e a queryKey fica estável entre
// renders. Ver historyWindow em channels/channel-period.

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = Date.now() - Date.parse(iso);
  if (diff < 0) return "agora";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `há ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h}h`;
  const d = Math.floor(h / 24);
  return `há ${d}d`;
}

// Canais cujo provedor confirma entrega de verdade. O callback de SMS da Short
// Brasil não informa status (nenhum SMS é marcado entregue), então para SMS o
// "sucesso" é só "aceito pelo provedor" — mostramos Enviados, sem taxa de entrega.
const CHANNEL_SHOWS_DELIVERY: Record<ChannelKey, boolean> = {
  // SMS and email providers do not confirm delivery: show sent and failed only.
  sms: false,
  email: false,
  calls: true,
  whatsapp: true,
};

export interface HistoryShellOptions {
  /** Sobrescreve CHANNEL_SHOWS_DELIVERY: exibe "Entregues" e taxa de entrega. */
  showsDelivery?: boolean;
  showFlow?: boolean;
  showStep?: boolean;
  title?: string;
  subtitle?: string;
  cardLabels?: {
    total: string;
    success: string;
    failed: string;
    pending: string;
    conversions: string;
  };
}

export function HistoryShell({
  channel,
  options = {},
}: {
  channel: ChannelKey;
  options?: HistoryShellOptions;
}) {
  const qc = useQueryClient();
  const [preset, setPreset] = useState<PeriodPreset>("today");
  const [range, setRange] = useState<DateRange | undefined>(() => periodRange("today"));
  const [flowId, setFlowId] = useState<string>("all");
  const [step, setStep] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [direction, setDirection] = useState<"all" | "outgoing" | "incoming">("outgoing");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(0);
  const [openRow, setOpenRow] = useState<HistoryRow | null>(null);
  const pageSize = 50;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(0);
  }, [range, flowId, step, status, direction, debouncedSearch]);

  // Quando troca de fluxo, zera o filtro de dia (as opções mudam).
  useEffect(() => {
    setStep("all");
  }, [flowId]);

  // Recalcula só quando muda o período ou o dia (virada da meia-noite em Brasília).
  const dayKey = brtDayKey(new Date());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const iso = useMemo(() => historyWindow(range), [range, dayKey]);
  const showFlow = options.showFlow !== false;
  const showStep = options.showStep !== false;
  const showDirection = channel === "whatsapp";
  const showsDelivery = options.showsDelivery ?? CHANNEL_SHOWS_DELIVERY[channel];

  const histFn = useServerFn(getChannelHistory);
  const statsFn = useServerFn(getChannelHistoryStats);
  const flowsFn = useServerFn(getChannelFlowOptions);
  const summaryFn = useServerFn(getChannelFlowSummary);
  const timelineFn = useServerFn(getChannelDispatchTimeline);
  const stepsFn = useServerFn(getChannelFlowSteps);

  const stats = useQuery({
    queryKey: ["history-stats", channel, iso.from, iso.to],
    queryFn: () => statsFn({ data: { channel, from: iso.from, to: iso.to } }),
    ...HISTORY_POLL,
  });
  const flows = useQuery({
    queryKey: ["history-flows", channel],
    queryFn: () => flowsFn({ data: { channel } }),
    enabled: showFlow,
    staleTime: 60_000,
  });
  const stepOptions = useQuery({
    queryKey: ["history-steps", channel, flowId],
    queryFn: () => stepsFn({ data: { channel, flowId } }),
    enabled: showStep && flowId !== "all",
    staleTime: 60_000,
  });
  const summary = useQuery({
    queryKey: ["history-summary", channel, iso.from, iso.to],
    queryFn: () => summaryFn({ data: { channel, from: iso.from, to: iso.to } }),
    enabled: showFlow,
    ...HISTORY_POLL,
  });
  const timeline = useQuery({
    queryKey: ["history-timeline", channel, iso.from, iso.to, iso.bucket],
    queryFn: () =>
      timelineFn({ data: { channel, from: iso.from, to: iso.to, bucket: iso.bucket } }),
    ...HISTORY_POLL,
  });
  const hist = useQuery({
    queryKey: [
      "history-rows",
      channel,
      iso.from,
      iso.to,
      flowId,
      step,
      status,
      direction,
      debouncedSearch,
      page,
    ],
    queryFn: () =>
      histFn({
        data: {
          channel,
          from: iso.from,
          to: iso.to,
          flowId: flowId === "all" ? null : flowId,
          step: step === "all" ? null : step,
          status: status as any,
          direction,
          search: debouncedSearch || null,
          page,
          pageSize,
        },
      }),
    ...HISTORY_POLL,
  });

  // Sem Realtime (REP-05): as tabelas de log (sms_send_logs etc.) têm escrita
  // alta e cada mudança re-executava as estatísticas pesadas. Agora as queries
  // acima fazem polling a cada 60 s (só com a aba visível) e ao voltar o foco.

  const cards = options.cardLabels ?? {
    total: "Envios",
    success: showsDelivery ? "Entregues" : "Enviados",
    failed: "Falhas",
    pending: "Pendentes",
    conversions: "Conversões",
  };

  const rows = hist.data?.rows ?? [];
  const total = hist.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  function refresh() {
    qc.invalidateQueries({ queryKey: ["history-stats", channel] });
    qc.invalidateQueries({ queryKey: ["history-summary", channel] });
    qc.invalidateQueries({ queryKey: ["history-timeline", channel] });
    qc.invalidateQueries({ queryKey: ["history-rows", channel] });
    toast.success("Histórico atualizado");
  }

  function clearFilters() {
    setFlowId("all");
    setStep("all");
    setStatus("all");
    setSearch("");
  }

  const filtersActive =
    flowId !== "all" || step !== "all" || status !== "all" || debouncedSearch !== "";

  const deltaPct = (() => {
    const s = stats.data;
    if (!s || s.prevTotal === 0) return null;
    return Math.round(((s.total - s.prevTotal) / s.prevTotal) * 100);
  })();

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <PeriodPicker
          preset={preset}
          range={range}
          onChange={(nextPreset, nextRange) => {
            setPreset(nextPreset);
            setRange(nextRange);
          }}
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="text-xs text-muted-foreground">
            {options.subtitle ? `${options.subtitle} · ` : ""}
            Último envio:{" "}
            <span className="text-foreground">{formatRelative(stats.data?.lastDispatchAt)}</span>
          </p>
          <UpdatedAgo ts={stats.dataUpdatedAt} className="hidden sm:inline" />
          <Button variant="outline" onClick={refresh} className="h-9 gap-1.5">
            <RefreshCw className={`h-3.5 w-3.5 ${stats.isFetching ? "animate-spin" : ""}`} />
            Atualizar
          </Button>
        </div>
      </div>
      {options.title && <h2 className="text-section">{options.title}</h2>}

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard
          icon={<Send className="h-4 w-4" />}
          label={cards.total}
          value={stats.data?.total}
          deltaPct={deltaPct}
        />
        <StatCard
          icon={<CheckCircle2 className="h-4 w-4 text-success" />}
          label={cards.success}
          value={stats.data?.success}
          subtitle={showsDelivery && stats.data ? `${stats.data.deliveryRate}% taxa` : undefined}
        />
        <StatCard
          icon={<XCircle className="h-4 w-4 text-danger" />}
          label={cards.failed}
          value={stats.data?.failed}
        />
        <StatCard
          icon={<Clock className="h-4 w-4 text-warning" />}
          label={cards.pending}
          value={stats.data?.pending}
        />
        <StatCard
          icon={<TrendingUp className="h-4 w-4 text-primary" />}
          label={cards.conversions}
          value={stats.data?.conversions}
        />
      </div>

      {/* Sparkline */}
      {(timeline.data?.points?.length ?? 0) > 1 && (
        <Card>
          <CardContent className="p-3">
            <div className="mb-1 flex items-center justify-between px-1">
              <p className="text-label text-muted-foreground">
                Envios por {iso.bucket === "hour" ? "hora" : "dia"}
              </p>
              <p className="text-meta text-muted-foreground">
                {(timeline.data?.points ?? [])
                  .reduce((a, b) => a + b.count, 0)
                  .toLocaleString("pt-BR")}{" "}
                total
              </p>
            </div>
            <ResponsiveContainer width="100%" height={64}>
              <BarChart
                data={timeline.data?.points ?? []}
                margin={{ top: 4, right: 4, bottom: 0, left: 4 }}
              >
                <XAxis dataKey="t" hide />
                <Tooltip
                  {...chartTooltipProps}
                  labelFormatter={(v) =>
                    new Date(v as string).toLocaleString("pt-BR", {
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  }
                  formatter={(v) => [`${v}`, "envios"]}
                />
                <Bar dataKey="count" fill={CHART_COLORS.primary} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Top fluxos */}
      {showFlow && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <div>
              <CardTitle>Jornadas com mais envios</CardTitle>
              <p className="text-meta text-muted-foreground">
                Clique numa jornada para filtrar a tabela abaixo.
              </p>
            </div>
            {flowId !== "all" && (
              <Button
                variant="ghost"
                size="sm"
                className="gap-1 text-xs"
                onClick={() => setFlowId("all")}
              >
                Limpar seleção
              </Button>
            )}
          </CardHeader>
          <CardContent className="p-0">
            <FlowRanking
              items={summary.data?.items ?? []}
              selectedId={flowId === "all" ? null : flowId}
              onSelect={(id) => setFlowId(id)}
              loading={summary.isLoading}
              showsDelivery={showsDelivery}
            />
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <Card>
        <CardContent className="grid grid-cols-1 gap-2 p-3 md:grid-cols-5">
          {showFlow ? (
            <Select value={flowId} onValueChange={setFlowId}>
              <SelectTrigger>
                <SelectValue placeholder="Jornada" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as jornadas</SelectItem>
                {(flows.data?.flows ?? []).map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="hidden md:block" />
          )}
          {showDirection ? (
            <Select value={direction} onValueChange={(v: any) => setDirection(v)}>
              <SelectTrigger>
                <SelectValue placeholder="Direção" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="outgoing">Só envios</SelectItem>
                <SelectItem value="incoming">Só recebidas</SelectItem>
                <SelectItem value="all">Tudo</SelectItem>
              </SelectContent>
            </Select>
          ) : showStep ? (
            <Select value={step} onValueChange={setStep} disabled={flowId === "all"}>
              <SelectTrigger>
                <SelectValue
                  placeholder={flowId === "all" ? "Selecione uma jornada" : "Dia da jornada"}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os dias</SelectItem>
                {(stepOptions.data?.steps ?? []).map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="hidden md:block" />
          )}
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger>
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os status</SelectItem>
              <SelectItem value="green">Sucesso</SelectItem>
              <SelectItem value="yellow">Pendente / retry</SelectItem>
              <SelectItem value="red">Falha</SelectItem>
              <SelectItem value="blue">Processando</SelectItem>
              <SelectItem value="gray">Cancelado</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative md:col-span-2">
            <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Buscar nome, telefone, email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="overflow-x-auto p-0">
          {hist.isLoading && rows.length === 0 ? (
            <p className="p-10 text-center text-sm text-muted-foreground">Carregando…</p>
          ) : rows.length === 0 ? (
            <div className="space-y-2 p-10 text-center text-sm">
              <p className="text-muted-foreground">
                {filtersActive
                  ? "Nenhum registro com esses filtros."
                  : "Nenhum envio nesse período."}
              </p>
              {filtersActive && (
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  Limpar filtros
                </Button>
              )}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Jogador</TableHead>
                  <TableHead>Contato</TableHead>
                  <TableHead>Mensagem</TableHead>
                  {showFlow && <TableHead>Jornada</TableHead>}
                  {showStep && <TableHead>Dia</TableHead>}
                  <TableHead>Status</TableHead>
                  <TableHead>Conv.</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} className="cursor-pointer" onClick={() => setOpenRow(r)}>
                    <TableCell className="whitespace-nowrap text-meta text-muted-foreground">
                      {new Date(r.created_at).toLocaleString("pt-BR", {
                        day: "2-digit",
                        month: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </TableCell>
                    <TableCell className="text-xs font-medium">
                      {r.lead_name ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="font-mono text-meta text-muted-foreground">
                      {r.contact}
                    </TableCell>
                    <TableCell className="max-w-[280px] truncate text-xs text-muted-foreground">
                      {r.message ?? "—"}
                    </TableCell>
                    {showFlow && (
                      <TableCell className="text-xs">
                        {r.flow_name ?? <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    )}
                    {showStep && (
                      <TableCell className="text-xs">
                        {r.step ?? <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    )}
                    <TableCell>
                      <StatusBadge color={r.status_color} label={r.status_label} title={r.error} />
                    </TableCell>
                    <TableCell>
                      {r.converted ? (
                        <StatusBadge color="green" label="Convertido" />
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
        {rows.length > 0 && (
          <div className="flex items-center justify-between gap-2 border-t border-white/5 px-4 py-3">
            <div className="text-xs text-muted-foreground">
              {total.toLocaleString("pt-BR")} registros · página {page + 1} de {totalPages}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0 || hist.isFetching}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Anterior
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page + 1 >= totalPages || hist.isFetching}
                onClick={() => setPage((p) => p + 1)}
              >
                Próxima
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Detail drawer */}
      <Sheet open={!!openRow} onOpenChange={(v) => !v && setOpenRow(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          {openRow && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  {CHANNEL_LABEL[openRow.channel]} ·{" "}
                  <StatusBadge color={openRow.status_color} label={openRow.status_label} />
                </SheetTitle>
                <SheetDescription>
                  {new Date(openRow.created_at).toLocaleString("pt-BR")}
                </SheetDescription>
              </SheetHeader>
              <div className="mt-6 space-y-4 text-sm">
                <DetailField label="Jogador">{openRow.lead_name ?? "—"}</DetailField>
                <DetailField label="Contato">
                  <span className="font-mono text-xs">{openRow.contact}</span>
                </DetailField>
                <DetailField label="Jornada">{openRow.flow_name ?? "—"}</DetailField>
                <DetailField label="Dia da jornada">{openRow.step ?? "—"}</DetailField>
                <DetailField label="Template / assunto">{openRow.template ?? "—"}</DetailField>
                <DetailField label="Mensagem">
                  <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                    {openRow.message ?? "—"}
                  </pre>
                </DetailField>
                {openRow.error && (
                  <DetailField label="Falha no envio">
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-danger/10 p-2 text-xs text-danger">
                      {openRow.error}
                    </pre>
                  </DetailField>
                )}
                {openRow.converted && (
                  <div className="rounded-md border border-success/20 bg-success/5 p-3 text-xs text-success">
                    O jogador depositou em até 72h após o contato.
                  </div>
                )}
              </div>
              <div className="mt-6 flex flex-wrap gap-2">
                {openRow.player_id && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    onClick={() => window.open(`/players?focus=${openRow.player_id}`, "_blank")}
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> Ver jogador
                  </Button>
                )}
                {openRow.message && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    onClick={() => {
                      navigator.clipboard.writeText(openRow.message ?? "");
                      toast.success("Mensagem copiada");
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" /> Copiar mensagem
                  </Button>
                )}
                {openRow.error && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    onClick={() => {
                      navigator.clipboard.writeText(openRow.error ?? "");
                      toast.success("Erro copiado");
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" /> Copiar erro
                  </Button>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  subtitle,
  deltaPct,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | undefined;
  subtitle?: string;
  deltaPct?: number | null;
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="text-label text-muted-foreground">{label}</p>
          <p className="text-kpi-sm tabular-nums">
            {value == null ? "—" : value.toLocaleString("pt-BR")}
          </p>
          {subtitle ? (
            <p className="text-meta text-muted-foreground">{subtitle}</p>
          ) : deltaPct != null ? (
            <p
              className={`flex items-center gap-0.5 text-meta ${
                deltaPct >= 0 ? "text-success" : "text-danger"
              }`}
            >
              {deltaPct >= 0 ? (
                <ArrowUpRight className="h-3 w-3" />
              ) : (
                <ArrowDownRight className="h-3 w-3" />
              )}
              {Math.abs(deltaPct)}% vs período anterior
            </p>
          ) : null}
        </div>
        <div className="rounded-md bg-muted/40 p-2 text-muted-foreground">{icon}</div>
      </CardContent>
    </Card>
  );
}

function FlowRanking({
  items,
  selectedId,
  onSelect,
  loading,
  showsDelivery,
}: {
  items: FlowSummaryItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  showsDelivery: boolean;
}) {
  if (loading && items.length === 0) {
    return <p className="p-6 text-center text-xs text-muted-foreground">Carregando jornadas…</p>;
  }
  if (items.length === 0) {
    return (
      <p className="p-6 text-center text-xs text-muted-foreground">
        Nenhum envio por jornada no período.
      </p>
    );
  }
  const max = Math.max(...items.map((i) => i.total));
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Jornada</TableHead>
          <TableHead className="text-right">Envios</TableHead>
          <TableHead className="text-right">{showsDelivery ? "Sucesso" : "Enviados"}</TableHead>
          {showsDelivery && <TableHead className="text-right">% entrega</TableHead>}
          <TableHead className="text-right">Falhas</TableHead>
          <TableHead>Último</TableHead>
          <TableHead className="w-6"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((s) => {
          const pct = s.total > 0 ? Math.round((s.success / s.total) * 100) : 0;
          const width = max > 0 ? Math.max(2, Math.round((s.total / max) * 100)) : 0;
          const isSelected = selectedId === s.flow_id;
          return (
            <TableRow
              key={s.flow_id}
              className={`cursor-pointer ${isSelected ? "bg-primary/5" : ""}`}
              onClick={() => onSelect(s.flow_id)}
            >
              <TableCell className="max-w-[260px]">
                <div className="text-xs font-medium">{s.flow_name}</div>
                <div className="mt-1 h-1 w-full rounded bg-muted/40">
                  <div className="h-1 rounded bg-primary/70" style={{ width: `${width}%` }} />
                </div>
              </TableCell>
              <TableCell className="text-right text-xs tabular-nums">
                {s.total.toLocaleString("pt-BR")}
              </TableCell>
              <TableCell className="text-right text-xs tabular-nums text-success">
                {s.success.toLocaleString("pt-BR")}
              </TableCell>
              {showsDelivery && (
                <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                  {pct}%
                </TableCell>
              )}
              <TableCell className="text-right text-xs tabular-nums text-danger">
                {s.failed.toLocaleString("pt-BR")}
              </TableCell>
              <TableCell className="text-meta text-muted-foreground">
                {formatRelative(s.last_at)}
              </TableCell>
              <TableCell>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-label text-muted-foreground">{label}</p>
      <div>{children}</div>
    </div>
  );
}
