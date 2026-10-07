import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  BadgeCheck,
  BarChart3,
  Calendar,
  CheckCircle2,
  Clipboard,
  Eye,
  ExternalLink,
  FileSpreadsheet,
  Image as ImageIcon,
  Link2,
  Loader2,
  Radio,
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
import { getMarketingOverview, saveMarketingIntegration } from "@/lib/marketing.functions";
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
    meta: [{ title: "Midia e LTV - BETLEADS" }],
  }),
  component: MediaLtvPage,
});

type Platform = "meta" | "google" | "tiktok" | "kwai";
type Provider = "meta" | "windsor" | "csv";

type MarketingIntegration = {
  provider: Provider;
  status: string;
};

type MarketingTotals = {
  spend: number;
  revenue: number;
  ftdRevenue: number;
  redepositRevenue: number;
  roas: number | null;
  players: number;
  markedPlayers: number;
  orphanPlayers: number;
  ftd: number;
  cpaFtd: number | null;
};

type CampaignRow = {
  campaign: string;
  campaign_id: string | null;
  match_status: string;
  spend: number;
  impressions: number;
  clicks: number;
  players: number;
  ftd: number;
  revenue: number;
  ftdRevenue: number;
  redepositRevenue: number;
};

type OrphanAttributionRow = {
  campaign: string;
  creative: string;
  adset: string | null;
  source: string | null;
  provider: string | null;
  players: number;
  ftd: number;
  revenue: number;
};

type CreativeRow = {
  creative: string;
  campaign: string | null;
  adset: string | null;
  ad_id: string | null;
  thumbnail_url: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  frequency: number | null;
  players: number;
  ftd: number;
  revenue: number;
  ftdRevenue: number;
  redepositRevenue: number;
};

type AudienceRow = {
  adset: string;
  spend: number;
  ads: number;
  impressions: number;
  clicks: number;
  players: number;
  ftd: number;
  revenue: number;
};

type DailyPoint = {
  date: string;
  label: string;
  spend: number;
  ftd: number;
};

type MoneyRow = {
  creative: string;
  campaign: string | null;
  thumbnail_url: string | null;
  revenue: number;
  share: number;
};

type MarketingOverview = {
  integrations: MarketingIntegration[];
  period: { from: string; to: string };
  totals: MarketingTotals;
  campaigns: CampaignRow[];
  creatives: CreativeRow[];
  audiences: AudienceRow[];
  daily: DailyPoint[];
  moneyMap: MoneyRow[];
  orphanAttributions: OrphanAttributionRow[];
  attributionHealth: {
    total: number;
    marked: number;
    matched: number;
    missingUtm: number;
    orphan: number;
    matchRate: number | null;
  };
};

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

const platformLabels: Record<Platform, string> = {
  meta: "Facebook / Instagram",
  google: "Google Ads",
  tiktok: "TikTok Ads",
  kwai: "Kwai",
};

const utmByPlatform: Record<Platform, string> = {
  meta: "utm_source={{site_source_name}}&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{adset.name}}&utm_id={{ad.id}}",
  google:
    "utm_source=google&utm_medium=paid&utm_campaign={campaignid}&utm_content={creative}&utm_term={adgroupid}&utm_id={creative}",
  tiktok:
    "__CAMPAIGN_NAME__=__CAMPAIGN_NAME__&utm_source=tiktok&utm_medium=paid&utm_campaign=__CAMPAIGN_NAME__&utm_content=__CID_NAME__&utm_id=__CID__",
  kwai: "utm_source=kwai&utm_medium=paid&utm_campaign=__CAMPAIGN_NAME__&utm_content=__CREATIVE_NAME__&utm_id=__CREATIVE_ID__",
};

type PeriodPreset = "today" | "yesterday" | "7d" | "30d" | "this_month" | "last_month";

