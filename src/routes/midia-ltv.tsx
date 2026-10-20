import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  BarChart3,
  Calendar,
  CheckCircle2,
  Clipboard,
  Eye,
  Image as ImageIcon,
  Link2,
  Loader2,
  RefreshCw,
  Settings,
  ShieldCheck,
  Target,
  Trash2,
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/components/ui-premium/page-header";
import { DataCard } from "@/components/ui-premium/data-card";
import { EmptyState } from "@/components/ui-premium/empty-state";
import { MetricCard } from "@/components/ui-premium/metric-card";
import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
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
import {
  connectMetaSystemUserToken,
  disconnectMetaConnection,
  getMetaConnectionSummary,
  enqueueMetaSync,
  getMetaSyncRuns,
  updateMetaAccountSelection,
  validateMetaConnection,
} from "@/lib/meta.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/midia-ltv")({
  head: () => ({
    meta: [{ title: "Aquisição e LTV - BETLEADS" }],
  }),
  component: MediaLtvPage,
});

type MarketingIntegration = {
  provider: string;
  status: string;
};

type MarketingOverview = MarketingOverviewData & { integrations: MarketingIntegration[] };

type MetaAccount = {
  id: string;
  connection_id: string;
  meta_ad_account_id: string;
  account_id: string | null;
  name: string | null;
  currency: string | null;
  selected: boolean | null;
  last_sync_at: string | null;
  sync_status: "never" | "queued" | "syncing" | "healthy" | "warning" | "error";
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_row_count: number;
};

type MetaConnection = {
  id: string;
  meta_user_name: string | null;
  scopes: string[] | null;
  status: string;
  last_error: string | null;
  last_sync_at: string | null;
  token_hint: string | null;
  token_validated_at: string | null;
  permissions_checked_at: string | null;
  app_id: string | null;
  app_name: string | null;
  business_id: string | null;
  connection_label: string | null;
  auth_type: "legacy_oauth" | "system_user_token";
};

type MetaSummary = {
  accounts: MetaAccount[];
  connections: MetaConnection[];
};

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

// Só a Meta tem gasto sincronizado. Google, TikTok e Kwai voltam quando houver
// integração (AL5-04); antes disso o gerador prometeria uma medição que não existe.
const META_UTM_PARAMS =
  "utm_source={{site_source_name}}&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{adset.name}}&utm_id={{ad.id}}";

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

function appendParams(url: string, params: string) {
  const clean = url.trim();
  if (!clean) return params;
  return `${clean}${clean.includes("?") ? "&" : "?"}${params}`;
}

function statusLabel(status?: string) {
  if (status === "connected") return "conectada";
  if (status === "configured") return "preparada";
  if (status === "error") return "erro";
  if (status === "disabled") return "pausada";
  return "planejada";
}

function syncStatusLabel(status: MetaSyncRun["status"]) {
  if (status === "queued") return "na fila";
  if (status === "running") return "sincronizando";
  if (status === "completed") return "concluída";
  if (status === "partial") return "concluída com atenção";
  if (status === "failed") return "falhou";
  return "cancelada";
}

