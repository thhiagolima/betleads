import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
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
  Copy,
  FileJson,
  Link2,
  ShieldAlert,
  Terminal,
  Webhook as WebhookIcon,
} from "lucide-react";
import { useState } from "react";
import { timeAgo } from "@/lib/format";
import { WEBHOOK_EVENTS } from "@/lib/webhook-events";
import { PageHeader } from "@/components/ui-premium/page-header";
import { DataCard } from "@/components/ui-premium/data-card";
import { EmptyState } from "@/components/ui-premium/empty-state";
import { getMyWebhookToken } from "@/lib/webhooks.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/webhooks")({
  component: WebhooksPage,
});

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

type WebhookLog = {
  id: string;
  tenant_id: string | null;
  evento: string;
  status: string;
  created_at: string;
  payload: unknown;
};

function WebhooksPage() {
  const fetchToken = useServerFn(getMyWebhookToken);
  const { data: tokenInfo, isLoading: tokenLoading } = useQuery({
    queryKey: ["my-webhook-token"],
    queryFn: () => fetchToken(),
  });
  const token = tokenInfo?.token ?? null;
  const legacy = Boolean(tokenInfo?.legacy);
  const origin = publicOrigin();
  const baseUrl = legacy
    ? `${origin}/api/public/webhook`
    : token
      ? `${origin}/api/public/webhook/${token}`
      : null;

  const { data: logs = [], isLoading } = useQuery<WebhookLog[]>({
    queryKey: ["webhook_logs"],
    queryFn: async () => {
      const { data } = await supabase
        .from("webhook_logs")
        .select("id, tenant_id, evento, status, created_at, payload")
        .order("created_at", { ascending: false })
        .limit(50);
      return (data ?? []) as WebhookLog[];
    },
    refetchInterval: 10000,
  });

  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [selectedLog, setSelectedLog] = useState<WebhookLog | null>(null);

  function copy(text: string) {
    navigator.clipboard.writeText(text);
    setCopiedUrl(text);
    toast.success("URL copiada para a área de transferência");
    setTimeout(() => setCopiedUrl((c) => (c === text ? null : c)), 1800);
  }

  function copyPayload(payload: unknown) {
    navigator.clipboard.writeText(prettyJson(payload));
    toast.success("Payload copiado");
  }

  const lastByEvent = new Map<string, string>();
  logs.forEach((l) => {
    if (!lastByEvent.has(l.evento)) lastByEvent.set(l.evento, l.created_at);
  });

  const categorias = Array.from(new Set(WEBHOOK_EVENTS.map((e) => e.categoria)));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Webhooks"
        subtitle="URLs de integração com sua casa de aposta. Copie e cole no backoffice."
        icon={<WebhookIcon className="h-5 w-5 text-primary-foreground" />}
      />

      {!legacy && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 flex items-start gap-3">
          <ShieldAlert className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
          <div className="text-xs text-amber-100/90 leading-relaxed">
            <p className="font-semibold text-amber-200">URLs exclusivas da sua conta</p>
            <p>
              Cada usuário tem seu próprio conjunto de URLs com um token único. Não compartilhe —
              qualquer pessoa com o link consegue gravar dados na sua conta.
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <DataCard
            title="URLs de integração"
            description={`${WEBHOOK_EVENTS.length} endpoints disponíveis · 1 por evento`}
            icon={<Link2 className="h-4 w-4" />}
          >
            {!tokenLoading && !legacy && !token && (
              <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
                Não foi possível carregar o token da sua conta. Recarregue a página ou contate o
                suporte.
              </div>
            )}
            <div className="space-y-6">
              {categorias.map((cat) => (
                <div key={cat}>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground mb-2.5">
                    {cat}
                  </p>
                  <div className="space-y-2">
                    {WEBHOOK_EVENTS.filter((e) => e.categoria === cat).map((ev) => {
                      const url = baseUrl ? `${baseUrl}/${ev.slug}` : "";
                      const last = lastByEvent.get(ev.slug);
                      const copied = copiedUrl === url;
                      return (
                        <div
                          key={ev.slug}
                          className="rounded-lg border border-border/60 bg-background/30 p-3 transition-all hover:border-primary/30"
                        >
                          <div className="flex items-start justify-between gap-2 mb-2">
                            <div className="min-w-0">
                              <p className="text-sm font-semibold truncate">{ev.label}</p>
                              <p className="text-[11px] text-muted-foreground truncate">
                                {ev.descricao}
                              </p>
                            </div>
                            {last ? (
                              <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px] shrink-0">
                                <span className="h-1 w-1 rounded-full bg-emerald-400 pulse-realtime mr-1" />
                                ativo · {timeAgo(last)}
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className="text-[10px] text-muted-foreground shrink-0"
                              >
                                aguardando
                              </Badge>
                            )}
                          </div>
                          <div className="flex gap-2">
                            {tokenLoading ? (
                              <Skeleton className="h-8 flex-1 rounded-md" />
                            ) : (
                              <Input
                                value={url}
                                readOnly
                                className="bg-background/60 font-mono text-[11px] h-8"
                                placeholder="token indisponível"
                              />
                            )}
                            <Button
                              variant="outline"
                              size="icon"
                              className={cn(
                                "h-8 w-8 shrink-0 transition-all",
                                copied && "border-emerald-500/40 text-emerald-400",
                              )}
                              onClick={() => url && copy(url)}
                              disabled={!url}
                              title={copied ? "Copiado!" : "Copiar URL"}
                            >
                              {copied ? (
                                <Check className="h-3.5 w-3.5" />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          </div>
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
          title="Console de logs"
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
              const ok = l.status === "processado" || l.status === "recebido";
              return (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setSelectedLog(l)}
                  className={cn(
                    "w-full rounded-md border bg-background/40 p-2.5 text-left text-xs font-mono transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                    ok
                      ? "border-emerald-500/15 hover:border-emerald-500/30"
                      : "border-rose-500/20 hover:border-rose-500/40",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold truncate">{l.evento}</span>
                    {ok ? (
                      <span className="text-[10px] text-emerald-400 uppercase tracking-wider shrink-0">
                        {l.status}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] text-rose-400 uppercase tracking-wider shrink-0">
                        <AlertCircle className="h-3 w-3" />
                        {l.status}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-muted-foreground text-[10px]">
                    {timeAgo(l.created_at)}
                  </p>
                </button>
              );
            })}
            {!isLoading && logs.length === 0 && (
              <EmptyState
                icon={<Terminal className="h-6 w-6" />}
                title="Nenhum log ainda"
                description="Os webhooks recebidos vão aparecer aqui em tempo real."
                className="py-8"
              />
            )}
          </div>
        </DataCard>
      </div>

      <Dialog open={!!selectedLog} onOpenChange={(open) => !open && setSelectedLog(null)}>
        <DialogContent className="max-h-[88vh] max-w-4xl overflow-hidden p-0">
          {selectedLog && (
            <>
              <DialogHeader className="border-b border-border/60 px-5 py-4">
                <DialogTitle className="flex items-center gap-2">
                  <FileJson className="h-4 w-4 text-primary" />
                  Detalhes do log
                </DialogTitle>
                <DialogDescription>
                  {selectedLog.evento} Â· {new Date(selectedLog.created_at).toLocaleString("pt-BR")}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 overflow-y-auto px-5 py-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-md border border-border/60 bg-background/40 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      Evento
                    </p>
                    <p className="mt-1 break-words text-sm font-semibold">{selectedLog.evento}</p>
                  </div>
                  <div className="rounded-md border border-border/60 bg-background/40 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      Status
                    </p>
                    <p
                      className={cn(
                        "mt-1 text-sm font-semibold",
                        selectedLog.status === "processado" || selectedLog.status === "recebido"
                          ? "text-emerald-400"
                          : "text-rose-400",
                      )}
                    >
                      {selectedLog.status}
                    </p>
                  </div>
                  <div className="rounded-md border border-border/60 bg-background/40 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      Recebido
                    </p>
                    <p className="mt-1 text-sm font-semibold">
                      {new Date(selectedLog.created_at).toLocaleString("pt-BR")}
                    </p>
                  </div>
                </div>

                <div className="rounded-md border border-border/60 bg-background/40">
                  <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
                    <p className="text-xs font-semibold">Payload recebido</p>
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
                  <pre className="max-h-[52vh] overflow-auto whitespace-pre-wrap break-words p-3 text-[11px] leading-relaxed text-muted-foreground">
                    {prettyJson(selectedLog.payload)}
                  </pre>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
