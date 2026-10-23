import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Copy,
  FileJson,
  Link2,
  ShieldAlert,
  Terminal,
} from "lucide-react";
import { useState } from "react";
import { num, timeAgo } from "@/lib/format";
import { WEBHOOK_EVENTS, describeEventType } from "@/lib/webhook-events";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { DataCard } from "@/components/ui-premium/data-card";
import { MetricCard } from "@/components/ui-premium/metric-card";
import { EmptyState } from "@/components/ui-premium/empty-state";
import { PageTabs } from "@/components/ui-premium/page-tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { LinksOverview } from "@/components/integrations/links-overview";
import { LinksSettings } from "@/components/integrations/links-settings";
import { MetaConnectionPanel } from "@/components/integrations/meta-connection";
import {
  getMyWebhookAccess,
  getMyWebhookHealth,
  getMyWebhookLogs,
  getMyWebhookToken,
  provisionMyWebhookHmacSecret,
  setMyWebhookHmacEnforcement,
} from "@/lib/webhooks.functions";
import { cn } from "@/lib/utils";
import { requestConfirmation } from "@/components/system-dialog-host";
import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import { DEMO_EMPTY_STATE_TEXT } from "@/lib/demo-tenant";

export const Route = createFileRoute("/webhooks")({
  component: IntegrationsPage,
});

const TABS = [
  { value: "plataforma", label: "Plataforma de apostas" },
  { value: "links", label: "Links curtos" },
  { value: "meta", label: "Meta Ads" },
] as const;
type IntegrationTab = (typeof TABS)[number]["value"];

function integrationTabFromHash(hash: string): IntegrationTab {
  return TABS.some((tab) => tab.value === hash) ? (hash as IntegrationTab) : "plataforma";
}

function IntegrationsPage() {
  const hash = useLocation({ select: (l) => l.hash });
  const navigate = useNavigate();
  const tab = integrationTabFromHash(hash);

  return (
    <Page>
      <PageHeader subtitle="Conecte a plataforma de apostas, os links curtos e a Meta." />
      <PageTabs
        label="Integrações"
        value={tab}
        // Sem replace: cada aba vira uma entrada no histórico (o voltar do navegador funciona).
        onValueChange={(value) => void navigate({ to: "/webhooks", hash: value })}
        items={TABS}
      />
      <div role="tabpanel" aria-labelledby={`tab-${tab}`} className="space-y-4 sm:space-y-5">
        {tab === "plataforma" && <PlatformSection />}
        {tab === "links" && (
          <>
            <LinksOverview />
            <LinksSettings />
          </>
        )}
        {tab === "meta" && <MetaConnectionPanel />}
      </div>
    </Page>
  );
}

function publicOrigin(): string {
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return import.meta.env.VITE_PUBLIC_APP_URL ?? "";
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value ?? "");
  }
}

const LOG_STATUS_LABELS: Record<string, string> = {
  recebido: "recebido",
  processado: "registrado",
  duplicado: "repetido",
  erro: "com erro",
  sem_player: "jogador não encontrado",
};

function logStatusLabel(status: string | null | undefined): string {
  return LOG_STATUS_LABELS[status ?? ""] ?? "situação desconhecida";
}

function eventLabel(evento: string | null | undefined): string {
  return describeEventType(evento).label;
}

type WebhookLog = {
  id: string;
  tenant_id: string | null;
  evento: string;
  status: string;
  created_at: string;
  payload: unknown;
};

type WebhookHealth = {
  since: string;
  received: number;
  processed: number;
  duplicates: number;
  failed: number;
  ignored: number;
  latest: Pick<WebhookLog, "created_at" | "evento" | "status"> | null;
};

