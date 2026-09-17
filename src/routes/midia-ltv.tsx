import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  BadgeCheck,
  BarChart3,
  Clipboard,
  ExternalLink,
  FileSpreadsheet,
  Link2,
  Loader2,
  Radio,
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
import { createMetaOAuthUrl, getMetaConnectionSummary } from "@/lib/meta.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/midia-ltv")({
  head: () => ({
    meta: [{ title: "Midia e LTV - BETLEADS" }],
  }),
  component: MediaLtvPage,
});

type Platform = "meta" | "google" | "tiktok" | "kwai";

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
  const [days, setDays] = useState(7);
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
    mutationFn: (provider: "meta" | "windsor" | "csv") =>
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

      <div className="grid gap-4 lg:grid-cols-3">
        <DataCard
          title="Meta Ads"
          description="App proprio com OAuth e Marketing API"
          icon={<Target className="h-4 w-4" />}
          actions={<StatusBadge status={meta?.status} />}
        >
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Melhor caminho para produto proprio: controle de contas, permissoes e sincronizacao
              diaria sem depender de planilha.
            </p>
            <Button
              className="w-full gap-2"
              onClick={() => connectMetaMutation.mutate()}
              disabled={connectMetaMutation.isPending}
            >
              {connectMetaMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              Conectar Meta
            </Button>
            {metaSummary?.accounts?.length ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground">
                  {num(metaSummary.accounts.length)} conta(s) conectada(s)
                </p>
                <div className="space-y-1.5">
                  {metaSummary.accounts.slice(0, 3).map((account) => (
                    <div
                      key={account.id}
                      className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-background/40 px-3 py-2"
                    >
                      <span className="truncate text-xs font-medium">
                        {account.name ?? account.meta_ad_account_id}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {account.currency ?? "BRL"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </DataCard>

        <DataCard
          title="Windsor.ai"
          description="Atalho para validar dados antes do app Meta"
          icon={<Radio className="h-4 w-4" />}
          actions={<StatusBadge status={windsor?.status} />}
        >
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Boa alternativa temporaria para puxar spend e criativos enquanto o app Meta passa por
              permissao e revisao.
            </p>
            <Button
              variant="outline"
              className="w-full gap-2"
              onClick={() => saveMutation.mutate("windsor")}
              disabled={saveMutation.isPending}
            >
              <ExternalLink className="h-4 w-4" />
              Registrar estrategia Windsor
            </Button>
          </div>
        </DataCard>

        <DataCard
          title="CSV"
          description="Fallback manual para comecar hoje"
          icon={<FileSpreadsheet className="h-4 w-4" />}
          actions={<StatusBadge status={csv?.status} />}
        >
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Serve para importar gasto por dia/anuncio enquanto a conexao automatica nao esta
              ligada.
            </p>
            <Button
              variant="outline"
              className="w-full gap-2"
              onClick={() => saveMutation.mutate("csv")}
              disabled={saveMutation.isPending}
            >
              <BadgeCheck className="h-4 w-4" />
              Ativar fallback CSV
            </Button>
          </div>
        </DataCard>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Kpi title="Investido" value={brl(data?.totals.spend)} detail={`${days} dias`} />
        <Kpi
          title="Receita atribuida"
          value={brl(data?.totals.revenue)}
          detail="depositos dos players"
          tone="success"
        />
        <Kpi title="ROAS" value={ratio(data?.totals.roas)} detail="receita / midia" tone="info" />
        <Kpi
          title="CPA FTD"
          value={data?.totals.cpaFtd ? brl(data.totals.cpaFtd) : "-"}
          detail={`${num(data?.totals.ftd)} FTD`}
        />
      </div>

      <DataCard
        title="Montar marcacao"
        description="Copie os parametros para a plataforma de anuncios."
        icon={<Link2 className="h-4 w-4" />}
      >
        <div className="space-y-5">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(240px,360px)]">
            <div>
              <Label>Link da casa</Label>
              <Input
                value={houseUrl}
                onChange={(e) => setHouseUrl(e.target.value)}
                className="mt-2 bg-background/60"
              />
            </div>
            <div>
              <Label>Plataforma</Label>
              <Tabs
                value={platform}
                onValueChange={(v) => setPlatform(v as Platform)}
                className="mt-2"
              >
                <TabsList className="grid h-auto w-full grid-cols-2 gap-1 lg:grid-cols-4">
                  {(Object.keys(platformLabels) as Platform[]).map((p) => (
                    <TabsTrigger key={p} value={p} className="text-xs">
                      {platformLabels[p].split(" ")[0]}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
          </div>

          <CopyBlock
            title="Parametros de URL"
            value={utmParams}
            onCopy={() => copy(utmParams, "Parametros copiados")}
          />
          <CopyBlock
            title="Link completo"
            value={fullUrl}
            onCopy={() => copy(fullUrl, "Link copiado")}
          />
        </div>
      </DataCard>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.55fr)]">
        <DataCard
          title="Criativo por criativo"
          description="Une gasto de midia com players criados pela marcacao UTM."
          icon={<BarChart3 className="h-4 w-4" />}
          bodyClassName="p-0"
        >
          {isLoading ? (
            <div className="p-5 text-sm text-muted-foreground">Carregando metricas...</div>
          ) : data?.creatives.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Criativo</TableHead>
                  <TableHead className="text-right">Investido</TableHead>
                  <TableHead className="text-right">Players</TableHead>
                  <TableHead className="text-right">FTD</TableHead>
                  <TableHead className="text-right">Receita</TableHead>
                  <TableHead className="text-right">ROAS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.creatives.map((row) => {
                  const roas = row.spend > 0 ? row.revenue / row.spend : null;
                  return (
                    <TableRow key={`${row.creative}-${row.ad_id ?? ""}`}>
                      <TableCell>
                        <div className="min-w-0">
                          <p className="font-medium">{row.creative}</p>
                          <p className="text-xs text-muted-foreground">
                            {row.campaign ?? "sem campanha"} {row.ad_id ? `- ${row.ad_id}` : ""}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">{brl(row.spend)}</TableCell>
                      <TableCell className="text-right">{num(row.players)}</TableCell>
                      <TableCell className="text-right">{num(row.ftd)}</TableCell>
                      <TableCell className="text-right">{brl(row.revenue)}</TableCell>
                      <TableCell className="text-right font-semibold text-emerald-400">
                        {ratio(roas)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              icon={<BarChart3 className="h-6 w-6" />}
              title="Sem dados atribuidos"
              description="Depois que players chegarem com UTM ou gasto for importado, a leitura por criativo aparece aqui."
              className="py-12"
            />
          )}
        </DataCard>

        <DataCard
          title="Plano tecnico"
          description="Ordem recomendada para ligar Meta com seguranca"
          icon={<ShieldCheck className="h-4 w-4" />}
        >
          <div className="space-y-3 text-sm text-muted-foreground">
            {[
              "Criar app Meta Business e configurar OAuth server-side.",
              "Solicitar ads_read e business_management para contas de clientes.",
              "Salvar tokens apenas no servidor, com expiracao e refresh controlado.",
              "Sincronizar campaigns/adsets/ads/insights por job diario.",
              "Cruzar utm_id/utm_content dos players com o gasto do anuncio.",
            ].map((item, index) => (
              <div
                key={item}
                className="flex gap-3 rounded-lg border border-border/50 bg-background/30 p-3"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-xs font-semibold text-primary">
                  {index + 1}
                </span>
                <p>{item}</p>
              </div>
            ))}
          </div>
        </DataCard>
      </div>
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
