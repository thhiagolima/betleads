import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  BadgeCheck,
  BarChart3,
  Clipboard,
  Eye,
  ExternalLink,
  FileSpreadsheet,
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
  roas: number | null;
  ftd: number;
  cpaFtd: number | null;
};

type CampaignRow = {
  campaign: string;
  campaign_id: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  players: number;
  ftd: number;
  revenue: number;
};

type CreativeRow = {
  creative: string;
  campaign: string | null;
  ad_id: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  players: number;
  ftd: number;
  revenue: number;
};

type MarketingOverview = {
  totals: MarketingTotals;
  campaigns: CampaignRow[];
  creatives: CreativeRow[];
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

function brl(value: number | null | undefined) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(value ?? 0);
}

function num(value: number | null | undefined) {
  return new Intl.NumberFormat("pt-BR").format(value ?? 0);
}

function ratio(value: number | null | undefined) {
  return value == null ? "-" : `${value.toFixed(2)}x`;
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
  const [days, setDays] = useState(7);
  const [section, setSection] = useState<"visualizacao" | "configuracao">("visualizacao");
  const [platform, setPlatform] = useState<Platform>("meta");
  const [houseUrl, setHouseUrl] = useState("https://sua-casa.com/cadastro");

  const { data, isLoading, error } = useQuery({
    queryKey: ["marketing-overview", days],
    queryFn: () => fetchOverview({ data: { days } }),
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
    mutationFn: () => syncMeta({ data: { days } }),
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
        subtitle="Conexao de anuncios, marcacao UTM e leitura de retorno por criativo."
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
            {[7, 30, 90].map((d) => (
              <Button
                key={d}
                variant={days === d ? "default" : "outline"}
                size="sm"
                onClick={() => setDays(d)}
              >
                {d} dias
              </Button>
            ))}
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
          days={days}
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
  days,
  data,
  isLoading,
  metaSummary,
  syncPending,
  onSync,
}: {
  days: number;
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

  return (
    <div className="space-y-5">
      <DataCard
        title="Leitura Meta"
        description="Contas conectadas e sincronizacao de campanhas, conjuntos, anuncios e gasto."
        icon={<Radio className="h-4 w-4" />}
        actions={
          <Button
            className="gap-2"
            onClick={onSync}
            disabled={syncPending || accounts.length === 0}
          >
            {syncPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Sincronizar Meta
          </Button>
        }
      >
        <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr]">
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {accounts.length > 0
                ? `${accounts.length} conta(s) conectada(s), ${selectedAccounts.length} selecionada(s) para leitura.`
                : "Nenhuma conta Meta conectada ainda."}
            </p>
            {lastSync && (
              <p className="text-xs text-muted-foreground">
                Ultima sincronizacao: {new Date(lastSync).toLocaleString("pt-BR")}
              </p>
            )}
            {accounts.length === 0 && (
              <p className="text-xs text-amber-300">
                Va em Configuracao para conectar o Facebook antes de importar campanhas.
              </p>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {accounts.slice(0, 4).map((account) => (
              <div
                key={account.id}
                className="rounded-lg border border-border/60 bg-background/40 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-semibold">
                    {account.name ?? account.account_id}
                  </p>
                  <StatusBadge status={account.selected === false ? "disabled" : "connected"} />
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {account.account_id ?? account.meta_ad_account_id} {account.currency ?? ""}
                </p>
              </div>
            ))}
          </div>
        </div>
      </DataCard>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Kpi title="Investido" value={brl(totals?.spend)} detail={`${days} dias`} />
        <Kpi
          title="Receita atribuida"
          value={brl(totals?.revenue)}
          detail="depositos dos players"
          tone="success"
        />
        <Kpi title="ROAS" value={ratio(totals?.roas)} detail="receita / midia" tone="info" />
        <Kpi
          title="CPA FTD"
          value={totals?.cpaFtd ? brl(totals.cpaFtd) : "-"}
          detail={`${num(totals?.ftd)} FTD`}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_1fr]">
        <CampaignTable campaigns={data?.campaigns ?? []} isLoading={isLoading} />
        <CreativeTable creatives={data?.creatives ?? []} isLoading={isLoading} />
      </div>
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

function CampaignTable({ campaigns, isLoading }: { campaigns: CampaignRow[]; isLoading: boolean }) {
  return (
    <DataCard
      title="Campanha por campanha"
      description="Gasto de midia cruzado com cadastros, FTD e receita atribuida."
      icon={<BarChart3 className="h-4 w-4" />}
      bodyClassName="overflow-x-auto"
    >
      {campaigns.length === 0 ? (
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Campanha</TableHead>
              <TableHead className="text-right">Investido</TableHead>
              <TableHead className="text-right">Impressoes</TableHead>
              <TableHead className="text-right">Cliques</TableHead>
              <TableHead className="text-right">Players</TableHead>
              <TableHead className="text-right">FTD</TableHead>
              <TableHead className="text-right">Receita</TableHead>
              <TableHead className="text-right">ROAS</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.map((row) => (
              <TableRow key={`${row.campaign_id ?? row.campaign}`}>
                <TableCell>
                  <p className="font-semibold">{row.campaign}</p>
                  {row.campaign_id && (
                    <p className="text-xs text-muted-foreground">{row.campaign_id}</p>
                  )}
                </TableCell>
                <TableCell className="text-right">{brl(row.spend)}</TableCell>
                <TableCell className="text-right">{num(row.impressions)}</TableCell>
                <TableCell className="text-right">{num(row.clicks)}</TableCell>
                <TableCell className="text-right">{num(row.players)}</TableCell>
                <TableCell className="text-right">{num(row.ftd)}</TableCell>
                <TableCell className="text-right">{brl(row.revenue)}</TableCell>
                <TableCell className="text-right">
                  {ratio(row.spend > 0 ? row.revenue / row.spend : null)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </DataCard>
  );
}

function CreativeTable({ creatives, isLoading }: { creatives: CreativeRow[]; isLoading: boolean }) {
  return (
    <DataCard
      title="Criativo por criativo"
      description="Une gasto de midia com players criados pela marcacao UTM."
      icon={<Target className="h-4 w-4" />}
      bodyClassName="overflow-x-auto"
    >
      {creatives.length === 0 ? (
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Criativo</TableHead>
              <TableHead className="text-right">Investido</TableHead>
              <TableHead className="text-right">CTR</TableHead>
              <TableHead className="text-right">CPC</TableHead>
              <TableHead className="text-right">Players</TableHead>
              <TableHead className="text-right">FTD</TableHead>
              <TableHead className="text-right">Receita</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {creatives.map((row) => {
              const ctr = row.impressions > 0 ? (row.clicks / row.impressions) * 100 : null;
              const cpc = row.clicks > 0 ? row.spend / row.clicks : null;
              return (
                <TableRow key={`${row.ad_id ?? row.creative}`}>
                  <TableCell>
                    <p className="font-semibold">{row.creative}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.campaign ?? "Sem campanha"}
                    </p>
                  </TableCell>
                  <TableCell className="text-right">{brl(row.spend)}</TableCell>
                  <TableCell className="text-right">
                    {ctr == null ? "-" : `${ctr.toFixed(2)}%`}
                  </TableCell>
                  <TableCell className="text-right">{cpc == null ? "-" : brl(cpc)}</TableCell>
                  <TableCell className="text-right">{num(row.players)}</TableCell>
                  <TableCell className="text-right">{num(row.ftd)}</TableCell>
                  <TableCell className="text-right">{brl(row.revenue)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </DataCard>
  );
}
