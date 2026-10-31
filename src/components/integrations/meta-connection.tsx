import { Clipboard, Link2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { DataCard } from "@/components/ui-premium/data-card";
import { useActiveTenant } from "@/hooks/use-active-tenant";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import { MetaConnectionView } from "./meta/meta-connection-view";
import { useMetaActions } from "./meta/use-meta-actions";
import { useMetaConnectionSummary, type MarketingIntegration } from "./meta-summary";

// Conexão com a Meta (chaves de Usuário do Sistema, contas por BM) e montador de UTM.
// Mora em Integrações (/webhooks#meta). As regras da tela estão em
// `meta-connection-model.ts`; os pedaços da tela, em `./meta/`.

// Só a Meta tem gasto sincronizado. Google, TikTok e Kwai voltam quando houver
// integração (AL5-04); antes disso o gerador prometeria uma medição que não existe.
const META_UTM_PARAMS =
  "utm_source={{site_source_name}}&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{adset.name}}&utm_id={{ad.id}}";

function appendParams(url: string, params: string) {
  const clean = url.trim();
  if (!clean) return params;
  return `${clean}${clean.includes("?") ? "&" : "?"}${params}`;
}

/**
 * Aba "Meta Ads" de Integrações: conexão + montador de UTM. `meta` (status de
 * `marketing_integrations`) é aceito por compatibilidade; o status vem das chaves.
 */
export function MetaConnectionPanel(_props: { meta?: MarketingIntegration }) {
  const [houseUrl, setHouseUrl] = useState("");
  const {
    data: metaSummary,
    isLoading: summaryLoading,
    isError: summaryFailed,
    isFetching: summaryFetching,
    refetch: refetchSummary,
  } = useMetaConnectionSummary();
  const isDemo = useIsDemoTenant();
  // Só o admin da casa (ou o super admin) altera a conexão; o servidor também confere.
  // Enquanto o papel carrega, nada fica bloqueado.
  const { active } = useActiveTenant();
  const readOnly = Boolean(active) && active?.role !== "admin" && active?.role !== "super_admin";
  const { connect, select, validate, disconnect, rename, sync } = useMetaActions();

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
    <div className="min-w-0 space-y-5">
      {summaryLoading ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : (
        <MetaConnectionView
          summary={metaSummary}
          readOnly={readOnly}
          isDemo={isDemo}
          loadError={
            summaryFailed ? { retry: () => void refetchSummary(), retrying: summaryFetching } : null
          }
          actions={{
            connect: (token) => connect.mutateAsync(token),
            connectPending: connect.isPending,
            saveSelection: (accountIds) => select.mutateAsync(accountIds),
            savePending: select.isPending,
            validate: (connectionId) => validate.mutate(connectionId),
            validatingConnectionId: validate.isPending ? (validate.variables ?? null) : null,
            rename: (connectionId, label) => rename.mutateAsync({ connectionId, label }),
            renamePending: rename.isPending,
            disconnect: (connectionId) => disconnect.mutateAsync(connectionId),
            disconnectPending: disconnect.isPending,
            sync: () => sync.mutate(),
            syncPending: sync.isPending,
          }}
        />
      )}

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
            onChange={(e) => setHouseUrl(e.target.value)}
          />
          <p className="text-meta text-muted-foreground">
            O <code>utm_id</code> leva o ID do anúncio. É ele que liga cada cadastro ao anúncio
            certo, mesmo quando dois anúncios têm o mesmo nome.
          </p>
        </div>
        <div className="mt-5 space-y-4">
          <CopyBlock title="Parâmetros de URL" value={utmParams} onCopy={() => copy(utmParams)} />
          <CopyBlock title="Link completo" value={fullUrl} onCopy={() => copy(fullUrl)} />
        </div>
      </DataCard>
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
      <pre className="overflow-auto rounded-md bg-background/70 p-3 text-meta text-primary">
        {value}
      </pre>
    </div>
  );
}
