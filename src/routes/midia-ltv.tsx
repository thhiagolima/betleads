import { Link, createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  BarChart3,
  Calendar,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Target,
  Wallet,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { PageTabs } from "@/components/ui-premium/page-tabs";
import { RetentionPanel } from "@/components/crm-results/retention";
import { CHART_COLORS, chartAxisProps, chartGridProps, chartTooltipStyle } from "@/lib/chart-theme";
import { DataCard } from "@/components/ui-premium/data-card";
import { EmptyState } from "@/components/ui-premium/empty-state";
import { MetricCard } from "@/components/ui-premium/metric-card";
import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import { useActiveTenant } from "@/hooks/use-active-tenant";
import { DEMO_EMPTY_STATE_TEXT } from "@/lib/demo-tenant";
import { getMarketingOverview } from "@/lib/marketing.functions";
import type {
  AudienceRow,
  CampaignRow,
  CreativeRow,
  DailyPoint,
  MarketingOverview as MarketingOverviewData,
  MoneyRow,
  OrphanAttributionRow,
  OthersRow,
} from "@/lib/marketing-overview";
import { brtPeriodRange, brtToday, periodDays, type PeriodPreset } from "@/lib/marketing-overview";
import { enqueueMetaSync, getMetaSyncRuns } from "@/lib/meta.functions";
import {
  useMetaConnectionSummary,
  type MarketingIntegration,
  type MetaSummary,
} from "@/components/integrations/meta-summary";
import { AdAccountFilter, AdAccountFilterNote } from "@/components/midia-ltv/ad-account-filter";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/midia-ltv")({
  component: MediaLtvPage,
});

type MarketingOverview = MarketingOverviewData & { integrations: MarketingIntegration[] };

type MetaSyncRun = {
  id: string;
  trigger_type: "manual" | "scheduled" | "backfill";
  days: number;
  status: "queued" | "running" | "completed" | "partial" | "failed" | "canceled";
  total_accounts: number;
  processed_accounts: number;
  successful_accounts: number;
  failed_accounts: number;
  rows_imported: number;
  started_at: string | null;
  finished_at: string | null;
  error_summary: string | null;
  created_at: string;
};

const periodLabels: Record<PeriodPreset, string> = {
  today: "Hoje",
  yesterday: "Ontem",
  "7d": "7 dias",
  "30d": "30 dias",
  this_month: "Este mês",
  last_month: "Mês passado",
};

function periodText(period?: { from: string; to: string }) {
  if (!period) return "";
  const from = new Date(`${period.from}T00:00:00`);
  const to = new Date(`${period.to}T00:00:00`);
  return `${from.toLocaleDateString("pt-BR")} a ${to.toLocaleDateString("pt-BR")}`;
}

function brl(value: number | null | undefined) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(value ?? 0);
}

function brl2(value: number | null | undefined) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value ?? 0);
}

