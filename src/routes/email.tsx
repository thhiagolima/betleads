import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Send,
  Eye,
  MousePointerClick,
  XCircle,
  AlertTriangle,
  Megaphone,
  TrendingUp,
  Server,
  ShieldCheck,
  Activity,
  Plus,
  Pencil,
  Copy,
  Trash2,
  Pause,
  Play,
  Workflow,
  Star,
  LayoutTemplate,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HistoryShell } from "@/components/history/history-shell";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  LineChart,
  Line,
  BarChart,
  Bar,
} from "recharts";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { CHART_COLORS, chartAxisProps, chartGridProps, chartTooltipProps } from "@/lib/chart-theme";
import { num } from "@/lib/format";
import { MetricCard, EmptyState } from "@/components/ui-premium";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { SendWindowCard } from "@/components/send-window-card";
import { ProvidersPausedBanner } from "@/components/providers-paused-banner";
import { requestConfirmation } from "@/components/system-dialog-host";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import {
  listEmailCampaigns,
  listEmailTemplates,
  saveEmailTemplate,
  deleteEmailTemplate,
  duplicateEmailTemplate,
  getEmailDashboard,
} from "@/lib/email.functions";
import { useRealtimeInvalidate } from "@/hooks/use-realtime-invalidate";
import {
  DashboardDateRangePicker,
  defaultTodayRange,
  rangeToKey,
  type DashboardRange,
} from "@/components/dashboard-date-range-picker";
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
  const navigate = useNavigate();
  const hash = useLocation({ select: (l) => l.hash });
  const VALID = ["dashboard", "templates", "historico"] as const;
  const legacySettings = ["remetentes", "smtp", "configuracoes"].includes(hash);
  const current = legacySettings
    ? "dashboard"
    : (VALID as readonly string[]).includes(hash)
      ? hash
      : "dashboard";

  useEffect(() => {
    if (hash === "campanhas") {
      void navigate({ to: "/campanhas", search: { newChannel: "email" } as never, replace: true });
    }
    if (hash === "automacoes") {
      void navigate({ to: "/automacoes", replace: true });
    }
    if (legacySettings) {
      void navigate({ to: "/email", hash: "dashboard", replace: true });
    }
  }, [hash, legacySettings, navigate]);

  return (
    <Page>
      <PageHeader
        subtitle="Saúde do canal, entregas, templates e histórico"
        actions={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() =>
                void navigate({ to: "/campanhas", search: { newChannel: "email" } as never })
              }
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Criar campanha
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void navigate({ to: "/automacoes" })}
            >
              <Workflow className="mr-1.5 h-3.5 w-3.5" /> Automações
            </Button>
          </div>
        }
      />

      <SendWindowCard compact />

      <ProvidersPausedBanner channel="email" />

      <Tabs
        value={current}
        onValueChange={(v) => navigate({ to: "/email", hash: v, replace: true })}
        className="w-full"
      >
        <TabsList className="hidden">
          <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="historico">Histórico</TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard" className="mt-2">
          <DashboardTab />
        </TabsContent>
        <TabsContent value="templates" className="mt-2">
          <TemplatesTab />
        </TabsContent>
        <TabsContent value="historico" className="mt-2">
          <HistoricoTab />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

// ============================================================
// Dashboard
// ============================================================