function MediaLtvPage() {
  const qc = useQueryClient();
  const fetchOverview = useServerFn(getMarketingOverview);
  const connectMetaToken = useServerFn(connectMetaSystemUserToken);
  const fetchMetaSummary = useServerFn(getMetaConnectionSummary);
  const requestMetaSync = useServerFn(enqueueMetaSync);
  const fetchMetaSyncRuns = useServerFn(getMetaSyncRuns);
  const saveMetaSelection = useServerFn(updateMetaAccountSelection);
  const testMetaConnection = useServerFn(validateMetaConnection);
  const removeMetaConnection = useServerFn(disconnectMetaConnection);
  const [period, setPeriod] = useState<PeriodPreset>("7d");
  const [customRange, setCustomRange] = useState<{ from: string; to: string } | null>(null);
  const [section, setSection] = useState<"visualizacao" | "configuracao">("visualizacao");
  const [houseUrl, setHouseUrl] = useState("");
  const range = useMemo(() => {
    if (!customRange) return brtPeriodRange(period);
    return { ...customRange, days: periodDays(customRange.from, customRange.to) };
  }, [period, customRange]);
  const includesToday = range.to >= brtToday();

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["marketing-overview", range.from, range.to],
    queryFn: async () =>
      (await fetchOverview({
        data: { from: range.from, to: range.to },
      })) as MarketingOverview,
    // Só o período que inclui hoje muda sozinho; o resto é atualizado ao fim de um sync.
    refetchInterval: includesToday ? 60_000 : false,
  });

  const { data: metaSummary } = useQuery({
    queryKey: ["meta-connection-summary"],
    queryFn: async () => (await fetchMetaSummary()) as unknown as MetaSummary,
    refetchInterval: 30000,
  });

  const { data: metaSyncRuns = [] } = useQuery({
    queryKey: ["meta-sync-runs"],
    queryFn: () => fetchMetaSyncRuns(),
    refetchInterval: (query) => {
      const runs = (query.state.data ?? []) as MetaSyncRun[];
      return runs.some((run) => run.status === "queued" || run.status === "running") ? 3000 : 15000;
    },
  });

  const connectMetaTokenMutation = useMutation({
    mutationFn: (accessToken: string) => connectMetaToken({ data: { accessToken } }),
    onSuccess: (result) => {
      toast.success(
        `${result.accounts.length} conta(s) encontrada(s). Escolha quais acompanhar e salve.`,
      );
      qc.invalidateQueries({ queryKey: ["meta-connection-summary"] });
      qc.invalidateQueries({ queryKey: ["marketing-overview"] });
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Não foi possível validar o token Meta"),
  });

  const metaSelectionMutation = useMutation({
    mutationFn: (accountIds: string[]) => saveMetaSelection({ data: { accountIds } }),
    onSuccess: (result) => {
      toast.success(`${result.selected} conta(s) selecionada(s)`);
      qc.invalidateQueries({ queryKey: ["meta-connection-summary"] });
      qc.invalidateQueries({ queryKey: ["marketing-overview"] });
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Não foi possível salvar as contas"),
  });

  const validateMetaMutation = useMutation({
    mutationFn: (connectionId: string) => testMetaConnection({ data: { connectionId } }),
    onSuccess: (result) => {
      toast.success(`Conexão validada · ${result.accounts} conta(s) acessíveis`);
      qc.invalidateQueries({ queryKey: ["meta-connection-summary"] });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Não foi possível validar a conexão");
      qc.invalidateQueries({ queryKey: ["meta-connection-summary"] });
    },
  });

  const disconnectMetaMutation = useMutation({
    mutationFn: (connectionId: string) => removeMetaConnection({ data: { connectionId } }),
    onSuccess: () => {
      toast.success("Conexão Meta removida");
      qc.invalidateQueries({ queryKey: ["meta-connection-summary"] });
      qc.invalidateQueries({ queryKey: ["marketing-overview"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Não foi possível desconectar"),
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

  const integrations = data?.integrations ?? [];
  const meta = integrations.find((i) => i.provider === "meta");
  const utmParams = META_UTM_PARAMS;
  const fullUrl = useMemo(() => appendParams(houseUrl, utmParams), [houseUrl, utmParams]);

  async function copy(text: string, label = "Copiado") {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(label);
    } catch {
      toast.error("Não foi possível copiar. Selecione o texto e copie manualmente.");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Aquisição e LTV"
        subtitle="Cada jogador carrega o anúncio que o trouxe. Veja quem trouxe cadastro barato e quem trouxe dinheiro."
        icon={<BarChart3 className="h-5 w-5 text-primary-foreground" />}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant={section === "visualizacao" ? "default" : "outline"}
              size="sm"
              className="gap-2"
              onClick={() => setSection("visualizacao")}
            >
              <Eye className="h-3.5 w-3.5" />
              Visualização
            </Button>
            <Button
              variant={section === "configuracao" ? "default" : "outline"}
              size="sm"
              className="gap-2"
              onClick={() => setSection("configuracao")}
            >
              <Settings className="h-3.5 w-3.5" />
              Configuração
            </Button>
          </div>
        }
      />

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100"
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

      {section === "visualizacao" ? (
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
          syncPending={
            syncMetaMutation.isPending ||
            metaSyncRuns.some(
              (run: MetaSyncRun) => run.status === "queued" || run.status === "running",
            )
          }
          onSync={() => syncMetaMutation.mutate()}
          syncRuns={metaSyncRuns as MetaSyncRun[]}
        />
      ) : (
        <ConfiguracaoSection
          meta={meta}
          metaSummary={metaSummary}
          houseUrl={houseUrl}
          utmParams={utmParams}
          fullUrl={fullUrl}
          onConnectMetaToken={(token) => connectMetaTokenMutation.mutateAsync(token)}
          connectTokenPending={connectMetaTokenMutation.isPending}
          onSaveMetaSelection={(accountIds) => metaSelectionMutation.mutateAsync(accountIds)}
          selectionPending={metaSelectionMutation.isPending}
          onValidateMeta={(connectionId) => validateMetaMutation.mutateAsync(connectionId)}
          validatingConnectionId={validateMetaMutation.variables ?? null}
          onDisconnectMeta={(connectionId) => disconnectMetaMutation.mutateAsync(connectionId)}
          disconnectPending={disconnectMetaMutation.isPending}
          onHouseUrlChange={setHouseUrl}
          onCopy={copy}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status?: string }) {
  const connected = status === "connected";
  const configured = status === "configured" || status === "planned";
  return (
    <Badge
      variant="outline"
      className={cn(
        "border-border/60 text-[10px]",
        connected && "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
        configured && "border-sky-500/30 bg-sky-500/10 text-sky-300",
        status === "error" && "border-rose-500/30 bg-rose-500/10 text-rose-300",
      )}
    >
      {statusLabel(status)}
    </Badge>
  );
}

function Kpi({
  title,
  value,
  detail,
  tone = "default",
}: {
  title: string;
  value: string;
  detail: string;
  tone?: "default" | "success" | "info";
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
    />
  );
}

function CopyBlock({ title, value, onCopy }: { title: string; value: string; onCopy: () => void }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-sm font-semibold">{title}</p>
        <Button variant="outline" size="sm" className="gap-2" onClick={onCopy}>
          <Clipboard className="h-3.5 w-3.5" />
          Copiar
        </Button>
      </div>
      <pre className="overflow-auto rounded-md bg-background/70 p-3 text-xs text-primary">
        {value}
      </pre>
    </div>
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
  syncPending: boolean;
  onSync: () => void;
  syncRuns: MetaSyncRun[];
}) {
  const isDemo = useIsDemoTenant();
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
            disabled={isDemo || syncPending || accounts.length === 0}
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
      </div>

      {latestRun && (
        <div
          className={cn(
            "rounded-xl border px-4 py-3",
            latestRun.status === "failed" && "border-rose-500/30 bg-rose-500/5",
            latestRun.status === "partial" && "border-amber-500/30 bg-amber-500/5",
            latestRun.status === "completed" && "border-emerald-500/30 bg-emerald-500/5",
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
            <p className="mt-2 text-xs text-rose-300">{latestRun.error_summary}</p>
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
                      {run.trigger_type === "manual" ? "manual" : "automática"}
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
        {(Object.keys(periodLabels) as PeriodPreset[]).map((key) => (
          <Button
            key={key}
            variant={period === key ? "default" : "outline"}
            className="h-11 px-5"
            onClick={() => onPeriodChange(key)}
          >
            {periodLabels[key]}
          </Button>
        ))}
        <div className="flex items-center gap-2 rounded-md border border-border/70 px-3 py-1.5">
          <Calendar className="h-4 w-4 text-muted-foreground" />
          <Input
            aria-label="Data inicial"
            type="date"
            className="h-8 w-36 border-0 bg-transparent p-0"
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
            className="h-8 w-36 border-0 bg-transparent p-0"
            value={customRange?.to ?? range.to}
            min={customRange?.from ?? range.from}
            max={brtToday()}
            onChange={(event) =>
              onCustomRangeChange({ from: customRange?.from ?? range.from, to: event.target.value })
            }
          />
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Gasto: Meta Ads, {num(selectedAccounts.length)} conta(s)
        {lastSync
          ? `, última leitura em ${new Date(lastSync).toLocaleString("pt-BR")}`
          : ", aguardando a primeira leitura"}
        . Cadastros, FTD e depósitos: webhook da casa.
      </p>

      {/* AL0-06: sai quando a conferência da AL1 com a casa piloto for aceita. */}
      <div
        role="note"
        className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
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
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
        >
          <strong>Contas em outra moeda:</strong>{" "}
          {spendOther.map((row) => money(row.spend, row.currency)).join(" · ")}. Esse gasto fica
          fora do investido, do ROAS e do custo por FTD, que estão em reais.
        </div>
      )}

      {staleAccounts > 0 && (
        <div className="rounded-xl border border-red-500/40 bg-card/70 p-4 text-sm">
          <p className="flex items-center gap-2 font-semibold text-red-400">
            <AlertTriangle className="h-4 w-4" />A conta conectada ainda não está entregando gasto
          </p>
          <p className="mt-2 text-muted-foreground">
            O token pode estar válido, mas sem leitura recente para uma conta de anúncio. Enquanto
            isso o gasto dessa conta não entra, e o ROI aparece melhor do que é.
          </p>
        </div>
      )}

      {orphanRows.length > 0 && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/15 px-4 py-3 text-sm text-amber-100">
          <strong>
            {num(totals?.orphanPlayers)} cadastros marcados sem anúncio correspondente nas contas
            conectadas
          </strong>
          : {brl(orphanRevenue)} de depósitos e {num(orphanFtd)} FTD sem gasto importado. Veja os
          detalhes na aba Diagnóstico.
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
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
          title="Custo por FTD"
          value={totals?.cpaFtd == null ? "-" : brl2(totals.cpaFtd)}
          detail={`${num(totals?.paidFtd)} FTD de anúncio · ${num(totals?.ftd)} na casa`}
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
        />
      </div>

      <div className="rounded-lg bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        <strong className="text-foreground">{brl(totals?.ftdRevenue)}</strong> em{" "}
        {num(totals?.paidFtd)} primeiros depósitos
        <span className="px-2">+</span>
        <strong className="text-foreground">{brl(totals?.redepositRevenue)}</strong> de redepósito
        <span className="px-2">−</span>
        <strong className="text-foreground">{brl(totals?.withdrawals)}</strong> de saques
        <span className="px-2">=</span>
        <strong className="text-emerald-400">{brl(totals?.net)}</strong> líquidos
        <span className="px-2">÷</span>
        <strong className="text-foreground">{brl(totals?.spend)}</strong> investidos
        <span className="px-2">=</span>
        <strong className="text-emerald-400">{ratio(totals?.roas)}</strong>
        <span className="float-right hidden text-muted-foreground lg:inline">
          jogadores cadastrados no período por anúncio · horário de Brasília
        </span>
      </div>

      <Tabs value={reportView} onValueChange={(value) => setReportView(value as typeof reportView)}>
        <TabsList className="app-scrollbar h-auto max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="creatives">Criativos</TabsTrigger>
          <TabsTrigger value="audiences">Públicos</TabsTrigger>
          <TabsTrigger value="campaigns">Campanhas</TabsTrigger>
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
            color="#f59e0b"
            formatter={brl}
          />
          <DailyChart
            title="FTD de anúncio por dia"
            subtitle={`${range.days} dias`}
            data={data?.daily ?? []}
            dataKey="ftd"
            color="#22c55e"
            formatter={num}
          />
          <MoneyMapCard rows={data?.moneyMap ?? []} />
        </div>
      )}
      {reportView === "diagnostics" && (
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

function ConfiguracaoSection({
  meta,
  metaSummary,
  houseUrl,
  utmParams,
  fullUrl,
  onConnectMetaToken,
  connectTokenPending,
  onSaveMetaSelection,
  selectionPending,
  onValidateMeta,
  validatingConnectionId,
  onDisconnectMeta,
  disconnectPending,
  onHouseUrlChange,
  onCopy,
}: {
  meta: MarketingIntegration | undefined;
  metaSummary: MetaSummary | undefined;
  houseUrl: string;
  utmParams: string;
  fullUrl: string;
  onConnectMetaToken: (token: string) => Promise<unknown>;
  connectTokenPending: boolean;
  onSaveMetaSelection: (accountIds: string[]) => Promise<unknown>;
  selectionPending: boolean;
  onValidateMeta: (connectionId: string) => Promise<unknown>;
  validatingConnectionId: string | null;
  onDisconnectMeta: (connectionId: string) => Promise<unknown>;
  disconnectPending: boolean;
  onHouseUrlChange: (value: string) => void;
  onCopy: (value: string, label?: string) => void;
}) {
  return (
    <div className="space-y-5">
      <MetaConnectionWizard
        meta={meta}
        summary={metaSummary}
        onConnect={onConnectMetaToken}
        connectPending={connectTokenPending}
        onSaveSelection={onSaveMetaSelection}
        selectionPending={selectionPending}
        onValidate={onValidateMeta}
        validatingConnectionId={validatingConnectionId}
        onDisconnect={onDisconnectMeta}
        disconnectPending={disconnectPending}
      />

      <DataCard
        title="Montar marcação"
        description="Copie os parâmetros para os anúncios do Facebook e Instagram."
        icon={<Link2 className="h-4 w-4" />}
      >
        <div className="space-y-2">
          <Label htmlFor="house-url">Link da casa</Label>
          <Input
            id="house-url"
            type="url"
            placeholder="https://sua-casa.com/cadastro"
            value={houseUrl}
            onChange={(e) => onHouseUrlChange(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            O <code>utm_id</code> leva o ID do anúncio. É ele que liga cada cadastro ao anúncio
            certo, mesmo quando dois anúncios têm o mesmo nome.
          </p>
        </div>
        <div className="mt-5 space-y-4">
          <CopyBlock title="Parâmetros de URL" value={utmParams} onCopy={() => onCopy(utmParams)} />
          <CopyBlock title="Link completo" value={fullUrl} onCopy={() => onCopy(fullUrl)} />
        </div>
      </DataCard>
    </div>
  );
}

function MetaConnectionWizard({
  meta,
  summary,
  onConnect,
  connectPending,
  onSaveSelection,
  selectionPending,
  onValidate,
  validatingConnectionId,
  onDisconnect,
  disconnectPending,
}: {
  meta: MarketingIntegration | undefined;
  summary: MetaSummary | undefined;
  onConnect: (token: string) => Promise<unknown>;
  connectPending: boolean;
  onSaveSelection: (accountIds: string[]) => Promise<unknown>;
  selectionPending: boolean;
  onValidate: (connectionId: string) => Promise<unknown>;
  validatingConnectionId: string | null;
  onDisconnect: (connectionId: string) => Promise<unknown>;
  disconnectPending: boolean;
}) {
  const isDemo = useIsDemoTenant();
  const connections = useMemo(() => summary?.connections ?? [], [summary?.connections]);
  const activeConnectionIds = useMemo(
    () => new Set(connections.map((item) => item.id)),
    [connections],
  );
  const accounts = useMemo(
    () =>
      (summary?.accounts ?? []).filter((account) => activeConnectionIds.has(account.connection_id)),
    [summary?.accounts, activeConnectionIds],
  );
  const [token, setToken] = useState("");
  const [showGuide, setShowGuide] = useState(connections.length === 0);
  const [showTokenForm, setShowTokenForm] = useState(connections.length === 0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [disconnectId, setDisconnectId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedIds(accounts.filter((account) => account.selected).map((account) => account.id));
  }, [accounts]);

  useEffect(() => {
    if (connections.length === 0) setShowTokenForm(true);
  }, [connections.length]);

  const persistedSelectedCount = accounts.filter((account) => account.selected).length;
  const legacyConnections = connections.filter(
    (connection) => connection.auth_type === "legacy_oauth",
  );
  const currentStep = connections.length === 0 ? 1 : persistedSelectedCount === 0 ? 2 : 3;
  const connectionStatus = connections.some((connection) => connection.status === "error")
    ? "error"
    : connections.length > 0
      ? "connected"
      : meta?.status;

  return (
    <DataCard
      title="Meta Ads"
      description="Conecte sua conta, escolha o que deseja acompanhar e valide o acesso."
      icon={<Target className="h-4 w-4" />}
      actions={<StatusBadge status={connectionStatus} />}
    >
      <div className="mb-5 grid gap-2 sm:grid-cols-3">
        {["Conectar", "Escolher contas", "Validar acesso"].map((label, index) => {
          const step = index + 1;
          const complete = step < currentStep;
          const active = step === currentStep;
          return (
            <div
              key={label}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                active && "border-primary/60 bg-primary/10",
                complete && "border-emerald-500/30 bg-emerald-500/10",
              )}
            >
              <span
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-bold",
                  active && "bg-primary text-primary-foreground",
                  complete && "bg-emerald-500/20 text-emerald-400",
                )}
              >
                {complete ? <CheckCircle2 className="h-4 w-4" /> : step}
              </span>
              <span className={cn("font-medium", !active && !complete && "text-muted-foreground")}>
                {label}
              </span>
            </div>
          );
        })}
      </div>

      <Button variant="outline" size="sm" onClick={() => setShowGuide((value) => !value)}>
        {showGuide ? "Esconder preparação" : "Como preparar a conta"}
      </Button>
      {legacyConnections.length > 0 && (
        <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
          <p className="font-semibold text-amber-300">Conexão antiga precisa ser substituída</p>
          <p className="mt-1 text-muted-foreground">
            A integração anterior usava o app compartilhado da plataforma. Gere um token no app da
            sua operação e conecte abaixo; os dados já importados serão preservados.
          </p>
        </div>
      )}
      {showGuide && (
        <div className="mt-3 grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
          {[
            "Abra as Configurações do negócio no Business Manager.",
            "Crie um Usuário do Sistema para esta operação.",
            "Atribua somente as contas de anúncio necessárias.",
            "Gere um token no app da operação com ads_read.",
          ].map((step, index) => (
            <div key={step} className="flex gap-2 rounded-lg bg-muted/40 p-3">
              <span className="font-bold text-primary">{index + 1}</span>
              <span>{step}</span>
            </div>
          ))}
        </div>
      )}

      {(showTokenForm || connections.length === 0) && (
        <div className="mt-5 rounded-xl border border-border/60 bg-background/40 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold">
                {connections.length ? "Atualizar credencial" : "Conectar sua conta Meta"}
              </p>
              <p className="text-xs text-muted-foreground">
                O token é criptografado no servidor e não volta a aparecer.
              </p>
            </div>
            {connections.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowTokenForm(false);
                  setToken("");
                }}
              >
                Cancelar
              </Button>
            )}
          </div>
          <Label className="mt-4 block" htmlFor="meta-system-token">
            Token do Usuário do Sistema
          </Label>
          <Input
            id="meta-system-token"
            className="mt-2"
            type="password"
            autoComplete="off"
            placeholder="EAAG..."
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <DemoDisabledTooltip active={isDemo}>
            <Button
              className="mt-3 gap-2"
              disabled={isDemo || connectPending || token.trim().length < 40}
              onClick={async () => {
                try {
                  await onConnect(token.trim());
                  setToken("");
                  setShowTokenForm(false);
                } catch {
                  // A mensagem de erro é exibida pela mutation; mantenha o token para nova tentativa.
                }
              }}
            >
              {connectPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              Validar token e buscar contas
            </Button>
          </DemoDisabledTooltip>
        </div>
      )}

      {connections.length > 0 && !showTokenForm && (
        <div className="mt-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-semibold">Conexões encontradas</p>
              <p className="text-xs text-muted-foreground">
                Revise a origem antes de escolher as contas de anúncio.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setShowTokenForm(true)}>
              Atualizar token
            </Button>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {connections.map((connection) => (
              <div
                key={connection.id}
                className={cn(
                  "rounded-xl border p-4",
                  connection.status === "error"
                    ? "border-rose-500/30 bg-rose-500/5"
                    : "border-border/60 bg-background/40",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">
                      {connection.connection_label ?? connection.app_name ?? "Conta Meta"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      App {connection.app_name ?? connection.app_id ?? "identificado"} · token{" "}
                      {connection.token_hint ?? "protegido"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Usuário: {connection.meta_user_name ?? "Usuário do Sistema"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {connection.auth_type === "system_user_token"
                        ? "App próprio da operação"
                        : "Conexão antiga do app compartilhado"}
                    </p>
                  </div>
                  <StatusBadge status={connection.status} />
                </div>
                {connection.last_error && (
                  <p className="mt-3 rounded-md bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                    {connection.last_error}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <DemoDisabledTooltip active={isDemo}>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      disabled={isDemo || validatingConnectionId === connection.id}
                      onClick={() => onValidate(connection.id)}
                    >
                      {validatingConnectionId === connection.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}{" "}
                      Testar acesso
                    </Button>
                  </DemoDisabledTooltip>
                  <DemoDisabledTooltip active={isDemo}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-2 text-rose-400 hover:text-rose-300"
                      disabled={isDemo}
                      onClick={() => setDisconnectId(connection.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Desconectar
                    </Button>
                  </DemoDisabledTooltip>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-border/60 bg-background/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold">Contas que entram nos relatórios</p>
                <p className="text-xs text-muted-foreground">
                  Somente as contas marcadas serão sincronizadas.
                </p>
              </div>
              <span className="text-sm font-semibold text-primary">
                {selectedIds.length} de {accounts.length} selecionadas
              </span>
            </div>
            <div className="app-scrollbar mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
              {accounts.map((account) => (
                <label
                  key={account.id}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border border-border/50 px-3 py-3 hover:bg-muted/30"
                >
                  <Checkbox
                    checked={selectedIds.includes(account.id)}
                    onCheckedChange={(checked) =>
                      setSelectedIds((current) =>
                        checked
                          ? [...current, account.id]
                          : current.filter((id) => id !== account.id),
                      )
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">
                      {account.name ?? account.account_id}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {account.meta_ad_account_id}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">{account.currency ?? ""}</span>
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px]",
                      account.sync_status === "healthy" && "border-emerald-500/30 text-emerald-400",
                      account.sync_status === "warning" && "border-amber-500/30 text-amber-300",
                      account.sync_status === "error" && "border-rose-500/30 text-rose-300",
                    )}
                    title={account.last_error ?? undefined}
                  >
                    {account.sync_status === "healthy"
                      ? "dados atualizados"
                      : account.sync_status === "syncing"
                        ? "sincronizando"
                        : account.sync_status === "queued"
                          ? "aguardando"
                          : account.sync_status === "error"
                            ? "erro"
                            : account.sync_status === "warning"
                              ? "atenção"
                              : "sem leitura"}
                  </Badge>
                </label>
              ))}
              {accounts.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Nenhuma conta de anúncio foi encontrada.
                </p>
              )}
            </div>
            <div className="mt-4 flex justify-end">
              <DemoDisabledTooltip active={isDemo}>
                <Button
                  disabled={isDemo || selectionPending || accounts.length === 0}
                  onClick={() => onSaveSelection(selectedIds)}
                >
                  {selectionPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Salvar
                  contas
                </Button>
              </DemoDisabledTooltip>
            </div>
          </div>
        </div>
      )}

      <AlertDialog
        open={Boolean(disconnectId)}
        onOpenChange={(open) => !open && !disconnectPending && setDisconnectId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desconectar esta conta Meta?</AlertDialogTitle>
            <AlertDialogDescription>
              O token armazenado será removido e as contas vinculadas deixarão de sincronizar. Os
              relatórios já importados serão preservados.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnectPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={disconnectPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async (event) => {
                event.preventDefault();
                if (!disconnectId) return;
                try {
                  await onDisconnect(disconnectId);
                  setDisconnectId(null);
                } catch {
                  // O diálogo permanece aberto e a mutation informa o erro.
                }
              }}
            >
              {disconnectPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Desconectar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DataCard>
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
        "border-border/60 text-[10px]",
        matched && "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
        orphan && "border-amber-500/30 bg-amber-500/10 text-amber-300",
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
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" opacity={0.45} />
          <XAxis
            dataKey="label"
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(value) => formatter(Number(value))}
            width={58}
          />
          <Tooltip
            cursor={{ stroke: color, strokeOpacity: 0.35 }}
            contentStyle={{
              background: "hsl(var(--popover))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 8,
              color: "hsl(var(--popover-foreground))",
            }}
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
      description="Participação nos depósitos do período (FTD e redepósito), por anúncio"
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
      <TableHead className="text-right">FTD</TableHead>
      <TableHead className="text-right">Custo por FTD</TableHead>
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
              <TableHead className="text-right">FTD</TableHead>
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
                  <TableHead className="text-right">FTD</TableHead>
                  <TableHead className="text-right">Custo por FTD</TableHead>
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
          <p className="text-sm text-muted-foreground">
            Gasto, impressões e cliques vêm da Meta. Cadastros, FTD e depósitos vêm do webhook da
            casa, só de jogadores cadastrados no período que foram ligados a este anúncio. Jogadores
            ligados só à campanha aparecem na aba Campanhas.
          </p>
        </div>
      )}
    </DataCard>
  );
}
