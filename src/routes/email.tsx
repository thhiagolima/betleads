import { Link, createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  Copy,
  LayoutTemplate,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
  Workflow,
} from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";

import { ChannelPage } from "@/components/channels/channel-page";
import {
  ChannelBlock,
  ChannelOverview,
  ChannelSendsChart,
  useChannelPeriod,
} from "@/components/channels/channel-overview";
import { HistoryShell } from "@/components/history/history-shell";
import { StatusBadge } from "@/components/history/status-badge";
import { emailEventStatus } from "@/components/history/email-event-status";
import { HomeCard, MetricRow } from "@/components/home/home-cards";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { CHART_COLORS } from "@/lib/chart-theme";
import { num } from "@/lib/format";
import { EmptyState } from "@/components/ui-premium";
import { requestConfirmation } from "@/components/system-dialog-host";
import {
  listEmailCampaigns,
  listEmailTemplates,
  saveEmailTemplate,
  deleteEmailTemplate,
  duplicateEmailTemplate,
  getEmailDashboard,
} from "@/lib/email.functions";
import { useRealtimeInvalidate } from "@/hooks/use-realtime-invalidate";
import { TemplateEditorDialog } from "@/components/email/template-editor-dialog";
import { QuickEditorDialog } from "@/components/email/quick-editor-dialog";

export const Route = createFileRoute("/email")({
  component: EmailPage,
});

// ============================================================
// Tipos
// ============================================================

type Template = {
  id: string;
  nome: string;
  assunto: string;
  preheader: string;
  fromName: string;
  categoria: string;
  tags: string[];
  corpo: string;
  ativo: boolean;
  trackLinks?: boolean;
  lifecycleStatus?: "draft" | "published" | "archived";
  version?: number;
  atualizadoEm: string;
};

type CampStatus = "rascunho" | "agendada" | "enviando" | "pausada" | "concluida";
type Campanha = {
  id: string;
  nome: string;
  audienceMode?: "segmento" | "leads" | "emails";
  segmento: string;
  template: string;
  smtp: string;
  templateId?: string | null;
  smtpId?: string | null;
  senderId?: string | null;
  shortDomainId?: string | null;
  agendadoPara?: string;
  status: CampStatus;
  blockedReason?: string | null;
  enviados: number;
  entregues: number;
  abertos: number;
  cliques: number;
  descadastros?: number;
  falhas: number;
  data: string;
  targetPlayerIds?: string[];
  extraEmails?: string[];
};

// ============================================================
// Página
// ============================================================

function EmailPage() {
  return (
    <ChannelPage
      channel="email"
      subtitle="Envios, templates e histórico do canal de email."
      actions={
        <Button asChild variant="outline" className="h-9">
          <Link to="/automacoes">
            <Workflow className="size-4" aria-hidden="true" />
            Automações
          </Link>
        </Button>
      }
    >
      {(tab) =>
        tab === "templates" ? (
          <TemplatesTab />
        ) : tab === "historico" ? (
          <HistoricoTab />
        ) : (
          <DashboardTab />
        )
      }
    </ChannelPage>
  );
}

// ============================================================
// Visão geral
// ============================================================

