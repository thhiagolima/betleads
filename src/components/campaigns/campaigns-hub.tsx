import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Mail, Plus, RotateCw, Search, Send, Volume2, Workflow } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";

import { NewSmsCampaignDialog } from "@/components/campaigns/new-sms-campaign-dialog";
import { NewEmailCampaignDialog } from "@/components/campaigns/new-email-campaign-dialog";
import { IndividualSmsDialog } from "@/components/campaigns/individual-sms-dialog";
import { MetricCard } from "@/components/ui-premium/metric-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { num } from "@/lib/format";
import { cancelScheduledSmsCampaign, listScheduledSmsCampaigns } from "@/lib/sms.functions";
import { listEmailCampaigns } from "@/lib/email.functions";
import { listCallQueue } from "@/lib/calls.functions";

type CampaignStatus = "todos" | "agendadas" | "enviando" | "finalizadas";
type Campaign = {
  id: string;
  name: string | null;
  scheduled_at: string;
  status: string;
  total_count: number | null;
  sent_count: number | null;
  failed_count: number | null;
  channel: "sms" | "email" | "voice";
  cancellable?: boolean;
};

type EmailCampaignRow = {
  id: string;
  nome: string | null;
  agendadoPara: string | null;
  status: string;
  enviados: number;
  falhas: number;
};

