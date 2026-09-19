import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Mail,
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
  History,
  Star,
  CheckCircle2,
  Filter,
  Variable,
  LayoutTemplate,
  Sparkles,
  MoreHorizontal,
} from "lucide-react";
import { Search, X as XIcon, Users } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HistoryShell } from "@/components/history/history-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { MetricCard, EmptyState, PageHeader } from "@/components/ui-premium";
import { SendWindowCard } from "@/components/send-window-card";
import { ProvidersPausedBanner } from "@/components/providers-paused-banner";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import {
  getEmailProviderStatus,
  sendTestEmail,
  listEmailCampaigns,
  saveEmailCampaign,
  deleteEmailCampaign,
  duplicateEmailCampaign,
  updateEmailCampaignStatus,
  sendEmailCampaignNow,
  previewSegmentCount,
  listEmailTemplates,
  saveEmailTemplate,
  deleteEmailTemplate,
  duplicateEmailTemplate,
  listSmtpConfigs,
  listPlayersForEmail,
  listEmailSenders,
  saveEmailSender,
  deleteEmailSender,
  setDefaultEmailSender,
  getEmailDashboard,
  getEmailHistory,
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
import {
  listEmailFlows,
  getEmailFlow,
  saveEmailFlow,
  toggleEmailFlow,
  deleteEmailFlow,
  duplicateEmailFlow,
  listEmailFlowLeads,
  listEmailFlowLogs,
  triggerEmailFlowTest,
} from "@/lib/email-automations.functions";
import {
  EMAIL_TRIGGERS,
  EMAIL_EXIT_CONDITIONS,
  defaultExitConditions,
  emptyBlock,
  triggerLabel,
  formatDelay,
  type EmailFlowBlockDraft,
  type EmailTrigger,
} from "@/lib/email-automations.shared";
import {
  ArrowDown,
  ArrowUp,
  Clock,
  GitBranch,
  Tag as TagIcon,
  StopCircle,
  UserMinus,
  FlaskConical,
} from "lucide-react";

export const Route = createFileRoute("/email")({
  head: () => ({
    meta: [
      { title: "Email Marketing — BETLEADS" },
      {
        name: "description",
        content:
          "Módulo de Email Marketing premium: SMTP, templates, campanhas, automações e histórico.",
      },
    ],
  }),
  component: EmailPage,
});

// ============================================================
// Tipos & mocks (placeholders — sem backend ainda)
// ============================================================

type SmtpStatus = "ativo" | "inativo";
type SmtpConfig = {
  id: string;
  nome: string;
  provedor: string;
  host: string;
  porta: number;
  seguranca: "SSL/TLS" | "STARTTLS" | "Nenhuma";
  usuario: string;
  senha: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  limiteDiario: number;
  limiteHora: number;
  status: SmtpStatus;
  padrao: boolean;
};

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
  agendadoPara?: string;
  status: CampStatus;
  enviados: number;
  entregues: number;
  abertos: number;
  cliques: number;
  falhas: number;
  data: string;
  targetPlayerIds?: string[];
  extraEmails?: string[];
};

// Parser de emails colados (um por linha, vírgula, ponto-e-vírgula ou espaço).
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function parseExtraEmails(raw: string): { valid: string[]; invalid: number } {
  const parts = raw
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const valid: string[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  for (const p of parts) {
    if (!EMAIL_RX.test(p)) {
      invalid++;
      continue;
    }
    if (seen.has(p)) continue;
    seen.add(p);
    valid.push(p);
  }
  return { valid, invalid };
}

const SEGMENTOS = [
  "Todos",
  "Logaram nos últimos 4 dias",
  "7+ dias sem login",
  "VIP",
  "VIP sem login",
  "Faltando pouco pro VIP",
  "Depositando frequentemente",
  "Com saldo e sem login",
  "Depositaram hoje",
  "Cadastrados sem depósito",
  "7 a 14 dias sem login",
  "15 a 24 dias sem login",
  "25 a 34 dias sem login",
  "35 a 44 dias sem login",
  "45 a 59 dias sem login",
  "60+ dias sem login",
];

const VARIAVEIS = [
  "{primeiro_nome}",
  "{nome}",
  "{email}",
  "{telefone}",
  "{saldo}",
  "{ultimo_login}",
  "{ultimo_deposito}",
  "{total_depositado}",
  "{link_deposito}",
  "{link_login}",
];

const SAIDAS = ["Login", "Depósito", "Primeiro depósito", "Aposta", "Resposta", "Handoff humano"];

// chart data agora vem do server (getEmailDashboard)

// ============================================================
// Página
// ============================================================

function EmailPage() {
  const navigate = useNavigate();
  const hash = useLocation({ select: (l) => l.hash });
  const VALID = [
    "dashboard",
    "remetentes",
    "smtp",
    "templates",
    "campanhas",
    "automacoes",
    "historico",
  ] as const;
  const current = (VALID as readonly string[]).includes(hash) ? hash : "dashboard";

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <PageHeader
        title="Email Marketing"
        subtitle="Dashboard, SMTP, templates, campanhas, automações e histórico"
        icon={<Mail className="h-5 w-5 text-primary-foreground" />}
        actions={
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="border-accent/40 text-accent text-[10px] uppercase tracking-wider"
            >
              <Sparkles className="h-3 w-3 mr-1" /> Pronto p/ integrar
            </Badge>
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
          <TabsTrigger value="remetentes">Remetentes</TabsTrigger>
          <TabsTrigger value="smtp">SMTP</TabsTrigger>
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="campanhas">Campanhas</TabsTrigger>
          <TabsTrigger value="automacoes">Automações</TabsTrigger>
          <TabsTrigger value="historico">Histórico</TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard" className="mt-2">
          <DashboardTab />
        </TabsContent>
        <TabsContent value="remetentes" className="mt-2">
          <RemetentesTab />
        </TabsContent>
        <TabsContent value="smtp" className="mt-2">
          <SmtpTab />
        </TabsContent>
        <TabsContent value="templates" className="mt-2">
          <TemplatesTab />
        </TabsContent>
        <TabsContent value="campanhas" className="mt-2">
          <CampanhasTab />
        </TabsContent>
        <TabsContent value="automacoes" className="mt-2">
          <AutomacoesTab />
        </TabsContent>
        <TabsContent value="historico" className="mt-2">
          <HistoricoTab />
        </TabsContent>
      </Tabs>
    </div>
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
          <h2 className="text-lg font-semibold">Visão geral</h2>
          <p className="text-xs text-muted-foreground">
            Métricas em tempo real · provedor BusinessCode
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
          label="Entregues"
          value={v(totals?.delivered)}
          icon={<CheckCircle2 className="h-4 w-4" />}
          accent="success"
          hint={
            totals && totals.sent > 0
              ? `${Math.round((totals.delivered / totals.sent) * 100)}% taxa`
              : "—"
          }
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
        <Card className="card-premium border-0 lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">
              Envios x Entregas —{" "}
              {sameDay
                ? new Date(rk.from + "T00:00:00").toLocaleDateString("pt-BR")
                : `${new Date(rk.from + "T00:00:00").toLocaleDateString("pt-BR")} - ${new Date(rk.to + "T00:00:00").toLocaleDateString("pt-BR")}`}
            </CardTitle>
            <CardDescription>Volume de envios e taxa de entrega</CardDescription>
          </CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data?.by_day ?? []}>
                <defs>
                  <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tickFormatter={fmtDay}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                  }}
                  labelFormatter={(v) => fmtDay(String(v))}
                />
                <Legend />
                <Area
                  type="monotone"
                  dataKey="enviados"
                  stroke="hsl(var(--primary))"
                  fill="url(#g1)"
                />
                <Area
                  type="monotone"
                  dataKey="entregues"
                  stroke="hsl(var(--accent))"
                  fillOpacity={0}
                />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="card-premium border-0">
          <CardHeader>
            <CardTitle className="text-base">Saúde do envio</CardTitle>
            <CardDescription>Status do remetente e infraestrutura</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <HealthRow
              icon={<ShieldCheck className="h-4 w-4" />}
              label="Saúde do domínio"
              value={health?.sender_domain ?? "Não configurado"}
              tone={health?.sender_domain ? "ok" : "warn"}
            />
            <HealthRow
              icon={<Star className="h-4 w-4" />}
              label="Reputação do remetente"
              value="—"
              tone="muted"
            />
            <HealthRow
              icon={<Server className="h-4 w-4" />}
              label="SMTP"
              value={health?.smtp_active ? (health.smtp_name ?? "Ativo") : "Inativo"}
              tone={health?.smtp_active ? "ok" : "danger"}
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
                        "shrink-0 rounded px-1.5 py-0.5 border text-[10px] uppercase tracking-wider",
                        e.status === "sent" || e.status === "delivered"
                          ? "border-emerald-500/30 text-emerald-400 bg-emerald-500/10"
                          : e.status === "failed" || e.status === "dlq" || e.status === "error"
                            ? "border-rose-500/30 text-rose-400 bg-rose-500/10"
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
        <Card className="card-premium border-0">
          <CardHeader>
            <CardTitle className="text-base">Falhas no período</CardTitle>
          </CardHeader>
          <CardContent className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data?.by_day ?? []}>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tickFormatter={fmtDay}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                  }}
                  labelFormatter={(v) => fmtDay(String(v))}
                />
                <Legend />
                <Line type="monotone" dataKey="falharam" stroke="hsl(var(--destructive))" />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="card-premium border-0">
          <CardHeader>
            <CardTitle className="text-base">Conversões após email</CardTitle>
          </CardHeader>
          <CardContent className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data?.conversions_by_day ?? []}>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tickFormatter={fmtDay}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                  }}
                  labelFormatter={(v) => fmtDay(String(v))}
                />
                <Bar dataKey="conversoes" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
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
    ok: "text-emerald-400",
    warn: "text-amber-400",
    danger: "text-rose-400",
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
// SMTP
// ============================================================