function DashboardTab() {
  const period = useChannelPeriod();
  const { query } = period;
  const fn = useServerFn(getEmailDashboard);
  useRealtimeInvalidate(
    "email-dashboard-realtime",
    [
      "email_send_logs",
      "email_campaigns",
      "email_flow_leads",
      "dispatcher_runs",
      "dispatch_rate_state",
    ],
    [["email-dashboard"]],
  );
  const { data, isLoading, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ["email-dashboard", query.from, query.to],
    queryFn: () => fn({ data: { from: query.from, to: query.to } }),
    refetchInterval: query.includesToday ? 10_000 : false,
    placeholderData: (previous) => previous,
  });
  const totals = data?.totals;
  const health = data?.health;
  const events = data?.recent_events ?? [];
  const queued = (totals?.pending ?? 0) + (totals?.queue_due ?? 0);
  const activeCampaigns = totals?.active_campaigns ?? 0;
  const bounced = totals?.bounced ?? 0;

  return (
    <ChannelOverview
      period={period}
      updatedAt={dataUpdatedAt}
      isFetching={isFetching}
      isLoading={isLoading}
      // No "Entregues" or delivery rate: the email provider does not confirm delivery.
      kpis={[
        {
          title: "Enviados",
          value: num(totals?.sent ?? 0),
          detail: `para ${num(totals?.unique_recipients ?? 0)} endereços diferentes`,
        },
        {
          title: "Falhas",
          value: num(totals?.failed ?? 0),
          detail: bounced > 0 ? `${num(bounced)} devolvidos pelo destino` : "não saíram",
        },
        {
          title: "Na fila",
          value: num(queued),
          detail:
            activeCampaigns > 0
              ? `${num(activeCampaigns)} campanha(s) ativa(s)`
              : "aguardando envio agora",
        },
        // The email dashboard does not count clicks yet (the server returns 0).
        { title: "Cliques", value: "—", detail: "contagem de cliques ainda não disponível" },
      ]}
      chart={
        <ChannelSendsChart
          historyChannel="email"
          period={period}
          daily={data?.by_day}
          series={[
            { key: "enviados", label: "Enviados", color: CHART_COLORS.primary },
            { key: "falharam", label: "Falhas", color: CHART_COLORS.danger },
          ]}
        />
      }
    >
      <ChannelBlock title="Saúde do envio" description="Remetente, capacidade e últimos envios.">
        <div className="grid gap-x-8 md:grid-cols-2">
          <div>
            <MetricRow
              label="Domínio do remetente"
              value={!health ? "—" : health.sender_configured ? "Configurado" : "Não configurado"}
              valueClassName={
                !health ? undefined : health.sender_configured ? "text-success" : "text-warning"
              }
            />
            <MetricRow
              label="Capacidade de envio"
              value={!health ? "—" : health.channel_active ? "Disponível" : "Indisponível"}
              valueClassName={
                !health ? undefined : health.channel_active ? "text-success" : "text-danger"
              }
            />
            <MetricRow label="Campanhas ativas" value={num(activeCampaigns)} />
            <MetricRow
              label="Depositaram em até 72h após o email"
              value={num(totals?.conversions ?? 0)}
            />
          </div>
          <div className="mt-4 md:mt-0">
            <p className="py-2.5 text-[13.5px] text-muted-foreground">Últimos envios</p>
            {events.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                Quando começar a enviar, os envios aparecem aqui.
              </p>
            ) : (
              <ul className="max-h-56 overflow-auto pr-1">
                {events.map((event) => {
                  const status = emailEventStatus(event.status);
                  return (
                    <li
                      key={event.id}
                      className="flex items-center justify-between gap-2 border-b border-border/70 py-2 text-[13px] last:border-b-0"
                    >
                      <span className="truncate text-foreground/85" title={event.to_email}>
                        {event.to_email}
                      </span>
                      <StatusBadge color={status.color} label={status.label} title={event.error} />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </ChannelBlock>
    </ChannelOverview>
  );
}

// ============================================================
// Templates
// ============================================================

function TemplatesTab() {
  const listFn = useServerFn(listEmailTemplates);
  const listCampaignsFn = useServerFn(listEmailCampaigns);
  const saveFn = useServerFn(saveEmailTemplate);
  const delFn = useServerFn(deleteEmailTemplate);
  const dupFn = useServerFn(duplicateEmailTemplate);

  const q = useQuery({
    queryKey: ["email-templates"],
    queryFn: () => listFn(),
  });
  const items: Template[] = (q.data?.items ?? []) as any;
  const campaignQ = useQuery({
    queryKey: ["email-template-report"],
    queryFn: () => listCampaignsFn(),
  });
  const reportByTemplate = useMemo(() => {
    const report = new Map<
      string,
      { enviados: number; entregues: number; cliques: number; descadastros: number; falhas: number }
    >();
    for (const campaign of (campaignQ.data?.items ?? []) as Campanha[]) {
      if (!campaign.templateId) continue;
      const current = report.get(campaign.templateId) ?? {
        enviados: 0,
        entregues: 0,
        cliques: 0,
        descadastros: 0,
        falhas: 0,
      };
      current.enviados += campaign.enviados ?? 0;
      current.entregues += campaign.entregues ?? 0;
      current.cliques += campaign.cliques ?? 0;
      current.descadastros += campaign.descadastros ?? 0;
      current.falhas += campaign.falhas ?? 0;
      report.set(campaign.templateId, current);
    }
    return report;
  }, [campaignQ.data]);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [chooserOpen, setChooserOpen] = useState(false);

  function novo() {
    setEditing({
      id: "",
      nome: "",
      assunto: "",
      preheader: "",
      fromName: "BETLEADS",
      categoria: "Geral",
      tags: [],
      corpo: "",
      ativo: true,
      trackLinks: true,
      lifecycleStatus: "draft",
      version: 1,
      atualizadoEm: "agora",
    });
    setChooserOpen(true);
  }

  async function salvar(t: Template) {
    try {
      await saveFn({
        data: {
          id: t.id || undefined,
          nome: t.nome,
          assunto: t.assunto,
          preheader: t.preheader,
          fromName: t.fromName,
          categoria: t.categoria,
          tags: t.tags,
          corpo: t.corpo,
          ativo: t.ativo,
          trackLinks: t.trackLinks ?? true,
          lifecycleStatus: t.lifecycleStatus,
        },
      } as any);
      setOpen(false);
      toast.success("Template salvo");
      q.refetch();
    } catch (e: any) {
      toast.error(e?.message ?? "Erro ao salvar");
    }
  }

  async function duplicar(t: Template) {
    try {
      await dupFn({ data: { id: t.id } } as any);
      toast.success("Template duplicado");
      q.refetch();
    } catch (e: any) {
      toast.error(e?.message ?? "Erro ao duplicar");
    }
  }
  async function excluir(id: string) {
    if (
      !(await requestConfirmation({
        title: "Excluir template?",
        description: "O template será removido e não poderá mais ser usado em novas campanhas.",
        confirmLabel: "Excluir template",
        destructive: true,
      }))
    )
      return;
    try {
      await delFn({ data: { id } } as any);
      toast.success("Template excluído");
      q.refetch();
    } catch (e: any) {
      toast.error(e?.message ?? "Erro ao excluir");
    }
  }
  async function togglePause(t: Template) {
    try {
      await saveFn({
        data: {
          id: t.id,
          nome: t.nome,
          assunto: t.assunto,
          preheader: t.preheader,
          fromName: t.fromName,
          categoria: t.categoria,
          tags: t.tags,
          corpo: t.corpo,
          ativo: !t.ativo,
          trackLinks: t.trackLinks ?? true,
          lifecycleStatus: t.ativo ? "archived" : "published",
        },
      } as any);
      q.refetch();
    } catch (e: any) {
      toast.error(e?.message ?? "Erro ao atualizar");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-body text-muted-foreground">
          Modelos reutilizáveis para campanhas e automações.
        </p>
        <Button onClick={novo} className="h-9">
          <Plus className="size-4" aria-hidden="true" /> Novo template
        </Button>
      </div>

      {items.length === 0 ? (
        <HomeCard className="p-10">
          <EmptyState
            icon={<LayoutTemplate className="h-6 w-6" />}
            title="Crie seu primeiro template"
            description="Templates premium com blocos visuais, variáveis e suporte a HTML."
            action={
              <Button onClick={novo} className="gap-2">
                <Plus className="h-4 w-4" /> Novo template
              </Button>
            }
          />
        </HomeCard>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((t) => (
            <HomeCard
              key={t.id}
              className={cn("flex flex-col p-4 sm:p-5", !t.ativo && "opacity-70")}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate text-[15px] font-semibold">{t.nome || "Sem nome"}</h3>
                  <p className="truncate text-xs text-muted-foreground">
                    {t.assunto || "(sem assunto)"}
                  </p>
                </div>
                <Badge
                  className={cn(
                    "shrink-0",
                    t.lifecycleStatus === "published"
                      ? "bg-success/15 text-success border-success/30"
                      : t.lifecycleStatus === "draft"
                        ? "bg-warning/15 text-warning border-warning/30"
                        : "bg-muted text-muted-foreground",
                  )}
                >
                  {t.lifecycleStatus === "published"
                    ? "publicado"
                    : t.lifecycleStatus === "draft"
                      ? "rascunho"
                      : "arquivado"}
                </Badge>
              </div>
              <p className="mt-2 line-clamp-3 min-h-[3em] text-xs text-muted-foreground">
                {t.preheader || t.corpo || "Sem conteúdo ainda."}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge variant="outline" className="text-meta">
                  {t.categoria}
                </Badge>
                {t.tags.map((tag) => (
                  <Badge
                    key={tag}
                    variant="outline"
                    className="text-meta border-accent/30 text-accent"
                  >
                    #{tag}
                  </Badge>
                ))}
              </div>
              {(() => {
                const report = reportByTemplate.get(t.id) ?? {
                  enviados: 0,
                  entregues: 0,
                  cliques: 0,
                  descadastros: 0,
                  falhas: 0,
                };
                return (
                  <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-muted/40 p-2 text-meta text-muted-foreground">
                    <span>
                      <b className="text-foreground">{num(report.enviados)}</b> envios
                    </span>
                    <span>
                      <b className="text-foreground">{num(report.falhas)}</b> falhas
                    </span>
                    <span>
                      <b className="text-foreground">{num(report.descadastros)}</b> descad.
                    </span>
                  </div>
                );
              })()}
              <div className="mt-4 flex items-center justify-between gap-2 lg:mt-auto lg:pt-4">
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  v{t.version ?? 1} · atualizado {t.atualizadoEm}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="outline"
                    className="h-9"
                    onClick={() => {
                      setEditing(t);
                      setOpen(true);
                    }}
                  >
                    <Pencil className="size-3.5" aria-hidden="true" />
                    Editar
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <IconButton
                        label={`Mais ações de ${t.nome || "template"}`}
                        icon={<MoreHorizontal className="size-4" />}
                      />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => void duplicar(t)}>
                        <Copy className="size-4" aria-hidden="true" />
                        Duplicar
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void togglePause(t)}>
                        {t.ativo ? (
                          <Pause className="size-4" aria-hidden="true" />
                        ) : (
                          <Play className="size-4" aria-hidden="true" />
                        )}
                        {t.ativo ? "Pausar" : "Reativar"}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-danger focus:text-danger"
                        onSelect={() => void excluir(t.id)}
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                        Excluir
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </HomeCard>
          ))}
        </div>
      )}

      <TemplateEditorDialog open={open} onOpenChange={setOpen} editing={editing} onSave={salvar} />
      <QuickEditorDialog
        open={quickOpen}
        onOpenChange={setQuickOpen}
        editing={editing}
        onSave={(t) => {
          setQuickOpen(false);
          salvar(t);
        }}
        onOpenAdvanced={(html) => {
          setEditing((prev) => (prev ? { ...prev, corpo: html } : prev));
          setQuickOpen(false);
          setTimeout(() => setOpen(true), 50);
        }}
      />
      <Dialog open={chooserOpen} onOpenChange={setChooserOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Como você quer criar este template?</DialogTitle>
            <DialogDescription>
              Escolha o editor rápido para o padrão BETLEADS, ou o avançado para HTML livre.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => {
                setChooserOpen(false);
                setTimeout(() => setQuickOpen(true), 50);
              }}
              className="rounded-lg border border-border hover:border-primary/60 hover:bg-primary/5 p-4 text-left transition-all"
            >
              <div className="text-sm font-semibold mb-1">⚡ Editor Rápido BETLEADS</div>
              <div className="text-meta text-muted-foreground">
                Padrão Pixreals. Preencha campos, suba banner, ajuste cores e salve.
              </div>
            </button>
            <button
              type="button"
              onClick={() => {
                setChooserOpen(false);
                setTimeout(() => setOpen(true), 50);
              }}
              className="rounded-lg border border-border hover:border-primary/60 hover:bg-primary/5 p-4 text-left transition-all"
            >
              <div className="text-sm font-semibold mb-1">🧩 Editor Avançado HTML</div>
              <div className="text-meta text-muted-foreground">
                Modo livre com blocos, IA, presets e HTML customizado.
              </div>
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================================
// Histórico
// ============================================================

function HistoricoTab() {
  return (
    <HistoryShell
      channel="email"
      options={{
        subtitle: "Envios de campanhas e automações, com as falhas.",
        showStep: false,
      }}
    />
  );
}