export function CampaignsHub() {
  const queryClient = useQueryClient();
  const listCampaigns = useServerFn(listScheduledSmsCampaigns);
  const listEmailCampaignsFn = useServerFn(listEmailCampaigns);
  const listCallQueueFn = useServerFn(listCallQueue);
  const cancelCampaign = useServerFn(cancelScheduledSmsCampaign);
  const [open, setOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [individualOpen, setIndividualOpen] = useState(false);
  const [requestedAudienceId, setRequestedAudienceId] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<CampaignStatus>("todos");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const audienceId = params.get("audience") ?? "";
    setRequestedAudienceId(audienceId);
    if (params.get("newChannel") === "email") {
      setEmailOpen(true);
    } else if (params.get("newCampaign") === "1") {
      setOpen(true);
    }
  }, []);

  const campaigns = useQuery({
    queryKey: ["sms-scheduled-campaigns"],
    queryFn: () => listCampaigns(),
    refetchInterval: 30_000,
  });
  const emailCampaigns = useQuery({
    queryKey: ["email-campaigns"],
    queryFn: () => listEmailCampaignsFn(),
    refetchInterval: 30_000,
  });
  const voiceQueue = useQuery({
    queryKey: ["call-queue", "campaigns-hub"],
    queryFn: () => listCallQueueFn({ data: { limit: 100 } }),
    refetchInterval: 30_000,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => cancelCampaign({ data: { id } }),
    onSuccess: () => {
      toast.success("Campanha cancelada");
      queryClient.invalidateQueries({ queryKey: ["sms-scheduled-campaigns"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const smsCampaigns = ((campaigns.data?.campaigns ?? []) as Omit<Campaign, "channel">[]).map(
    (campaign) => ({
      ...campaign,
      channel: "sms" as const,
      cancellable: campaign.status === "agendada",
    }),
  );
  const emailRows = ((emailCampaigns.data?.items ?? []) as EmailCampaignRow[]).map((campaign) => ({
    id: campaign.id,
    name: campaign.nome,
    scheduled_at: campaign.agendadoPara ?? new Date().toISOString(),
    status: campaign.status,
    total_count: campaign.enviados + campaign.falhas,
    sent_count: campaign.enviados,
    failed_count: campaign.falhas,
    channel: "email" as const,
    cancellable: false,
  }));
  const voiceRows: Campaign[] = ((voiceQueue.data?.items ?? []) as any[]).map((item) => ({
    id: item.id,
    name: item.script_name ?? item.audio_name ?? "Ligação por voz",
    scheduled_at: item.scheduled_at ?? item.created_at ?? new Date().toISOString(),
    status: item.status ?? "pendente",
    total_count: 1,
    sent_count: ["dispatched", "sent", "completed", "answered"].includes(item.status) ? 1 : 0,
    failed_count: ["failed", "error", "cancelled"].includes(item.status) ? 1 : 0,
    channel: "voice",
    cancellable: false,
  }));
  const all: Campaign[] = [...smsCampaigns, ...emailRows, ...voiceRows].sort(
    (a, b) => new Date(b.scheduled_at).getTime() - new Date(a.scheduled_at).getTime(),
  );
  const normalizedSearch = search.trim().toLowerCase();
  const rows = all.filter((campaign) => {
    const statusMatches =
      status === "todos" ||
      (status === "agendadas" && campaign.status === "agendada") ||
      (status === "enviando" && campaign.status === "enviando") ||
      (status === "finalizadas" &&
        ["enviado", "falhou", "cancelada", "concluida", "pausada"].includes(campaign.status));
    return (
      statusMatches &&
      (!normalizedSearch ||
        String(campaign.name ?? "")
          .toLowerCase()
          .includes(normalizedSearch))
    );
  });
  const sent = all.reduce((sum, campaign) => sum + Number(campaign.sent_count ?? 0), 0);
  const failed = all.reduce((sum, campaign) => sum + Number(campaign.failed_count ?? 0), 0);
  const queued = all.filter((campaign) =>
    ["agendada", "enviando"].includes(campaign.status),
  ).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Campanhas</h1>
          <p className="text-sm text-muted-foreground">
            Crie, acompanhe e agende disparos para os seus públicos salvos.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setIndividualOpen(true)}>
            <Send className="mr-2 h-4 w-4" />
            SMS individual
          </Button>
          <Button variant="outline" onClick={() => setEmailOpen(true)}>
            <Mail className="mr-2 h-4 w-4" />
            Campanha de email
          </Button>
          <Button variant="outline" asChild>
            <Link to="/ligacoes" hash="fila">
              <Volume2 className="mr-2 h-4 w-4" />
              Campanha de voz
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link to="/automacoes" hash="fluxos">
              <Workflow className="mr-2 h-4 w-4" />
              Automações
            </Link>
          </Button>
          <Button onClick={() => setOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Campanha de SMS
          </Button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Enviados" value={num(sent)} hint="nas campanhas listadas" />
        <MetricCard
          label="Entregues"
          value={num(Math.max(0, sent - failed))}
          hint="estimativa confirmada"
        />
        <MetricCard label="Falhas" value={num(failed)} hint="rejeitados ou inválidos" />
        <MetricCard label="Em envio" value={num(queued)} hint="agendadas ou processando" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-lg border border-border/70 bg-card/60 p-1">
          {(["todos", "agendadas", "enviando", "finalizadas"] as CampaignStatus[]).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={status === value ? "default" : "ghost"}
              onClick={() => setStatus(value)}
              className="capitalize"
            >
              {value}
            </Button>
          ))}
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-9"
            placeholder="Buscar campanha..."
          />
        </div>
      </div>
      <Card
        className="relative overflow-hidden border-border/70 bg-card/70"
        aria-busy={campaigns.isFetching || emailCampaigns.isFetching}
      >
        {campaigns.isFetching && !campaigns.isLoading && (
          <div
            className="absolute inset-x-0 top-0 z-10 flex items-center justify-center border-b border-primary/20 bg-primary/10 px-3 py-1.5 text-xs text-primary"
            role="status"
          >
            <RotateCw className="mr-2 h-3.5 w-3.5 animate-spin" />
            Atualizando campanhas...
          </div>
        )}
        <CardContent
          className={cn(
            "p-0",
            (campaigns.isFetching || emailCampaigns.isFetching) &&
              !(campaigns.isLoading || emailCampaigns.isLoading) &&
              "opacity-60 transition-opacity",
          )}
        >
          {campaigns.isLoading && (
            <p className="p-6 text-sm text-muted-foreground">Carregando campanhas…</p>
          )}
          {!campaigns.isLoading && rows.length === 0 && (
            <p className="p-10 text-center text-sm text-muted-foreground">
              Nenhuma campanha encontrada.
            </p>
          )}
          {rows.map((campaign) => {
            const total = Number(campaign.total_count ?? 0);
            const delivered = Number(campaign.sent_count ?? 0);
            return (
              <div
                key={campaign.id}
                className="grid gap-3 border-b border-border/50 px-4 py-3 last:border-0 md:grid-cols-[1fr_90px_90px_90px_110px] md:items-center"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-medium">{campaign.name}</p>
                    <Badge variant="outline" className={operationState(campaign.status).tone}>
                      {operationState(campaign.status).label}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {campaign.channel === "sms" ? "SMS" : "Email"} · {num(total)} destinatários ·{" "}
                    {new Date(campaign.scheduled_at).toLocaleString("pt-BR")}
                  </p>
                </div>
                <CampaignMetric label="Enviados" value={num(delivered)} />
                <CampaignMetric label="Falhas" value={num(campaign.failed_count ?? 0)} />
                <CampaignMetric
                  label="Progresso"
                  value={`${total ? Math.round((delivered / total) * 100) : 0}%`}
                />
                <div className="flex justify-end">
                  {campaign.cancellable ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate(campaign.id)}
                    >
                      Cancelar
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" disabled>
                      Relatório
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
      <NewSmsCampaignDialog
        open={open}
        onOpenChange={setOpen}
        initialAudienceId={requestedAudienceId}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ["sms-scheduled-campaigns"] })}
      />
      <NewEmailCampaignDialog
        open={emailOpen}
        onOpenChange={setEmailOpen}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ["email-campaigns"] })}
      />
      <IndividualSmsDialog open={individualOpen} onOpenChange={setIndividualOpen} />
    </div>
  );
}

function CampaignMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-xs text-muted-foreground">
      {label}
      <strong className="block text-sm text-foreground">{value}</strong>
    </div>
  );
}

function operationState(status: string) {
  const normalized = status.toLowerCase();
  if (["agendada", "pending", "queued", "audio_ready"].includes(normalized)) {
    return { label: "Aguardando envio", tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" };
  }
  if (["enviando", "running", "processing", "dispatched"].includes(normalized)) {
    return { label: "Em processamento", tone: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300" };
  }
  if (["enviado", "sent", "delivered", "concluida", "completed", "answered"].includes(normalized)) {
    return { label: "Concluída", tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" };
  }
  if (["falhou", "failed", "error", "cancelled", "cancelada"].includes(normalized)) {
    return { label: "Ação necessária", tone: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300" };
  }
  if (["pausada", "paused"].includes(normalized)) {
    return { label: "Pausada", tone: "border-muted-foreground/30 bg-muted text-muted-foreground" };
  }
  return { label: status || "Sem status", tone: "border-border text-muted-foreground" };
}