function money(value: number, currency: string) {
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

function num(value: number | null | undefined) {
  return new Intl.NumberFormat("pt-BR").format(value ?? 0);
}

function ratio(value: number | null | undefined) {
  return value == null ? "-" : `${value.toFixed(2).replace(".", ",")}x`;
}

function pct(value: number | null | undefined) {
  return value == null ? "-" : `${value.toFixed(2).replace(".", ",")}%`;
}

function syncStatusLabel(status: MetaSyncRun["status"]) {
  if (status === "queued") return "na fila";
  if (status === "running") return "sincronizando";
  if (status === "completed") return "concluída";
  if (status === "partial") return "concluída com atenção";
  if (status === "failed") return "falhou";
  return "cancelada";
}

const VIEWS = [
  { value: "midia", label: "Mídia" },
  { value: "retencao", label: "Retenção" },
] as const;
type View = (typeof VIEWS)[number]["value"];

function MediaLtvPage() {
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash.replace(/^#/, "") });
  const view: View = hash === "retencao" ? "retencao" : "midia";
  const setView = (next: View) =>
    void navigate({ to: "/midia-ltv", hash: next === "midia" ? undefined : next });
  const qc = useQueryClient();
  const fetchOverview = useServerFn(getMarketingOverview);
  const requestMetaSync = useServerFn(enqueueMetaSync);
  const fetchMetaSyncRuns = useServerFn(getMetaSyncRuns);
  const [period, setPeriod] = useState<PeriodPreset>("7d");
  const [customRange, setCustomRange] = useState<{ from: string; to: string } | null>(null);
  const range = useMemo(() => {
    if (!customRange) return brtPeriodRange(period);
    return { ...customRange, days: periodDays(customRange.from, customRange.to) };
  }, [period, customRange]);
  const includesToday = range.to >= brtToday();

  const { data: metaSummary } = useMetaConnectionSummary();
  // MB4-04: filtro "BM / conta" (estado local). Só valem as contas ainda marcadas.
  const [adAccountFilter, setAdAccountFilter] = useState<string[]>([]);
  const adAccountIds = useMemo(() => {
    const marked = metaSummary
      ? new Set(
          metaSummary.accounts
            .filter((account) => account.selected !== false)
            .map((account) => account.meta_ad_account_id),
        )
      : null;
    return adAccountFilter.filter((id) => !marked || marked.has(id)).sort();
  }, [adAccountFilter, metaSummary]);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["marketing-overview", range.from, range.to, adAccountIds.join(",")],
    queryFn: async () =>
      (await fetchOverview({
        data: { from: range.from, to: range.to, adAccountIds },
      })) as MarketingOverview,
    // Só o período que inclui hoje muda sozinho; o resto é atualizado ao fim de um sync.
    refetchInterval: includesToday ? 60_000 : false,
  });

  const { data: metaSyncRuns = [] } = useQuery({
    queryKey: ["meta-sync-runs"],
    queryFn: () => fetchMetaSyncRuns(),
    refetchInterval: (query) => {
      const runs = (query.state.data ?? []) as MetaSyncRun[];
      return runs.some((run) => run.status === "queued" || run.status === "running") ? 3000 : 15000;
    },
  });

  const syncMetaMutation = useMutation({
    mutationFn: () => requestMetaSync({ data: { days: range.days } }),
    onSuccess: (run) => {
      toast.success(
        run.reused ? "A sincronização já está na fila" : "Sincronização adicionada à fila",
      );
      qc.invalidateQueries({ queryKey: ["meta-sync-runs"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao agendar sincronização"),
  });

  const latestMetaRun = metaSyncRuns[0] as MetaSyncRun | undefined;
  const latestMetaRunId = latestMetaRun?.id;
  const latestMetaRunStatus = latestMetaRun?.status;
  useEffect(() => {
    if (!latestMetaRunId || !latestMetaRunStatus) return;
    if (!["completed", "partial", "failed"].includes(latestMetaRunStatus)) return;
    qc.invalidateQueries({ queryKey: ["marketing-overview"] });
    qc.invalidateQueries({ queryKey: ["meta-connection-summary"] });
  }, [latestMetaRunId, latestMetaRunStatus, qc]);

  // A conexão com a Meta mora em Integrações (/webhooks#meta); aqui só um atalho.
  const noMetaConnection = Boolean(metaSummary) && (metaSummary?.connections.length ?? 0) === 0;

  return (
    <Page>
      <PageHeader
        subtitle="Cada jogador carrega o anúncio que o trouxe. Veja quem trouxe cadastro barato, quem trouxe dinheiro e quem continua depositando."
        actions={
          view === "midia" && noMetaConnection ? (
            <Button asChild size="sm" className="gap-2">
              <Link to="/webhooks" hash="meta">
                <Target className="h-3.5 w-3.5" />
                Conectar Meta
              </Link>
            </Button>
          ) : undefined
        }
      />

      <PageTabs
        value={view}
        onValueChange={setView}
        label="Seções de Aquisição e LTV"
        items={VIEWS}
      />

      {view === "retencao" && (
        <div role="tabpanel" aria-labelledby="tab-retencao">
          <RetentionPanel />
        </div>
      )}

      {view === "midia" && error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning"
        >
          <span>
            Não foi possível carregar os dados de mídia deste período.
            {error instanceof Error && error.message ? ` (${error.message})` : ""}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={isFetching}
            onClick={() => refetch()}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
            Tentar novamente
          </Button>
        </div>
      )}

      {view === "midia" && (
        <VisualizacaoSection
          range={range}
          period={period}
          customRange={customRange}
          onPeriodChange={(value) => {
            setPeriod(value);
            setCustomRange(null);
          }}
          onCustomRangeChange={setCustomRange}
          data={data}
          isLoading={isLoading}
          metaSummary={metaSummary}
          adAccountIds={adAccountIds}
          onAdAccountIdsChange={setAdAccountFilter}
          syncPending={
            syncMetaMutation.isPending ||
            metaSyncRuns.some(
              (run: MetaSyncRun) => run.status === "queued" || run.status === "running",
            )
          }
          onSync={() => syncMetaMutation.mutate()}
          syncRuns={metaSyncRuns as MetaSyncRun[]}
        />
      )}
    </Page>
  );
}

function Kpi({
  title,
  value,
  detail,
  tone = "default",
  className,
}: {
  title: string;
  value: string;
  detail: string;
  tone?: "default" | "success" | "info";
  className?: string;
}) {
  const icon =
    tone === "success" ? (
      <Wallet className="h-4 w-4" />
    ) : tone === "info" ? (
      <Target className="h-4 w-4" />
    ) : (
      <BarChart3 className="h-4 w-4" />
    );
  return (
    <MetricCard
      label={title}
      value={value}
      hint={detail}
      icon={icon}
      accent={tone === "success" ? "success" : "primary"}
      className={className}
    />
  );
}

function VisualizacaoSection({
  range,
  period,
  customRange,
  onPeriodChange,
  onCustomRangeChange,
  data,
  isLoading,
  metaSummary,
  adAccountIds,
  onAdAccountIdsChange,
  syncPending,
  onSync,
  syncRuns,
}: {
  range: { from: string; to: string; days: number };
  period: PeriodPreset;
  customRange: { from: string; to: string } | null;
  onPeriodChange: (period: PeriodPreset) => void;
  onCustomRangeChange: (range: { from: string; to: string } | null) => void;
  data: MarketingOverview | undefined;
  isLoading: boolean;
  metaSummary: MetaSummary | undefined;
  adAccountIds: string[];
  onAdAccountIdsChange: (ids: string[]) => void;
  syncPending: boolean;
  onSync: () => void;
  syncRuns: MetaSyncRun[];
}) {
  const isDemo = useIsDemoTenant();
  // Só o admin da casa (ou o super admin) sincroniza a Meta; o servidor também confere.
  // Enquanto o papel carrega, nada fica bloqueado.
  const { active } = useActiveTenant();
  const readOnly = Boolean(active) && active?.role !== "admin" && active?.role !== "super_admin";
  const [reportView, setReportView] = useState<
    "creatives" | "audiences" | "campaigns" | "evolution" | "diagnostics"
  >("creatives");
  const totals = data?.totals;
  const accounts = metaSummary?.accounts ?? [];
  const selectedAccounts = accounts.filter((account) => account.selected !== false);
  const lastSync = accounts
    .map((account) => account.last_sync_at)
    .filter(Boolean)
    .sort()
    .at(-1);
  const staleAccounts = selectedAccounts.filter((account) => !account.last_sync_at).length;
  const orphanRows = data?.orphanAttributions ?? [];
  const orphanRevenue = orphanRows.reduce((sum, row) => sum + row.revenue, 0);
  const orphanFtd = orphanRows.reduce((sum, row) => sum + row.ftd, 0);
  const spendOther = totals?.spendOther ?? [];
  const latestRun = syncRuns[0];
  const progress = latestRun?.total_accounts
    ? Math.round((latestRun.processed_accounts / latestRun.total_accounts) * 100)
    : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-border/70 px-3 py-1.5 text-sm font-medium text-muted-foreground">
          {periodText(data?.period ?? range)}
        </span>
        <DemoDisabledTooltip active={isDemo}>
          <Button
            variant="outline"
            className="gap-2"
            disabled={isDemo || readOnly || syncPending || accounts.length === 0}
            onClick={onSync}
          >
            {syncPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {syncPending ? "sincronização na fila" : "Atualizar agora"}
          </Button>
        </DemoDisabledTooltip>
        {readOnly && !isDemo && (
          <span className="text-xs text-muted-foreground">
            Só o administrador da casa sincroniza a Meta.
          </span>
        )}
      </div>

      {latestRun && (
        <div
          className={cn(
            "rounded-xl border px-4 py-3",
            latestRun.status === "failed" && "border-danger/30 bg-danger/5",
            latestRun.status === "partial" && "border-warning/30 bg-warning/5",
            latestRun.status === "completed" && "border-success/30 bg-success/5",
            ["queued", "running"].includes(latestRun.status) && "border-primary/30 bg-primary/5",
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">
                Última sincronização: {syncStatusLabel(latestRun.status)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {latestRun.processed_accounts} de {latestRun.total_accounts} conta(s) ·{" "}
                {num(latestRun.rows_imported)} linhas processadas
              </p>
            </div>
            <span className="text-sm font-semibold">
              {["queued", "running"].includes(latestRun.status)
                ? `${progress}%`
                : new Date(latestRun.finished_at ?? latestRun.created_at).toLocaleString("pt-BR")}
            </span>
          </div>
          {["queued", "running"].includes(latestRun.status) && (
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-500"
                style={{ width: `${Math.max(4, progress)}%` }}
              />
            </div>
          )}
          {latestRun.error_summary && (
            <p className="mt-2 text-xs text-danger">{latestRun.error_summary}</p>
          )}
          {syncRuns.length > 1 && (
            <details className="mt-3 text-xs text-muted-foreground">
              <summary className="cursor-pointer font-medium text-foreground">
                Ver histórico recente
              </summary>
              <div className="mt-2 space-y-1.5">
                {syncRuns.slice(1, 6).map((run) => (
                  <div
                    key={run.id}
                    className="flex flex-wrap justify-between gap-2 rounded-md bg-background/40 px-3 py-2"
                  >
                    <span>
                      {syncStatusLabel(run.status)} ·{" "}
                      {run.trigger_type === "manual"
                        ? "manual"
                        : run.trigger_type === "backfill"
                          ? "importação inicial"
                          : "automática"}
                    </span>
                    <span>
                      {run.processed_accounts}/{run.total_accounts} contas ·{" "}
                      {new Date(run.created_at).toLocaleString("pt-BR")}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/* Same segmented look as the Início period picker. */}
        <div
          role="group"
          aria-label="Período"
          className="flex max-w-full gap-0.5 overflow-x-auto rounded-xl border border-border bg-card p-[3px] [scrollbar-width:none]"
        >
          {(Object.keys(periodLabels) as PeriodPreset[]).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={!customRange && period === key}
              onClick={() => onPeriodChange(key)}
              className={cn(
                "h-9 shrink-0 whitespace-nowrap rounded-lg px-3 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                !customRange && period === key
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {periodLabels[key]}
            </button>
          ))}
        </div>
        <div className="flex w-full items-center gap-2 rounded-xl border border-border px-3 py-1 sm:w-auto">
          <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Input
            aria-label="Data inicial"
            type="date"
            className="h-8 w-full min-w-0 border-0 bg-transparent p-0 sm:w-36"
            value={customRange?.from ?? range.from}
            max={customRange?.to ?? range.to}
            onChange={(event) =>
              onCustomRangeChange({ from: event.target.value, to: customRange?.to ?? range.to })
            }
          />
          <span className="text-xs text-muted-foreground">até</span>
          <Input
            aria-label="Data final"
            type="date"
            className="h-8 w-full min-w-0 border-0 bg-transparent p-0 sm:w-36"
            value={customRange?.to ?? range.to}
            min={customRange?.from ?? range.from}
            max={brtToday()}
            onChange={(event) =>
              onCustomRangeChange({ from: customRange?.from ?? range.from, to: event.target.value })
            }
          />
        </div>
        <AdAccountFilter accounts={accounts} value={adAccountIds} onChange={onAdAccountIdsChange} />
      </div>

      <AdAccountFilterNote active={adAccountIds.length > 0} />

      <p className="text-meta text-muted-foreground">
        Gasto: Meta Ads, {num(adAccountIds.length || selectedAccounts.length)} conta(s)
        {lastSync
          ? `, última leitura em ${new Date(lastSync).toLocaleString("pt-BR")}`
          : ", aguardando a primeira leitura"}
        . Cadastros, 1º depósito e depósitos: integração da casa.
      </p>

      {/* AL0-06: sai quando a conferência da AL1 com a casa piloto for aceita. */}
      <div
        role="note"
        className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning"
      >
        <p className="flex items-center gap-2 font-semibold">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          Números em validação
        </p>
        <p className="mt-1">
          Os cálculos desta tela foram refeitos e estão sendo conferidos com o Gerenciador de
          Anúncios. Até o fim da conferência, use os valores como referência.
        </p>
      </div>

      {spendOther.length > 0 && (
        <div
          role="note"
          className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning"
        >
          <strong>Contas em outra moeda:</strong>{" "}
          {spendOther.map((row) => money(row.spend, row.currency)).join(" · ")}. Esse gasto fica
          fora do investido, do ROAS e do custo por 1º depósito, que estão em reais.
        </div>
      )}

      {staleAccounts > 0 && (
        <div className="rounded-xl border border-danger/40 bg-card/70 p-4 text-sm">
          <p className="flex items-center gap-2 font-semibold text-danger">
            <AlertTriangle className="h-4 w-4" />A conta conectada ainda não está entregando gasto
          </p>
          <p className="mt-2 text-muted-foreground">
            O token pode estar válido, mas sem leitura recente para uma conta de anúncio. Enquanto
            isso o gasto dessa conta não entra, e o ROI aparece melhor do que é.
          </p>
        </div>
      )}

      {orphanRows.length > 0 && (
        <div className="rounded-lg border border-warning/20 bg-warning/15 px-4 py-3 text-sm text-warning">
          <strong>
            {num(totals?.orphanPlayers)} cadastros marcados sem anúncio correspondente nas contas
            conectadas
          </strong>
          : {brl(orphanRevenue)} de depósitos e {num(orphanFtd)} primeiros depósitos sem gasto
          importado. Veja os detalhes na aba Diagnóstico.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-5">
        <Kpi
          title="Investido no período"
          value={brl(totals?.spend)}
          detail={`${brl((totals?.spend ?? 0) / Math.max(1, range.days))} por dia, em média`}
        />
        <Kpi
          title="ROAS líquido"
          value={ratio(totals?.roas)}
          detail={`depósitos − saques ÷ investido · bruto ${ratio(totals?.roasGross)}`}
          tone="info"
        />
        <Kpi
          title="Custo por 1º depósito"
          value={totals?.cpaFtd == null ? "-" : brl2(totals.cpaFtd)}
          detail={`${num(totals?.paidFtd)} vindos de anúncio · ${num(totals?.ftd)} na casa`}
        />
        <Kpi
          title="Custo por cadastro"
          value={totals?.cacSignup == null ? "-" : brl2(totals.cacSignup)}
          detail={`${num(totals?.paidPlayers)} cadastros de anúncio · ${num(totals?.players)} na casa`}
        />
        <Kpi
          title="Depósito líquido"
          value={brl(totals?.net)}
          detail={`${brl(totals?.revenue)} depositados − ${brl(totals?.withdrawals)} sacados`}
          tone="success"
          className="col-span-2 xl:col-span-1"
        />
      </div>

      <p className="text-meta text-muted-foreground">
        Como o ROAS é calculado:{" "}
        <strong className="text-foreground">{brl(totals?.ftdRevenue)}</strong> em{" "}
        {num(totals?.paidFtd)} primeiros depósitos
        <span className="px-1">+</span>
        <strong className="text-foreground">{brl(totals?.redepositRevenue)}</strong> de redepósito
        <span className="px-1">−</span>
        <strong className="text-foreground">{brl(totals?.withdrawals)}</strong> de saques
        <span className="px-1">=</span>
        <strong className="text-success">{brl(totals?.net)}</strong> líquidos
        <span className="px-1">÷</span>
        <strong className="text-foreground">{brl(totals?.spend)}</strong> investidos
        <span className="px-1">=</span>
        <strong className="text-success">{ratio(totals?.roas)}</strong>. Conta os jogadores que se
        cadastraram no período por um anúncio (horário de Brasília).
      </p>

      <Tabs value={reportView} onValueChange={(value) => setReportView(value as typeof reportView)}>
        <TabsList className="app-scrollbar h-auto max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="creatives">Por criativo</TabsTrigger>
          <TabsTrigger value="audiences">Por público da Meta</TabsTrigger>
          <TabsTrigger value="campaigns">Por campanha da Meta</TabsTrigger>
          <TabsTrigger value="evolution">Evolução</TabsTrigger>
          <TabsTrigger value="diagnostics">Diagnóstico</TabsTrigger>
        </TabsList>
      </Tabs>

      {reportView === "creatives" && (
        <CreativeTable
          creatives={data?.creatives ?? []}
          others={data?.creativesOthers}
          totals={totals}
          isLoading={isLoading}
        />
      )}
      {reportView === "audiences" && (
        <AudienceTable
          rows={data?.audiences ?? []}
          others={data?.audiencesOthers}
          isLoading={isLoading}
        />
      )}
      {reportView === "campaigns" && (
        <CampaignTable
          campaigns={data?.campaigns ?? []}
          others={data?.campaignsOthers}
          isLoading={isLoading}
          orphanRevenue={orphanRevenue}
        />
      )}
      {reportView === "evolution" && (
        <div className="grid gap-5 xl:grid-cols-2">
          <DailyChart
            title="Investimento por dia"
            subtitle={`${range.days} dias · o que foi gasto em mídia`}
            data={data?.daily ?? []}
            dataKey="spend"
            color={CHART_COLORS.orange}
            formatter={brl}
          />
          <DailyChart
            title="1º depósito de anúncio por dia"
            subtitle={`${range.days} dias`}
            data={data?.daily ?? []}
            dataKey="ftd"
            color={CHART_COLORS.green}
            formatter={num}
          />
          <MoneyMapCard rows={data?.moneyMap ?? []} />
        </div>
      )}
      {reportView === "diagnostics" && adAccountIds.length > 0 && (
        // Com filtro, só entra tráfego atribuído às contas: a saúde da atribuição
        // daria 100% / 0 órfãos trivialmente, então não mostramos os números.
        <p
          role="note"
          className="rounded-lg border border-border/60 bg-muted/30 px-4 py-3 text-sm text-muted-foreground"
        >
          O diagnóstico de atribuição considera todo o tráfego. Limpe o filtro de BM / conta para
          ver.
        </p>
      )}
      {reportView === "diagnostics" && adAccountIds.length === 0 && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <Kpi title="Cadastros" value={num(data?.attributionHealth.total)} detail="no período" />
            <Kpi
              title="Com marcação"
              value={num(data?.attributionHealth.marked)}
              detail="chegaram com UTM ou ID"
            />
            <Kpi
              title="Ligados a anúncio"
              value={num(data?.attributionHealth.matched)}
              detail={`${pct(data?.attributionHealth.matchRate)} dos marcados por mídia`}
              tone="success"
            />
            <Kpi
              title="Sem anúncio correspondente"
              value={num(
                (data?.attributionHealth.orphan ?? 0) + (data?.attributionHealth.ambiguous ?? 0),
              )}
              detail={`${num(data?.attributionHealth.ambiguous)} com nome repetido em mais de um anúncio`}
            />
            <Kpi
              title="Vindos do CRM"
              value={num(data?.attributionHealth.crm)}
              detail="link de SMS ou WhatsApp, não é mídia paga"
            />
            <Kpi
              title="Sem UTM"
              value={num(data?.attributionHealth.missingUtm)}
              detail="não permitem atribuição"
            />
          </div>
          <OrphanAttributionTable rows={orphanRows} isLoading={isLoading} />
        </div>
      )}
    </div>
  );
}

function attributionStatusLabel(status: string) {
  if (status === "matched_ad_id") return "anúncio";
  if (status === "matched_ad_name") return "nome do anúncio";
  if (status === "matched_campaign_id" || status === "matched_campaign_name") return "campanha";
  if (status === "ambiguous") return "nome repetido";
  if (status === "crm") return "CRM";
  if (status === "orphan_campaign") return "fora das contas";
  if (status === "missing_utm") return "sem UTM";
  return "pendente";
}

function AttributionBadge({ status }: { status: string }) {
  const orphan = ["orphan_campaign", "missing_utm", "ambiguous"].includes(status);
  const matched = status.startsWith("matched_");
  return (
    <Badge
      variant="outline"
      className={cn(
        "border-border/60 text-meta",
        matched && "border-success/30 bg-success/10 text-success",
        orphan && "border-warning/30 bg-warning/10 text-warning",
      )}
    >
      {attributionStatusLabel(status)}
    </Badge>
  );
}

function CreativeThumb({ src, label }: { src?: string | null; label: string }) {
  return (
    <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/60 bg-muted/50">
      {src ? (
        <img src={src} alt={label} className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <ImageIcon className="h-4 w-4 text-muted-foreground" />
      )}
    </div>
  );
}

function DailyChart({
  title,
  subtitle,
  data,
  dataKey,
  color,
  formatter,
}: {
  title: string;
  subtitle: string;
  data: DailyPoint[];
  dataKey: "spend" | "ftd";
  color: string;
  formatter: (value: number) => string;
}) {
  return (
    <DataCard title={title} description={subtitle} bodyClassName="h-[250px] pt-3">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 10, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`grad-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.35} />
              <stop offset="95%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid {...chartGridProps} />
          <XAxis dataKey="label" {...chartAxisProps} />
          <YAxis
            {...chartAxisProps}
            tickFormatter={(value) => formatter(Number(value))}
            width={58}
          />
          <Tooltip
            cursor={{ stroke: color, strokeOpacity: 0.35 }}
            contentStyle={chartTooltipStyle}
            labelStyle={{ color: "var(--color-muted-foreground)" }}
            formatter={(value) => formatter(Number(value))}
          />
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke={color}
            fill={`url(#grad-${dataKey})`}
            strokeWidth={2.5}
          />
        </AreaChart>
      </ResponsiveContainer>
    </DataCard>
  );
}

function MoneyMapCard({ rows }: { rows: MoneyRow[] }) {
  const [page, setPage] = useState(1);
  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, totalPages);
  const paged = rows.slice((current - 1) * pageSize, current * pageSize);

  return (
    <DataCard
      title="Onde o dinheiro está"
      description="Participação nos depósitos do período (1º depósito e redepósito), por anúncio"
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={<Wallet className="h-6 w-6" />}
          title="Sem receita atribuída"
          description="Quando os depósitos chegarem com UTM, a distribuição aparece aqui."
        />
      ) : (
        <div className="space-y-3">
          {paged.map((row) => (
            <div key={`${row.creative}-${row.campaign ?? ""}`} className="space-y-1">
              <div className="flex items-center gap-3">
                <CreativeThumb src={row.thumbnail_url} label={row.creative} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate text-sm font-semibold">{row.creative}</p>
                    <span className="text-sm text-muted-foreground">{Math.round(row.share)}%</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted/50">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.max(1, row.share)}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 pt-2 text-sm text-muted-foreground">
            <span>
              {rows.length === 0 ? 0 : (current - 1) * pageSize + 1}–
              {Math.min(current * pageSize, rows.length)} de {num(rows.length)} criativos
            </span>
            <div className="ml-auto flex flex-wrap gap-2">
              {Array.from({ length: Math.min(totalPages, 10) }).map((_, index) => {
                const n = index + 1;
                return (
                  <Button
                    key={n}
                    variant={n === current ? "default" : "outline"}
                    size="sm"
                    className="h-9 w-9 p-0"
                    onClick={() => setPage(n)}
                  >
                    {n}
                  </Button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </DataCard>
  );
}

type BusinessTotals = {
  spend: number;
  players: number;
  ftd: number;
  net: number;
  revenue: number;
};

function sumBusiness(
  rows: { spend: number; players: number; ftd: number; net: number; revenue: number }[],
  others: OthersRow | undefined,
): BusinessTotals {
  const listed = rows.reduce(
    (acc, row) => ({
      spend: acc.spend + row.spend,
      players: acc.players + row.players,
      ftd: acc.ftd + row.ftd,
      net: acc.net + row.net,
      revenue: acc.revenue + row.revenue,
    }),
    { spend: 0, players: 0, ftd: 0, net: 0, revenue: 0 },
  );
  return {
    spend: listed.spend + (others?.spend ?? 0),
    players: listed.players + (others?.players ?? 0),
    ftd: listed.ftd + (others?.ftd ?? 0),
    net: listed.net + (others?.net ?? 0),
    revenue: listed.revenue + (others?.revenue ?? 0),
  };
}

function BusinessCells({ spend, players, ftd, net }: Omit<BusinessTotals, "revenue">) {
  return (
    <>
      <TableCell className="text-right">{players > 0 ? num(players) : "—"}</TableCell>
      <TableCell className="text-right">
        {players > 0 && spend > 0 ? brl2(spend / players) : "—"}
      </TableCell>
      <TableCell className="text-right font-semibold">{ftd > 0 ? num(ftd) : "—"}</TableCell>
      <TableCell className="text-right">{ftd > 0 && spend > 0 ? brl2(spend / ftd) : "—"}</TableCell>
      <TableCell className="text-right">{brl(net)}</TableCell>
      <TableCell className="text-right font-semibold">
        {spend > 0 ? ratio(net / spend) : "—"}
      </TableCell>
    </>
  );
}

function BusinessHeads() {
  return (
    <>
      <TableHead className="text-right">Cadastros</TableHead>
      <TableHead className="text-right">Custo por cadastro</TableHead>
      <TableHead className="text-right">1º dep.</TableHead>
      <TableHead className="text-right">Custo por 1º dep.</TableHead>
      <TableHead className="text-right">Depósito líquido</TableHead>
      <TableHead className="text-right">ROAS líquido</TableHead>
    </>
  );
}

function AudienceTable({
  rows,
  others,
  isLoading,
}: {
  rows: AudienceRow[];
  others: OthersRow | undefined;
  isLoading: boolean;
}) {
  const isDemo = useIsDemoTenant();
  const totals = sumBusiness(rows, others);
  const othersCount = others?.count ?? 0;

  return (
    <DataCard
      title="Público por público"
      description="O que cada conjunto de anúncios custou e o que os jogadores dele trouxeram. É onde mora a segmentação: idade, posicionamento, interesse."
      bodyClassName="overflow-x-auto"
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={
            isLoading ? (
              <Loader2 className="h-6 w-6 animate-spin" />
            ) : (
              <Target className="h-6 w-6" />
            )
          }
          title={isLoading ? "Carregando públicos" : "Sem públicos no período"}
          description={
            isDemo
              ? DEMO_EMPTY_STATE_TEXT
              : "Depois de sincronizar conjuntos de anúncio, eles aparecem aqui."
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Público</TableHead>
              <TableHead className="text-right">Investido</TableHead>
              <TableHead className="text-right">Anúncios</TableHead>
              <BusinessHeads />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.adset}>
                <TableCell>{row.adset}</TableCell>
                <TableCell className="text-right font-medium">{brl(row.spend)}</TableCell>
                <TableCell className="text-right text-muted-foreground">{num(row.ads)}</TableCell>
                <BusinessCells {...row} />
              </TableRow>
            ))}
            {othersCount > 0 && (
              <TableRow className="text-muted-foreground">
                <TableCell>Outros {num(othersCount)} públicos</TableCell>
                <TableCell className="text-right">{brl(others?.spend)}</TableCell>
                <TableCell className="text-right">—</TableCell>
                <BusinessCells
                  spend={others?.spend ?? 0}
                  players={others?.players ?? 0}
                  ftd={others?.ftd ?? 0}
                  net={others?.net ?? 0}
                />
              </TableRow>
            )}
            <TableRow className="bg-muted/35 font-semibold">
              <TableCell>{num(rows.length + othersCount)} públicos</TableCell>
              <TableCell className="text-right">{brl(totals.spend)}</TableCell>
              <TableCell className="text-right">—</TableCell>
              <BusinessCells {...totals} />
            </TableRow>
          </TableBody>
        </Table>
      )}
    </DataCard>
  );
}

function CampaignTable({
  campaigns,
  others,
  isLoading,
  orphanRevenue,
}: {
  campaigns: CampaignRow[];
  others: OthersRow | undefined;
  isLoading: boolean;
  orphanRevenue: number;
}) {
  const isDemo = useIsDemoTenant();
  const rows = campaigns;
  const totals = sumBusiness(rows, others);
  const othersCount = others?.count ?? 0;

  return (
    <DataCard
      title="Campanha por campanha"
      description="O que cada campanha custou e o que os jogadores dela depositaram, menos os saques, no período."
      icon={<BarChart3 className="h-4 w-4" />}
      bodyClassName="overflow-x-auto"
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={
            isLoading ? (
              <Loader2 className="h-6 w-6 animate-spin" />
            ) : (
              <BarChart3 className="h-6 w-6" />
            )
          }
          title={isLoading ? "Carregando campanhas" : "Sem campanhas no período"}
          description={
            isDemo
              ? DEMO_EMPTY_STATE_TEXT
              : "Depois de sincronizar o Meta ou receber jogadores com UTM, as campanhas aparecem aqui."
          }
        />
      ) : (
        <div className="space-y-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campanha</TableHead>
                <TableHead className="text-right">Investido</TableHead>
                <TableHead className="text-right">Cliques no link</TableHead>
                <BusinessHeads />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={`${row.campaign_id ?? row.campaign}`}>
                  <TableCell>
                    <p className="font-semibold">{row.campaign}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.match_status === "no_spend"
                        ? "sem gasto importado no período"
                        : (row.campaign_id ?? "sem id")}
                    </p>
                  </TableCell>
                  <TableCell className="text-right font-medium">{brl(row.spend)}</TableCell>
                  <TableCell className="text-right">{num(row.linkClicks)}</TableCell>
                  <BusinessCells {...row} />
                </TableRow>
              ))}
              {othersCount > 0 && (
                <TableRow className="text-muted-foreground">
                  <TableCell>Outras {num(othersCount)} campanhas</TableCell>
                  <TableCell className="text-right">{brl(others?.spend)}</TableCell>
                  <TableCell className="text-right">—</TableCell>
                  <BusinessCells
                    spend={others?.spend ?? 0}
                    players={others?.players ?? 0}
                    ftd={others?.ftd ?? 0}
                    net={others?.net ?? 0}
                  />
                </TableRow>
              )}
              <TableRow className="bg-muted/35 font-semibold">
                <TableCell>
                  Total
                  <p className="text-xs font-normal text-muted-foreground">
                    {num(rows.length + othersCount)} campanha(s)
                  </p>
                </TableCell>
                <TableCell className="text-right">{brl(totals.spend)}</TableCell>
                <TableCell className="text-right">—</TableCell>
                <BusinessCells {...totals} />
              </TableRow>
            </TableBody>
          </Table>
          <p className="text-sm text-muted-foreground">
            ROAS líquido é o que os jogadores da campanha depositaram, menos os saques, dividido
            pelo investido. Campanhas de contas de anúncio não conectadas ficam sem investimento e
            sem ROAS
            {orphanRevenue > 0 ? ` (${brl(orphanRevenue)} de depósitos nessa situação)` : ""}.
          </p>
        </div>
      )}
    </DataCard>
  );
}

function OrphanAttributionTable({
  rows,
  isLoading,
}: {
  rows: OrphanAttributionRow[];
  isLoading: boolean;
}) {
  const isDemo = useIsDemoTenant();
  return (
    <DataCard
      title="Marcações sem anúncio correspondente"
      description="Jogadores que chegaram com UTM, mas não foram ligados a nenhum anúncio ou campanha das contas conectadas."
      icon={<ShieldCheck className="h-4 w-4" />}
      bodyClassName="overflow-x-auto"
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={
            isLoading ? (
              <Loader2 className="h-6 w-6 animate-spin" />
            ) : (
              <ShieldCheck className="h-6 w-6" />
            )
          }
          title={isLoading ? "Conferindo atribuições" : "Nenhuma marcação sem anúncio no período"}
          description={
            isDemo
              ? DEMO_EMPTY_STATE_TEXT
              : "Quando uma UTM chegar de uma campanha fora das BMs conectadas, ela aparece aqui sem gerar ROAS artificial."
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Campanha declarada</TableHead>
              <TableHead>Criativo</TableHead>
              <TableHead>Conjunto</TableHead>
              <TableHead>Origem</TableHead>
              <TableHead className="text-right">Jogadores</TableHead>
              <TableHead className="text-right">1º dep.</TableHead>
              <TableHead className="text-right">Depósitos</TableHead>
              <TableHead className="text-right">Investido</TableHead>
              <TableHead className="text-right">ROAS</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.campaign}-${row.creative}-${row.source ?? ""}`}>
                <TableCell className="font-semibold">{row.campaign}</TableCell>
                <TableCell>{row.creative}</TableCell>
                <TableCell>{row.adset ?? "-"}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span>{row.source ?? row.provider ?? "-"}</span>
                    <AttributionBadge status={row.ambiguous ? "ambiguous" : "orphan_campaign"} />
                  </div>
                </TableCell>
                <TableCell className="text-right">{num(row.players)}</TableCell>
                <TableCell className="text-right">{num(row.ftd)}</TableCell>
                <TableCell className="text-right">{brl(row.revenue)}</TableCell>
                <TableCell className="text-right text-muted-foreground">não encontrado</TableCell>
                <TableCell className="text-right text-muted-foreground">não calculado</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </DataCard>
  );
}

function CreativeTable({
  creatives,
  others,
  totals,
  isLoading,
}: {
  creatives: CreativeRow[];
  others: OthersRow | undefined;
  totals: MarketingOverview["totals"] | undefined;
  isLoading: boolean;
}) {
  const isDemo = useIsDemoTenant();
  const rows = creatives;
  const othersCount = others?.count ?? 0;

  return (
    <DataCard
      title="Criativo por criativo"
      description="Do anúncio que mais devolveu para o que menos devolveu, em depósitos dos jogadores que ele trouxe"
      icon={<Target className="h-4 w-4" />}
      bodyClassName="overflow-x-auto"
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={
            isLoading ? (
              <Loader2 className="h-6 w-6 animate-spin" />
            ) : (
              <Target className="h-6 w-6" />
            )
          }
          title={isLoading ? "Carregando criativos" : "Sem dados atribuídos"}
          description={
            isDemo
              ? DEMO_EMPTY_STATE_TEXT
              : "Depois que jogadores chegarem com UTM ou o gasto for importado, a leitura por criativo aparece aqui."
          }
        />
      ) : (
        <div className="space-y-3">
          <div className="max-h-[560px] overflow-auto pr-1">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Criativo</TableHead>
                  <TableHead className="text-right">Investido</TableHead>
                  <TableHead className="text-right">Cliques no link</TableHead>
                  <TableHead className="text-right">Cadastros</TableHead>
                  <TableHead className="text-right">1º dep.</TableHead>
                  <TableHead className="text-right">Custo por 1º dep.</TableHead>
                  <TableHead className="text-right">Depósito líquido</TableHead>
                  <TableHead className="text-right">ROAS líquido</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={`${row.ad_id ?? row.creative}`}>
                    <TableCell>
                      <div className="flex min-w-[260px] items-center gap-3">
                        <CreativeThumb src={row.thumbnail_url} label={row.creative} />
                        <div className="min-w-0">
                          <p className="truncate font-semibold">{row.creative}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {row.campaign ?? "Sem campanha"}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <p className="font-medium">{brl(row.spend)}</p>
                      <p className="text-xs text-muted-foreground">
                        {num(row.impressions)} impressões
                      </p>
                    </TableCell>
                    <TableCell className="text-right">
                      <p>{num(row.linkClicks)}</p>
                      <p className="text-xs text-muted-foreground">
                        CTR{" "}
                        {pct(row.impressions > 0 ? (row.linkClicks / row.impressions) * 100 : null)}
                      </p>
                    </TableCell>
                    <TableCell className="text-right">
                      {row.players > 0 ? num(row.players) : "—"}
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      {row.ftd > 0 ? num(row.ftd) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {row.ftd > 0 && row.spend > 0 ? brl2(row.spend / row.ftd) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <p className="font-medium">{brl(row.net)}</p>
                      <p className="text-xs text-muted-foreground">{brl(row.revenue)} bruto</p>
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      {row.spend > 0 ? ratio(row.net / row.spend) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
                {othersCount > 0 && (
                  <TableRow className="text-muted-foreground">
                    <TableCell>Outros {num(othersCount)} criativos</TableCell>
                    <TableCell className="text-right">{brl(others?.spend)}</TableCell>
                    <TableCell className="text-right">{num(others?.linkClicks)}</TableCell>
                    <TableCell className="text-right">{num(others?.players)}</TableCell>
                    <TableCell className="text-right">{num(others?.ftd)}</TableCell>
                    <TableCell className="text-right">—</TableCell>
                    <TableCell className="text-right">{brl(others?.net)}</TableCell>
                    <TableCell className="text-right">—</TableCell>
                  </TableRow>
                )}
                <TableRow className="sticky bottom-0 bg-muted font-semibold">
                  <TableCell>Total · {num(rows.length + othersCount)} criativos</TableCell>
                  <TableCell className="text-right">{brl(totals?.spend)}</TableCell>
                  <TableCell className="text-right">{num(totals?.linkClicks)}</TableCell>
                  <TableCell className="text-right">{num(totals?.paidPlayers)}</TableCell>
                  <TableCell className="text-right">{num(totals?.paidFtd)}</TableCell>
                  <TableCell className="text-right">
                    {totals?.cpaFtd == null ? "—" : brl2(totals.cpaFtd)}
                  </TableCell>
                  <TableCell className="text-right">{brl(totals?.net)}</TableCell>
                  <TableCell className="text-right">{ratio(totals?.roas)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
          <p className="text-meta text-muted-foreground">
            Gasto, impressões e cliques vêm da Meta. Cadastros, 1º depósito e depósitos vêm da
            integração da casa, só de jogadores cadastrados no período que foram ligados a este
            anúncio. Jogadores ligados só à campanha aparecem em “Por campanha da Meta”.
          </p>
        </div>
      )}
    </DataCard>
  );
}
