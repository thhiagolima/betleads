import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  BadgeCheck,
  BarChart3,
  Calendar,
  Clipboard,
  CreditCard,
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
  Wallet,
} from "lucide-react";
import { useMemo, useState } from "react";
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
import { Label } from "@/components/ui/label";
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
import { getMarketingOverview, saveMarketingIntegration } from "@/lib/marketing.functions";
import {
  createMetaOAuthUrl,
  getMetaConnectionSummary,
  syncMetaInsights,
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
  period: { from: string; to: string };
  totals: MarketingTotals;
  campaigns: CampaignRow[];
  creatives: CreativeRow[];
  audiences: AudienceRow[];
  daily: DailyPoint[];
  moneyMap: MoneyRow[];
  orphanAttributions: OrphanAttributionRow[];
};

type MetaAccount = {
  id: string;
  meta_ad_account_id: string;
  account_id: string | null;
  name: string | null;
  currency: string | null;
  selected: boolean | null;
  last_sync_at: string | null;
};

type MetaSummary = {
  accounts: MetaAccount[];
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

function MediaLtvPage() {
  const qc = useQueryClient();
  const fetchOverview = useServerFn(getMarketingOverview);
  const saveIntegration = useServerFn(saveMarketingIntegration);
  const createMetaUrl = useServerFn(createMetaOAuthUrl);
  const fetchMetaSummary = useServerFn(getMetaConnectionSummary);
  const syncMeta = useServerFn(syncMetaInsights);
  const [period, setPeriod] = useState<PeriodPreset>("7d");
  const [section, setSection] = useState<"visualizacao" | "configuracao">("visualizacao");
  const [platform, setPlatform] = useState<Platform>("meta");
  const [houseUrl, setHouseUrl] = useState("https://sua-casa.com/cadastro");
  const range = useMemo(() => periodRange(period), [period]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["marketing-overview", range.from, range.to],
    queryFn: () => fetchOverview({ data: { days: range.days, from: range.from, to: range.to } }),
    refetchInterval: 30000,
  });

  const { data: metaSummary } = useQuery({
    queryKey: ["meta-connection-summary"],
    queryFn: () => fetchMetaSummary(),
    refetchInterval: 30000,
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

  const connectMetaMutation = useMutation({
    mutationFn: () => createMetaUrl({ data: { returnTo: "/midia-ltv" } }),
    onSuccess: (res) => {
      window.location.assign(res.url);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao iniciar OAuth Meta"),
  });

  const syncMetaMutation = useMutation({
    mutationFn: () => syncMeta({ data: { days: range.days } }),
    onSuccess: (res) => {
      if (res.errors.length > 0) {
        toast.warning(
          `${num(res.imported)} linhas importadas; ${res.errors.length} conta(s) com erro`,
        );
      } else {
        toast.success(`${num(res.imported)} linhas de midia importadas`);
      }
      qc.invalidateQueries({ queryKey: ["marketing-overview"] });
      qc.invalidateQueries({ queryKey: ["meta-connection-summary"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao sincronizar Meta"),
  });

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
          onPeriodChange={setPeriod}
          data={data}
          isLoading={isLoading}
          metaSummary={metaSummary}
          syncPending={syncMetaMutation.isPending}
          onSync={() => syncMetaMutation.mutate()}
        />
      ) : (
        <ConfiguracaoSection
          meta={meta}
          windsor={windsor}
          csv={csv}
          metaSummary={metaSummary}
          connectPending={connectMetaMutation.isPending}
          savePending={saveMutation.isPending}
          platform={platform}
          houseUrl={houseUrl}
          utmParams={utmParams}
          fullUrl={fullUrl}
          onConnectMeta={() => connectMetaMutation.mutate()}
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
  return (
    <div className="rounded-xl border border-border/60 bg-card/70 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {title}
        </p>
        {tone === "success" ? (
          <Wallet className="h-4 w-4 text-emerald-400" />
        ) : tone === "info" ? (
          <Target className="h-4 w-4 text-sky-300" />
        ) : (
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
        )}
      </div>
      <p className="mt-3 text-2xl font-bold">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
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
  onPeriodChange,
  data,
  isLoading,
  metaSummary,
  syncPending,
  onSync,
}: {
  range: { from: string; to: string; days: number };
  period: PeriodPreset;
  onPeriodChange: (period: PeriodPreset) => void;
  data: MarketingOverview | undefined;
  isLoading: boolean;
  metaSummary: MetaSummary | undefined;
  syncPending: boolean;
  onSync: () => void;
}) {
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
          {syncPending ? "lendo a conta..." : "Atualizar agora"}
        </Button>
        <span className="inline-flex items-center gap-2 rounded-md border border-border/70 bg-muted/50 px-3 py-2 text-sm font-semibold text-muted-foreground">
          <CreditCard className="h-4 w-4" />
          6.499 créditos de SMS
        </span>
      </div>

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
        <Button variant="outline" className="h-11 gap-2">
          <Calendar className="h-4 w-4" />
          Escolher datas
        </Button>
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

      <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <CreativeTable creatives={data?.creatives ?? []} isLoading={isLoading} />
        <div className="space-y-4">
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
      </div>

      <AudienceTable rows={data?.audiences ?? []} isLoading={isLoading} />
      <CampaignTable
        campaigns={data?.campaigns ?? []}
        isLoading={isLoading}
        orphanRevenue={orphanRevenue}
      />
      <OrphanAttributionTable rows={orphanRows} isLoading={isLoading} />
    </div>
  );
}

function ConfiguracaoSection({
  meta,
  windsor,
  csv,
  metaSummary,
  connectPending,
  savePending,
  platform,
  houseUrl,
  utmParams,
  fullUrl,
  onConnectMeta,
  onSaveProvider,
  onPlatformChange,
  onHouseUrlChange,
  onCopy,
}: {
  meta: MarketingIntegration | undefined;
  windsor: MarketingIntegration | undefined;
  csv: MarketingIntegration | undefined;
  metaSummary: MetaSummary | undefined;
  connectPending: boolean;
  savePending: boolean;
  platform: Platform;
  houseUrl: string;
  utmParams: string;
  fullUrl: string;
  onConnectMeta: () => void;
  onSaveProvider: (provider: Provider) => void;
  onPlatformChange: (platform: Platform) => void;
  onHouseUrlChange: (value: string) => void;
  onCopy: (value: string, label?: string) => void;
}) {
  return (
    <div className="space-y-5">
      <div className="grid gap-4 xl:grid-cols-3">
        <DataCard
          title="Meta Ads"
          description="App proprio com OAuth e Marketing API."
          icon={<Target className="h-4 w-4" />}
          actions={
            <StatusBadge status={metaSummary?.accounts?.length ? "connected" : meta?.status} />
          }
        >
          <p className="mb-4 text-sm text-muted-foreground">
            Melhor caminho para produto proprio: cada tenant pode conectar varias contas de anuncio,
            e a leitura fica sob seu controle.
          </p>
          <Button className="w-full gap-2" onClick={onConnectMeta} disabled={connectPending}>
            {connectPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            Conectar Meta
          </Button>
          <ConnectedAccounts accounts={metaSummary?.accounts ?? []} />
        </DataCard>

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
            "Manter app Meta Business com OAuth server-side.",
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

function ConnectedAccounts({ accounts }: { accounts: MetaAccount[] }) {
  if (!accounts.length) {
    return <p className="mt-3 text-xs text-muted-foreground">Nenhuma conta conectada.</p>;
  }

  return (
    <div className="mt-4 space-y-2">
      <p className="text-xs text-muted-foreground">{accounts.length} conta(s) conectada(s)</p>
      {accounts.slice(0, 5).map((account) => (
        <div
          key={account.id}
          className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-background/40 px-3 py-2"
        >
          <span className="truncate text-xs font-semibold">
            {account.name ?? account.account_id}
          </span>
          <span className="text-[10px] text-muted-foreground">{account.currency ?? ""}</span>
        </div>
      ))}
    </div>
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