const periodLabels: Record<PeriodPreset, string> = {
  today: "Hoje",
  yesterday: "Ontem",
  "7d": "7 dias",
  "30d": "30 dias",
  this_month: "Este mês",
  last_month: "Mês passado",
};

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function periodRange(preset: PeriodPreset) {
  const now = new Date();
  const from = new Date(now);
  const to = new Date(now);

  if (preset === "today") {
    return { from: isoDate(from), to: isoDate(to), days: 1 };
  }
  if (preset === "yesterday") {
    from.setDate(now.getDate() - 1);
    to.setDate(now.getDate() - 1);
    return { from: isoDate(from), to: isoDate(to), days: 1 };
  }
  if (preset === "30d") {
    from.setDate(now.getDate() - 29);
    return { from: isoDate(from), to: isoDate(to), days: 30 };
  }
  if (preset === "this_month") {
    from.setDate(1);
    return { from: isoDate(from), to: isoDate(to), days: Math.max(1, now.getDate()) };
  }
  if (preset === "last_month") {
    from.setMonth(now.getMonth() - 1, 1);
    to.setDate(0);
    const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000) + 1);
    return { from: isoDate(from), to: isoDate(to), days };
  }

  from.setDate(now.getDate() - 6);
  return { from: isoDate(from), to: isoDate(to), days: 7 };
}

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

function num(value: number | null | undefined) {
  return new Intl.NumberFormat("pt-BR").format(value ?? 0);
}