function PlatformSection() {
  const isDemo = useIsDemoTenant();
  const fetchAccess = useServerFn(getMyWebhookAccess);
  const fetchToken = useServerFn(getMyWebhookToken);
  const fetchLogs = useServerFn(getMyWebhookLogs);
  const fetchHealth = useServerFn(getMyWebhookHealth);
  const provisionHmac = useServerFn(provisionMyWebhookHmacSecret);
  const setHmacEnforcement = useServerFn(setMyWebhookHmacEnforcement);
  const queryClient = useQueryClient();
  const { data: access, isLoading: accessLoading } = useQuery({
    queryKey: ["my-webhook-access"],
    queryFn: () => fetchAccess(),
  });
  const { data: tokenInfo, isLoading: tokenLoading } = useQuery({
    queryKey: ["my-webhook-token"],
    queryFn: () => fetchToken(),
    enabled: Boolean(access?.canManage),
  });
  // Disabled queries report isLoading=false, so "loading" alone would let a click through
  // before we know whether a key exists (and rotate it without the confirmation).
  const hmacUnknown = tokenLoading || !tokenInfo;
  const token = tokenInfo?.token ?? null;
  const legacy = Boolean(tokenInfo?.legacy);
  const origin = publicOrigin();
  const baseUrl = token ? `${origin}/api/public/webhook/${token}` : null;

  const { data: logs = [], isLoading } = useQuery<WebhookLog[]>({
    queryKey: ["webhook_logs"],
    queryFn: async () => (await fetchLogs()) as WebhookLog[],
    refetchInterval: 10000,
    enabled: Boolean(access?.canManage),
  });
  const { data: health, isLoading: healthLoading } = useQuery<WebhookHealth>({
    queryKey: ["webhook-health"],
    queryFn: () => fetchHealth() as Promise<WebhookHealth>,
    refetchInterval: 10000,
    enabled: Boolean(access?.canManage),
  });

  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [selectedLog, setSelectedLog] = useState<WebhookLog | null>(null);
  const [provisionedSecret, setProvisionedSecret] = useState<string | null>(null);
  const provision = useMutation({
    mutationFn: () => provisionHmac(),
    onSuccess: ({ secret }) => {
      setProvisionedSecret(secret);
      queryClient.invalidateQueries({ queryKey: ["my-webhook-token"] });
      toast.success(
        "Chave gerada. Configure-a na plataforma da casa antes de exigir a assinatura.",
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const enforceHmac = useMutation({
    mutationFn: (enforce: boolean) => setHmacEnforcement({ data: { enforce } }),
    onSuccess: ({ enforced }) => {
      queryClient.invalidateQueries({ queryKey: ["my-webhook-token"] });
      toast.success(
        enforced
          ? "A assinatura dos envios passou a ser obrigatória."
          : "Os envios sem assinatura voltaram a ser aceitos.",
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });

  // UX-02: as duas ações mudam o que a casa precisa enviar; uma chave errada
  // ou ausente faz depósitos e cadastros pararem de entrar.
  async function confirmRotate() {
    const confirmed = tokenInfo?.hmacConfigured
      ? await requestConfirmation({
          title: "Trocar a chave de assinatura?",
          description: `A chave atual deixa de valer imediatamente e uma nova é gerada; ela aparece uma única vez, então copie-a. ${
            tokenInfo.hmacEnforced
              ? "A exigência de assinatura será desligada até você ativá-la de novo, e os envios da plataforma passam a entrar sem verificação nesse intervalo. "
              : ""
          }Atualize a nova chave na plataforma da casa antes de exigir assinatura.`,
          confirmLabel: "Trocar chave",
          destructive: true,
        })
      : await requestConfirmation({
          title: "Gerar a chave de assinatura?",
          description:
            "A chave permite que a plataforma de apostas assine cada envio, provando que os dados vieram mesmo dela. Ela aparece uma única vez, então copie-a e entregue-a ao responsável pela integração. Gerar a chave não muda nada no recebimento até você exigir a assinatura.",
          confirmLabel: "Gerar chave",
        });
    if (!confirmed) return;
    provision.mutate();
  }

  async function confirmEnforce() {
    const confirmed = await requestConfirmation({
      title: "Exigir assinatura nos envios?",
      description:
        "A partir de agora, todo envio sem assinatura válida será recusado. Se a plataforma da casa ainda não assina os envios com a chave atual, depósitos, cadastros e os demais eventos deixam de ser registrados até ela configurar a chave. Confirme com a casa antes de ativar.",
      confirmLabel: "Exigir assinatura",
      destructive: true,
    });
    if (confirmed) enforceHmac.mutate(true);
  }

  async function confirmAllowUnsigned() {
    const confirmed = await requestConfirmation({
      title: "Aceitar envios sem assinatura?",
      description:
        "Os envios da plataforma voltam a ser aceitos mesmo sem assinatura, ou seja, sem a verificação de que vieram dela. Use só enquanto a casa troca ou configura a chave, e volte a exigir a assinatura assim que possível.",
      confirmLabel: "Aceitar sem assinatura",
      destructive: true,
    });
    if (confirmed) enforceHmac.mutate(false);
  }

  function copy(text: string, message = "Endereço copiado") {
    navigator.clipboard.writeText(text);
    setCopiedUrl(text);
    toast.success(message);
    setTimeout(() => setCopiedUrl((c) => (c === text ? null : c)), 1800);
  }

  function copyPayload(payload: unknown) {
    navigator.clipboard.writeText(prettyJson(payload));
    toast.success("Dados copiados");
  }

  if (!accessLoading && access && !access.canManage) {
    return (
      <EmptyState
        icon={<ShieldAlert className="h-5 w-5" />}
        title="Acesso administrativo necessário"
        description="Os endereços e as chaves que a plataforma de apostas usa para enviar dados são vistos só pelos administradores da casa."
      />
    );
  }

  const lastByEvent = new Map<string, string>();
  logs.forEach((l) => {
    if (!lastByEvent.has(l.evento)) lastByEvent.set(l.evento, l.created_at);
  });

  const categorias = Array.from(new Set(WEBHOOK_EVENTS.map((e) => e.categoria)));
  const attention = (health?.failed ?? 0) + (health?.ignored ?? 0);
  const baseCopied = Boolean(baseUrl) && copiedUrl === baseUrl;

  return (
    <>
      <section
        className="grid grid-cols-2 gap-3 lg:grid-cols-4"
        aria-label="Recebimentos da plataforma nas últimas 24 horas"
      >
        <MetricCard
          label="Recebidos"
          value={healthLoading ? <Skeleton className="h-7 w-16" /> : num(health?.received)}
          hint={
            health?.duplicates
              ? `últimas 24 horas · ${num(health.duplicates)} repetidos, ignorados com segurança`
              : "últimas 24 horas"
          }
        />
        <MetricCard
          label="Registrados"
          value={healthLoading ? <Skeleton className="h-7 w-16" /> : num(health?.processed)}
          hint="gravados com sucesso"
        />
        <MetricCard
          label="Precisam de atenção"
          value={
            healthLoading ? (
              <Skeleton className="h-7 w-16" />
            ) : (
              <span className={attention > 0 ? "text-warning" : undefined}>{num(attention)}</span>
            )
          }
          hint={
            (health?.failed ?? 0) > 0
              ? `${num(health?.failed)} com erro`
              : health?.ignored
                ? `${num(health.ignored)} sem jogador encontrado`
                : "nenhum"
          }
        />
        <MetricCard
          label="Último recebimento"
          value={
            healthLoading ? (
              <Skeleton className="h-7 w-16" />
            ) : health?.latest ? (
              timeAgo(health.latest.created_at)
            ) : (
              "—"
            )
          }
          hint={
            health?.latest
              ? `${eventLabel(health.latest.evento)} · ${logStatusLabel(health.latest.status)}`
              : "aguardando a integração"
          }
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <DataCard
            title="Endereços de integração"
            description={`Um endereço por evento (${WEBHOOK_EVENTS.length} no total). São exclusivos da sua casa: quem tiver o endereço consegue enviar dados para ela.`}
            icon={<Link2 className="h-4 w-4" />}
          >
            {!tokenLoading &&
              !legacy &&
              !token &&
              (isDemo ? (
                <div className="mb-4 rounded-lg border border-border/60 bg-muted/40 p-3 text-label text-muted-foreground">
                  {DEMO_EMPTY_STATE_TEXT}
                </div>
              ) : (
                <div className="mb-4 rounded-lg border border-danger/30 bg-danger/10 p-3 text-label text-danger">
                  Não foi possível carregar os endereços de integração da sua casa. Recarregue a
                  página ou contate o suporte.
                </div>
              ))}
            <div className="mb-5">
              <p className="mb-1.5 text-label text-muted-foreground">
                Endereço base (cada evento acrescenta o seu final)
              </p>
              <div className="flex gap-2">
                {tokenLoading ? (
                  <Skeleton className="h-9 flex-1 rounded-md" />
                ) : (
                  <Input
                    value={baseUrl ?? ""}
                    readOnly
                    className="h-9 bg-background/60 font-mono text-meta"
                    placeholder="endereço indisponível"
                    aria-label="Endereço base de integração"
                  />
                )}
                <IconButton
                  variant="outline"
                  label={baseCopied ? "Copiado" : "Copiar endereço base"}
                  icon={
                    baseCopied ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )
                  }
                  className={cn("shrink-0", baseCopied && "border-success/40 text-success")}
                  onClick={() => baseUrl && copy(baseUrl)}
                  disabled={!baseUrl}
                />
              </div>
            </div>
            <div className="space-y-6">
              {categorias.map((cat) => (
                <div key={cat}>
                  <p className="text-label font-semibold text-muted-foreground mb-2.5">{cat}</p>
                  <div className="space-y-2">
                    {WEBHOOK_EVENTS.filter((e) => e.categoria === cat).map((ev) => {
                      const url = baseUrl ? `${baseUrl}/${ev.slug}` : "";
                      const last = lastByEvent.get(ev.slug);
                      const copied = Boolean(url) && copiedUrl === url;
                      return (
                        <div
                          key={ev.slug}
                          className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/30 p-3 transition-all hover:border-primary/30"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline gap-x-2">
                              <p className="text-body font-semibold">{ev.label}</p>
                              <code className="truncate font-mono text-meta text-muted-foreground">
                                /{ev.slug}
                              </code>
                            </div>
                            <p className="truncate text-meta text-muted-foreground">
                              {ev.descricao}
                            </p>
                          </div>
                          {last ? (
                            <Badge className="bg-success/15 text-success border-success/30 text-meta shrink-0">
                              <span className="h-1 w-1 rounded-full bg-success pulse-realtime mr-1" />
                              ativo · {timeAgo(last)}
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-meta text-muted-foreground shrink-0"
                            >
                              aguardando
                            </Badge>
                          )}
                          <IconButton
                            variant="outline"
                            label={copied ? "Copiado" : `Copiar endereço de ${ev.label}`}
                            icon={
                              copied ? (
                                <Check className="h-3.5 w-3.5" />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )
                            }
                            className={cn(
                              "shrink-0 transition-all",
                              copied && "border-success/40 text-success",
                            )}
                            onClick={() => url && copy(url)}
                            disabled={!url}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </DataCard>
        </div>

        <DataCard
          title="Últimos recebimentos"
          description="Atualiza a cada 10s · últimos 50"
          icon={<Terminal className="h-4 w-4" />}
          bodyClassName="p-3"
        >
          <div className="space-y-1.5 max-h-[700px] overflow-y-auto pr-1">
            {isLoading &&
              Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 rounded-md" />
              ))}
            {logs.map((l) => {
              const isDuplicate = l.status === "duplicado";
              const ok = l.status === "processado" || l.status === "recebido" || isDuplicate;
              return (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setSelectedLog(l)}
                  className={cn(
                    "w-full rounded-md border bg-background/40 p-2.5 text-left text-meta transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                    ok
                      ? "border-success/15 hover:border-success/30"
                      : "border-danger/20 hover:border-danger/40",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold truncate">{eventLabel(l.evento)}</span>
                    {ok ? (
                      <span
                        className={`text-meta shrink-0 ${isDuplicate ? "text-muted-foreground" : "text-success"}`}
                      >
                        {logStatusLabel(l.status)}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-meta text-danger shrink-0">
                        <AlertCircle className="h-3 w-3" aria-hidden="true" />
                        {logStatusLabel(l.status)}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-muted-foreground text-meta">{timeAgo(l.created_at)}</p>
                </button>
              );
            })}
            {!isLoading && logs.length === 0 && (
              <EmptyState
                icon={<Terminal className="h-6 w-6" />}
                title="Nada recebido ainda"
                description={
                  isDemo
                    ? DEMO_EMPTY_STATE_TEXT
                    : "Os dados enviados pela plataforma de apostas vão aparecer aqui em tempo real."
                }
                className="py-8"
              />
            )}
          </div>
        </DataCard>
      </div>

      <Collapsible className="rounded-2xl border border-border bg-card/80">
        <CollapsibleTrigger className="group flex w-full items-start justify-between gap-4 rounded-2xl px-4 py-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-5">
          <div className="min-w-0">
            <h2 className="text-section">Segurança avançada: assinatura dos envios</h2>
            <p className="mt-0.5 text-label text-muted-foreground">
              Garante que os dados vieram mesmo da plataforma. Ative somente depois de configurar a
              mesma chave na plataforma da casa.
            </p>
          </div>
          <ChevronDown
            className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="px-4 pb-4 sm:px-5 sm:pb-5">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge
              variant="outline"
              className={
                tokenInfo?.hmacEnforced
                  ? "border-success/40 text-success"
                  : "border-warning/40 text-warning"
              }
            >
              {tokenInfo?.hmacEnforced ? "assinatura obrigatória" : "assinatura ainda opcional"}
            </Badge>
            <span className="text-muted-foreground">
              {tokenInfo?.hmacConfigured ? "Chave gerada." : "Nenhuma chave gerada."}
            </span>
            <DemoDisabledTooltip active={isDemo}>
              <Button
                size="sm"
                variant="outline"
                disabled={isDemo || hmacUnknown || provision.isPending}
                onClick={() => void confirmRotate()}
              >
                {provision.isPending
                  ? "Gerando..."
                  : tokenInfo?.hmacConfigured
                    ? "Trocar chave"
                    : "Gerar chave"}
              </Button>
            </DemoDisabledTooltip>
            {tokenInfo?.hmacEnforced ? (
              <DemoDisabledTooltip active={isDemo}>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isDemo || hmacUnknown || enforceHmac.isPending}
                  onClick={() => void confirmAllowUnsigned()}
                >
                  Aceitar sem assinatura por enquanto
                </Button>
              </DemoDisabledTooltip>
            ) : (
              <DemoDisabledTooltip active={isDemo}>
                <Button
                  size="sm"
                  disabled={
                    isDemo || hmacUnknown || !tokenInfo?.hmacConfigured || enforceHmac.isPending
                  }
                  onClick={() => void confirmEnforce()}
                >
                  Exigir assinatura
                </Button>
              </DemoDisabledTooltip>
            )}
          </div>
          <p className="mt-3 text-meta text-muted-foreground">
            Para o responsável pela integração: a assinatura (HMAC-SHA256 com a chave) vai no
            cabeçalho <code className="font-mono text-foreground/85">x-webhook-signature</code>.
          </p>
          {provisionedSecret ? (
            <div className="mt-3 flex gap-2">
              <Input
                value={provisionedSecret}
                readOnly
                className="font-mono text-meta"
                aria-label="Chave de assinatura gerada"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => copy(provisionedSecret, "Chave copiada")}
              >
                <Copy className="mr-1 h-3.5 w-3.5" /> Copiar
              </Button>
            </div>
          ) : null}
        </CollapsibleContent>
      </Collapsible>

      <Dialog open={!!selectedLog} onOpenChange={(open) => !open && setSelectedLog(null)}>
        <DialogContent className="max-h-[88vh] max-w-4xl overflow-hidden p-0">
          {selectedLog && (
            <>
              <DialogHeader className="border-b border-border/60 px-5 py-4">
                <DialogTitle className="flex items-center gap-2">
                  <FileJson className="h-4 w-4 text-primary" />
                  Detalhes do recebimento
                </DialogTitle>
                <DialogDescription>
                  {eventLabel(selectedLog.evento)} ·{" "}
                  {new Date(selectedLog.created_at).toLocaleString("pt-BR")}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 overflow-y-auto px-5 py-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-md border border-border/60 bg-background/40 p-3">
                    <p className="text-label text-muted-foreground">Evento</p>
                    <p className="mt-1 break-words text-sm font-semibold">
                      {eventLabel(selectedLog.evento)}
                    </p>
                  </div>
                  <div className="rounded-md border border-border/60 bg-background/40 p-3">
                    <p className="text-label text-muted-foreground">Situação</p>
                    <p
                      className={cn(
                        "mt-1 text-sm font-semibold",
                        selectedLog.status === "duplicado"
                          ? "text-muted-foreground"
                          : selectedLog.status === "processado" || selectedLog.status === "recebido"
                            ? "text-success"
                            : "text-danger",
                      )}
                    >
                      {logStatusLabel(selectedLog.status)}
                    </p>
                  </div>
                  <div className="rounded-md border border-border/60 bg-background/40 p-3">
                    <p className="text-label text-muted-foreground">Recebido</p>
                    <p className="mt-1 text-sm font-semibold">
                      {new Date(selectedLog.created_at).toLocaleString("pt-BR")}
                    </p>
                  </div>
                </div>

                <div className="rounded-md border border-border/60 bg-background/40">
                  <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
                    <p className="text-label font-semibold">Dados recebidos</p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-2"
                      onClick={() => copyPayload(selectedLog.payload)}
                    >
                      <Copy className="h-3.5 w-3.5" />
                      Copiar
                    </Button>
                  </div>
                  <pre className="max-h-[52vh] overflow-auto whitespace-pre-wrap break-words p-3 text-meta leading-relaxed text-muted-foreground">
                    {prettyJson(selectedLog.payload)}
                  </pre>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