function SmtpTab() {
  const [items, setItems] = useState<SmtpConfig[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SmtpConfig | null>(null);

  function novo() {
    setEditing({
      id: crypto.randomUUID(),
      nome: "",
      provedor: "",
      host: "",
      porta: 587,
      seguranca: "STARTTLS",
      usuario: "",
      senha: "",
      fromName: "",
      fromEmail: "",
      replyTo: "",
      limiteDiario: 10000,
      limiteHora: 500,
      status: "ativo",
      padrao: items.length === 0,
    });
    setOpen(true);
  }

  function salvar(cfg: SmtpConfig) {
    setItems((prev) => {
      const ex = prev.find((p) => p.id === cfg.id);
      const next = ex ? prev.map((p) => (p.id === cfg.id ? cfg : p)) : [...prev, cfg];
      return cfg.padrao ? next.map((p) => ({ ...p, padrao: p.id === cfg.id })) : next;
    });
    setOpen(false);
    toast.success(
      editing && items.find((i) => i.id === editing.id) ? "SMTP atualizado" : "SMTP criado",
    );
  }

  function excluir(id: string) {
    setItems((p) => p.filter((i) => i.id !== id));
    toast.success("SMTP removido");
  }

  function definirPadrao(id: string) {
    setItems((p) => p.map((i) => ({ ...i, padrao: i.id === id })));
  }

  function testar() {
    toast.info("Teste de conexão simulado — integre seu provedor SMTP para validar.");
  }

  return (
    <div className="space-y-4">
      <BusinessCodeEmailCard />
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Configurações SMTP</h2>
          <p className="text-xs text-muted-foreground">
            Cadastre servidores SMTP da sua empresa terceira de email
          </p>
        </div>
        <Button onClick={novo} className="gap-2">
          <Plus className="h-4 w-4" /> Novo servidor
        </Button>
      </div>

      {items.length === 0 ? (
        <Card className="card-premium border-0 p-10">
          <EmptyState
            icon={<Server className="h-6 w-6" />}
            title="Configure seu primeiro servidor SMTP"
            description="Adicione um servidor SMTP para começar a enviar emails profissionais pela BETLEADS."
            action={
              <Button onClick={novo} className="gap-2">
                <Plus className="h-4 w-4" /> Configurar servidor
              </Button>
            }
          />
        </Card>
      ) : (
        <Card className="card-premium border-0">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Provedor</TableHead>
                  <TableHead>Host</TableHead>
                  <TableHead>Remetente</TableHead>
                  <TableHead>Limites</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-[60px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {s.nome || "—"}
                        {s.padrao && (
                          <Badge
                            variant="outline"
                            className="border-primary/40 text-primary text-[10px]"
                          >
                            padrão
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{s.provedor || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.host}:{s.porta}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.fromName} &lt;{s.fromEmail}&gt;
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {s.limiteDiario}/dia · {s.limiteHora}/h
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={
                          s.status === "ativo"
                            ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                            : "bg-muted text-muted-foreground"
                        }
                      >
                        {s.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => {
                              setEditing(s);
                              setOpen(true);
                            }}
                          >
                            <Pencil className="h-4 w-4 mr-2" /> Editar
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={testar}>
                            <Activity className="h-4 w-4 mr-2" /> Testar conexão
                          </DropdownMenuItem>
                          {!s.padrao && (
                            <DropdownMenuItem onClick={() => definirPadrao(s.id)}>
                              <Star className="h-4 w-4 mr-2" /> Definir como padrão
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => excluir(s.id)}
                            className="text-rose-400 focus:text-rose-300"
                          >
                            <Trash2 className="h-4 w-4 mr-2" /> Excluir
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <SmtpDialog
        open={open}
        onOpenChange={setOpen}
        editing={editing}
        onSave={salvar}
        onTest={testar}
      />
    </div>
  );
}

function SmtpDialog({
  open,
  onOpenChange,
  editing,
  onSave,
  onTest,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: SmtpConfig | null;
  onSave: (s: SmtpConfig) => void;
  onTest: () => void;
}) {
  const [s, setS] = useState<SmtpConfig | null>(editing);
  useEffect(() => setS(editing), [editing]);
  if (!s) return null;
  const up = <K extends keyof SmtpConfig>(k: K, v: SmtpConfig[K]) =>
    setS((p) => (p ? { ...p, [k]: v } : p));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Servidor SMTP</DialogTitle>
          <DialogDescription>
            Configure os dados do servidor SMTP da sua empresa terceira.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Nome da configuração">
            <Input
              value={s.nome}
              onChange={(e) => up("nome", e.target.value)}
              placeholder="Ex: Principal"
            />
          </Field>
          <Field label="Provedor/empresa">
            <Input
              value={s.provedor}
              onChange={(e) => up("provedor", e.target.value)}
              placeholder="Brevo, Mailgun..."
            />
          </Field>
          <Field label="Host SMTP">
            <Input
              value={s.host}
              onChange={(e) => up("host", e.target.value)}
              placeholder="smtp.provedor.com"
            />
          </Field>
          <Field label="Porta">
            <Input
              type="number"
              value={s.porta}
              onChange={(e) => up("porta", Number(e.target.value))}
            />
          </Field>
          <Field label="Segurança">
            <Select value={s.seguranca} onValueChange={(v: any) => up("seguranca", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SSL/TLS">SSL/TLS</SelectItem>
                <SelectItem value="STARTTLS">STARTTLS</SelectItem>
                <SelectItem value="Nenhuma">Nenhuma</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Status">
            <Select value={s.status} onValueChange={(v: any) => up("status", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ativo">Ativo</SelectItem>
                <SelectItem value="inativo">Inativo</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Usuário SMTP">
            <Input value={s.usuario} onChange={(e) => up("usuario", e.target.value)} />
          </Field>
          <Field label="Senha SMTP">
            <Input type="password" value={s.senha} onChange={(e) => up("senha", e.target.value)} />
          </Field>
          <Field label="Nome do remetente">
            <Input
              value={s.fromName}
              onChange={(e) => up("fromName", e.target.value)}
              placeholder="BETLEADS"
            />
          </Field>
          <Field label="Email do remetente">
            <Input
              value={s.fromEmail}
              onChange={(e) => up("fromEmail", e.target.value)}
              placeholder="no-reply@dominio.com"
            />
          </Field>
          <Field label="Email de resposta">
            <Input
              value={s.replyTo}
              onChange={(e) => up("replyTo", e.target.value)}
              placeholder="suporte@dominio.com"
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Limite diário">
              <Input
                type="number"
                value={s.limiteDiario}
                onChange={(e) => up("limiteDiario", Number(e.target.value))}
              />
            </Field>
            <Field label="Limite por hora">
              <Input
                type="number"
                value={s.limiteHora}
                onChange={(e) => up("limiteHora", Number(e.target.value))}
              />
            </Field>
          </div>
          <div className="sm:col-span-2 flex items-center gap-3 pt-1">
            <Switch checked={s.padrao} onCheckedChange={(v) => up("padrao", v)} />
            <Label className="text-sm">Definir como padrão</Label>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onTest} className="gap-2">
            <Activity className="h-4 w-4" /> Testar conexão
          </Button>
          <Button onClick={() => onSave(s)} className="gap-2">
            <CheckCircle2 className="h-4 w-4" /> Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

// ============================================================
// Templates
// ============================================================

function TemplatesTab() {
  const listFn = useServerFn(listEmailTemplates);
  const saveFn = useServerFn(saveEmailTemplate);
  const delFn = useServerFn(deleteEmailTemplate);
  const dupFn = useServerFn(duplicateEmailTemplate);

  const q = useQuery({
    queryKey: ["email-templates"],
    queryFn: () => listFn(),
  });
  const items: Template[] = (q.data?.items ?? []) as any;

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
    if (!confirm("Excluir este template?")) return;
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
          <h2 className="text-lg font-semibold">Templates</h2>
          <p className="text-xs text-muted-foreground">
            Modelos reutilizáveis para campanhas e automações
          </p>
        </div>
        <Button onClick={novo} className="gap-2">
          <Plus className="h-4 w-4" /> Novo template
        </Button>
      </div>

      {items.length === 0 ? (
        <Card className="card-premium border-0 p-10">
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
            <Card key={t.id} className="card-premium border-0">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="text-base truncate">{t.nome || "Sem nome"}</CardTitle>
                    <CardDescription className="truncate">
                      {t.assunto || "(sem assunto)"}
                    </CardDescription>
                  </div>
                  <Badge
                    className={
                      t.ativo
                        ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                        : "bg-muted text-muted-foreground"
                    }
                  >
                    {t.ativo ? "ativo" : "pausado"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="text-xs text-muted-foreground line-clamp-3 min-h-[3em]">
                  {t.preheader || t.corpo || "Sem conteúdo ainda."}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="text-[10px]">
                    {t.categoria}
                  </Badge>
                  {t.tags.map((tag) => (
                    <Badge
                      key={tag}
                      variant="outline"
                      className="text-[10px] border-accent/30 text-accent"
                    >
                      #{tag}
                    </Badge>
                  ))}
                </div>
                <Separator />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Atualizado {t.atualizadoEm}</span>
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => toast.info("Preview em breve")}
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => {
                        setEditing(t);
                        setOpen(true);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => duplicar(t)}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => togglePause(t)}
                    >
                      {t.ativo ? (
                        <Pause className="h-3.5 w-3.5" />
                      ) : (
                        <Play className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-rose-400"
                      onClick={() => excluir(t.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
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
              <div className="text-[11px] text-muted-foreground">
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
              <div className="text-[11px] text-muted-foreground">
                Modo livre com blocos, IA, presets e HTML customizado.
              </div>
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const BLOCOS = [
  { id: "titulo", label: "Título", snippet: "<h1>Título</h1>" },
  { id: "texto", label: "Texto", snippet: "<p>Texto do email...</p>" },
  { id: "imagem", label: "Imagem", snippet: '<img src="" alt="" style="max-width:100%" />' },
  {
    id: "botao",
    label: "Botão",
    snippet:
      '<a href="{link_login}" style="background:#3b82f6;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;display:inline-block">Clique aqui</a>',
  },
  { id: "divisor", label: "Divisor", snippet: "<hr />" },
  {
    id: "rodape",
    label: "Rodapé",
    snippet:
      '<footer style="font-size:12px;color:#999">BETLEADS — você recebe pois é cadastrado.</footer>',
  },
  { id: "html", label: "HTML", snippet: "<!-- HTML customizado -->" },
];

function TemplateDialog({
  open,
  onOpenChange,
  editing,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: Template | null;
  onSave: (t: Template) => void;
}) {
  const [t, setT] = useState<Template | null>(editing);
  const [mode, setMode] = useState<"visual" | "html">("visual");
  const [tagInput, setTagInput] = useState("");
  useEffect(() => setT(editing), [editing]);
  if (!t) return null;
  const up = <K extends keyof Template>(k: K, v: Template[K]) =>
    setT((p) => (p ? { ...p, [k]: v } : p));

  function inserir(snippet: string) {
    up("corpo", (t!.corpo || "") + "\n" + snippet);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Template de email</DialogTitle>
          <DialogDescription>Monte o template com blocos visuais ou HTML.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Nome do template">
                <Input value={t.nome} onChange={(e) => up("nome", e.target.value)} />
              </Field>
              <Field label="Categoria">
                <Input value={t.categoria} onChange={(e) => up("categoria", e.target.value)} />
              </Field>
              <Field label="Assunto">
                <Input value={t.assunto} onChange={(e) => up("assunto", e.target.value)} />
              </Field>
              <Field label="Pré-header">
                <Input value={t.preheader} onChange={(e) => up("preheader", e.target.value)} />
              </Field>
              <Field label="Nome do remetente">
                <Input value={t.fromName} onChange={(e) => up("fromName", e.target.value)} />
              </Field>
              <Field label="Tags">
                <div className="flex gap-1.5">
                  <Input
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && tagInput.trim()) {
                        up("tags", [...t.tags, tagInput.trim()]);
                        setTagInput("");
                      }
                    }}
                    placeholder="enter para adicionar"
                  />
                </div>
              </Field>
            </div>

            {t.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {t.tags.map((tag) => (
                  <Badge
                    key={tag}
                    variant="outline"
                    className="text-[10px] cursor-pointer"
                    onClick={() =>
                      up(
                        "tags",
                        t.tags.filter((x) => x !== tag),
                      )
                    }
                  >
                    #{tag} ×
                  </Badge>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">Corpo do email</Label>
              <div className="flex rounded-md border border-border overflow-hidden">
                <button
                  className={cn(
                    "px-3 py-1 text-xs",
                    mode === "visual" ? "bg-primary/15 text-primary" : "text-muted-foreground",
                  )}
                  onClick={() => setMode("visual")}
                >
                  Visual
                </button>
                <button
                  className={cn(
                    "px-3 py-1 text-xs",
                    mode === "html" ? "bg-primary/15 text-primary" : "text-muted-foreground",
                  )}
                  onClick={() => setMode("html")}
                >
                  HTML
                </button>
              </div>
            </div>
            <Textarea
              value={t.corpo}
              onChange={(e) => up("corpo", e.target.value)}
              rows={12}
              className="font-mono text-xs"
              placeholder={
                mode === "html" ? "<!doctype html>..." : "Escreva o conteúdo ou insira blocos →"
              }
            />
          </div>

          <div className="space-y-3">
            <div>
              <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                <LayoutTemplate className="h-3.5 w-3.5" /> Blocos
              </Label>
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                {BLOCOS.map((b) => (
                  <Button
                    key={b.id}
                    variant="outline"
                    size="sm"
                    className="justify-start text-xs h-8"
                    onClick={() => inserir(b.snippet)}
                  >
                    <Plus className="h-3 w-3 mr-1" /> {b.label}
                  </Button>
                ))}
              </div>
            </div>

            <div>
              <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Variable className="h-3.5 w-3.5" /> Variáveis
              </Label>
              <div className="mt-2 flex flex-wrap gap-1">
                {VARIAVEIS.map((v) => (
                  <Badge
                    key={v}
                    variant="outline"
                    className="text-[10px] cursor-pointer hover:bg-primary/10"
                    onClick={() => inserir(v)}
                  >
                    {v}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => onSave(t)} className="gap-2">
            <CheckCircle2 className="h-4 w-4" /> Salvar template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// Campanhas
// ============================================================

function CampanhasTab() {
  const listFn = useServerFn(listEmailCampaigns);
  const saveFn = useServerFn(saveEmailCampaign);
  const delFn = useServerFn(deleteEmailCampaign);
  const dupFn = useServerFn(duplicateEmailCampaign);
  const statusFn = useServerFn(updateEmailCampaignStatus);
  const sendNowFn = useServerFn(sendEmailCampaignNow);

  const q = useQuery({
    queryKey: ["email-campaigns"],
    queryFn: () => listFn(),
    refetchInterval: (query) => {
      const items = (query.state.data as any)?.items ?? [];
      return items.some((c: any) => c.status === "enviando") ? 4000 : false;
    },
  });
  const items: Campanha[] = (q.data?.items ?? []) as any;

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Campanha | null>(null);
  const [failuresFor, setFailuresFor] = useState<Campanha | null>(null);
  const historyFn = useServerFn(getEmailHistory);
  const failuresQ = useQuery({
    queryKey: ["campaign-failures", failuresFor?.id],
    enabled: !!failuresFor?.id,
    queryFn: () =>
      historyFn({
        data: { status: "error", campaign_id: failuresFor!.id, limit: 200, offset: 0 },
      } as any),
  });

  function novo() {
    setEditing({
      id: "",
      nome: "",
      audienceMode: "segmento",
      segmento: "Todos",
      template: "",
      smtp: "",
      templateId: null,
      smtpId: null,
      status: "rascunho",
      enviados: 0,
      entregues: 0,
      abertos: 0,
      cliques: 0,
      falhas: 0,
      data: new Date().toLocaleDateString("pt-BR"),
      targetPlayerIds: [],
      extraEmails: [],
    });
    setOpen(true);
  }

  async function salvar(c: Campanha) {
    try {
      const mode = c.audienceMode ?? "segmento";
      await saveFn({
        data: {
          id: c.id || undefined,
          nome: c.nome,
          audienceMode: mode,
          segmento: c.segmento,
          template: c.template,
          smtp: c.smtp,
          templateId: c.templateId ?? null,
          smtpId: c.smtpId ?? null,
          agendadoPara: c.agendadoPara ?? null,
          status: c.status,
          targetPlayerIds: mode === "leads" ? (c.targetPlayerIds ?? []) : [],
          extraEmails: mode === "emails" ? (c.extraEmails ?? []) : [],
        },
      } as any);
      setOpen(false);
      toast.success("Campanha salva");
      q.refetch();
    } catch (e: any) {
      toast.error(e?.message ?? "Erro ao salvar");
    }
  }

  async function setStatus(id: string, status: CampStatus) {
    try {
      await statusFn({ data: { id, status } } as any);
      q.refetch();
    } catch (e: any) {
      toast.error(e?.message ?? "Erro");
    }
  }

  async function duplicar(c: Campanha) {
    try {
      await dupFn({ data: { id: c.id } } as any);
      q.refetch();
    } catch (e: any) {
      toast.error(e?.message ?? "Erro ao duplicar");
    }
  }

  async function excluir(c: Campanha) {
    if (!confirm(`Excluir a campanha "${c.nome}"?`)) return;
    try {
      await delFn({ data: { id: c.id } } as any);
      toast.success("Campanha removida");
      q.refetch();
    } catch (e: any) {
      toast.error(e?.message ?? "Erro ao excluir");
    }
  }

  async function enviarAgora(c: Campanha) {
    if (!c.templateId) {
      toast.error("Selecione um template antes de enviar.");
      return;
    }
    if (!confirm(`Disparar campanha "${c.nome}" agora para o segmento "${c.segmento}"?`)) return;
    const tid = toast.loading("Enviando campanha…");
    try {
      const r: any = await sendNowFn({ data: { campaignId: c.id } } as any);
      toast.success(
        `Campanha enviada: ${r.enviados} ok, ${r.pendentes ?? 0} pendentes, ${r.falhas} falhas (${r.total} destinatários).`,
        { id: tid },
      );
      q.refetch();
    } catch (e: any) {
      toast.error(e?.message ?? "Erro no envio", { id: tid });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Campanhas</h2>
          <p className="text-xs text-muted-foreground">Disparos pontuais para segmentos</p>
        </div>
        <Button onClick={novo} className="gap-2">
          <Plus className="h-4 w-4" /> Nova campanha
        </Button>
      </div>

      {items.length === 0 ? (
        <Card className="card-premium border-0 p-10">
          <EmptyState
            icon={<Megaphone className="h-6 w-6" />}
            title="Nenhuma campanha ainda"
            description="Crie sua primeira campanha de email para um segmento."
            action={
              <Button onClick={novo} className="gap-2">
                <Plus className="h-4 w-4" /> Nova campanha
              </Button>
            }
          />
        </Card>
      ) : (
        <Card className="card-premium border-0">
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Segmento</TableHead>
                  <TableHead>Template</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Enviados</TableHead>
                  <TableHead className="text-right">Entregues</TableHead>
                  <TableHead className="text-right">Abertos</TableHead>
                  <TableHead className="text-right">Cliques</TableHead>
                  <TableHead className="text-right">Falhas</TableHead>
                  <TableHead>Data</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.nome}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{c.segmento}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {c.template || "—"}
                    </TableCell>
                    <TableCell>
                      <StatusBadgeCampanha s={c.status} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{c.enviados}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.entregues}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.abertos}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.cliques}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c.falhas > 0 ? (
                        <button
                          type="button"
                          className="text-rose-400 underline-offset-2 hover:underline"
                          onClick={() => setFailuresFor(c)}
                          title="Ver detalhes das falhas"
                        >
                          {c.falhas}
                        </button>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{c.data}</TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => {
                              setEditing(c);
                              setOpen(true);
                            }}
                          >
                            <Pencil className="h-4 w-4 mr-2" /> Editar
                          </DropdownMenuItem>
                          {(c.status === "rascunho" ||
                            c.status === "agendada" ||
                            c.status === "pausada") && (
                            <DropdownMenuItem onClick={() => enviarAgora(c)}>
                              <Send className="h-4 w-4 mr-2" /> Enviar agora
                            </DropdownMenuItem>
                          )}
                          {c.status !== "pausada" ? (
                            <DropdownMenuItem onClick={() => setStatus(c.id, "pausada")}>
                              <Pause className="h-4 w-4 mr-2" /> Pausar
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onClick={() => setStatus(c.id, "enviando")}>
                              <Play className="h-4 w-4 mr-2" /> Retomar
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onClick={() => duplicar(c)}>
                            <Copy className="h-4 w-4 mr-2" /> Duplicar
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => excluir(c)} className="text-rose-400">
                            <Trash2 className="h-4 w-4 mr-2" /> Excluir
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <CampanhaDialog open={open} onOpenChange={setOpen} editing={editing} onSave={salvar} />

      <Dialog open={!!failuresFor} onOpenChange={(o) => !o && setFailuresFor(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Falhas — {failuresFor?.nome}</DialogTitle>
            <DialogDescription>
              Detalhe dos envios que não foram aceitos pelo provedor. Use a mensagem para corrigir o
              remetente, domínio ou destinatário.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto rounded-md border border-border/40">
            {failuresQ.isLoading ? (
              <div className="p-6 text-sm text-muted-foreground">Carregando…</div>
            ) : (failuresQ.data?.items ?? []).length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">Nenhuma falha registrada.</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Destinatário</TableHead>
                    <TableHead>Quando</TableHead>
                    <TableHead>Motivo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(failuresQ.data?.items ?? []).map((it: any) => (
                    <TableRow key={it.id}>
                      <TableCell className="font-mono text-xs">{it.recipient}</TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(it.created_at).toLocaleString("pt-BR")}
                      </TableCell>
                      <TableCell className="text-xs text-rose-300">
                        {it.error_summary ?? "Erro desconhecido"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFailuresFor(null)}>
              Fechar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusBadgeCampanha({ s }: { s: CampStatus }) {
  const map: Record<CampStatus, string> = {
    rascunho: "bg-muted text-muted-foreground",
    agendada: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    enviando: "bg-primary/15 text-primary border-primary/30",
    pausada: "bg-muted text-muted-foreground",
    concluida: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  };
  return <Badge className={map[s]}>{s}</Badge>;
}

function CampanhaDialog({
  open,
  onOpenChange,
  editing,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: Campanha | null;
  onSave: (c: Campanha) => void;
}) {
  const [c, setC] = useState<Campanha | null>(editing);
  const [agendar, setAgendar] = useState(false);
  const [audienceMode, setAudienceMode] = useState<"segmento" | "leads" | "emails">(
    editing?.audienceMode ?? ((editing?.targetPlayerIds?.length ?? 0) > 0 ? "leads" : "segmento"),
  );
  const [extraRaw, setExtraRaw] = useState<string>((editing?.extraEmails ?? []).join("\n"));
  const extraParsed = useMemo(() => parseExtraEmails(extraRaw), [extraRaw]);
  useEffect(() => {
    setC((p) => (p ? { ...p, extraEmails: extraParsed.valid } : p));
  }, [extraParsed.valid.join(",")]);
  useEffect(() => {
    const mode =
      editing?.audienceMode ??
      ((editing?.targetPlayerIds?.length ?? 0) > 0
        ? "leads"
        : (editing?.extraEmails?.length ?? 0) > 0
          ? "emails"
          : "segmento");
    setC(editing ? { ...editing, audienceMode: mode } : editing);
    setAgendar(Boolean(editing?.agendadoPara));
    setAudienceMode(mode);
    setExtraRaw((editing?.extraEmails ?? []).join("\n"));
  }, [editing]);

  const listTpl = useServerFn(listEmailTemplates);
  const listSmtp = useServerFn(listSmtpConfigs);
  const previewFn = useServerFn(previewSegmentCount);
  const sendNowFn = useServerFn(sendEmailCampaignNow);
  const saveFn = useServerFn(saveEmailCampaign);
  const getStatus = useServerFn(getEmailProviderStatus);

  const tplQ = useQuery({
    queryKey: ["email-templates-sel"],
    queryFn: () => listTpl(),
    enabled: open,
  });
  const smtpQ = useQuery({
    queryKey: ["email-smtp-sel"],
    queryFn: () => listSmtp(),
    enabled: open,
  });
  const provQ = useQuery({
    queryKey: ["email-provider-status"],
    queryFn: () => getStatus(),
    enabled: open,
  });
  const templates: any[] = (tplQ.data?.items ?? []) as any;
  const smtps: any[] = (smtpQ.data?.items ?? []) as any;
  const bcAtivo: boolean = Boolean((provQ.data as any)?.configured);

  // Pré-seleciona servidor em campanha nova: SMTP padrão > BusinessCode
  useEffect(() => {
    if (!c || c.smtpId) return;
    const padrao = smtps.find((s) => s.padrao);
    if (padrao) {
      setC((p) => (p ? { ...p, smtpId: padrao.id, smtp: padrao.nome } : p));
      return;
    }
    if (bcAtivo) {
      setC((p) => (p ? { ...p, smtpId: "businesscode", smtp: "BusinessCode" } : p));
    }
  }, [smtps, bcAtivo, c]);

  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!open || !c) return;
    const ids = c.targetPlayerIds ?? [];
    if (audienceMode === "emails") {
      setCount(extraParsed.valid.length);
      return;
    }
    if (audienceMode === "leads") {
      if (ids.length === 0) {
        setCount(0);
        return;
      }
    } else if (!c.segmento) {
      return;
    }
    setCount(null);
    previewFn({
      data:
        audienceMode === "leads"
          ? { audienceMode, targetPlayerIds: ids }
          : { audienceMode, segmento: c.segmento, extraEmails: extraParsed.valid },
    } as any)
      .then((r: any) => setCount(r.total))
      .catch(() => setCount(null));
  }, [open, audienceMode, c?.segmento, c?.targetPlayerIds, extraParsed.valid.join(","), previewFn]);

  if (!c) return null;
  const up = <K extends keyof Campanha>(k: K, v: Campanha[K]) =>
    setC((p) => (p ? { ...p, [k]: v } : p));

  async function enviarAgoraDoDialogo() {
    if (!c) return;
    if (!c.templateId) {
      toast.error("Selecione um template antes de enviar.");
      return;
    }
    if (!c.nome.trim()) {
      toast.error("Dê um nome para a campanha.");
      return;
    }
    if (audienceMode === "emails" && extraParsed.valid.length === 0) {
      toast.error("Informe pelo menos um email avulso válido.");
      return;
    }
    if (audienceMode === "leads" && (c.targetPlayerIds?.length ?? 0) === 0) {
      toast.error("Selecione pelo menos um lead com email.");
      return;
    }
    const tid = toast.loading("Salvando e enviando…");
    try {
      // Garante que a campanha está salva antes do envio
      const saved: any = await saveFn({
        data: {
          id: c.id || undefined,
          nome: c.nome,
          audienceMode,
          segmento: c.segmento,
          template: c.template,
          smtp: c.smtp,
          templateId: c.templateId ?? null,
          smtpId: c.smtpId ?? null,
          agendadoPara: null,
          status: "enviando",
          targetPlayerIds: audienceMode === "leads" ? (c.targetPlayerIds ?? []) : [],
          extraEmails: audienceMode === "emails" ? extraParsed.valid : [],
        },
      } as any);
      const id = saved?.id || c.id;
      const r: any = await sendNowFn({ data: { campaignId: id } } as any);
      toast.success(
        `Aceito pela BusinessCode: ${r.enviados} encaminhados, ${r.pendentes ?? 0} pendentes, ${r.falhas} falhas (${r.total} destinatários).`,
        { id: tid },
      );
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e?.message ?? "Erro no envio", { id: tid });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Campanha de email</DialogTitle>
          <DialogDescription>Defina destino, template e envio.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Nome da campanha">
            <Input value={c.nome} onChange={(e) => up("nome", e.target.value)} />
          </Field>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Destinatários</Label>
            <Tabs
              value={audienceMode}
              onValueChange={(v) => {
                const mode = v === "leads" ? "leads" : v === "emails" ? "emails" : "segmento";
                setAudienceMode(mode);
                if (mode === "segmento") {
                  setC((p) =>
                    p ? { ...p, audienceMode: mode, targetPlayerIds: [], extraEmails: [] } : p,
                  );
                } else if (mode === "leads") {
                  setC((p) =>
                    p
                      ? {
                          ...p,
                          audienceMode: mode,
                          targetPlayerIds: p.targetPlayerIds ?? [],
                          extraEmails: [],
                        }
                      : p,
                  );
                } else {
                  setC((p) =>
                    p
                      ? {
                          ...p,
                          audienceMode: mode,
                          targetPlayerIds: [],
                          extraEmails: extraParsed.valid,
                        }
                      : p,
                  );
                }
              }}
            >
              <TabsList className="grid grid-cols-3 h-8 w-full">
                <TabsTrigger value="segmento" className="text-xs">
                  <Filter className="h-3 w-3 mr-1" /> Segmento
                </TabsTrigger>
                <TabsTrigger value="leads" className="text-xs">
                  <Users className="h-3 w-3 mr-1" /> Leads específicos
                </TabsTrigger>
                <TabsTrigger value="emails" className="text-xs">
                  <Mail className="h-3 w-3 mr-1" /> Avulsos
                </TabsTrigger>
              </TabsList>
              <TabsContent value="segmento" className="mt-2">
                <Select value={c.segmento} onValueChange={(v) => up("segmento", v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {SEGMENTOS.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TabsContent>
              <TabsContent value="leads" className="mt-2">
                <LeadEmailPicker
                  selectedIds={c.targetPlayerIds ?? []}
                  onChange={(ids) => setC((p) => (p ? { ...p, targetPlayerIds: ids } : p))}
                />
              </TabsContent>
              <TabsContent value="emails" className="mt-2 space-y-1.5">
                <Textarea
                  value={extraRaw}
                  onChange={(e) => setExtraRaw(e.target.value)}
                  placeholder="Cole os emails (um por linha ou separados por vírgula)"
                  className="min-h-[110px] font-mono text-xs"
                />
                <p className="text-[11px] text-muted-foreground">
                  {extraParsed.valid.length} email{extraParsed.valid.length === 1 ? "" : "s"} avulso
                  {extraParsed.valid.length === 1 ? "" : "s"} válido
                  {extraParsed.valid.length === 1 ? "" : "s"}
                  {extraParsed.invalid > 0 && (
                    <span className="text-amber-500/80">
                      {" "}
                      · {extraParsed.invalid} ignorado{extraParsed.invalid > 1 ? "s" : ""} (formato
                      inválido)
                    </span>
                  )}
                  . Não serão somados aos contatos da base.
                </p>
              </TabsContent>
            </Tabs>
            {count !== null && (
              <p className="text-[11px] text-muted-foreground mt-1">
                ≈ {count.toLocaleString("pt-BR")} destinatário(s) com email
              </p>
            )}
          </div>
          <Field label="Template">
            <Select
              value={c.templateId ?? ""}
              onValueChange={(v) => {
                const t = templates.find((x) => x.id === v);
                setC((p) => (p ? { ...p, templateId: v, template: t?.nome ?? "" } : p));
              }}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    templates.length ? "Selecionar template" : "Crie um template primeiro"
                  }
                />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.nome}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Servidor de envio">
            <Select
              value={c.smtpId ?? ""}
              onValueChange={(v) => {
                if (v === "businesscode") {
                  setC((p) => (p ? { ...p, smtpId: "businesscode", smtp: "BusinessCode" } : p));
                  return;
                }
                const s = smtps.find((x) => x.id === v);
                setC((p) => (p ? { ...p, smtpId: v, smtp: s?.nome ?? "" } : p));
              }}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    bcAtivo || smtps.length ? "Selecionar servidor" : "Cadastre um SMTP primeiro"
                  }
                />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {bcAtivo && (
                  <SelectItem value="businesscode">Provedor de Email (BusinessCode)</SelectItem>
                )}
                {smtps.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.nome}
                    {s.padrao ? " · padrão" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="sm:col-span-2 flex items-center gap-3">
            <Switch
              checked={agendar}
              onCheckedChange={(v) => {
                setAgendar(v);
                if (!v) up("agendadoPara", undefined);
                if (v) up("status", "agendada");
              }}
            />
            <Label className="text-sm">Agendar envio</Label>
          </div>
          {agendar && (
            <Field label="Agendar para">
              <Input
                type="datetime-local"
                value={c.agendadoPara ?? ""}
                onChange={(e) => up("agendadoPara", e.target.value)}
              />
            </Field>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onSave(c)} className="gap-2">
            <CheckCircle2 className="h-4 w-4" />
            {agendar ? "Salvar agendamento" : "Salvar rascunho"}
          </Button>
          {!agendar && (
            <Button onClick={enviarAgoraDoDialogo} className="gap-2">
              <Send className="h-4 w-4" /> Enviar agora
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// Automações
// ============================================================

function AutomacoesTab() {
  const [sub, setSub] = useState<"fluxos" | "historico" | "logs">("fluxos");
  return (
    <div className="space-y-4">
      <Tabs value={sub} onValueChange={(v) => setSub(v as typeof sub)}>
        <TabsList>
          <TabsTrigger value="fluxos">Fluxos</TabsTrigger>
          <TabsTrigger value="historico">Histórico</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>
        <TabsContent value="fluxos" className="mt-3">
          <FluxosList />
        </TabsContent>
        <TabsContent value="historico" className="mt-3">
          <FluxosHistorico />
        </TabsContent>
        <TabsContent value="logs" className="mt-3">
          <FluxosLogs />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------- Lista de fluxos ----------
function FluxosList() {
  const listFn = useServerFn(listEmailFlows);
  const toggleFn = useServerFn(toggleEmailFlow);
  const delFn = useServerFn(deleteEmailFlow);
  const dupFn = useServerFn(duplicateEmailFlow);
  const { data, refetch, isLoading } = useQuery({
    queryKey: ["email-flows"],
    queryFn: () => listFn(),
  });
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  function novo() {
    setEditingId(null);
    setEditorOpen(true);
  }
  function abrirEditor(id: string | null) {
    setEditingId(id);
    setEditorOpen(true);
  }

  const flows = data?.flows ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Automações</h2>
          <p className="text-xs text-muted-foreground">Construtor visual de fluxos por gatilho</p>
        </div>
        <Button onClick={novo} className="gap-2">
          <Plus className="h-4 w-4" /> Nova automação
        </Button>
      </div>
      {isLoading ? (
        <Card className="card-premium border-0 p-6 text-xs text-muted-foreground">Carregando…</Card>
      ) : flows.length === 0 ? (
        <Card className="card-premium border-0 p-10">
          <EmptyState
            icon={<Workflow className="h-6 w-6" />}
            title="Nenhuma automação criada"
            description="Monte um fluxo visual por blocos, selecionando um gatilho real do sistema."
            action={
              <Button onClick={novo} className="gap-2">
                <Plus className="h-4 w-4" /> Nova automação
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {flows.map((f) => (
            <Card key={f.id} className="card-premium border-0">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="text-base truncate">{f.name}</CardTitle>
                    <CardDescription className="flex flex-wrap gap-1 mt-1">
                      <Badge variant="outline" className="text-[10px] border-accent/30 text-accent">
                        {triggerLabel(f.trigger_type)}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {f.counts.blocks} etapa{f.counts.blocks !== 1 ? "s" : ""}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {f.counts.active_leads} leads ativos
                      </Badge>
                    </CardDescription>
                  </div>
                  <Switch
                    checked={f.active}
                    onCheckedChange={async (v) => {
                      try {
                        await toggleFn({ data: { id: f.id, active: v } });
                        refetch();
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "Falha");
                      }
                    }}
                  />
                </div>
              </CardHeader>
              <CardContent className="space-y-3 text-xs">
                <div className="grid grid-cols-2 gap-2 text-muted-foreground">
                  <div>
                    Cooldown: <span className="text-foreground">{f.cooldown_hours}h</span>
                  </div>
                  <div className="col-span-2">
                    Última execução:{" "}
                    <span className="text-foreground">
                      {f.last_run_at ? new Date(f.last_run_at).toLocaleString("pt-BR") : "—"}
                    </span>
                  </div>
                </div>
                <div className="flex items-center justify-end gap-1 pt-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1"
                    onClick={() => abrirEditor(f.id)}
                  >
                    <Pencil className="h-3.5 w-3.5" /> Editar
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    title="Duplicar"
                    onClick={async () => {
                      try {
                        await dupFn({ data: { id: f.id } });
                        refetch();
                        toast.success("Duplicado");
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "Falha");
                      }
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-rose-400"
                    title="Excluir"
                    onClick={async () => {
                      if (!confirm("Excluir esta automação?")) return;
                      try {
                        await delFn({ data: { id: f.id } });
                        refetch();
                        toast.success("Excluído");
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "Falha");
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {editorOpen && (
        <FlowBuilderDialog
          flowId={editingId}
          onClose={() => {
            setEditorOpen(false);
            refetch();
          }}
        />
      )}
    </div>
  );
}

// ---------- Flow builder ----------
function FlowBuilderDialog({ flowId, onClose }: { flowId: string | null; onClose: () => void }) {
  const getFn = useServerFn(getEmailFlow);
  const saveFn = useServerFn(saveEmailFlow);
  const testFn = useServerFn(triggerEmailFlowTest);
  const tplListFn = useServerFn(listEmailTemplates);
  const smtpListFn = useServerFn(listSmtpConfigs);

  const { data: tplData } = useQuery({ queryKey: ["email-templates"], queryFn: () => tplListFn() });
  const { data: smtpData } = useQuery({ queryKey: ["email-smtp"], queryFn: () => smtpListFn() });
  const templates = (tplData?.items ?? []) as Array<{ id: string; nome?: string; name?: string }>;
  const smtps = (smtpData?.items ?? []) as Array<{ id: string; name?: string; nome?: string }>;

  const [loading, setLoading] = useState(!!flowId);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<EmailTrigger>("cadastrados_sem_deposito");
  const [active, setActive] = useState(false);
  const [cooldownH, setCooldownH] = useState(72);
  const [exits, setExits] = useState<Record<string, boolean>>(defaultExitConditions());
  const [blocks, setBlocks] = useState<EmailFlowBlockDraft[]>(() => [
    { ...emptyBlock("send_email"), label: "Enviar email" },
    { ...emptyBlock("end"), label: "Encerrar fluxo" },
  ]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!flowId) return;
    (async () => {
      try {
        const r = await getFn({ data: { id: flowId } });
        if (!r.flow) return;
        setName(r.flow.name);
        setTrigger(r.flow.trigger_type as EmailTrigger);
        setActive(r.flow.active);
        setCooldownH(r.flow.cooldown_hours);
        setExits({
          ...defaultExitConditions(),
          ...(r.flow.exit_conditions as Record<string, boolean>),
        });
        setBlocks(
          r.blocks.map((b) => ({
            id: b.id,
            block_type: b.block_type as EmailFlowBlockDraft["block_type"],
            template_ids: (b.template_ids as string[]) ?? [],
            sender_id: b.sender_id,
            smtp_config_id: b.smtp_config_id,
            subject_override: b.subject_override,
            preheader_override: b.preheader_override,
            pre_delay_seconds: b.pre_delay_seconds ?? 0,
            delay_seconds: b.delay_seconds ?? 0,
            condition_type: b.condition_type,
            condition_value: b.condition_value,
            label: b.label,
          })),
        );
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Falha ao carregar");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId]);

  function moveBlock(i: number, dir: -1 | 1) {
    setBlocks((bs) => {
      const j = i + dir;
      if (j < 0 || j >= bs.length) return bs;
      const copy = bs.slice();
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  }
  function insertBlock(at: number, type: EmailFlowBlockDraft["block_type"]) {
    setBlocks((bs) => [...bs.slice(0, at), emptyBlock(type), ...bs.slice(at)]);
  }
  function removeBlock(i: number) {
    setBlocks((bs) => bs.filter((_, k) => k !== i));
  }
  function updateBlock(i: number, patch: Partial<EmailFlowBlockDraft>) {
    setBlocks((bs) => bs.map((b, k) => (k === i ? { ...b, ...patch } : b)));
  }

  async function salvar() {
    if (!name.trim()) {
      toast.error("Informe um nome");
      return;
    }
    // Validações
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.block_type === "send_email" && b.template_ids.length === 0) {
        toast.error(`Bloco ${i + 1}: selecione pelo menos um template`);
        return;
      }
      if (b.block_type === "delay" && b.delay_seconds <= 0) {
        toast.error(`Bloco ${i + 1}: delay precisa ser maior que zero`);
        return;
      }
    }
    setSaving(true);
    try {
      const r = await saveFn({
        data: {
          id: flowId ?? undefined,
          name: name.trim(),
          trigger_type: trigger,
          active,
          daily_limit: 999999,
          cooldown_hours: cooldownH,
          exit_conditions: exits as never,
          blocks: blocks.map((b) => ({
            block_type: b.block_type,
            template_ids: b.template_ids,
            sender_id: b.sender_id ?? null,
            smtp_config_id: b.smtp_config_id ?? null,
            subject_override: b.subject_override,
            preheader_override: b.preheader_override,
            pre_delay_seconds: b.pre_delay_seconds,
            delay_seconds: b.delay_seconds,
            condition_type: b.condition_type,
            condition_value: b.condition_value,
            label: b.label,
          })),
        },
      });
      toast.success("Automação salva");
      onClose();
      void r;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao salvar");
    } finally {
      setSaving(false);
    }
  }

  async function dispararTeste() {
    if (!flowId) {
      toast.error("Salve a automação antes de testar");
      return;
    }
    const email = prompt("Email do destinatário para teste:");
    if (!email) return;
    try {
      await testFn({ data: { flow_id: flowId, email } });
      toast.success("Teste enfileirado");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha no teste");
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{flowId ? "Editar automação" : "Nova automação"}</DialogTitle>
          <DialogDescription>
            Fluxo visual por blocos. Use M1/M2 para randomizar modelos.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="text-xs text-muted-foreground p-6">Carregando…</div>
        ) : (
          <div className="space-y-5">
            {/* Header */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Nome da automação">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ex.: Conversão 7 dias"
                />
              </Field>
              <Field label="Gatilho">
                <Select value={trigger} onValueChange={(v) => setTrigger(v as EmailTrigger)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EMAIL_TRIGGERS.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Cooldown (horas)">
                <Input
                  type="number"
                  value={cooldownH}
                  onChange={(e) => setCooldownH(Math.max(0, Number(e.target.value) || 0))}
                />
              </Field>
              <div className="sm:col-span-2">
                <Label className="text-xs text-muted-foreground">Condições de saída</Label>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {EMAIL_EXIT_CONDITIONS.map((s) => {
                    const on = !!exits[s.value];
                    return (
                      <button
                        key={s.value}
                        type="button"
                        onClick={() => setExits((p) => ({ ...p, [s.value]: !on }))}
                        className={cn(
                          "px-2.5 py-1 rounded-md text-xs border transition-colors",
                          on
                            ? "border-primary/40 bg-primary/15 text-primary"
                            : "border-border text-muted-foreground hover:bg-muted/40",
                        )}
                      >
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="sm:col-span-2 flex items-center gap-3">
                <Switch checked={active} onCheckedChange={setActive} />
                <Label className="text-sm">Automação ativa</Label>
              </div>
            </div>

            <Separator />

            {/* Canvas de blocos */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Fluxo</h3>
                <div className="text-[10px] text-muted-foreground">
                  {blocks.length} bloco{blocks.length !== 1 ? "s" : ""}
                </div>
              </div>

              {/* Início fixo */}
              <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 flex items-center gap-2 text-xs">
                <Play className="h-3.5 w-3.5 text-accent" />
                <span className="font-medium">Início</span>
                <Badge variant="outline" className="text-[10px] border-accent/30 text-accent">
                  {triggerLabel(trigger)}
                </Badge>
              </div>

              {blocks.map((b, i) => (
                <div key={b.id}>
                  <div className="flex justify-center">
                    <ArrowDown className="h-3 w-3 text-muted-foreground" />
                  </div>
                  <BlockEditor
                    index={i}
                    block={b}
                    templates={templates}
                    smtps={smtps}
                    onChange={(patch) => updateBlock(i, patch)}
                    onRemove={() => removeBlock(i)}
                    onMove={(dir) => moveBlock(i, dir)}
                  />
                  <div className="flex justify-center mt-1">
                    <InsertBlockButton onInsert={(t) => insertBlock(i + 1, t)} />
                  </div>
                </div>
              ))}

              {blocks.length === 0 && (
                <div className="flex justify-center py-3">
                  <InsertBlockButton onInsert={(t) => insertBlock(0, t)} />
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          {flowId && (
            <Button variant="outline" onClick={dispararTeste} className="gap-2">
              <FlaskConical className="h-4 w-4" /> Disparar teste
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={salvar} disabled={saving} className="gap-2">
            <CheckCircle2 className="h-4 w-4" /> {saving ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Block editor ----------
function BlockEditor({
  index,
  block,
  templates,
  smtps,
  onChange,
  onRemove,
  onMove,
}: {
  index: number;
  block: EmailFlowBlockDraft;
  templates: Array<{ id: string; name?: string; nome?: string }>;
  smtps: Array<{ id: string; name?: string; nome?: string }>;
  onChange: (patch: Partial<EmailFlowBlockDraft>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const meta = blockMeta(block.block_type);
  return (
    <div className="rounded-lg border border-border bg-card/40 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="inline-flex items-center justify-center h-6 w-6 rounded bg-primary/15 text-primary">
            {meta.icon}
          </span>
          <span className="font-medium">{meta.title}</span>
          {block.label && (
            <Badge variant="outline" className="text-[10px]">
              {block.label}
            </Badge>
          )}
          <span className="text-muted-foreground">#{index + 1}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={() => onMove(-1)}
            title="Subir"
          >
            <ArrowUp className="h-3 w-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={() => onMove(1)}
            title="Descer"
          >
            <ArrowDown className="h-3 w-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 text-rose-400"
            onClick={onRemove}
            title="Remover"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {block.block_type === "send_email" && (
        <div className="space-y-2">
          <Field label="Templates (selecione 1 ou mais — múltiplos = randomização M1/M2)">
            <div className="border rounded-md p-2 max-h-40 overflow-y-auto space-y-1">
              {templates.length === 0 && (
                <div className="text-xs text-muted-foreground">Nenhum template disponível</div>
              )}
              {templates.map((t) => {
                const checked = block.template_ids.includes(t.id);
                return (
                  <label
                    key={t.id}
                    className="flex items-center gap-2 text-xs cursor-pointer hover:bg-muted/40 px-1 py-0.5 rounded"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...block.template_ids, t.id]
                          : block.template_ids.filter((x) => x !== t.id);
                        onChange({ template_ids: next });
                      }}
                    />
                    <span className="truncate">{t.name ?? t.nome ?? t.id.slice(0, 8)}</span>
                  </label>
                );
              })}
            </div>
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Field label="SMTP (opcional)">
              <Select
                value={block.smtp_config_id ?? "__none"}
                onValueChange={(v) => onChange({ smtp_config_id: v === "__none" ? null : v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Padrão" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">Usar padrão</SelectItem>
                  {smtps.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name ?? s.nome ?? s.id.slice(0, 8)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Delay antes (segundos)">
              <Input
                type="number"
                value={block.pre_delay_seconds}
                onChange={(e) =>
                  onChange({ pre_delay_seconds: Math.max(0, Number(e.target.value) || 0) })
                }
              />
            </Field>
            <Field label="Assunto (override)">
              <Input
                value={block.subject_override ?? ""}
                onChange={(e) => onChange({ subject_override: e.target.value || null })}
                placeholder="Usa o do template"
              />
            </Field>
            <Field label="Pré-header (override)">
              <Input
                value={block.preheader_override ?? ""}
                onChange={(e) => onChange({ preheader_override: e.target.value || null })}
                placeholder="Usa o do template"
              />
            </Field>
          </div>
        </div>
      )}

      {block.block_type === "delay" && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Quantidade">
            <Input
              type="number"
              value={Math.max(1, Math.round(block.delay_seconds / delayUnitSec(block)))}
              onChange={(e) =>
                onChange({
                  delay_seconds: Math.max(1, Number(e.target.value) || 1) * delayUnitSec(block),
                })
              }
            />
          </Field>
          <Field label="Unidade">
            <Select
              value={delayUnit(block)}
              onValueChange={(u) => {
                const qty = Math.max(1, Math.round(block.delay_seconds / delayUnitSec(block)));
                const newSec =
                  qty * ({ seg: 1, min: 60, h: 3600, dia: 86400 } as Record<string, number>)[u];
                onChange({ delay_seconds: newSec });
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="seg">Segundos</SelectItem>
                <SelectItem value="min">Minutos</SelectItem>
                <SelectItem value="h">Horas</SelectItem>
                <SelectItem value="dia">Dias</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="col-span-2 text-[11px] text-muted-foreground">
            Total: {formatDelay(block.delay_seconds)}
          </div>
        </div>
      )}

      {(block.block_type === "condition" || block.block_type === "tag") && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Tipo">
            <Input
              value={block.condition_type ?? ""}
              onChange={(e) => onChange({ condition_type: e.target.value || null })}
            />
          </Field>
          <Field label="Valor">
            <Input
              value={block.condition_value ?? ""}
              onChange={(e) => onChange({ condition_value: e.target.value || null })}
            />
          </Field>
        </div>
      )}

      {(block.block_type === "remove" || block.block_type === "end") && (
        <div className="text-xs text-muted-foreground">
          Encerra a participação do lead neste fluxo.
        </div>
      )}
    </div>
  );
}

function blockMeta(t: EmailFlowBlockDraft["block_type"]) {
  switch (t) {
    case "send_email":
      return { title: "Enviar email", icon: <Mail className="h-3.5 w-3.5" /> };
    case "delay":
      return { title: "Delay", icon: <Clock className="h-3.5 w-3.5" /> };
    case "condition":
      return { title: "Condição", icon: <GitBranch className="h-3.5 w-3.5" /> };
    case "tag":
      return { title: "Tag", icon: <TagIcon className="h-3.5 w-3.5" /> };
    case "remove":
      return { title: "Remover do fluxo", icon: <UserMinus className="h-3.5 w-3.5" /> };
    case "end":
      return { title: "Encerrar fluxo", icon: <StopCircle className="h-3.5 w-3.5" /> };
    default:
      return { title: t, icon: <Workflow className="h-3.5 w-3.5" /> };
  }
}

function delayUnit(b: EmailFlowBlockDraft): "seg" | "min" | "h" | "dia" {
  const s = b.delay_seconds;
  if (s % 86400 === 0 && s >= 86400) return "dia";
  if (s % 3600 === 0 && s >= 3600) return "h";
  if (s % 60 === 0 && s >= 60) return "min";
  return "seg";
}
function delayUnitSec(b: EmailFlowBlockDraft): number {
  return ({ seg: 1, min: 60, h: 3600, dia: 86400 } as Record<string, number>)[delayUnit(b)];
}

function InsertBlockButton({
  onInsert,
}: {
  onInsert: (t: EmailFlowBlockDraft["block_type"]) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1 text-xs">
          <Plus className="h-3 w-3" /> Inserir bloco
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center">
        <DropdownMenuItem onClick={() => onInsert("send_email")}>
          <Mail className="h-3.5 w-3.5 mr-2" /> Enviar email
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onInsert("delay")}>
          <Clock className="h-3.5 w-3.5 mr-2" /> Delay
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onInsert("condition")}>
          <GitBranch className="h-3.5 w-3.5 mr-2" /> Condição
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onInsert("tag")}>
          <TagIcon className="h-3.5 w-3.5 mr-2" /> Tag
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onInsert("remove")}>
          <UserMinus className="h-3.5 w-3.5 mr-2" /> Remover do fluxo
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onInsert("end")}>
          <StopCircle className="h-3.5 w-3.5 mr-2" /> Encerrar fluxo
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------- Histórico de leads ----------
function FluxosHistorico() {
  const listFlowsFn = useServerFn(listEmailFlows);
  const listLeadsFn = useServerFn(listEmailFlowLeads);
  const { data: flowsData } = useQuery({ queryKey: ["email-flows"], queryFn: () => listFlowsFn() });
  const [flowId, setFlowId] = useState<string>("__all");
  const { data, refetch } = useQuery({
    queryKey: ["email-flow-leads", flowId],
    queryFn: () =>
      listLeadsFn({ data: { flow_id: flowId === "__all" ? undefined : flowId, limit: 100 } }),
  });
  useEffect(() => {
    refetch();
  }, [flowId, refetch]);
  const leads = data?.leads ?? [];
  const flowsMap = new Map((flowsData?.flows ?? []).map((f) => [f.id, f.name]));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Select value={flowId} onValueChange={setFlowId}>
          <SelectTrigger className="w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">Todos os fluxos</SelectItem>
            {(flowsData?.flows ?? []).map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Card className="card-premium border-0">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lead</TableHead>
                <TableHead>Fluxo</TableHead>
                <TableHead>Etapa</TableHead>
                <TableHead>Próximo envio</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Motivo de saída</TableHead>
                <TableHead>Entrada</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leads.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-xs text-muted-foreground py-6">
                    Sem leads
                  </TableCell>
                </TableRow>
              )}
              {leads.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="text-xs">{l.email}</TableCell>
                  <TableCell className="text-xs">
                    {flowsMap.get(l.flow_id) ?? l.flow_id.slice(0, 8)}
                  </TableCell>
                  <TableCell className="text-xs">#{l.current_block_index}</TableCell>
                  <TableCell className="text-xs">
                    {l.next_run_at ? new Date(l.next_run_at).toLocaleString("pt-BR") : "—"}
                  </TableCell>
                  <TableCell className="text-xs">
                    <Badge variant="outline" className="text-[10px]">
                      {l.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {l.exit_reason ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {new Date(l.entered_at).toLocaleString("pt-BR")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- Logs ----------
function FluxosLogs() {
  const listFlowsFn = useServerFn(listEmailFlows);
  const listLogsFn = useServerFn(listEmailFlowLogs);
  const { data: flowsData } = useQuery({ queryKey: ["email-flows"], queryFn: () => listFlowsFn() });
  const [flowId, setFlowId] = useState<string>("__all");
  const { data, refetch } = useQuery({
    queryKey: ["email-flow-logs", flowId],
    queryFn: () =>
      listLogsFn({ data: { flow_id: flowId === "__all" ? undefined : flowId, limit: 200 } }),
  });
  useEffect(() => {
    refetch();
  }, [flowId, refetch]);
  const logs = data?.logs ?? [];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Select value={flowId} onValueChange={setFlowId}>
          <SelectTrigger className="w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">Todos os fluxos</SelectItem>
            {(flowsData?.flows ?? []).map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Card className="card-premium border-0">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>Evento</TableHead>
                <TableHead>Lead</TableHead>
                <TableHead>Detalhe</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-xs text-muted-foreground py-6">
                    Sem logs
                  </TableCell>
                </TableRow>
              )}
              {logs.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="text-xs">
                    {new Date(l.created_at).toLocaleString("pt-BR")}
                  </TableCell>
                  <TableCell className="text-xs">
                    <Badge variant="outline" className="text-[10px]">
                      {l.event}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">{l.flow_lead_id?.slice(0, 8) ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground font-mono break-all">
                    {JSON.stringify(l.detail)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
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

// ============================================================
// Provedor BusinessCode (envio real via API)
// ============================================================

function BusinessCodeEmailCard() {
  const getStatus = useServerFn(getEmailProviderStatus);
  const { data: status } = useQuery({
    queryKey: ["email-provider-status"],
    queryFn: () => getStatus(),
  });

  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [subject, setSubject] = useState("Teste de envio — BetLeads");
  const [html, setHtml] = useState(
    "<h1>Olá {primeiro_nome}!</h1><p>Este é um teste de envio via BusinessCode.</p>",
  );
  const [sending, setSending] = useState(false);

  const sendTest = useServerFn(sendTestEmail);

  async function enviar() {
    if (!to || !fromEmail || !subject || !html) {
      toast.error("Preencha destinatário, remetente, assunto e conteúdo.");
      return;
    }
    setSending(true);
    try {
      await sendTest({
        data: {
          to,
          subject,
          html,
          fromEmail,
          fromName: fromName || null,
          replyTo: replyTo || null,
        },
      });
      toast.success("Email aceito pela BusinessCode. Aguarde a entrega na caixa de entrada.");
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha no envio");
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="h-4 w-4 text-primary" />
            Provedor de Email (BusinessCode)
          </CardTitle>
          <CardDescription className="text-xs">
            Endpoint:{" "}
            <code className="text-[11px]">dash.businesscode.com.br/api/v1/messaging/email</code>
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {status?.configured ? (
            <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
              <CheckCircle2 className="h-3 w-3 mr-1" /> Token ativo
            </Badge>
          ) : (
            <Badge variant="destructive">
              <AlertTriangle className="h-3 w-3 mr-1" /> Token ausente
            </Badge>
          )}
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <Send className="h-3.5 w-3.5 mr-1" /> Enviar teste
          </Button>
        </div>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground space-y-1">
        <p>
          O envio usa o secret <code>BUSINESSCODE_EMAIL_TOKEN</code>. O domínio do remetente precisa
          estar verificado em <em>Configurações &gt; Domínios de Email</em> na BusinessCode.
        </p>
        <p>
          Variáveis no conteúdo (ex.: <code>{"{primeiro_nome}"}</code>, <code>{"{saldo}"}</code>)
          são substituídas automaticamente quando o destinatário existe no CRM.
        </p>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Enviar email de teste</DialogTitle>
            <DialogDescription>
              Envio único via API BusinessCode. O log fica em Histórico.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Para</Label>
                <Input
                  type="email"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="cliente@exemplo.com"
                />
              </div>
              <div>
                <Label className="text-xs">De (email verificado)</Label>
                <Input
                  type="email"
                  value={fromEmail}
                  onChange={(e) => setFromEmail(e.target.value)}
                  placeholder="contato@seudominio.com"
                />
              </div>
              <div>
                <Label className="text-xs">Nome do remetente</Label>
                <Input
                  value={fromName}
                  onChange={(e) => setFromName(e.target.value)}
                  placeholder="BetLeads"
                />
              </div>
              <div>
                <Label className="text-xs">Reply-to (opcional)</Label>
                <Input
                  type="email"
                  value={replyTo}
                  onChange={(e) => setReplyTo(e.target.value)}
                  placeholder="suporte@seudominio.com"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs">Assunto</Label>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Conteúdo (HTML)</Label>
              <Textarea
                rows={8}
                value={html}
                onChange={(e) => setHtml(e.target.value)}
                className="font-mono text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={enviar} disabled={sending}>
              {sending ? "Enviando…" : "Enviar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// =============== Lead picker (busca + lista selecionada) ===============
function LeadEmailPicker({
  selectedIds,
  onChange,
}: {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const listFn = useServerFn(listPlayersForEmail);

  // Busca por texto
  const searchQ = useQuery({
    queryKey: ["email-leads-search", search],
    queryFn: () => listFn({ data: { search, limit: 20 } } as any),
  });

  // Carrega detalhes dos já selecionados (nome/email) — só se houver
  const detailsQ = useQuery({
    queryKey: ["email-leads-details", selectedIds.join(",")],
    queryFn: () =>
      selectedIds.length === 0
        ? Promise.resolve({ players: [] })
        : listFn({ data: { ids: selectedIds, limit: 50 } } as any),
    enabled: selectedIds.length > 0,
  });

  const results: any[] = (searchQ.data?.players ?? []) as any;
  const selected: any[] = (detailsQ.data?.players ?? []) as any;

  function add(p: any) {
    if (selectedIds.includes(p.id)) return;
    onChange([...selectedIds, p.id]);
  }
  function remove(id: string) {
    onChange(selectedIds.filter((x) => x !== id));
  }

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-border bg-card/40">
        <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Nome, email ou telefone…"
            className="h-7 border-0 bg-transparent text-xs focus-visible:ring-0"
          />
        </div>
        <div className="max-h-44 overflow-y-auto">
          {searchQ.isLoading ? (
            <div className="p-3 text-xs text-muted-foreground">Buscando…</div>
          ) : results.length === 0 ? (
            <div className="p-3 text-xs text-muted-foreground">Nenhum lead encontrado.</div>
          ) : (
            results.map((p) => {
              const already = selectedIds.includes(p.id);
              const hasEmail = Boolean(p.email && String(p.email).trim());
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={already || !hasEmail}
                  onClick={() => add(p)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 border-b border-border/60 px-2 py-1.5 text-left text-xs last:border-0",
                    already
                      ? "opacity-50"
                      : hasEmail
                        ? "hover:bg-muted/40"
                        : "opacity-50 cursor-not-allowed",
                  )}
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{p.nome}</div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {hasEmail ? p.email : "sem email"}
                      {p.telefone ? ` · ${p.telefone}` : ""}
                    </div>
                  </div>
                  {already ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                  ) : (
                    <Plus className="h-3.5 w-3.5 text-primary" />
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      {selectedIds.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((p) => {
            const hasEmail = Boolean(p.email && String(p.email).trim());
            return (
              <Badge
                key={p.id}
                variant="outline"
                className={cn(
                  "gap-1 pl-2 pr-1 py-0.5 text-[11px]",
                  !hasEmail && "border-rose-500/50 text-rose-400",
                )}
              >
                <span className="max-w-[140px] truncate">
                  {p.nome}
                  {hasEmail ? "" : " (sem email)"}
                </span>
                <button
                  type="button"
                  onClick={() => remove(p.id)}
                  className="rounded p-0.5 hover:bg-muted"
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </Badge>
            );
          })}
        </div>
      )}
      {selectedIds.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {selectedIds.length} lead(s) selecionado(s).
        </p>
      )}
    </div>
  );
}

// ============================================================
// Remetentes (email_senders) — entidade dedicada, independente de SMTP
// ============================================================

type SenderUI = {
  id: string;
  name: string;
  fromEmail: string;
  fromName: string;
  replyTo: string;
  domain: string;
  isDefault: boolean;
};

function RemetentesTab() {
  const listFn = useServerFn(listEmailSenders);
  const saveFn = useServerFn(saveEmailSender);
  const delFn = useServerFn(deleteEmailSender);
  const setDefFn = useServerFn(setDefaultEmailSender);

  const q = useQuery({ queryKey: ["email-senders"], queryFn: () => listFn() });
  const items: SenderUI[] = (q.data?.items ?? []) as SenderUI[];

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SenderUI | null>(null);

  function novo() {
    setEditing({
      id: "",
      name: "",
      fromEmail: "",
      fromName: "",
      replyTo: "",
      domain: "",
      isDefault: items.length === 0,
    });
    setOpen(true);
  }

  async function salvar(s: SenderUI) {
    try {
      await saveFn({
        data: {
          id: s.id || undefined,
          name: s.name,
          fromEmail: s.fromEmail,
          fromName: s.fromName,
          replyTo: s.replyTo,
          domain: s.domain,
          isDefault: s.isDefault,
        },
      } as any);
      toast.success("Remetente salvo");
      setOpen(false);
      q.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar");
    }
  }

  async function excluir(id: string) {
    try {
      await delFn({ data: { id } } as any);
      toast.success("Remetente removido");
      q.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao remover");
    }
  }

  async function definirPadrao(id: string) {
    try {
      await setDefFn({ data: { id } } as any);
      q.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Remetentes</h2>
          <p className="text-xs text-muted-foreground">
            Cadastre os remetentes (nome, email e domínio verificado na BusinessCode) usados em
            campanhas e automações. Independente de SMTP.
          </p>
        </div>
        <Button onClick={novo} className="gap-2">
          <Plus className="h-4 w-4" /> Novo remetente
        </Button>
      </div>

      {items.length === 0 ? (
        <Card className="card-premium border-0 p-10">
          <EmptyState
            icon={<Mail className="h-6 w-6" />}
            title="Nenhum remetente cadastrado"
            description="Cadastre um remetente padrão (com o email do domínio verificado na BusinessCode) para poder enviar campanhas."
            action={
              <Button onClick={novo} className="gap-2">
                <Plus className="h-4 w-4" /> Cadastrar remetente
              </Button>
            }
          />
        </Card>
      ) : (
        <Card className="card-premium border-0">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Reply-To</TableHead>
                  <TableHead>Domínio</TableHead>
                  <TableHead className="w-[60px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {s.name}
                        {s.isDefault && (
                          <Badge
                            variant="outline"
                            className="border-primary/40 text-primary text-[10px]"
                          >
                            padrão
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.fromName ? `${s.fromName} <${s.fromEmail}>` : s.fromEmail}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{s.replyTo || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{s.domain || "—"}</TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => {
                              setEditing(s);
                              setOpen(true);
                            }}
                          >
                            <Pencil className="h-4 w-4 mr-2" /> Editar
                          </DropdownMenuItem>
                          {!s.isDefault && (
                            <DropdownMenuItem onClick={() => definirPadrao(s.id)}>
                              <Star className="h-4 w-4 mr-2" /> Definir como padrão
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => excluir(s.id)}
                            className="text-rose-400 focus:text-rose-300"
                          >
                            <Trash2 className="h-4 w-4 mr-2" /> Excluir
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <SenderDialog open={open} onOpenChange={setOpen} editing={editing} onSave={salvar} />
    </div>
  );
}

function SenderDialog({
  open,
  onOpenChange,
  editing,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  editing: SenderUI | null;
  onSave: (s: SenderUI) => void;
}) {
  const [s, setS] = useState<SenderUI | null>(editing);
  useEffect(() => {
    setS(editing);
  }, [editing]);
  if (!s) return null;
  const up = (k: keyof SenderUI, v: any) => setS((p) => (p ? { ...p, [k]: v } : p));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Remetente</DialogTitle>
          <DialogDescription>Configure nome, email e domínio do remetente.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Nome interno">
            <Input
              value={s.name}
              onChange={(e) => up("name", e.target.value)}
              placeholder="Ex.: BETLEADS"
            />
          </Field>
          <Field label="Nome exibido (From Name)">
            <Input
              value={s.fromName}
              onChange={(e) => up("fromName", e.target.value)}
              placeholder="Ex.: BETLEADS"
            />
          </Field>
          <Field label="Email do remetente (From)">
            <Input
              value={s.fromEmail}
              onChange={(e) => up("fromEmail", e.target.value)}
              placeholder="noreply@betleads.io"
            />
          </Field>
          <Field label="Reply-To (opcional)">
            <Input
              value={s.replyTo}
              onChange={(e) => up("replyTo", e.target.value)}
              placeholder="suporte@betleads.io"
            />
          </Field>
          <Field label="Domínio (opcional)">
            <Input
              value={s.domain}
              onChange={(e) => up("domain", e.target.value)}
              placeholder="betleads.io"
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={s.isDefault}
              onChange={(e) => up("isDefault", e.target.checked)}
            />
            Definir como padrão
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => onSave(s)} disabled={!s.name || !s.fromEmail}>
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