function DashboardTab() {
  const [range, setRange] = useState<DashboardRange>(() => defaultTodayRange());
  const rk = rangeToKey(range);
  const sameDay = rk.from === rk.to;
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
  const { data, isLoading } = useQuery({
    queryKey: ["email-dashboard", rk.from, rk.to],
    queryFn: () => fn({ data: rk }),
    refetchInterval: 10_000,
  });
  const totals = data?.totals;
  const today = data?.today;
  const health = data?.health;
  const events = data?.recent_events ?? [];
  const fmtDay = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    if (sameDay) return d.toLocaleTimeString("pt-BR", { hour: "2-digit" });
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  };
  const v = (n?: number) => (isLoading ? "…" : String(n ?? 0));
  const todayIsoLocal = (() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  })();
  const lastDayLabel = (() => {
    if (rk.to === todayIsoLocal) return "hoje";
    const d = new Date(rk.to + "T00:00:00");
    return `em ${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}`;
  })();
  // Em range de vários dias, o card mostra o total do PERÍODO.
  const sentHeadline = sameDay ? (today?.sent ?? 0) : (totals?.sent ?? 0);
  const sentHeadlineLabel = sameDay ? `Enviados ${lastDayLabel}` : "Enviados no período";
  const uniqHeadline = sameDay
    ? ((today as any)?.unique_recipients ?? 0)
    : ((totals as any)?.unique_recipients ?? 0);
  const sentHeadlineHint = sameDay
    ? `Período: ${totals?.sent ?? 0} · ${uniqHeadline} emails únicos`
    : `${(lastDayLabel[0]?.toUpperCase() ?? "") + lastDayLabel.slice(1)}: ${today?.sent ?? 0} · ${uniqHeadline} emails únicos`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-section">Visão geral</h2>
          <p className="text-xs text-muted-foreground">
            Métricas operacionais atualizadas em tempo real
          </p>
        </div>
        <DashboardDateRangePicker range={range} onChange={setRange} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
        <MetricCard
          label={sentHeadlineLabel}
          value={isLoading ? "…" : String(sentHeadline)}
          icon={<Send className="h-4 w-4" />}
          accent="primary"
          hint={sentHeadlineHint}
        />
        <MetricCard
          label="Abertos"
          value={v(totals?.opens)}
          icon={<Eye className="h-4 w-4" />}
          accent="ai"
        />
        <MetricCard
          label="Cliques"
          value={v(totals?.clicks)}
          icon={<MousePointerClick className="h-4 w-4" />}
          accent="primary"
        />
        <MetricCard
          label="Falharam"
          value={v(totals?.failed)}
          icon={<XCircle className="h-4 w-4" />}
          accent="danger"
        />
        <MetricCard
          label="Bounces"
          value={v(totals?.bounced)}
          icon={<AlertTriangle className="h-4 w-4" />}
          accent="warning"
        />
        <MetricCard
          label="Campanhas ativas"
          value={v(totals?.active_campaigns)}
          icon={<Megaphone className="h-4 w-4" />}
          accent="primary"
        />
        <MetricCard
          label="Conversões pós-email"
          value={v(totals?.conversions)}
          icon={<TrendingUp className="h-4 w-4" />}
          accent="success"
          hint="depósitos em 72h"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>
              Envios por dia —{" "}
              {sameDay
                ? new Date(rk.from + "T00:00:00").toLocaleDateString("pt-BR")
                : `${new Date(rk.from + "T00:00:00").toLocaleDateString("pt-BR")} - ${new Date(rk.to + "T00:00:00").toLocaleDateString("pt-BR")}`}
            </CardTitle>
            {/* No "Entregues": the provider does not confirm delivery (same rule as SMS). */}
            <CardDescription>Emails enviados no período</CardDescription>
          </CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data?.by_day ?? []}>
                <defs>
                  <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART_COLORS.primary} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={CHART_COLORS.primary} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...chartGridProps} />
                <XAxis dataKey="date" tickFormatter={fmtDay} {...chartAxisProps} />
                <YAxis {...chartAxisProps} />
                <Tooltip {...chartTooltipProps} labelFormatter={(v) => fmtDay(String(v))} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Area
                  type="monotone"
                  dataKey="enviados"
                  stroke={CHART_COLORS.primary}
                  fill="url(#g1)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Saúde do envio</CardTitle>
            <CardDescription>Status do remetente e infraestrutura</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <HealthRow
              icon={<ShieldCheck className="h-4 w-4" />}
              label="Saúde do domínio"
              value={health?.sender_configured ? "Configurada" : "Não configurada"}
              tone={health?.sender_configured ? "ok" : "warn"}
            />
            <HealthRow
              icon={<Star className="h-4 w-4" />}
              label="Reputação do remetente"
              value="—"
              tone="muted"
            />
            <HealthRow
              icon={<Server className="h-4 w-4" />}
              label="Capacidade de envio"
              value={health?.channel_active ? "Disponível" : "Indisponível"}
              tone={health?.channel_active ? "ok" : "danger"}
            />
            <Separator />
            <div className="text-xs text-muted-foreground">
              <Activity className="inline h-3 w-3 mr-1" /> Últimos eventos
            </div>
            {events.length === 0 ? (
              <EmptyState
                icon={<Activity className="h-5 w-5" />}
                title="Sem eventos ainda"
                description="Quando começar a enviar, os eventos aparecem aqui."
                className="py-6"
              />
            ) : (
              <div className="space-y-1.5 max-h-40 overflow-auto pr-1">
                {events.map((e) => (
                  <div key={e.id} className="flex items-center justify-between text-xs gap-2">
                    <span className="truncate text-foreground/80" title={e.to_email}>
                      {e.to_email}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded px-1.5 py-0.5 border text-meta",
                        e.status === "sent" || e.status === "delivered"
                          ? "border-success/30 text-success bg-success/10"
                          : e.status === "failed" || e.status === "dlq" || e.status === "error"
                            ? "border-danger/30 text-danger bg-danger/10"
                            : "border-border text-muted-foreground bg-muted/30",
                      )}
                    >
                      {e.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Falhas no período</CardTitle>
          </CardHeader>
          <CardContent className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data?.by_day ?? []}>
                <CartesianGrid {...chartGridProps} />
                <XAxis dataKey="date" tickFormatter={fmtDay} {...chartAxisProps} />
                <YAxis {...chartAxisProps} />
                <Tooltip {...chartTooltipProps} labelFormatter={(v) => fmtDay(String(v))} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="falharam" stroke={CHART_COLORS.danger} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Conversões após email</CardTitle>
          </CardHeader>
          <CardContent className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data?.conversions_by_day ?? []}>
                <CartesianGrid {...chartGridProps} />
                <XAxis dataKey="date" tickFormatter={fmtDay} {...chartAxisProps} />
                <YAxis {...chartAxisProps} />
                <Tooltip {...chartTooltipProps} labelFormatter={(v) => fmtDay(String(v))} />
                <Bar dataKey="conversoes" fill={CHART_COLORS.primary} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function HealthRow({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: "ok" | "warn" | "danger" | "muted";
}) {
  const toneCls = {
    ok: "text-success",
    warn: "text-warning",
    danger: "text-danger",
    muted: "text-muted-foreground",
  }[tone];
  return (
    <div className="flex items-center justify-between text-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className={toneCls}>{icon}</span>
        {label}
      </div>
      <span className={cn("text-xs font-medium", toneCls)}>{value}</span>
    </div>
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
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-section">Templates</h2>
          <p className="text-xs text-muted-foreground">
            Modelos reutilizáveis para campanhas e automações
          </p>
        </div>
        <Button onClick={novo} className="gap-2">
          <Plus className="h-4 w-4" /> Novo template
        </Button>
      </div>

      {items.length === 0 ? (
        <Card className="p-10">
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
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {items.map((t) => (
            <Card key={t.id}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="truncate">{t.nome || "Sem nome"}</CardTitle>
                    <CardDescription className="truncate">
                      {t.assunto || "(sem assunto)"}
                    </CardDescription>
                  </div>
                  <Badge
                    className={
                      t.lifecycleStatus === "published"
                        ? "bg-success/15 text-success border-success/30"
                        : t.lifecycleStatus === "draft"
                          ? "bg-warning/15 text-warning border-warning/30"
                          : "bg-muted text-muted-foreground"
                    }
                  >
                    {t.lifecycleStatus === "published"
                      ? "publicado"
                      : t.lifecycleStatus === "draft"
                        ? "rascunho"
                        : "arquivado"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="text-xs text-muted-foreground line-clamp-3 min-h-[3em]">
                  {t.preheader || t.corpo || "Sem conteúdo ainda."}
                </div>
                <div className="flex flex-wrap gap-1.5">
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
                    <div className="grid grid-cols-3 gap-2 rounded-md bg-muted/40 p-2 text-meta text-muted-foreground">
                      <span>
                        <b className="text-foreground">{num(report.enviados)}</b> envios
                      </span>
                      <span>
                        <b className="text-foreground">{num(report.cliques)}</b> cliques
                      </span>
                      <span>
                        <b className="text-foreground">{num(report.descadastros)}</b> descad.
                      </span>
                      <span>
                        <b className="text-foreground">{num(report.falhas)}</b> falhas
                      </span>
                    </div>
                  );
                })()}
                <Separator />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    v{t.version ?? 1} · Atualizado {t.atualizadoEm}
                  </span>
                  <div className="flex items-center gap-0.5">
                    <IconButton
                      label="Prévia do template"
                      icon={<Eye className="h-3.5 w-3.5" />}
                      onClick={() => toast.info("Preview em breve")}
                    />
                    <IconButton
                      label="Editar template"
                      icon={<Pencil className="h-3.5 w-3.5" />}
                      onClick={() => {
                        setEditing(t);
                        setOpen(true);
                      }}
                    />
                    <IconButton
                      label="Duplicar template"
                      icon={<Copy className="h-3.5 w-3.5" />}
                      onClick={() => duplicar(t)}
                    />
                    <IconButton
                      label={t.ativo ? "Pausar template" : "Reativar template"}
                      icon={
                        t.ativo ? (
                          <Pause className="h-3.5 w-3.5" />
                        ) : (
                          <Play className="h-3.5 w-3.5" />
                        )
                      }
                      onClick={() => togglePause(t)}
                    />
                    <IconButton
                      label="Excluir template"
                      className="text-danger"
                      icon={<Trash2 className="h-3.5 w-3.5" />}
                      onClick={() => excluir(t.id)}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
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
        title: "Histórico de emails",
        subtitle: "Eventos de envio, automações e falhas.",
        showStep: false,
      }}
    />
  );
}