function ratio(value: number | null | undefined) {
  return value == null ? "-" : `${value.toFixed(2)}x`;
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
  const saveIntegration = useServerFn(saveMarketingIntegration);
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
  const [platform, setPlatform] = useState<Platform>("meta");
  const [houseUrl, setHouseUrl] = useState("https://sua-casa.com/cadastro");
  const range = useMemo(() => {
    if (!customRange) return periodRange(period);
    const days = Math.max(
      1,
      Math.round(
        (new Date(`${customRange.to}T00:00:00`).getTime() -
          new Date(`${customRange.from}T00:00:00`).getTime()) /
          86400000,
      ) + 1,
    );
    return { ...customRange, days };
  }, [period, customRange]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["marketing-overview", range.from, range.to],
    queryFn: async () =>
      (await fetchOverview({
        data: { days: range.days, from: range.from, to: range.to },
      })) as MarketingOverview,
    refetchInterval: 30000,
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

  const saveMutation = useMutation({
    mutationFn: (provider: Provider) =>
      saveIntegration({
        data: {
          provider,
          status: provider === "csv" ? "configured" : "planned",
          account_name:
            provider === "meta"
              ? "Meta Ads"
              : provider === "windsor"
                ? "Windsor.ai"
                : "Importacao CSV",
          external_account_id: provider,
          currency: "BRL",
          settings: {
            attribution: "utm_content_utm_id",
            source: provider,
          },
        },
      }),
    onSuccess: () => {
      toast.success("Configuracao salva");
      qc.invalidateQueries({ queryKey: ["marketing-overview"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao salvar"),
  });

  const connectMetaTokenMutation = useMutation({
    mutationFn: (accessToken: string) => connectMetaToken({ data: { accessToken } }),
    onSuccess: (result) => {
      toast.success(`${result.accounts.length} conta(s) Meta conectada(s)`);
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
  const windsor = integrations.find((i) => i.provider === "windsor");
  const csv = integrations.find((i) => i.provider === "csv");
  const utmParams = utmByPlatform[platform];
  const fullUrl = useMemo(() => appendParams(houseUrl, utmParams), [houseUrl, utmParams]);

  async function copy(text: string, label = "Copiado") {
    await navigator.clipboard.writeText(text);
    toast.success(label);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Midia e LTV"
        subtitle="Cada jogador carrega o criativo que o trouxe. Ai da para ver quem trouxe cadastro barato e quem trouxe dinheiro."
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
              Visualizacao
            </Button>
            <Button
              variant={section === "configuracao" ? "default" : "outline"}
              size="sm"
              className="gap-2"
              onClick={() => setSection("configuracao")}
            >
              <Settings className="h-3.5 w-3.5" />
              Configuracao
            </Button>
          </div>
        }
      />

      {error && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
          As tabelas de midia ainda nao existem neste Supabase. Rode as migrations e atualize a
          pagina.
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
          windsor={windsor}
          csv={csv}
          metaSummary={metaSummary}
          savePending={saveMutation.isPending}
          platform={platform}
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
          onSaveProvider={(provider) => saveMutation.mutate(provider)}
          onPlatformChange={setPlatform}
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
  const totalReturn = (totals?.ftdRevenue ?? 0) + (totals?.redepositRevenue ?? 0);
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
        <Button
          variant="outline"
          className="gap-2"
          disabled={syncPending || accounts.length === 0}
          onClick={onSync}
        >
          {syncPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          {syncPending ? "sincronização na fila" : "Atualizar agora"}
        </Button>
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
            max={isoDate(new Date())}
            onChange={(event) =>
              onCustomRangeChange({ from: customRange?.from ?? range.from, to: event.target.value })
            }
          />
        </div>
        <span className="ml-1 text-sm text-muted-foreground">
          só anúncios com rastreio da iFluxHub
        </span>
      </div>

      <p className="text-sm text-muted-foreground">
        gasto e FTD lidos de {num(selectedAccounts.length)} conta(s)
        {lastSync
          ? ` · última leitura ${new Date(lastSync).toLocaleString("pt-BR")}`
          : " · aguardando primeira leitura"}
      </p>

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
          <strong>{num(orphanRows.length)} criativos de conta de anúncio não conectada</strong> —{" "}
          {brl(orphanRevenue)} de receita e {num(orphanFtd)} FTD, sem gasto importado. Conecte em
          Integrações → Mídia paga.
        </div>
      )}

      <div className="rounded-lg bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        <strong>Saúde da medição</strong> — FTD:{" "}
        <strong className="text-foreground">pelo seu webhook</strong> — cadastro:{" "}
        <strong className="text-foreground">pela conta</strong> · LTV por criativo:{" "}
        <strong className="text-emerald-400">disponível.</strong>
      </div>

      <p className="text-sm text-muted-foreground">
        pela conta de anúncio <strong className="text-foreground">{num(totals?.ftd)} FTD</strong> ·{" "}
        <strong className="text-foreground">{num(totals?.players)} cadastros</strong> — pelo seu
        webhook <strong className="text-foreground">{num(totals?.ftd)} FTD</strong> ·{" "}
        <strong className="text-foreground">{num(totals?.markedPlayers)} cadastros</strong>. Os
        cartões usam <strong className="text-foreground">o seu webhook</strong> para o FTD e{" "}
        <strong className="text-foreground">a conta</strong> para o cadastro.
      </p>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <Kpi
          title="Investido no periodo"
          value={brl(totals?.spend)}
          detail={`${brl((totals?.spend ?? 0) / Math.max(1, range.days))} por dia, em média`}
        />
        <Kpi
          title="ROAS no periodo"
          value={ratio(totals?.roas)}
          detail={`investiu ${brl(totals?.spend)} · voltou ${brl(totalReturn)}`}
          tone="info"
        />
        <Kpi
          title="ROAS do FTD"
          value={ratio(
            (totals?.spend ?? 0) > 0 ? (totals?.ftdRevenue ?? 0) / (totals?.spend ?? 0) : null,
          )}
          detail={`${brl(totals?.ftdRevenue)} em primeiros depósitos`}
          tone="info"
        />
        <Kpi
          title="Custo por FTD"
          value={totals?.cpaFtd == null ? "-" : brl2(totals.cpaFtd)}
          detail={`${num(totals?.ftd)} primeiros depósitos no período`}
        />
        <Kpi
          title="Redepósito no periodo"
          value={brl(totals?.redepositRevenue)}
          detail="recompra somada no período"
          tone="success"
        />
      </div>

      <div className="rounded-lg bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        <strong className="text-foreground">{brl(totals?.ftdRevenue)}</strong> de {num(totals?.ftd)}{" "}
        primeiros depósitos
        <span className="px-2">+</span>
        <strong className="text-foreground">{brl(totals?.redepositRevenue)}</strong> de redepósito
        <span className="px-2">=</span>
        <strong className="text-emerald-400">{brl(totalReturn)}</strong> de volta
        <span className="px-2">÷</span>
        <strong className="text-foreground">{brl(totals?.spend)}</strong> investidos
        <span className="px-2">=</span>
        <strong className="text-emerald-400">{ratio(totals?.roas)}</strong>
        <span className="float-right hidden text-muted-foreground lg:inline">
          nos últimos {range.days} dias · só de quem chegou por anúncio marcado
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
        <CreativeTable creatives={data?.creatives ?? []} isLoading={isLoading} />
      )}
      {reportView === "audiences" && (
        <AudienceTable rows={data?.audiences ?? []} isLoading={isLoading} />
      )}
      {reportView === "campaigns" && (
        <CampaignTable
          campaigns={data?.campaigns ?? []}
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
            title="Primeiros depósitos (FTD) por dia"
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
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <Kpi title="Cadastros" value={num(data?.attributionHealth.total)} detail="no período" />
            <Kpi
              title="Com marcação"
              value={num(data?.attributionHealth.marked)}
              detail="receberam UTM ou ID"
            />
            <Kpi
              title="Identificados"
              value={num(data?.attributionHealth.matched)}
              detail={`${pct(data?.attributionHealth.matchRate)} dos marcados`}
              tone="success"
            />
            <Kpi
              title="Sem UTM"
              value={num(data?.attributionHealth.missingUtm)}
              detail="não permitem atribuição"
            />
            <Kpi
              title="Sem correspondência"
              value={num(data?.attributionHealth.orphan)}
              detail="marcação não encontrada na Meta"
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
  windsor,
  csv,
  metaSummary,
  savePending,
  platform,
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
  onSaveProvider,
  onPlatformChange,
  onHouseUrlChange,
  onCopy,
}: {
  meta: MarketingIntegration | undefined;
  windsor: MarketingIntegration | undefined;
  csv: MarketingIntegration | undefined;
  metaSummary: MetaSummary | undefined;
  savePending: boolean;
  platform: Platform;
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
  onSaveProvider: (provider: Provider) => void;
  onPlatformChange: (platform: Platform) => void;
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

      <div className="grid gap-4 xl:grid-cols-2">
        <DataCard
          title="Windsor.ai"
          description="Atalho para validar dados antes da revisao Meta."
          icon={<Radio className="h-4 w-4" />}
          actions={<StatusBadge status={windsor?.status} />}
        >
          <p className="mb-4 text-sm text-muted-foreground">
            Alternativa temporaria para conferir spend e criativos se a API propria travar por
            permissao ou revisao.
          </p>
          <Button
            variant="outline"
            className="w-full gap-2"
            disabled={savePending}
            onClick={() => onSaveProvider("windsor")}
          >
            <ExternalLink className="h-4 w-4" />
            Registrar estrategia Windsor
          </Button>
        </DataCard>

        <DataCard
          title="CSV"
          description="Fallback manual para comecar hoje."
          icon={<FileSpreadsheet className="h-4 w-4" />}
          actions={<StatusBadge status={csv?.status} />}
        >
          <p className="mb-4 text-sm text-muted-foreground">
            Serve para importar gasto por dia/anuncio enquanto a conexao automatica nao esta ligada.
          </p>
          <Button
            variant="outline"
            className="w-full gap-2"
            disabled={savePending}
            onClick={() => onSaveProvider("csv")}
          >
            <BadgeCheck className="h-4 w-4" />
            Ativar fallback CSV
          </Button>
        </DataCard>
      </div>

      <DataCard
        title="Montar marcacao"
        description="Copie os parametros para a plataforma de anuncios."
        icon={<Link2 className="h-4 w-4" />}
      >
        <div className="grid gap-3 lg:grid-cols-[1fr_300px]">
          <div className="space-y-2">
            <Label htmlFor="house-url">Link da casa</Label>
            <Input
              id="house-url"
              value={houseUrl}
              onChange={(e) => onHouseUrlChange(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Plataforma</Label>
            <Tabs value={platform} onValueChange={(value) => onPlatformChange(value as Platform)}>
              <TabsList className="grid w-full grid-cols-4">
                {(Object.keys(platformLabels) as Platform[]).map((key) => (
                  <TabsTrigger key={key} value={key}>
                    {key === "meta" ? "Facebook" : platformLabels[key].replace(" Ads", "")}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
        </div>
        <div className="mt-5 space-y-4">
          <CopyBlock title="Parametros de URL" value={utmParams} onCopy={() => onCopy(utmParams)} />
          <CopyBlock title="Link completo" value={fullUrl} onCopy={() => onCopy(fullUrl)} />
        </div>
      </DataCard>

      <DataCard
        title="Plano tecnico"
        description="Ordem recomendada para ligar Meta com seguranca."
        icon={<ShieldCheck className="h-4 w-4" />}
      >
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
          {[
            "Usar o app e o Usuário do Sistema da própria operação.",
            "Solicitar ads_read e business_management para contas de clientes.",
            "Salvar tokens apenas no servidor, com expiracao monitorada.",
            "Sincronizar campanhas/adsets/ads/insights por acao e job diario.",
            "Cruzar utm_id/utm_content dos players com gasto do anuncio.",
          ].map((step, index) => (
            <div
              key={step}
              className="rounded-lg border border-border/60 bg-background/40 p-3 text-sm"
            >
              <span className="mb-2 flex h-6 w-6 items-center justify-center rounded-md bg-primary/15 text-xs font-bold text-primary">
                {index + 1}
              </span>
              <p className="text-muted-foreground">{step}</p>
            </div>
          ))}
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
          <Button
            className="mt-3 gap-2"
            disabled={connectPending || token.trim().length < 40}
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
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    disabled={validatingConnectionId === connection.id}
                    onClick={() => onValidate(connection.id)}
                  >
                    {validatingConnectionId === connection.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}{" "}
                    Testar acesso
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-2 text-rose-400 hover:text-rose-300"
                    onClick={() => setDisconnectId(connection.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Desconectar
                  </Button>
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
              <Button
                disabled={selectionPending || accounts.length === 0}
                onClick={() => onSaveSelection(selectedIds)}
              >
                {selectionPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Salvar contas
              </Button>
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
  if (status === "matched_ad_id") return "anuncio";
  if (status === "matched_ad_name") return "criativo";
  if (status === "matched_campaign_name") return "campanha";
  if (status === "orphan_campaign") return "sem BM";
  if (status === "missing_utm") return "sem UTM";
  return "pendente";
}

function AttributionBadge({ status }: { status: string }) {
  const orphan = status === "orphan_campaign" || status === "missing_utm";
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
      description="Participação na receita do período (FTD + recompra), por anúncio"
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

function AudienceTable({ rows, isLoading }: { rows: AudienceRow[]; isLoading: boolean }) {
  const totals = rows.reduce(
    (acc, row) => ({
      spend: acc.spend + row.spend,
      ads: acc.ads + row.ads,
      impressions: acc.impressions + row.impressions,
      clicks: acc.clicks + row.clicks,
      ftd: acc.ftd + row.ftd,
      players: acc.players + row.players,
    }),
    { spend: 0, ads: 0, impressions: 0, clicks: 0, ftd: 0, players: 0 },
  );

  return (
    <DataCard
      title="Público por público"
      description="O que cada conjunto custou e quantos primeiros depósitos ele trouxe. É onde mora a segmentação — idade, posicionamento, interesse. Só conjuntos que investiram no período."
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
          description="Depois de sincronizar conjuntos de anúncio, eles aparecem aqui."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Público</TableHead>
              <TableHead className="text-right">Investido</TableHead>
              <TableHead className="text-right">Anúncios</TableHead>
              <TableHead className="text-right">Impressões</TableHead>
              <TableHead className="text-right">Cliques</TableHead>
              <TableHead className="text-right">FTD</TableHead>
              <TableHead className="text-right">Custo por FTD</TableHead>
              <TableHead className="text-right">Cadastros</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.adset}>
                <TableCell>{row.adset}</TableCell>
                <TableCell className="text-right font-medium">{brl(row.spend)}</TableCell>
                <TableCell className="text-right text-muted-foreground">{num(row.ads)}</TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {num(row.impressions)}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {num(row.clicks)}
                </TableCell>
                <TableCell className="text-right font-semibold">
                  {row.ftd > 0 ? num(row.ftd) : "—"}
                </TableCell>
                <TableCell className="text-right">
                  {row.ftd > 0 ? brl2(row.spend / row.ftd) : "—"}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {row.players > 0 ? num(row.players) : "—"}
                </TableCell>
              </TableRow>
            ))}
            <TableRow className="bg-muted/35 font-semibold">
              <TableCell>{num(rows.length)} públicos</TableCell>
              <TableCell className="text-right">{brl(totals.spend)}</TableCell>
              <TableCell className="text-right">{num(totals.ads)}</TableCell>
              <TableCell className="text-right">{num(totals.impressions)}</TableCell>
              <TableCell className="text-right">{num(totals.clicks)}</TableCell>
              <TableCell className="text-right">{num(totals.ftd)}</TableCell>
              <TableCell className="text-right">
                {totals.ftd > 0 ? brl2(totals.spend / totals.ftd) : "—"}
              </TableCell>
              <TableCell className="text-right">{num(totals.players)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )}
    </DataCard>
  );
}

function CampaignTable({
  campaigns,
  isLoading,
  orphanRevenue,
}: {
  campaigns: CampaignRow[];
  isLoading: boolean;
  orphanRevenue: number;
}) {
  const rows = campaigns.filter((row) => row.spend > 0 || row.players > 0);
  const totals = rows.reduce(
    (acc, row) => ({
      spend: acc.spend + row.spend,
      impressions: acc.impressions + row.impressions,
      clicks: acc.clicks + row.clicks,
      players: acc.players + row.players,
      ftd: acc.ftd + row.ftd,
      ftdRevenue: acc.ftdRevenue + row.ftdRevenue,
    }),
    { spend: 0, impressions: 0, clicks: 0, players: 0, ftd: 0, ftdRevenue: 0 },
  );
  const totalCtr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : null;
  const totalCpc = totals.clicks > 0 ? totals.spend / totals.clicks : null;
  const totalCpm = totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : null;

  return (
    <DataCard
      title="Campanha por campanha"
      description="O que cada campanha custou e o que ela devolveu — primeiro depósito e recompra do mesmo dia. Só campanhas que investiram no período."
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
          title={isLoading ? "Carregando campanhas" : "Sem campanhas sincronizadas"}
          description="Depois de sincronizar o Meta ou receber players com UTM, as campanhas aparecem aqui."
        />
      ) : (
        <div className="space-y-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campanha</TableHead>
                <TableHead className="text-right">Investido</TableHead>
                <TableHead className="text-right">Impressões</TableHead>
                <TableHead className="text-right">Cliques</TableHead>
                <TableHead className="text-right">CTR</TableHead>
                <TableHead className="text-right">CPC</TableHead>
                <TableHead className="text-right">CPM</TableHead>
                <TableHead className="text-right">Cadastros</TableHead>
                <TableHead className="text-right">CPA cadastro</TableHead>
                <TableHead className="text-right">FTD</TableHead>
                <TableHead className="text-right">Valor FTD</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const ctr = row.impressions > 0 ? (row.clicks / row.impressions) * 100 : null;
                const cpc = row.clicks > 0 ? row.spend / row.clicks : null;
                const cpm = row.impressions > 0 ? (row.spend / row.impressions) * 1000 : null;
                return (
                  <TableRow key={`${row.campaign_id ?? row.campaign}`}>
                    <TableCell>
                      <p className="font-semibold">{row.campaign}</p>
                      <p className="text-xs text-muted-foreground">
                        {num(row.players)} cadastros · {row.campaign_id ?? "sem id"}
                      </p>
                    </TableCell>
                    <TableCell className="text-right font-medium">{brl(row.spend)}</TableCell>
                    <TableCell className="text-right">{num(row.impressions)}</TableCell>
                    <TableCell className="text-right">{num(row.clicks)}</TableCell>
                    <TableCell className="text-right">{pct(ctr)}</TableCell>
                    <TableCell className="text-right">{cpc == null ? "—" : brl2(cpc)}</TableCell>
                    <TableCell className="text-right">{cpm == null ? "—" : brl2(cpm)}</TableCell>
                    <TableCell className="text-right">{num(row.players)}</TableCell>
                    <TableCell className="text-right">
                      {row.players > 0 ? brl2(row.spend / row.players) : "—"}
                    </TableCell>
                    <TableCell className="text-right font-semibold">{num(row.ftd)}</TableCell>
                    <TableCell className="text-right">
                      <p className="font-semibold">{brl(row.ftdRevenue)}</p>
                      <p className="text-xs text-muted-foreground">
                        {row.ftd > 0 ? `${brl(row.ftdRevenue / row.ftd)} por jogador` : "—"}
                      </p>
                    </TableCell>
                  </TableRow>
                );
              })}
              <TableRow className="bg-muted/35 font-semibold">
                <TableCell>
                  Total
                  <p className="text-xs font-normal text-muted-foreground">
                    {num(rows.length)} campanha(s)
                  </p>
                </TableCell>
                <TableCell className="text-right">{brl(totals.spend)}</TableCell>
                <TableCell className="text-right">{num(totals.impressions)}</TableCell>
                <TableCell className="text-right">{num(totals.clicks)}</TableCell>
                <TableCell className="text-right">{pct(totalCtr)}</TableCell>
                <TableCell className="text-right">
                  {totalCpc == null ? "—" : brl2(totalCpc)}
                </TableCell>
                <TableCell className="text-right">
                  {totalCpm == null ? "—" : brl2(totalCpm)}
                </TableCell>
                <TableCell className="text-right">{num(totals.players)}</TableCell>
                <TableCell className="text-right">
                  {totals.players > 0 ? brl2(totals.spend / totals.players) : "—"}
                </TableCell>
                <TableCell className="text-right">{num(totals.ftd)}</TableCell>
                <TableCell className="text-right">{brl(totals.ftdRevenue)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <p className="text-sm text-muted-foreground">
            ROAS é o total depositado dividido pelo investido. Sem a conta de anúncios conectada,
            {orphanRevenue > 0 ? ` ${brl(orphanRevenue)} continuam` : " a receita órfã continua"} no
            início e em Relatórios.investimento fica em zero e a coluna aparece como “—”: é receita,
            não retorno.
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
  return (
    <DataCard
      title="UTMs sem midia vinculada"
      description="Players que chegaram marcados, mas nao casaram com nenhuma campanha/anuncio das contas conectadas."
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
          title={isLoading ? "Conferindo atribuicoes" : "Nenhum orfao no periodo"}
          description="Quando uma UTM chegar de uma campanha fora das BMs conectadas, ela aparece aqui sem gerar ROAS artificial."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Campanha declarada</TableHead>
              <TableHead>Criativo</TableHead>
              <TableHead>Conjunto</TableHead>
              <TableHead>Origem</TableHead>
              <TableHead className="text-right">Players</TableHead>
              <TableHead className="text-right">FTD</TableHead>
              <TableHead className="text-right">Receita</TableHead>
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
                    <AttributionBadge status="orphan_campaign" />
                  </div>
                </TableCell>
                <TableCell className="text-right">{num(row.players)}</TableCell>
                <TableCell className="text-right">{num(row.ftd)}</TableCell>
                <TableCell className="text-right">{brl(row.revenue)}</TableCell>
                <TableCell className="text-right text-muted-foreground">nao encontrado</TableCell>
                <TableCell className="text-right text-muted-foreground">nao calculado</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </DataCard>
  );
}

function CreativeTable({ creatives, isLoading }: { creatives: CreativeRow[]; isLoading: boolean }) {
  const rows = creatives.filter((row) => row.spend > 0 || row.players > 0).slice(0, 75);
  const totals = rows.reduce(
    (acc, row) => ({
      spend: acc.spend + row.spend,
      impressions: acc.impressions + row.impressions,
      clicks: acc.clicks + row.clicks,
      frequencySum: acc.frequencySum + (row.frequency ?? 0),
      frequencyCount: acc.frequencyCount + (row.frequency ? 1 : 0),
    }),
    { spend: 0, impressions: 0, clicks: 0, frequencySum: 0, frequencyCount: 0 },
  );
  const totalCtr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : null;
  const totalCpc = totals.clicks > 0 ? totals.spend / totals.clicks : null;
  const totalCpm = totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : null;
  const totalFrequency =
    totals.frequencyCount > 0 ? totals.frequencySum / totals.frequencyCount : null;

  return (
    <DataCard
      title="Criativo por criativo"
      description="Ordenado pelo que devolve, não pelo que é barato"
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
          title={isLoading ? "Carregando criativos" : "Sem dados atribuidos"}
          description="Depois que players chegarem com UTM ou gasto for importado, a leitura por criativo aparece aqui."
        />
      ) : (
        <div className="space-y-3">
          <div className="max-h-[560px] overflow-auto pr-1">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Criativo</TableHead>
                  <TableHead className="text-right">Investido</TableHead>
                  <TableHead className="text-right">CTR</TableHead>
                  <TableHead className="text-right">CPC</TableHead>
                  <TableHead className="text-right">CPM</TableHead>
                  <TableHead className="text-right">Freq.</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const ctr = row.impressions > 0 ? (row.clicks / row.impressions) * 100 : null;
                  const cpc = row.clicks > 0 ? row.spend / row.clicks : null;
                  const cpm = row.impressions > 0 ? (row.spend / row.impressions) * 1000 : null;
                  return (
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
                      <TableCell className="text-right font-medium">{pct(ctr)}</TableCell>
                      <TableCell className="text-right">
                        <p>{cpc == null ? "—" : brl2(cpc)}</p>
                        <p className="text-xs text-muted-foreground">{num(row.clicks)} cliques</p>
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {cpm == null ? "—" : brl2(cpm)}
                      </TableCell>
                      <TableCell className="text-right text-amber-400">
                        {row.frequency == null ? "—" : row.frequency.toFixed(1)}
                      </TableCell>
                    </TableRow>
                  );
                })}
                <TableRow className="sticky bottom-0 bg-muted font-semibold">
                  <TableCell>Total · {num(rows.length)} criativos</TableCell>
                  <TableCell className="text-right">
                    <p>{brl(totals.spend)}</p>
                    <p className="text-xs font-normal text-muted-foreground">
                      {num(totals.impressions)} impressões
                    </p>
                  </TableCell>
                  <TableCell className="text-right">{pct(totalCtr)}</TableCell>
                  <TableCell className="text-right">
                    <p>{totalCpc == null ? "—" : brl2(totalCpc)}</p>
                    <p className="text-xs font-normal text-muted-foreground">
                      {num(totals.clicks)} cliques
                    </p>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {totalCpm == null ? "—" : brl2(totalCpm)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {totalFrequency == null ? "—" : totalFrequency.toFixed(1)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
          <p className="text-sm text-muted-foreground">
            {num(rows.length)} criativos no período, do que mais devolveu para o que menos devolveu
            — {brl(totals.spend)} investido no total. O FTD vem da conta de anúncio, para bater com
            o gerenciador.
          </p>
        </div>
      )}
    </DataCard>
  );
}
