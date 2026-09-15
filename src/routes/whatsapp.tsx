import { createFileRoute } from "@tanstack/react-router";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  MessageCircle,
  Send,
  Workflow,
  ListOrdered,
  History,
  Shield,
  Plus,
  Pause,
  Play,
  Power,
  QrCode,
  TrendingUp,
  Users,
  Clock,
  Sparkles,
  Shuffle,
  Phone,
  Search,
  Star,
  AlertTriangle,
  CheckCircle2,
  UserCheck,
  Pencil,
  Trash2,
  ArrowUp,
  ArrowDown,
  Image as ImageIcon,
  Video,
  Mic,
  FileText,
  Timer,
  Type,
  Copy,
  Zap,
  BookOpen,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TRIGGER_NAMES, TRIGGER_MEANINGS, type TriggerType } from "@/lib/triggers";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listWhatsappSessions,
  createWhatsappSession,
  connectWhatsappSession,
  getWhatsappSessionStatus,
  disconnectWhatsappSession,
  deleteWhatsappSession,
  clearWhatsappSessionHistory,
  renameWhatsappSession,
  getEvolutionRealtimeConfig,
  diagnoseEvolution,
  listInboxChats,
  listChatMessages,
  sendWhatsappMessage,
  configureEvolutionWebhook,
  getWhatsappQueueStats,
  resumeWhatsappQueue,
  backfillWhatsappFromAlerts,
} from "@/lib/whatsapp.functions";
import {
  listWhatsappProxies,
  createWhatsappProxy,
  updateWhatsappProxy,
  deleteWhatsappProxy,
  testWhatsappProxy,
  assignProxyToSession,
} from "@/lib/whatsapp-proxies.functions";
import { supabase } from "@/integrations/supabase/client";
import { io, type Socket } from "socket.io-client";
import { QRCodeSVG } from "qrcode.react";
import { WhatsappInbox } from "@/components/whatsapp/inbox";
import { PrecallTab } from "@/components/whatsapp/precall/precall-tab";
import { ExternalIntegrationTab } from "@/components/whatsapp/external-integration-tab";
import {
  listRules,
  updateRule,
  listFlows,
  getFlow,
  saveFlow,
  deleteFlow,
  toggleFlow,
  duplicateFlow,
  testRule,
  createMediaUploadUrl,
  getAntibanSettings,
  saveAntibanSettings,
  triggerFlowTest,
  runEvaluateAndDispatch,
} from "@/lib/automations.functions";
import { LeadSelector, type SelectedLead } from "@/components/ligacoes/lead-selector";
import { MetricCard, EmptyState } from "@/components/ui-premium";
import { MessageVariablePicker } from "@/components/message-variable-picker";
import { getWhatsappDashboard, type WhatsappDashboard } from "@/lib/whatsapp-dashboard.functions";
import { useRealtimeInvalidate } from "@/hooks/use-realtime-invalidate";
import { HistoryShell } from "@/components/history/history-shell";
import {
  DashboardDateRangePicker,
  defaultTodayRange,
  rangeToKey,
  type DashboardRange,
} from "@/components/dashboard-date-range-picker";

export const Route = createFileRoute("/whatsapp")({
  head: () => ({
    meta: [{ title: "WhatsApp — BETLEADS" }],
  }),
  validateSearch: (s: Record<string, unknown>) => ({
    tab: typeof s.tab === "string" ? s.tab : undefined,
    chat: typeof s.chat === "string" ? s.chat : undefined,
  }),
  component: WhatsAppPage,
});

// ============================================================
// TYPES
// ============================================================
interface Fluxo {
  id: string;
  nome: string;
  gatilho: string;
  prioridade: "critico" | "alto" | "medio" | "baixo";
  ativo: boolean;
  mensagens: string[];
  cooldownHoras: number;
  delayMin: number;
  delayMax: number;
  saidas: string[];
  enviadosHoje: number;
  conversoes: number;
}

interface FilaItem {
  id: string;
  lead: string;
  fluxo: string;
  sessao: string;
  agendadoEm: string;
  prioridade: "critico" | "alto" | "medio" | "baixo";
  status: "aguardando" | "cooldown" | "pronto";
}

interface Conversa {
  id: string;
  lead: string;
  telefone: string;
  sessao: string;
  ultimaMsg: string;
  ultimaHora: string;
  naoLidas: number;
  vip: boolean;
  quente: boolean;
  totalDepositado: number;
  saldo: number;
  diasSemLogin: number;
  ultimoLogin: string;
  ultimoDeposito: string;
  lucro: number;
  origem: string;
  retentionScore: number;
  chanceRetorno: number;
  mensagens: { de: "lead" | "bot" | "humano"; texto: string; hora: string }[];
}

interface HistoricoItem {
  id: string;
  data: string;
  lead: string;
  fluxo: string;
  sessao: string;
  mensagem: string;
  resultado: "entregue" | "lido" | "respondeu" | "convertido" | "falhou";
}

// ============================================================
// HELPERS
// ============================================================
function realStatusBadge(s: string) {
  if (s === "connected") return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (s === "qrcode" || s === "connecting") return "bg-amber-500/15 text-amber-400 border-amber-500/30";
  if (s === "error") return "bg-rose-500/15 text-rose-400 border-rose-500/30";
  return "bg-slate-500/15 text-slate-300 border-slate-500/30";
}

function traduzirStatus(s: string): string {
  if (s === "connected") return "Conectado";
  if (s === "connecting") return "Conectando…";
  if (s === "qrcode") return "Aguardando QR";
  if (s === "disconnected") return "Desconectado";
  if (s === "error") return "Erro";
  return s;
}

function prioridadeBadge(p: "critico" | "alto" | "medio" | "baixo") {
  const map = {
    critico: "bg-red-500/15 text-red-400 border-red-500/30",
    alto: "bg-orange-500/15 text-orange-400 border-orange-500/30",
    medio: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    baixo: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  };
  return map[p];
}

function resultadoBadge(r: HistoricoItem["resultado"]) {
  const map = {
    entregue: "bg-sky-500/15 text-sky-400 border-sky-500/30",
    lido: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
    respondeu: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    convertido: "bg-violet-500/15 text-violet-300 border-violet-500/30",
    falhou: "bg-rose-500/15 text-rose-400 border-rose-500/30",
  };
  return map[r];
}

// ============================================================
// MAIN PAGE
// ============================================================
function WhatsAppPage() {
  const [fluxos, setFluxos] = useState<Fluxo[]>([]);
  const search = Route.useSearch();
  const navigate = useNavigate();
  const hash = useLocation({ select: (l) => l.hash });
  const VALID_TABS = ["dashboard", "sessoes", "fluxos", "precall", "inbox", "fila", "historico", "antiban", "proxies", "externo"] as const;
  const currentTab = (VALID_TABS as readonly string[]).includes(hash)
    ? hash
    : search.tab === "inbox"
      ? "inbox"
      : "dashboard";
  const list = useServerFn(listWhatsappSessions);
  const { data } = useQuery({
    queryKey: ["whatsapp-sessions"],
    queryFn: () => list(),
    refetchInterval: 10000,
  });
  const sessions = (data?.sessions ?? []) as any[];

  const dashFn = useServerFn(getWhatsappDashboard);
  const [range, setRange] = useState<DashboardRange>(() => defaultTodayRange());
  const rk = rangeToKey(range);
  const { data: dashboard, dataUpdatedAt } = useQuery({
    queryKey: ["whatsapp-dashboard", rk.from, rk.to],
    queryFn: () => dashFn({ data: rk }),
    refetchInterval: 15000,
  });

  // Realtime: invalida dashboard + sessões a cada novo evento
  const rtStatus = useRealtimeInvalidate(
    "whatsapp-dashboard-rt",
    ["whatsapp_messages", "whatsapp_chats", "whatsapp_sessions"],
    [["whatsapp-dashboard"], ["whatsapp-sessions"]],
    250,
  );

  const sessoesAtivas = dashboard?.sessions.active ?? sessions.filter((s) => s.status === "connected").length;
  const filaTotal = dashboard?.sessions.queue_pending ?? sessions.reduce((a, s) => a + (s.queue_pending ?? 0), 0);

  const isInbox = currentTab === "inbox";

  if (isInbox) {
    // Inbox em modo "operacional": ocupa toda a viewport útil, sem header da página,
    // sem padding externo. Neutraliza o padding do <main> do AppLayout.
    return (
      <div className="-m-4 sm:-m-6 h-[calc(100dvh-4rem)] overflow-hidden bg-background">
        <WhatsappInbox openChatId={search.chat} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600">
              <MessageCircle className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">WhatsApp</h1>
              <p className="text-sm text-muted-foreground">
                Central nativa de automação, inbox e retenção
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400/60" />
              {sessoesAtivas} sessões ativas · {filaTotal} na fila
            </span>
            <DashboardDateRangePicker range={range} onChange={setRange} />
          </div>
        </header>

        <Tabs
          value={currentTab}
          onValueChange={(v) =>
            navigate({ to: "/whatsapp", hash: v, search: search, replace: true })
          }
          className="space-y-6"
        >
          <TabsList className="hidden">
            <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
            <TabsTrigger value="sessoes">Sessões</TabsTrigger>
            <TabsTrigger value="fluxos">Fluxos</TabsTrigger>
            <TabsTrigger value="precall">Pré-ligação</TabsTrigger>
            <TabsTrigger value="inbox">Inbox</TabsTrigger>
            <TabsTrigger value="fila">Fila</TabsTrigger>
            <TabsTrigger value="historico">Histórico</TabsTrigger>
            <TabsTrigger value="antiban">Anti-ban</TabsTrigger>
            <TabsTrigger value="proxies">Proxies</TabsTrigger>
            <TabsTrigger value="externo">Integração externa</TabsTrigger>
          </TabsList>

          <TabsContent value="dashboard"><DashboardTab dashboard={dashboard} dataUpdatedAt={dataUpdatedAt} rtStatus={rtStatus} fluxos={fluxos} sessions={sessions} /></TabsContent>
          <TabsContent value="sessoes"><RealSessoesTab /></TabsContent>
          <TabsContent value="fluxos"><FluxosTab /></TabsContent>
          <TabsContent value="precall"><PrecallTab /></TabsContent>
          <TabsContent value="fila"><FilaTab /></TabsContent>
          <TabsContent value="historico"><HistoricoTab /></TabsContent>
          <TabsContent value="antiban"><AntibanTab /></TabsContent>
          <TabsContent value="proxies"><ProxiesTab /></TabsContent>
          <TabsContent value="externo"><ExternalIntegrationTab /></TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

// ============================================================
// DASHBOARD
// ============================================================
function GatilhosTab() {
  const keys = Object.keys(TRIGGER_NAMES) as TriggerType[];
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Referência rápida dos 12 gatilhos inteligentes. Use a aba Regras para vinculá-los a um fluxo.
      </p>
      <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
        {keys.map((k) => (
          <Card key={k} className="border-border/60 bg-card/60">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{TRIGGER_NAMES[k]}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{TRIGGER_MEANINGS[k]}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function DashboardTab({
  dashboard,
  dataUpdatedAt,
  rtStatus,
  fluxos,
  sessions,
}: {
  dashboard: WhatsappDashboard | undefined;
  dataUpdatedAt: number;
  rtStatus: "idle" | "connecting" | "active" | "offline";
  fluxos: Fluxo[];
  sessions: any[];
}) {
  void fluxos;
  const t = dashboard?.totals_today;
  const sentToday = t?.sent ?? 0;
  const delivered = t?.delivered ?? 0;
  const failed = t?.failed ?? 0;
  const received = t?.received ?? 0;
  const deliveryRate = t?.delivery_rate ?? 0;
  const conv = dashboard?.conversions_today;
  const convCount = conv?.count ?? 0;
  const convRate = conv?.rate ?? 0;
  const lastHour = dashboard?.last_hour.sent ?? 0;
  const hotLeads = dashboard?.hot_leads ?? 0;
  const sessoesAtivas = dashboard?.sessions.active ?? sessions.filter((s) => s.status === "connected").length;
  const sessoesTotal = dashboard?.sessions.total ?? sessions.length;
  const filaTotal = dashboard?.sessions.queue_pending ?? 0;
  const byHour = dashboard?.by_hour ?? [];
  const maxHour = Math.max(1, ...byHour.map((b) => b.sent));

  const updatedAgo = useUpdatedAgo(dataUpdatedAt);

  const kpis: Array<{ label: string; value: string; icon: any; accent: "primary" | "success" | "warning" | "danger" | "ai" }> = [
    { label: "Entregues hoje", value: delivered.toLocaleString("pt-BR"), icon: CheckCircle2, accent: "success" },
    { label: "Falhas hoje", value: failed.toLocaleString("pt-BR"), icon: AlertTriangle, accent: "danger" },
    { label: "Recebidas hoje", value: received.toLocaleString("pt-BR"), icon: MessageCircle, accent: "primary" },
    { label: "Taxa entrega", value: `${deliveryRate.toFixed(1)}%`, icon: Sparkles, accent: "ai" },
    { label: "Conversões", value: convCount.toLocaleString("pt-BR"), icon: TrendingUp, accent: "ai" },
    { label: "Taxa conversão", value: `${convRate.toFixed(1)}%`, icon: Sparkles, accent: "primary" },
  ];

  const rtColor =
    rtStatus === "active"
      ? "bg-emerald-400 shadow-emerald-400/60"
      : rtStatus === "connecting"
        ? "bg-amber-400 shadow-amber-400/60"
        : "bg-slate-500 shadow-slate-500/40";
  const rtLabel =
    rtStatus === "active" ? "Ao vivo" : rtStatus === "connecting" ? "Conectando…" : "Offline";

  return (
    <div className="space-y-6">
      {/* Hero: disparos de hoje em destaque */}
      <Card className="border-emerald-500/20 bg-gradient-to-br from-emerald-500/5 via-card to-card overflow-hidden">
        <CardContent className="p-6 grid gap-6 md:grid-cols-[1fr_auto] items-center">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
              <Send className="h-3.5 w-3.5" />
              Disparos hoje
              <span className="ml-2 inline-flex items-center gap-1.5 rounded-full bg-background/60 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-foreground/80 border border-border/60">
                <span className={`h-1.5 w-1.5 rounded-full shadow-[0_0_6px] ${rtColor}`} />
                {rtLabel}
              </span>
              <span className="ml-auto text-[10px] normal-case tracking-normal text-muted-foreground">
                Atualizado {updatedAgo}
              </span>
            </div>
            <div className="flex items-baseline gap-4 flex-wrap">
              <span className="text-5xl md:text-6xl font-bold tabular-nums tracking-tight">
                {sentToday.toLocaleString("pt-BR")}
              </span>
              <span className={`text-sm font-medium ${lastHour > 0 ? "text-emerald-400" : "text-muted-foreground"}`}>
                {lastHour > 0 ? `↑ ${lastHour} na última hora` : "Nenhum disparo na última hora"}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {sessoesAtivas}/{sessoesTotal} sessões conectadas · {filaTotal} na fila · {hotLeads} leads quentes
            </p>
          </div>
          {/* Sparkline 24h */}
          <div className="flex items-end gap-1 h-20 min-w-[240px]">
            {byHour.map((b, i) => {
              const h = Math.max(2, Math.round((b.sent / maxHour) * 72));
              return (
                <div
                  key={i}
                  className="w-2 rounded-sm bg-emerald-500/40 hover:bg-emerald-400 transition-colors"
                  style={{ height: `${h}px` }}
                  title={`${new Date(b.hour).getHours()}h: ${b.sent} disparos`}
                />
              );
            })}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        {kpis.map((k) => (
          <MetricCard
            key={k.label}
            label={k.label}
            value={k.value}
            accent={k.accent}
            icon={<k.icon className="h-4 w-4" />}
          />
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Performance por fluxo</CardTitle>
            <CardDescription>Mensagens enviadas vs conversões hoje</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {(dashboard?.flows_performance ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">Nenhum disparo de fluxo registrado hoje.</p>
            ) : (dashboard?.flows_performance ?? []).map((f) => {
              const total = f.sent_today + f.failed_today;
              const failPct = total > 0 ? (f.failed_today / total) * 100 : 0;
              const okPct = total > 0 ? 100 - failPct : 0;
              return (
                <div key={f.flow_id} className="space-y-1.5">
                  <div className="flex justify-between text-sm">
                    <span className="font-medium truncate">{f.name}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {f.sent_today} enviadas{f.failed_today > 0 ? ` · ${f.failed_today} falhas` : ""}
                    </span>
                  </div>
                  <div className="flex h-1.5 rounded-full overflow-hidden bg-muted">
                    <div className="bg-emerald-500" style={{ width: `${okPct}%` }} />
                    <div className="bg-rose-500" style={{ width: `${failPct}%` }} />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Saúde das sessões</CardTitle>
            <CardDescription>Volume e risco por número</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {sessions.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">Nenhuma sessão WhatsApp conectada ainda.</p>
            ) : sessions.map((s) => {
              const limite = s.daily_limit || 1;
              const pct = ((s.messages_sent_today ?? 0) / limite) * 100;
              return (
                <div key={s.id} className="space-y-1.5">
                  <div className="flex justify-between items-center text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{s.name}</span>
                      <Badge variant="outline" className={`text-[10px] ${realStatusBadge(s.status)}`}>{traduzirStatus(s.status)}</Badge>
                    </div>
                    <span className="text-muted-foreground text-xs">{s.messages_sent_today ?? 0}/{s.daily_limit ?? 0}</span>
                  </div>
                  <Progress value={pct} className="h-1.5" />
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function useUpdatedAgo(ts: number): string {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (!ts) return "agora";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return "agora";
  if (s < 60) return `há ${s}s`;
  const m = Math.floor(s / 60);
  return `há ${m}min`;
}

// ============================================================
// REAL SESSIONS (Evolution API)
// ============================================================
function RealSessoesTab() {
  const qc = useQueryClient();
  const list = useServerFn(listWhatsappSessions);
  const createFn = useServerFn(createWhatsappSession);
  const connectFn = useServerFn(connectWhatsappSession);
  const statusFn = useServerFn(getWhatsappSessionStatus);
  const disconnectFn = useServerFn(disconnectWhatsappSession);
  const deleteFn = useServerFn(deleteWhatsappSession);
  const clearHistoryFn = useServerFn(clearWhatsappSessionHistory);
  const renameFn = useServerFn(renameWhatsappSession);
  const proxiesListFn = useServerFn(listWhatsappProxies);
  const assignProxyFn = useServerFn(assignProxyToSession);
  const rtConfigFn = useServerFn(getEvolutionRealtimeConfig);
  const diagFn = useServerFn(diagnoseEvolution);
  const webhookFn = useServerFn(configureEvolutionWebhook);
  // webhookMut/diagMut removidos da UI (uso interno apenas após criar sessão).
  void webhookFn;
  void diagFn;

  const { data, isLoading } = useQuery({
    queryKey: ["whatsapp-sessions"],
    queryFn: () => list(),
    refetchInterval: 10000,
  });
  const sessions = data?.sessions ?? [];

  const { data: proxiesData } = useQuery({
    queryKey: ["whatsapp-proxies"],
    queryFn: () => proxiesListFn(),
  });
  const proxies = (proxiesData?.proxies ?? []) as any[];

  const assignProxyMut = useMutation({
    mutationFn: ({ session_id, proxy_id }: { session_id: string; proxy_id: string | null }) =>
      assignProxyFn({ data: { session_id, proxy_id } }),
    onSuccess: () => {
      toast.success("Proxy atualizado. Reconecte a sessão para aplicar.");
      qc.invalidateQueries({ queryKey: ["whatsapp-sessions"] });
    },
    onError: (e: any) => toast.error(e.message ?? "Erro"),
  });

  // Fallback: enquanto houver sessões em "qrcode" ou "connecting", consulta
  // a Evolution direto a cada 5s para o card atualizar mesmo se o webhook
  // não chegar. Para de pollar quando todas estão connected/disconnected.
  const hasPending = sessions.some(
    (s: any) => s.status === "qrcode" || s.status === "connecting",
  );
  useEffect(() => {
    if (!hasPending) return;
    const pending = sessions.filter(
      (s: any) => s.status === "qrcode" || s.status === "connecting",
    );
    const interval = setInterval(async () => {
      try {
        await Promise.all(
          pending.map((s: any) => statusFn({ data: { id: s.id } })),
        );
        qc.invalidateQueries({ queryKey: ["whatsapp-sessions"] });
      } catch {
        // ignora — próxima tentativa resolve
      }
    }, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPending, sessions.map((s: any) => `${s.id}:${s.status}`).join("|")]);

  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [manageSession, setManageSession] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [renameSession, setRenameSession] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // instance_name é derivado automaticamente do nome (slugify).
  const slug = newName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const instanceName = slug.length >= 2 ? slug : `${slug}-wa`.slice(0, 60);
  // `qr` = base64 data URL (img src). `qrText` = raw QR string (needs rendering via QRCodeSVG).
  const [qrSession, setQrSession] = useState<{
    id: string;
    name: string;
    qr: string | null;
    qrText: string | null;
    status: string;
  } | null>(null);
  // Keep the last QR session around during the dialog close animation so the
  // portal contents do not change structure mid-unmount (which causes Radix /
  // React's "Failed to execute 'removeChild' on 'Node'" crash).
  const [qrSnapshot, setQrSnapshot] = useState<{
    id: string;
    name: string;
    qr: string | null;
    qrText: string | null;
    status: string;
  } | null>(null);
  useEffect(() => {
    if (qrSession) setQrSnapshot(qrSession);
  }, [qrSession]);

  const createMut = useMutation({
    mutationFn: () => createFn({ data: { name: newName, instance_name: instanceName } }),
    onSuccess: async () => {
      toast.success("WhatsApp criado com sucesso");
      setNewOpen(false);
      setNewName("");
      // Do NOT call syncFn() here. Evolution's fetchInstances is shared across
      // tenants and would re-insert sessions from other tenants (or resurrect
      // ones that were just deleted). The new session is already persisted by
      // createWhatsappSession; just refresh the list.
      qc.invalidateQueries({ queryKey: ["whatsapp-sessions"] });
    },
    onError: (e: any) => toast.error(e.message ?? "Erro ao criar"),
  });

  const connectMut = useMutation({
    mutationFn: (id: string) => connectFn({ data: { id } }),
    onSuccess: (res, id) => {
      const s = sessions.find((x: any) => x.id === id);
      console.log("[whatsapp] connect response:", res);
      // res.qr_code may be a data: URL, raw base64, or null. Backend currently
      // only forwards image-shaped QR; raw text QR arrives via websocket.
      const raw = (res as any).qr_code as string | null | undefined;
      let qr: string | null = null;
      let qrText: string | null = null;
      if (typeof raw === "string" && raw.length > 0) {
        if (raw.startsWith("data:image")) qr = raw;
        else if (/^[A-Za-z0-9+/=]+$/.test(raw) && raw.length > 200) qr = `data:image/png;base64,${raw}`;
        else qrText = raw;
      }
      setQrSession({ id, name: s?.name ?? "Sessão", qr, qrText, status: res.status });
      qc.invalidateQueries({ queryKey: ["whatsapp-sessions"] });
    },
    onError: (e: any) => toast.error(e.message ?? "Erro ao conectar"),
  });

  const disconnectMut = useMutation({
    mutationFn: (id: string) => disconnectFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Sessão desconectada");
      qc.invalidateQueries({ queryKey: ["whatsapp-sessions"] });
    },
    onError: (e: any) => toast.error(e.message ?? "Erro"),
  });

  const deleteMut = useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) =>
      deleteFn({ data: { id, force } }),
    onSuccess: () => {
      toast.success("Sessão removida");
      setManageSession(null);
      qc.invalidateQueries({ queryKey: ["whatsapp-sessions"] });
    },
    onError: (e: any) => toast.error(e.message ?? "Erro"),
  });

  const clearHistoryMut = useMutation({
    mutationFn: (id: string) => clearHistoryFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Histórico apagado");
      setManageSession(null);
      qc.invalidateQueries({ queryKey: ["whatsapp-sessions"] });
      qc.invalidateQueries({ queryKey: ["whatsapp-inbox"] });
    },
    onError: (e: any) => toast.error(e.message ?? "Erro"),
  });

  const renameMut = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      renameFn({ data: { id, name } }),
    onSuccess: () => {
      toast.success("Nome atualizado");
      setRenameSession(null);
      qc.invalidateQueries({ queryKey: ["whatsapp-sessions"] });
    },
    onError: (e: any) => toast.error(e.message ?? "Erro ao renomear"),
  });

  // syncMut removido da UI — sync acontece automaticamente após criar sessão.

  // Poll QR session status while dialog open
  useEffect(() => {
    if (!qrSession) return;
    const t = setInterval(async () => {
      try {
        const res = await statusFn({ data: { id: qrSession.id } });
        setQrSession((prev) => (prev ? { ...prev, status: res.status, qr: res.qr_code ?? prev.qr } : prev));
        if (res.status === "connected") {
          toast.success("WhatsApp conectado!");
          qc.invalidateQueries({ queryKey: ["whatsapp-sessions"] });
          setQrSession(null);
        }
      } catch {}
    }, 3000);
    return () => clearInterval(t);
  }, [qrSession?.id, qc, statusFn]);

  // Evolution API v2 — listen to socket.io events for QR + connection state.
  // /instance/connect only triggers the connection; the QR arrives via websocket.
  useEffect(() => {
    if (!qrSession) return;
    const session = sessions.find((x: any) => x.id === qrSession.id);
    if (!session?.instance_name) return;

    const sockets: Socket[] = [];
    let cancelled = false;

    (async () => {
      try {
        const cfg = await rtConfigFn();
        if (cancelled) return;

        // Decide whether the QR is an image (base64/data URL) or a raw QR text
        // string that must be rendered with QRCodeSVG.
        const setQr = (value: string | null | undefined) => {
          if (!value) return;
          console.log("[whatsapp] QR value received (first 80):", value.slice(0, 80), "len=", value.length);
          if (value.startsWith("data:image")) {
            setQrSession((prev) => (prev ? { ...prev, qr: value, qrText: null, status: "qrcode" } : prev));
            return;
          }
          // Pure base64 -> wrap as data URL.
          const isBase64 = /^[A-Za-z0-9+/=]+$/.test(value) && value.length > 200;
          if (isBase64) {
            setQrSession((prev) => (prev ? { ...prev, qr: `data:image/png;base64,${value}`, qrText: null, status: "qrcode" } : prev));
            return;
          }
          // Raw QR text (e.g. "2@abc..."). Render via QRCodeSVG.
          setQrSession((prev) => (prev ? { ...prev, qr: null, qrText: value, status: "qrcode" } : prev));
        };

        const matchesInstance = (payload: any): boolean => {
          const inst =
            payload?.instance ??
            payload?.instanceName ??
            payload?.data?.instance ??
            payload?.data?.instanceName ??
            payload?.sender;
          // Accept payloads without instance identifier (instance-scoped namespaces
          // often omit it). Reject only if a different instance is explicitly set.
          if (!inst) return true;
          if (typeof inst === "string") return inst === session.instance_name;
          if (typeof inst === "object")
            return (inst.instanceName ?? inst.name) === session.instance_name;
          return true;
        };

        const extractQrFromAny = (payload: any): string | null => {
          if (!payload) return null;
          if (typeof payload === "string" && payload.length > 50) return payload;
          const candidates = [
            payload?.qrcode?.base64,
            payload?.qrcode?.code,
            payload?.qrcode,
            payload?.base64,
            payload?.qr,
            payload?.code,
            payload?.data?.qrcode?.base64,
            payload?.data?.qrcode?.code,
            payload?.data?.qrcode,
            payload?.data?.base64,
            payload?.data?.qr,
            payload?.data?.code,
          ];
          for (const c of candidates) {
            if (typeof c === "string" && c.length > 50) return c;
          }
          return null;
        };

        const handleQrPayload = (payload: any) => {
          console.log("[whatsapp] QR event payload:", payload);
          if (!matchesInstance(payload)) return;
          const value = extractQrFromAny(payload);
          if (value) setQr(value);
        };

        const handleConnPayload = (payload: any) => {
          if (!matchesInstance(payload)) return;
          const state =
            payload?.state ??
            payload?.data?.state ??
            payload?.connection ??
            payload?.data?.connection;
          if (state === "open") {
            toast.success("WhatsApp conectado!");
            qc.invalidateQueries({ queryKey: ["whatsapp-sessions"] });
            setQrSession(null);
          } else if (state) {
            setQrSession((prev) => (prev ? { ...prev, status: state === "connecting" ? "connecting" : prev.status } : prev));
          }
        };

        const qrEvents = [
          "qrcode.updated",
          "QRCODE_UPDATED",
          "qr",
          "QR_CODE",
          "qrCode",
          "qrcode",
        ];
        const connEvents = [
          "connection.update",
          "CONNECTION_UPDATE",
          "connectionUpdate",
        ];

        const wire = (s: Socket, label: string) => {
          s.on("connect", () => console.info(`[evo-ws ${label}] connected`));
          s.on("connect_error", (err) => console.warn(`[evo-ws ${label}] connect_error`, err.message));
          s.on("disconnect", (reason) => console.info(`[evo-ws ${label}] disconnect`, reason));
          for (const ev of qrEvents) s.on(ev, handleQrPayload);
          for (const ev of connEvents) s.on(ev, handleConnPayload);
          // Catch-all: some Evolution builds rename events. If a QR-shaped
          // payload arrives under any other event name, still react.
          s.onAny((event, ...args) => {
            const payload = args[0];
            const evLow = String(event).toLowerCase();
            if (evLow.includes("qr")) handleQrPayload(payload);
            else if (evLow.includes("connection")) handleConnPayload(payload);
            else {
              const b64 = extractQrFromAny(payload);
              if (b64 && matchesInstance(payload)) setQr(b64);
            }
          });
        };

        // Evolution v2 builds vary on websocket exposure. We open multiple
        // candidate connections in parallel; the wrong ones will simply fail
        // silently while the correct one delivers the QR.
        const base = cfg.url;
        const inst = session.instance_name;
        const candidates: Array<{ label: string; url: string; path?: string }> = [
          { label: "root", url: base },
          { label: "instance", url: `${base}/${inst}` },
          { label: "root-ws-path", url: base, path: "/ws/socket.io/" },
          { label: "instance-ws-path", url: `${base}/${inst}`, path: "/ws/socket.io/" },
        ];

        for (const c of candidates) {
          try {
            const s = io(c.url, {
              transports: ["websocket", "polling"],
              path: c.path,
              auth: { apikey: cfg.apikey },
              extraHeaders: { apikey: cfg.apikey },
              query: { apikey: cfg.apikey },
              forceNew: true,
              reconnection: true,
              reconnectionAttempts: 10,
              timeout: 8000,
            });
            wire(s, c.label);
            sockets.push(s);
          } catch (err: any) {
            console.warn(`[evo-ws ${c.label}] init failed`, err?.message);
          }
        }
      } catch (e: any) {
        console.warn("[evo-ws] setup failed:", e?.message);
      }
    })();

    return () => {
      cancelled = true;
      for (const s of sockets) {
        try { s.disconnect(); } catch {}
      }
    };
  }, [qrSession?.id, sessions, rtConfigFn, qc]);

  function statusColor(s: string) {
    if (s === "connected") return "bg-emerald-500/10 text-emerald-400 border-emerald-500/30";
    if (s === "qrcode" || s === "connecting") return "bg-amber-500/10 text-amber-400 border-amber-500/30";
    if (s === "error") return "bg-red-500/10 text-red-400 border-red-500/30";
    return "bg-muted text-muted-foreground border-border";
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-muted-foreground">Centralize sessões, automações e conversas do WhatsApp em tempo real.</p>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setNewOpen(true)}><Plus className="h-4 w-4" /> Nova sessão</Button>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : sessions.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center space-y-4">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10">
              <MessageCircle className="h-6 w-6 text-emerald-400" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-semibold">Nenhum WhatsApp conectado</h3>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                Conecte seu primeiro número para começar automações, campanhas e atendimento em tempo real.
              </p>
            </div>
            <Button size="sm" onClick={() => setNewOpen(true)}>
              <Plus className="h-4 w-4" /> Conectar WhatsApp
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {sessions.map((s: any) => (
            <Card key={s.id}>
              <CardHeader className="pb-3">
                <div className="flex justify-between items-start">
                  <div>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Phone className="h-4 w-4 text-emerald-400" /> {s.name}
                      <button
                        type="button"
                        onClick={() => {
                          setRenameValue(s.name);
                          setRenameSession({ id: s.id, name: s.name });
                        }}
                        className="text-muted-foreground hover:text-foreground transition-colors"
                        title="Renomear"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    </CardTitle>
                    <CardDescription className="text-xs mt-0.5">{s.phone_number || s.instance_name}</CardDescription>
                  </div>
                  <Badge variant="outline" className={`text-[10px] ${statusColor(s.status)}`}>{traduzirStatus(s.status)}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-md bg-muted/40 p-2">
                    <div className="text-muted-foreground">Hoje</div>
                    <div className="font-semibold">{s.messages_sent_today}/{s.daily_limit}</div>
                  </div>
                  <div className="rounded-md bg-muted/40 p-2">
                    <div className="text-muted-foreground">Fila</div>
                    <div className="font-semibold">{s.queue_pending}</div>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Shield className="h-3 w-3" /> Proxy
                  </Label>
                  <Select
                    value={s.proxy_id ?? "__none__"}
                    onValueChange={(v) =>
                      assignProxyMut.mutate({
                        session_id: s.id,
                        proxy_id: v === "__none__" ? null : v,
                      })
                    }
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Nenhum" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Nenhum (conexão direta)</SelectItem>
                      {proxies
                        .filter((p) => p.status === "active")
                        .map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                            {p.provider ? ` · ${p.provider}` : ""}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex gap-1.5 flex-wrap">
                  {s.status !== "connected" ? (
                    <Button size="sm" variant="outline" className="flex-1" onClick={() => connectMut.mutate(s.id)} disabled={connectMut.isPending}>
                      <QrCode className="h-3.5 w-3.5" /> Reconectar sessão
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" className="flex-1" onClick={() => disconnectMut.mutate(s.id)} disabled={disconnectMut.isPending}>
                      <Power className="h-3.5 w-3.5" /> Desconectar
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setManageSession({ id: s.id, name: s.name })}
                    title="Gerenciar sessão"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* New session dialog */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova sessão WhatsApp</DialogTitle>
            <DialogDescription>Conecte um novo número para automações e atendimento.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nome</Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="WhatsApp 01" />
              {newName && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  Identificador: <span className="font-mono">{instanceName}</span>
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOpen(false)}>Cancelar</Button>
            <Button
              onClick={() => createMut.mutate()}
              disabled={!newName || instanceName.length < 2 || createMut.isPending}
            >
              {createMut.isPending ? "Criando…" : "Criar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manage session: clear history / force delete */}
      <Dialog
        open={!!manageSession}
        onOpenChange={(o) => {
          if (!o) setManageSession(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Gerenciar sessão</DialogTitle>
            <DialogDescription>
              {manageSession?.name
                ? `Ações disponíveis para "${manageSession.name}".`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-sm font-medium">Limpar histórico</div>
              <p className="text-xs text-muted-foreground mt-1">
                Apaga todas as conversas e mensagens dessa sessão. Os leads
                vinculados são mantidos e a sessão segue conectada.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-3"
                disabled={!manageSession || clearHistoryMut.isPending}
                onClick={() => {
                  if (!manageSession) return;
                  if (
                    !confirm(
                      `Apagar todo o histórico de "${manageSession.name}"? Esta ação não pode ser desfeita.`,
                    )
                  )
                    return;
                  clearHistoryMut.mutate(manageSession.id);
                }}
              >
                {clearHistoryMut.isPending ? "Apagando…" : "Limpar histórico"}
              </Button>
            </div>

            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
              <div className="text-sm font-medium text-destructive">
                Excluir sessão (forçar)
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Apaga a sessão, todo o histórico de conversas e desvincula os
                leads (eles ficam órfãos e podem ser realocados depois). Esta
                ação não pode ser desfeita.
              </p>
              <Button
                size="sm"
                variant="destructive"
                className="mt-3"
                disabled={!manageSession || deleteMut.isPending}
                onClick={() => {
                  if (!manageSession) return;
                  if (
                    !confirm(
                      `Excluir definitivamente "${manageSession.name}" e apagar todo o histórico?`,
                    )
                  )
                    return;
                  deleteMut.mutate({ id: manageSession.id, force: true });
                }}
              >
                {deleteMut.isPending ? "Excluindo…" : "Excluir sessão"}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setManageSession(null)}>
              Fechar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename session */}
      <Dialog
        open={!!renameSession}
        onOpenChange={(o) => {
          if (!o) setRenameSession(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Renomear sessão</DialogTitle>
            <DialogDescription>
              Altera apenas o nome de exibição. A conexão e o número não são afetados.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Nome</Label>
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              maxLength={60}
              placeholder="WhatsApp 01"
              autoFocus
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  renameSession &&
                  renameValue.trim().length > 0 &&
                  renameValue.trim() !== renameSession.name &&
                  !renameMut.isPending
                ) {
                  renameMut.mutate({ id: renameSession.id, name: renameValue.trim() });
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameSession(null)}>
              Cancelar
            </Button>
            <Button
              disabled={
                !renameSession ||
                renameValue.trim().length === 0 ||
                renameValue.trim() === renameSession?.name ||
                renameMut.isPending
              }
              onClick={() => {
                if (!renameSession) return;
                renameMut.mutate({ id: renameSession.id, name: renameValue.trim() });
              }}
            >
              {renameMut.isPending ? "Salvando…" : "Salvar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* QR Code dialog */}
      <Dialog open={!!qrSession} onOpenChange={(o) => { if (!o) setQrSession(null); }}>
        <DialogContent key={qrSnapshot?.id ?? "qr-empty"}>
          <DialogHeader>
            <DialogTitle>Conectar {qrSnapshot?.name ?? ""}</DialogTitle>
            <DialogDescription>Abra o WhatsApp → Configurações → Aparelhos conectados → Conectar aparelho</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center justify-center p-6 gap-2">
            <div className="relative w-64 h-64 rounded-lg bg-white p-2 flex items-center justify-center">
              {qrSnapshot?.qr ? (
                <img src={qrSnapshot.qr} alt="QR Code" className="w-full h-full object-contain" />
              ) : qrSnapshot?.qrText ? (
                <QRCodeSVG value={qrSnapshot.qrText} size={240} level="M" includeMargin={false} />
              ) : (
                <div className="flex flex-col items-center gap-3 text-muted-foreground">
                  <div className="h-8 w-8 rounded-full border-2 border-muted-foreground/30 border-t-emerald-500 animate-spin" />
                  <span className="text-sm">Aguardando QR…</span>
                </div>
              )}
            </div>
          </div>
          <p className="text-xs text-center text-muted-foreground">
            Status: <span className="font-mono">{qrSnapshot?.status ?? ""}</span> · atualiza automaticamente
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================================
// REGRAS (gatilhos inteligentes)
// ============================================================
const TRIGGER_LABELS: Record<string, string> = {
  recuperacao_vip: "Recuperação VIP",
  vip_esfriando: "VIP esfriando",
  receita_em_queda: "Receita em queda",
  lead_quente_esfriando: "Lead quente esfriando",
  quase_vip: "Quase VIP",
  alto_potencial: "Alto potencial",
  reativacao_em_curso: "Reativação em curso",
  dinheiro_parado: "Dinheiro parado",
  engajado_sem_converter: "Engajado sem converter",
  frequencia_caindo: "Frequência caindo",
  cadastrados_sem_deposito: "Cadastrados sem depósito",
  sem_login_7_14: "7 a 14 dias sem login",
  sem_login_15_24: "15 a 24 dias sem login",
  sem_login_25_34: "25 a 34 dias sem login",
  sem_login_35_44: "35 a 44 dias sem login",
  sem_login_45_59: "45 a 59 dias sem login",
  sem_login_60_mais: "60+ dias sem login",
};

function RegrasTab() {
  const qc = useQueryClient();
  const listRulesFn = useServerFn(listRules);
  const listFlowsFn = useServerFn(listFlows);
  const updateRuleFn = useServerFn(updateRule);
  const testRuleFn = useServerFn(testRule);

  const { data: rulesData, isLoading } = useQuery({
    queryKey: ["rules"],
    queryFn: () => listRulesFn(),
  });
  const { data: flowsData } = useQuery({
    queryKey: ["flows"],
    queryFn: () => listFlowsFn(),
  });

  const rules = (rulesData?.rules ?? []) as any[];
  const flows = (flowsData?.flows ?? []) as any[];

  const mutate = useMutation({
    mutationFn: (input: { id: string; active?: boolean; flow_id?: string | null }) => updateRuleFn({ data: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rules"] }),
    onError: (e: any) => toast.error(e?.message ?? "Falha ao atualizar regra"),
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        12 gatilhos inteligentes hard-coded. Vincule cada um a um fluxo para começar a disparar automaticamente.
      </p>

      <div className="grid gap-3">
        {isLoading && <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Carregando regras…</CardContent></Card>}
        {rules.map((r) => (
          <Card key={r.id}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex-1 min-w-[240px]">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold">{r.name}</h3>
                    <Badge variant="outline" className={`text-[10px] ${prioridadeBadge(r.priority)}`}>{r.priority}</Badge>
                    {!r.active && <Badge variant="outline" className="text-[10px]">pausado</Badge>}
                    {!r.flow_id && <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-400">sem fluxo</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{r.meaning}</p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Select
                    value={r.flow_id ?? "__none"}
                    onValueChange={(v) => mutate.mutate({ id: r.id, flow_id: v === "__none" ? null : v })}
                  >
                    <SelectTrigger className="w-[200px] h-8 text-xs"><SelectValue placeholder="Vincular fluxo…" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">— sem fluxo —</SelectItem>
                      {flows.map((f) => (
                        <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Switch checked={r.active} onCheckedChange={(v) => mutate.mutate({ id: r.id, active: v })} />
                  <Button size="sm" variant="outline" onClick={async () => {
                    const res = await testRuleFn({ data: { trigger_type: r.trigger_type } });
                    toast.message(`${r.name}`, { description: `${res.matches_last_7d} disparos nos últimos 7 dias` });
                  }}>
                    Testar
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// FLUXOS (backend real)
// ============================================================
type BlockType = "text" | "image" | "video" | "audio" | "document" | "delay";
interface FlowBlockDraft {
  block_type: BlockType;
  content: string;
  caption: string;
  media_url: string | null;
  media_mimetype: string | null;
  media_filename: string | null;
  delay_seconds: number;
}
interface FlowTemplateDraft {
  id?: string;
  name: string;
  is_active: boolean;
  weight: number;
  blocks: FlowBlockDraft[];
}
interface FlowDraft {
  id?: string;
  name: string;
  trigger_type: string;
  priority: "critico" | "alto" | "medio" | "baixo";
  active: boolean;
  delay_min_seconds: number;
  delay_max_seconds: number;
  cooldown_hours: number;
  daily_limit: number;
  hourly_limit: number;
  exit_conditions: { login: boolean; deposit: boolean; first_deposit: boolean; bet: boolean; whatsapp_reply: boolean; human_takeover: boolean };
  templates: FlowTemplateDraft[];
}

const emptyBlock = (): FlowBlockDraft => ({ block_type: "text", content: "", caption: "", media_url: null, media_mimetype: null, media_filename: null, delay_seconds: 0 });
const emptyTemplate = (name = "Template 1"): FlowTemplateDraft => ({ name, is_active: true, weight: 1, blocks: [emptyBlock()] });

const EMPTY_FLOW: FlowDraft = {
  name: "Novo fluxo",
  trigger_type: "recuperacao_vip",
  priority: "medio",
  active: true,
  // Delays, cooldown e limites passam a ser 100% controlados pela aba Antispam.
  // Aqui ficam valores "neutros": min/máx 0 deixam o Antispam mandar no delay,
  // limites altos deixam o Antispam mandar nos tetos (Math.min vence).
  delay_min_seconds: 0,
  delay_max_seconds: 0,
  cooldown_hours: 0,
  daily_limit: 10000,
  hourly_limit: 1000,
  exit_conditions: { login: true, deposit: true, first_deposit: true, bet: true, whatsapp_reply: true, human_takeover: true },
  templates: [emptyTemplate()],
};

function FluxosTab() {
  const qc = useQueryClient();
  const listFlowsFn = useServerFn(listFlows);
  const deleteFlowFn = useServerFn(deleteFlow);
  const toggleFlowFn = useServerFn(toggleFlow);
  const duplicateFlowFn = useServerFn(duplicateFlow);
  const triggerTestFn = useServerFn(triggerFlowTest);
  const runEvalFn = useServerFn(runEvaluateAndDispatch);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [testFlowId, setTestFlowId] = useState<string | null>(null);
  const [testLead, setTestLead] = useState<SelectedLead | null>(null);
  const [testing, setTesting] = useState(false);
  const [evaluating, setEvaluating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["flows"],
    queryFn: () => listFlowsFn(),
  });
  const flows = (data?.flows ?? []) as any[];

  const getAntibanFn = useServerFn(getAntibanSettings);
  const { data: antibanData } = useQuery({
    queryKey: ["antiban-settings"],
    queryFn: () => getAntibanFn(),
  });
  const antiban = (antibanData?.settings ?? null) as any;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["flows"] });
    qc.invalidateQueries({ queryKey: ["rules"] });
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-muted-foreground">Automações multi-bloco com templates aleatórios e condições de saída. Delays, cooldown e limites ficam na aba Antispam.</p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={evaluating}
            onClick={async () => {
              setEvaluating(true);
              try {
                const r = await runEvalFn();
                toast.success(
                  `Avaliação: ${r.evaluate.enqueued} novos · Envio: ${r.dispatch.sent} mensagens`,
                );
                invalidate();
              } catch (e: any) {
                toast.error(e?.message ?? "Falha ao rodar");
              } finally {
                setEvaluating(false);
              }
            }}
          >
            {evaluating ? "Avaliando…" : "Avaliar agora"}
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> Novo fluxo
          </Button>
        </div>
      </div>

      <div className="grid gap-3">
        {isLoading && <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Carregando fluxos…</CardContent></Card>}
        {!isLoading && flows.length === 0 && (
          <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
            Nenhum fluxo criado ainda. Clique em "Novo fluxo" para criar a primeira automação.
          </CardContent></Card>
        )}
        {flows.map((f) => (
          <Card
            key={f.id}
            className={`border-l-2 transition-all hover:shadow-md ${
              f.priority === "critico"
                ? "border-l-red-500/70"
                : f.priority === "alto"
                  ? "border-l-orange-500/70"
                  : f.priority === "medio"
                    ? "border-l-amber-500/70"
                    : "border-l-slate-500/50"
            } ${!f.active ? "opacity-70" : ""}`}
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex-1 min-w-[240px]">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold tracking-tight">{f.name}</h3>
                    <Badge variant="outline" className={`text-[10px] ${prioridadeBadge(f.priority)}`}>{f.priority}</Badge>
                    {!f.active && <Badge variant="outline" className="text-[10px]">pausado</Badge>}
                    {f.active && f.activated_at ? (() => {
                      const activatedAt = new Date(f.activated_at).getTime();
                      const graceExpires = activatedAt + 48 * 60 * 60 * 1000;
                      const within = Date.now() < graceExpires;
                      const fmt = (ts: number) => new Date(ts).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
                      return within ? (
                        <Badge variant="outline" className="text-[10px] border-amber-500/50 text-amber-600 dark:text-amber-400" title="Nas primeiras 48h após ativação, só novos eventos disparam — proteção do WhatsApp.">
                          proteção 48h · libera {fmt(graceExpires)}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] text-muted-foreground">
                          ativo desde {fmt(activatedAt)}
                        </Badge>
                      );
                    })() : null}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 flex flex-wrap items-center gap-x-1">
                    <span>Gatilho: {TRIGGER_LABELS[f.trigger_type] ?? f.trigger_type}</span>
                    {antiban ? (() => {
                      const delayMin = Math.max(antiban.delay_min_seconds ?? 0, f.delay_min_seconds ?? 0);
                      const delayMax = Math.max(delayMin, antiban.delay_max_seconds ?? 0, f.delay_max_seconds ?? 0);
                      const cooldown = Math.max(antiban.cooldown_hours ?? 0, f.cooldown_hours ?? 0);
                      const daily = Math.min(
                        antiban.daily_limit ?? Number.MAX_SAFE_INTEGER,
                        f.daily_limit ?? Number.MAX_SAFE_INTEGER,
                      );
                      const hourly = Math.min(
                        antiban.hourly_limit ?? Number.MAX_SAFE_INTEGER,
                        f.hourly_limit ?? Number.MAX_SAFE_INTEGER,
                      );
                      const fmtDelay = (s: number) => (s >= 60 ? `${Math.round(s / 60)} min` : `${s}s`);
                      return (
                        <>
                          <span>· delay {fmtDelay(delayMin)}–{fmtDelay(delayMax)}</span>
                          <span>· cooldown {cooldown}h</span>
                          <span>· {daily}/dia · {hourly}/h</span>
                          <Badge variant="outline" className="text-[9px] ml-1 border-primary/40 text-primary">via Antispam</Badge>
                        </>
                      );
                    })() : (
                      <span>· carregando limites…</span>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={f.active} onCheckedChange={async (v) => {
                    if (v && !f.active) {
                      const ok = confirm(
                        `Ativar "${f.name}"?\n\nNas primeiras 48h, só NOVOS eventos vão disparar — isso protege o WhatsApp de uma enxurrada inicial. Depois desse prazo, leads que ainda estiverem em estado de gatilho entram naturalmente, respeitando os limites do Antispam.`,
                      );
                      if (!ok) return;
                    }
                    await toggleFlowFn({ data: { id: f.id, active: v } });
                    invalidate();
                  }} />
                  <Button size="sm" variant="outline" onClick={() => setEditingId(f.id)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    title="Disparar teste"
                    onClick={() => {
                      setTestFlowId(f.id);
                      setTestLead(null);
                    }}
                  >
                    <Send className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="outline" onClick={async () => { await duplicateFlowFn({ data: { id: f.id } }); invalidate(); toast.success("Fluxo duplicado"); }}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="outline" onClick={async () => {
                    if (!confirm(`Excluir fluxo "${f.name}"?`)) return;
                    await deleteFlowFn({ data: { id: f.id } });
                    invalidate();
                    toast.success("Fluxo removido");
                  }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {(editingId || creating) && (
        <FluxoEditor
          flowId={editingId}
          onClose={() => { setEditingId(null); setCreating(false); }}
          onSaved={() => { invalidate(); setEditingId(null); setCreating(false); }}
        />
      )}

      <Dialog open={!!testFlowId} onOpenChange={(o) => { if (!o) { setTestFlowId(null); setTestLead(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disparar teste</DialogTitle>
            <DialogDescription>
              Escolhe um player com WhatsApp válido. O primeiro bloco do fluxo é enviado na hora, ignorando janela operacional. Cada player só pode entrar uma vez por fluxo.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <LeadSelector value={testLead} onChange={setTestLead} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setTestFlowId(null); setTestLead(null); }}>
              Cancelar
            </Button>
            <Button
              disabled={!testFlowId || !testLead?.id || testing}
              onClick={async () => {
                if (!testFlowId || !testLead?.id) return;
                setTesting(true);
                try {
                  const res = await triggerTestFn({
                    data: { flow_id: testFlowId, player_id: testLead.id },
                  });
                  toast.success(
                    `Enviado para ${res.to} · ${res.dispatcher.sent} mensagem(ns)`,
                  );
                  setTestFlowId(null);
                  setTestLead(null);
                  invalidate();
                } catch (e: any) {
                  toast.error(e?.message ?? "Falha no disparo");
                } finally {
                  setTesting(false);
                }
              }}
            >
              {testing ? "Enviando…" : "Disparar agora"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FluxoEditor({ flowId, onClose, onSaved }: { flowId: string | null; onClose: () => void; onSaved: () => void }) {
  const getFlowFn = useServerFn(getFlow);
  const saveFlowFn = useServerFn(saveFlow);
  const uploadFn = useServerFn(createMediaUploadUrl);

  const [draft, setDraft] = useState<FlowDraft>(EMPTY_FLOW);
  const [loading, setLoading] = useState(false);
  const [activeTpl, setActiveTpl] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!flowId) { setDraft(EMPTY_FLOW); setActiveTpl(0); return; }
    setLoading(true);
    getFlowFn({ data: { id: flowId } })
      .then((res: any) => {
        if (!res.flow) return;
        const tpls: FlowTemplateDraft[] = ((res.templates ?? []) as any[]).map((t) => ({
          id: t.id,
          name: t.name,
          is_active: t.is_active,
          weight: t.weight ?? 1,
          blocks: (t.blocks ?? []).map((b: any) => ({
            block_type: b.block_type,
            content: b.content ?? "",
            caption: b.caption ?? "",
            media_url: b.media_url,
            media_mimetype: b.media_mimetype,
            media_filename: b.media_filename,
            delay_seconds: b.delay_seconds ?? 0,
          })),
        }));
        setDraft({
          id: res.flow.id,
          name: res.flow.name,
          trigger_type: res.flow.trigger_type,
          priority: res.flow.priority,
          active: res.flow.active,
          delay_min_seconds: res.flow.delay_min_seconds,
          delay_max_seconds: res.flow.delay_max_seconds,
          cooldown_hours: res.flow.cooldown_hours,
          daily_limit: res.flow.daily_limit,
          hourly_limit: res.flow.hourly_limit,
          exit_conditions: { ...EMPTY_FLOW.exit_conditions, ...(res.flow.exit_conditions ?? {}) },
          templates: tpls.length > 0 ? tpls : [emptyTemplate()],
        });
        setActiveTpl(0);
      })
      .finally(() => setLoading(false));
  }, [flowId, getFlowFn]);

  // Helpers de TEMPLATE
  function patchTemplate(ti: number, patch: Partial<FlowTemplateDraft>) {
    setDraft((d) => ({ ...d, templates: d.templates.map((t, idx) => (idx === ti ? { ...t, ...patch } : t)) }));
  }
  function addTemplate() {
    setDraft((d) => {
      const next = [...d.templates, emptyTemplate(`Template ${d.templates.length + 1}`)];
      setActiveTpl(next.length - 1);
      return { ...d, templates: next };
    });
  }
  function duplicateTemplate(ti: number) {
    setDraft((d) => {
      const src = d.templates[ti];
      const copy: FlowTemplateDraft = JSON.parse(JSON.stringify({ ...src, id: undefined, name: `${src.name} (cópia)` }));
      const next = [...d.templates.slice(0, ti + 1), copy, ...d.templates.slice(ti + 1)];
      setActiveTpl(ti + 1);
      return { ...d, templates: next };
    });
  }
  function removeTemplate(ti: number) {
    setDraft((d) => {
      if (d.templates.length <= 1) { toast.error("O fluxo precisa de pelo menos 1 template"); return d; }
      const next = d.templates.filter((_, idx) => idx !== ti);
      setActiveTpl(Math.max(0, Math.min(activeTpl, next.length - 1)));
      return { ...d, templates: next };
    });
  }

  // Helpers de BLOCO (operam no template ativo)
  function updateBlock(i: number, patch: Partial<FlowBlockDraft>) {
    patchTemplate(activeTpl, {
      blocks: draft.templates[activeTpl].blocks.map((b, idx) => (idx === i ? { ...b, ...patch } : b)),
    });
  }
  function moveBlock(i: number, dir: -1 | 1) {
    const arr = [...draft.templates[activeTpl].blocks];
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    patchTemplate(activeTpl, { blocks: arr });
  }
  function removeBlock(i: number) {
    patchTemplate(activeTpl, { blocks: draft.templates[activeTpl].blocks.filter((_, idx) => idx !== i) });
  }
  function addBlock(type: BlockType) {
    patchTemplate(activeTpl, {
      blocks: [
        ...draft.templates[activeTpl].blocks,
        { block_type: type, content: "", caption: "", media_url: null, media_mimetype: null, media_filename: null, delay_seconds: type === "delay" ? 60 : 0 },
      ],
    });
  }

  async function handleUpload(i: number, file: File) {
    try {
      const { path, token } = await uploadFn({ data: { filename: file.name, mimetype: file.type } });
      const { error } = await supabase.storage.from("whatsapp-media").uploadToSignedUrl(path, token, file, { contentType: file.type });
      if (error) throw error;
      updateBlock(i, { media_url: path, media_mimetype: file.type, media_filename: file.name });
      toast.success("Mídia enviada");
    } catch (e: any) {
      toast.error(e?.message ?? "Falha no upload");
    }
  }

  async function handleSave() {
    if (saving) return;
    try {
      if (!draft.name.trim()) return toast.error("Nome obrigatório");
      if (draft.templates.length === 0) return toast.error("Adicione ao menos 1 template");
      for (let ti = 0; ti < draft.templates.length; ti++) {
        const tpl = draft.templates[ti];
        if (!tpl.name.trim()) return toast.error(`Template ${ti + 1}: nome obrigatório`);
        if (tpl.blocks.length === 0) return toast.error(`Template "${tpl.name}": adicione ao menos 1 bloco`);
        for (const b of tpl.blocks) {
          if (b.block_type === "text" && !b.content.trim()) return toast.error(`Template "${tpl.name}": bloco de texto vazio`);
          if (["image", "video", "audio", "document"].includes(b.block_type) && !b.media_url) return toast.error(`Template "${tpl.name}": bloco ${b.block_type} sem mídia`);
        }
      }
      setSaving(true);
      await saveFlowFn({ data: draft });
      toast.success("Fluxo salvo");
      onSaved();
    } catch (e: any) {
      toast.error(e?.message ?? "Falha ao salvar");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !saving) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{flowId ? "Editar fluxo" : "Novo fluxo"}</DialogTitle>
          <DialogDescription>Configure gatilho, blocos multimídia e condições de saída. Delays, cooldown e limites são globais (aba Antispam).</DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="text-sm text-muted-foreground py-8 text-center">Carregando…</p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Nome</Label>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Gatilho</Label>
                <Select value={draft.trigger_type} onValueChange={(v) => setDraft({ ...draft, trigger_type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(TRIGGER_LABELS).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Prioridade</Label>
                <Select value={draft.priority} onValueChange={(v) => setDraft({ ...draft, priority: v as FlowDraft["priority"] })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="critico">Crítico</SelectItem>
                    <SelectItem value="alto">Alto</SelectItem>
                    <SelectItem value="medio">Médio</SelectItem>
                    <SelectItem value="baixo">Baixo</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
              Delay entre disparos, cooldown por lead e limites por hora/dia são globais e ficam na aba <strong className="text-foreground">Antispam</strong>.
            </div>

            <Separator />

            <div className="space-y-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <Label className="flex items-center gap-1.5"><Workflow className="h-3.5 w-3.5" /> Templates ({draft.templates.length}) — escolhido aleatoriamente no envio</Label>
                <Button size="sm" variant="outline" onClick={addTemplate}><Plus className="h-3 w-3" /> Novo template</Button>
              </div>

              {/* Abas dos templates */}
              <div className="flex items-center gap-1 flex-wrap border-b border-border/60 pb-1">
                {draft.templates.map((t, ti) => (
                  <button
                    key={ti}
                    type="button"
                    onClick={() => setActiveTpl(ti)}
                    className={`px-3 py-1.5 rounded-t-md text-xs flex items-center gap-1.5 transition-colors ${ti === activeTpl ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    <span>{t.name || `Template ${ti + 1}`}</span>
                    {!t.is_active && <Badge variant="outline" className="text-[9px] px-1 py-0">pausado</Badge>}
                    <span className="text-[9px] opacity-60">peso {t.weight}</span>
                  </button>
                ))}
              </div>

              {/* Cabeçalho do template ativo */}
              {draft.templates[activeTpl] && (
                <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto_auto] gap-2 items-end p-2 rounded-md bg-muted/30">
                  <div className="space-y-1">
                    <Label className="text-[11px]">Nome do template</Label>
                    <Input value={draft.templates[activeTpl].name} onChange={(e) => patchTemplate(activeTpl, { name: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px]">Peso</Label>
                    <Input type="number" min={1} max={100} className="w-20" value={draft.templates[activeTpl].weight} onChange={(e) => patchTemplate(activeTpl, { weight: Math.max(1, +e.target.value || 1) })} />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Switch checked={draft.templates[activeTpl].is_active} onCheckedChange={(v) => patchTemplate(activeTpl, { is_active: v })} />
                    <span className="text-xs">{draft.templates[activeTpl].is_active ? "Ativo" : "Pausado"}</span>
                  </div>
                  <div className="flex gap-1">
                    <Button size="sm" variant="outline" onClick={() => duplicateTemplate(activeTpl)} title="Duplicar template"><Copy className="h-3 w-3" /></Button>
                    <Button size="sm" variant="outline" onClick={() => removeTemplate(activeTpl)} title="Excluir template"><Trash2 className="h-3 w-3" /></Button>
                  </div>
                </div>
              )}

              {/* Toolbar de blocos */}
              <div className="flex gap-1 flex-wrap">
                <Button size="sm" variant="outline" onClick={() => addBlock("text")}><Type className="h-3 w-3" /> Texto</Button>
                <Button size="sm" variant="outline" onClick={() => addBlock("image")}><ImageIcon className="h-3 w-3" /> Imagem</Button>
                <Button size="sm" variant="outline" onClick={() => addBlock("video")}><Video className="h-3 w-3" /> Vídeo</Button>
                <Button size="sm" variant="outline" onClick={() => addBlock("audio")}><Mic className="h-3 w-3" /> Áudio</Button>
                <Button size="sm" variant="outline" onClick={() => addBlock("document")}><FileText className="h-3 w-3" /> PDF</Button>
                <Button size="sm" variant="outline" onClick={() => addBlock("delay")}><Timer className="h-3 w-3" /> Delay</Button>
              </div>

              {(draft.templates[activeTpl]?.blocks ?? []).map((b, i) => (
                <Card key={i} className="border-border/60">
                  <CardContent className="p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant="outline" className="text-[10px] capitalize">{i + 1}. {b.block_type}</Badge>
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => moveBlock(i, -1)} disabled={i === 0}><ArrowUp className="h-3 w-3" /></Button>
                        <Button size="sm" variant="ghost" onClick={() => moveBlock(i, 1)} disabled={i === (draft.templates[activeTpl]?.blocks.length ?? 0) - 1}><ArrowDown className="h-3 w-3" /></Button>
                        <Button size="sm" variant="ghost" onClick={() => removeBlock(i)}><Trash2 className="h-3 w-3" /></Button>
                      </div>
                    </div>

                    {b.block_type === "text" && (
                      <>
                        <Textarea
                          rows={3}
                          placeholder="Mensagem — use {primeiro_nome}, {saldo}, etc."
                          value={b.content}
                          onChange={(e) => updateBlock(i, { content: e.target.value })}
                        />
                        <MessageVariablePicker
                          value={b.content}
                          onChange={(next: string) => updateBlock(i, { content: next })}
                        />
                      </>
                    )}

                    {b.block_type === "delay" && (
                      <div className="flex items-center gap-2 text-sm">
                        <span>Aguardar</span>
                        <Input type="number" className="w-24" value={b.delay_seconds} onChange={(e) => updateBlock(i, { delay_seconds: +e.target.value || 0 })} />
                        <span>segundos</span>
                      </div>
                    )}

                    {["image", "video", "audio", "document"].includes(b.block_type) && (
                      <div className="space-y-2">
                        <Input
                          type="file"
                          accept={
                            b.block_type === "image" ? "image/*" :
                            b.block_type === "video" ? "video/*" :
                            b.block_type === "audio" ? "audio/*" :
                            ".pdf,application/pdf"
                          }
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(i, f); }}
                        />
                        {b.media_url && (
                          <p className="text-[11px] text-emerald-400">✓ {b.media_filename}</p>
                        )}
                        {b.block_type !== "audio" && (
                          <>
                            <Textarea
                              rows={2}
                              placeholder="Legenda (opcional)"
                              value={b.caption}
                              onChange={(e) => updateBlock(i, { caption: e.target.value })}
                            />
                            <MessageVariablePicker
                              value={b.caption}
                              onChange={(next: string) => updateBlock(i, { caption: next })}
                            />
                          </>
                        )}
                      </div>
                    )}

                    {b.block_type !== "delay" && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Timer className="h-3 w-3" />
                        <span>Esperar</span>
                        <Input type="number" className="w-20 h-7 text-xs" value={b.delay_seconds} onChange={(e) => updateBlock(i, { delay_seconds: +e.target.value || 0 })} />
                        <span>seg antes do próximo bloco</span>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>

            <Separator />

            <div className="space-y-2">
              <Label>Condições de saída automática</Label>
              <div className="flex gap-2 flex-wrap text-xs">
                {([
                  ["login", "Login"],
                  ["deposit", "Depósito"],
                  ["first_deposit", "Primeiro depósito"],
                  ["bet", "Aposta"],
                  ["whatsapp_reply", "Resposta WhatsApp"],
                  ["human_takeover", "Handoff humano"],
                ] as const).map(([k, label]) => {
                  const ativo = draft.exit_conditions[k];
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setDraft({ ...draft, exit_conditions: { ...draft.exit_conditions, [k]: !ativo } })}
                      className={`px-2 py-1 rounded-md border text-xs transition-colors ${ativo ? "bg-primary/15 border-primary/30 text-primary" : "border-border text-muted-foreground"}`}
                    >
                      {ativo && <CheckCircle2 className="inline h-3 w-3 mr-1" />}{label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Switch checked={draft.active} onCheckedChange={(v) => setDraft({ ...draft, active: v })} />
              <Label className="text-sm">Ativo</Label>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? "Salvando…" : "Salvar fluxo"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// INBOX
// ============================================================
function InboxTab() {
  const qc = useQueryClient();
  const listChats = useServerFn(listInboxChats);
  const listMsgs = useServerFn(listChatMessages);
  const sendFn = useServerFn(sendWhatsappMessage);

  const { data: chatsData, isLoading: chatsLoading } = useQuery({
    queryKey: ["inbox-chats"],
    queryFn: () => listChats(),
    refetchInterval: 15000,
  });
  const chats = (chatsData?.chats ?? []) as any[];
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!activeId && chats.length > 0) setActiveId(chats[0].id);
  }, [chats, activeId]);

  const { data: msgsData } = useQuery({
    queryKey: ["inbox-messages", activeId],
    queryFn: () => (activeId ? listMsgs({ data: { chat_id: activeId } }) : Promise.resolve({ messages: [] })),
    enabled: !!activeId,
    refetchInterval: 5000,
  });
  const messages = (msgsData?.messages ?? []) as any[];

  // Realtime: invalida queries quando chega mensagem nova
  useEffect(() => {
    const ch = supabase
      .channel("whatsapp-inbox")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "whatsapp_messages" },
        () => {
          qc.invalidateQueries({ queryKey: ["inbox-chats"] });
          qc.invalidateQueries({ queryKey: ["inbox-messages"] });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "whatsapp_chats" },
        () => qc.invalidateQueries({ queryKey: ["inbox-chats"] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [qc]);

  const sendMut = useMutation({
    mutationFn: () => sendFn({ data: { chat_id: activeId!, text: draft } }),
    onSuccess: () => {
      setDraft("");
      qc.invalidateQueries({ queryKey: ["inbox-messages", activeId] });
      qc.invalidateQueries({ queryKey: ["inbox-chats"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Falha ao enviar"),
  });

  return (
    <Card className="overflow-hidden">
      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] h-[600px]">
        {/* Lista de conversas */}
        <div className="border-r border-border flex flex-col">
          <div className="p-3 border-b border-border flex items-center gap-2">
            <span className="text-sm font-medium">Conversas</span>
            <span className="ml-auto flex items-center gap-1 text-[10px] text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px] shadow-emerald-400/60" />
              tempo real
            </span>
          </div>
          <ScrollArea className="flex-1">
            {chatsLoading ? (
              <p className="p-4 text-xs text-muted-foreground">Carregando…</p>
            ) : chats.length === 0 ? (
              <div className="p-4 text-xs text-muted-foreground space-y-2">
                <p>Aguardando mensagens.</p>
                <p className="text-muted-foreground/70">
                  Envie ou receba algo no WhatsApp conectado — a conversa aparece aqui em tempo real.
                </p>
              </div>
            ) : (
              chats.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setActiveId(c.id)}
                  className={`w-full text-left p-3 border-b border-border/60 hover:bg-muted/40 transition-colors ${activeId === c.id ? "bg-muted/60" : ""}`}
                >
                  <div className="flex justify-between items-baseline gap-2">
                    <span className="text-sm font-medium truncate">{c.name || c.phone || c.remote_jid}</span>
                    {c.unread_count > 0 && (
                      <Badge variant="default" className="text-[10px] h-4 px-1.5">{c.unread_count}</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">{c.last_message ?? "—"}</p>
                </button>
              ))
            )}
          </ScrollArea>
        </div>

        {/* Painel mensagens */}
        <div className="flex flex-col">
          {!activeId ? (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              Selecione uma conversa
            </div>
          ) : (
            <>
              <ScrollArea className="flex-1 p-4">
                <div className="space-y-2">
                  {messages.map((m) => (
                    <div
                      key={m.id}
                      className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${m.from_me ? "ml-auto bg-emerald-500/15 text-emerald-100" : "bg-muted/60"}`}
                    >
                      <div className="whitespace-pre-wrap break-words">{m.text ?? `[${m.message_type}]`}</div>
                      <div className="text-[10px] text-muted-foreground/70 mt-1 text-right">
                        {new Date(m.message_timestamp).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                      </div>
                    </div>
                  ))}
                  {messages.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-8">Sem mensagens nesta conversa.</p>
                  )}
                </div>
              </ScrollArea>
              <div className="border-t border-border p-3 flex gap-2">
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && draft.trim()) {
                      e.preventDefault();
                      sendMut.mutate();
                    }
                  }}
                  placeholder="Digite uma mensagem…"
                />
                <Button onClick={() => sendMut.mutate()} disabled={!draft.trim() || sendMut.isPending}>
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

// ============================================================
// FILA
// ============================================================
function FilaTab() {
  const statsFn = useServerFn(getWhatsappQueueStats);
  const resumeFn = useServerFn(resumeWhatsappQueue);
  const backfillFn = useServerFn(backfillWhatsappFromAlerts);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["whatsapp-queue-stats"],
    queryFn: () => statsFn(),
    refetchInterval: 15_000,
  });

  const resume = useMutation({
    mutationFn: (bypassWindow: boolean) => resumeFn({ data: { bypassWindow } }),
    onSuccess: (r: any) => {
      const sent = r?.dispatched?.sent ?? 0;
      const skipped = r?.dispatched?.skipped;
      toast.success(
        `${r.resumed} destravados, ${r.retried} reagendados, ${sent} enviados${skipped ? ` (${skipped})` : ""}`,
      );
      qc.invalidateQueries({ queryKey: ["whatsapp-queue-stats"] });
    },
    onError: (e: any) => toast.error(`Falha: ${e?.message ?? "erro"}`),
  });

  const backfill = useMutation({
    mutationFn: () => backfillFn(),
    onSuccess: (r: any) =>
      toast.success(`${r.enqueued} novos leads enfileirados (${r.skipped} ignorados de ${r.scanned})`),
    onError: (e: any) => toast.error(`Falha: ${e?.message ?? "erro"}`),
  });

  const c = data?.counts ?? { pending: 0, running: 0, cooldown: 0, overdue: 0, failed: 0, sent_today: 0 };
  const problems = data?.problems ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ListOrdered className="h-4 w-4" /> Fila de disparo
          </CardTitle>
          <CardDescription>
            Estado real dos leads em fluxos de WhatsApp. Atualiza a cada 15s.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
            <QueueMetric label="Pending" value={c.pending} />
            <QueueMetric label="Running" value={c.running} />
            <QueueMetric label="Cooldown" value={c.cooldown} />
            <QueueMetric label="Atrasados" value={c.overdue} highlight={c.overdue > 0} />
            <QueueMetric label="Falhas" value={c.failed} highlight={c.failed > 0} />
            <QueueMetric label="Enviados hoje" value={c.sent_today} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => resume.mutate(false)}
              disabled={resume.isPending || c.overdue === 0}
              size="sm"
            >
              <Zap className="h-4 w-4 mr-1" />
              {resume.isPending ? "Disparando…" : `Disparar agora (${c.overdue} atrasados)`}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => resume.mutate(true)}
              disabled={resume.isPending}
              title="Ignora a janela operacional do anti-ban (use só pra testar)"
            >
              Forçar (bypass janela)
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => backfill.mutate()}
              disabled={backfill.isPending}
            >
              <UserCheck className="h-4 w-4 mr-1" />
              {backfill.isPending ? "Processando…" : "Reprocessar alertas pendentes"}
            </Button>
          </div>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Carregando…</p>
          ) : problems.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhum lead atrasado ou com falha. A fila está em dia.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground border-b">
                  <tr>
                    <th className="text-left py-2 pr-3">Lead</th>
                    <th className="text-left py-2 pr-3">Fluxo</th>
                    <th className="text-left py-2 pr-3">Status</th>
                    <th className="text-left py-2 pr-3">Agendado p/</th>
                    <th className="text-left py-2 pr-3">Tentativas</th>
                    <th className="text-left py-2 pr-3">Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {problems.map((p) => (
                    <tr key={p.id} className="border-b border-border/50">
                      <td className="py-2 pr-3">
                        <div className="font-medium">{p.player_name}</div>
                        <div className="text-muted-foreground">{p.phone}</div>
                      </td>
                      <td className="py-2 pr-3">{p.flow_name}</td>
                      <td className="py-2 pr-3">
                        <Badge variant={p.status === "failed" ? "destructive" : "outline"}>
                          {p.status}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3">
                        {new Date(p.next_run_at).toLocaleString("pt-BR")}
                      </td>
                      <td className="py-2 pr-3">{p.attempts}</td>
                      <td className="py-2 pr-3 text-muted-foreground max-w-[260px] truncate">
                        {typeof p.reason === "string" ? p.reason : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function QueueMetric({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold ${highlight ? "text-destructive" : ""}`}>{value}</div>
    </div>
  );
}

// ============================================================
// HISTÓRICO
// ============================================================
function HistoricoTab() {
  return (
    <HistoryShell
      channel="whatsapp"
      options={{
        title: "Histórico do WhatsApp",
        subtitle: "Mensagens enviadas pelos bots. Fluxo e etapa não disponíveis para mensagens livres.",
        showFlow: false,
        showStep: false,
      }}
    />
  );
}

// ============================================================
// ANTI-BAN
// ============================================================
function AntibanTab() {
  const getFn = useServerFn(getAntibanSettings);
  const saveFn = useServerFn(saveAntibanSettings);
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["antiban-settings"],
    queryFn: () => getFn(),
  });
  const settings = data?.settings;

  // estado local em minutos (slider) e msg
  const [delayMin, setDelayMin] = useState([3]);
  const [delayMax, setDelayMax] = useState([12]);
  const [msgHora, setMsgHora] = useState([40]);
  const [msgSessao, setMsgSessao] = useState([400]);
  const [cooldownLead, setCooldownLead] = useState([48]);
  const [janelaIni, setJanelaIni] = useState("08:00");
  const [janelaFim, setJanelaFim] = useState("22:00");
  const [randomizacao, setRandomizacao] = useState(true);
  const [supressao, setSupressao] = useState(true);
  const [pausaAuto, setPausaAuto] = useState(true);
  const [aquecimento, setAquecimento] = useState(true);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);

  // hidrata estado quando carrega
  useEffect(() => {
    if (!settings || loaded) return;
    setDelayMin([Math.max(1, Math.round((settings.delay_min_seconds ?? 180) / 60))]);
    setDelayMax([Math.max(1, Math.round((settings.delay_max_seconds ?? 720) / 60))]);
    setMsgHora([settings.hourly_limit ?? 40]);
    setMsgSessao([settings.daily_limit ?? 400]);
    setCooldownLead([settings.cooldown_hours ?? 48]);
    setJanelaIni((settings.window_start ?? "08:00").slice(0, 5));
    setJanelaFim((settings.window_end ?? "22:00").slice(0, 5));
    setRandomizacao(!!settings.randomization_enabled);
    setSupressao(!!settings.smart_suppression_enabled);
    setPausaAuto(!!settings.auto_pause_enabled);
    setAquecimento(!!settings.warmup_enabled);
    setLoaded(true);
  }, [settings, loaded]);

  const mutation = useMutation({
    mutationFn: (payload: {
      delay_min_seconds: number;
      delay_max_seconds: number;
      hourly_limit: number;
      daily_limit: number;
      cooldown_hours: number;
      window_start: string;
      window_end: string;
      randomization_enabled: boolean;
      smart_suppression_enabled: boolean;
      auto_pause_enabled: boolean;
      warmup_enabled: boolean;
      warmup_initial_daily: number;
      warmup_days: number;
    }) => saveFn({ data: payload }),
    onSuccess: () => {
      setSavedAt(Date.now());
      qc.invalidateQueries({ queryKey: ["antiban-settings"] });
    },
  });

  // auto-save com debounce
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      mutation.mutate({
        delay_min_seconds: delayMin[0] * 60,
        delay_max_seconds: Math.max(delayMin[0], delayMax[0]) * 60,
        hourly_limit: msgHora[0],
        daily_limit: msgSessao[0],
        cooldown_hours: cooldownLead[0],
        window_start: janelaIni,
        window_end: janelaFim,
        randomization_enabled: randomizacao,
        smart_suppression_enabled: supressao,
        auto_pause_enabled: pausaAuto,
        warmup_enabled: aquecimento,
        warmup_initial_daily: settings?.warmup_initial_daily ?? 50,
        warmup_days: settings?.warmup_days ?? 7,
      });
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    loaded,
    delayMin,
    delayMax,
    msgHora,
    msgSessao,
    cooldownLead,
    janelaIni,
    janelaFim,
    randomizacao,
    supressao,
    pausaAuto,
    aquecimento,
  ]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Clock className="h-4 w-4" /> Delays e cooldowns</CardTitle>
          <CardDescription>Comportamento humano para evitar padrões robóticos.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <SliderRow label="Delay mínimo entre disparos" value={delayMin} setValue={setDelayMin} unit="min" max={30} />
          <SliderRow label="Delay máximo entre disparos" value={delayMax} setValue={setDelayMax} unit="min" max={60} />
          <SliderRow label="Mensagens por hora (por sessão)" value={msgHora} setValue={setMsgHora} unit="msg/h" max={120} />
          <SliderRow label="Mensagens por sessão (dia)" value={msgSessao} setValue={setMsgSessao} unit="msg/dia" max={800} />
          <SliderRow label="Cooldown por lead" value={cooldownLead} setValue={setCooldownLead} unit="h" max={168} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Shield className="h-4 w-4" /> Proteções automáticas</CardTitle>
          <CardDescription>Travas de segurança da fila inteligente.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ToggleRow label="Randomização de mensagens" desc="Escolhe variações automaticamente e evita repetição." checked={randomizacao} onChange={setRandomizacao} />
          <ToggleRow label="Supressão inteligente" desc="Não dispara se o lead respondeu, voltou ou já está em outro fluxo." checked={supressao} onChange={setSupressao} />
          <ToggleRow label="Pausa automática em risco" desc="Sessões com risco alto são pausadas até reaquecer." checked={pausaAuto} onChange={setPausaAuto} />
          <ToggleRow label="Aquecimento progressivo" desc="Novos números começam com limite reduzido." checked={aquecimento} onChange={setAquecimento} />

          <Separator />

          <div className="space-y-2">
            <Label className="text-xs">Janela operacional</Label>
            <div className="flex gap-2 items-center">
              <Input type="time" value={janelaIni} onChange={(e) => setJanelaIni(e.target.value)} />
              <span className="text-muted-foreground">até</span>
              <Input type="time" value={janelaFim} onChange={(e) => setJanelaFim(e.target.value)} />
            </div>
            <p className="text-[11px] text-muted-foreground">Fora desta janela, mensagens ficam na fila até o próximo horário válido.</p>
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2 border-amber-500/30 bg-amber-500/5">
        <CardContent className="p-4 flex gap-3 items-start">
          <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs">
            <p className="font-semibold text-amber-300 mb-1 flex items-center gap-2">
              Política anti-ban ativa
              {savedAt && (
                <span className="text-[10px] font-normal text-emerald-400">• salvo</span>
              )}
            </p>
            <p className="text-muted-foreground">
              Estes limites valem como teto global obrigatório — fluxos e sessões nunca excedem estes valores. Nenhum evento dispara instantaneamente: toda mensagem passa pela fila inteligente, respeita cooldown por lead, vinculação fixa de sessão, delays aleatórios e limites por sessão.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function SliderRow({ label, value, setValue, unit, max }: { label: string; value: number[]; setValue: (v: number[]) => void; unit: string; max: number }) {
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-xs">
        <span>{label}</span>
        <span className="font-medium tabular-nums">{value[0]} {unit}</span>
      </div>
      <Slider value={value} onValueChange={setValue} min={1} max={max} step={1} />
    </div>
  );
}

function ToggleRow({ label, desc, checked, onChange }: { label: string; desc: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex-1">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{desc}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
// ============================================================
// PROXIES TAB
// ============================================================
function ProxiesTab() {
  const qc = useQueryClient();
  const listFn = useServerFn(listWhatsappProxies);
  const createFn = useServerFn(createWhatsappProxy);
  const updateFn = useServerFn(updateWhatsappProxy);
  const deleteFn = useServerFn(deleteWhatsappProxy);
  const testFn = useServerFn(testWhatsappProxy);

  const { data, isLoading } = useQuery({
    queryKey: ["whatsapp-proxies"],
    queryFn: () => listFn(),
  });
  const proxies = (data?.proxies ?? []) as any[];

  const emptyForm = {
    id: null as string | null,
    name: "",
    protocol: "http" as "http" | "https" | "socks4" | "socks5",
    host: "",
    port: 8080,
    username: "",
    password: "",
    provider: "",
    notes: "",
    status: "active" as "active" | "inactive",
    has_password: false,
  };
  const [form, setForm] = useState(emptyForm);
  const [open, setOpen] = useState(false);

  const openCreate = () => {
    setForm(emptyForm);
    setOpen(true);
  };
  const openEdit = (p: any) => {
    setForm({
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      host: p.host,
      port: p.port,
      username: p.username ?? "",
      password: "",
      provider: p.provider ?? "",
      notes: p.notes ?? "",
      status: p.status,
      has_password: p.has_password,
    });
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: async () => {
      const payload = {
        name: form.name.trim(),
        protocol: form.protocol,
        host: form.host.trim(),
        port: Number(form.port),
        username: form.username.trim() || null,
        password: form.password ? form.password : null,
        provider: form.provider.trim() || null,
        notes: form.notes.trim() || null,
        status: form.status,
      };
      if (form.id) {
        return updateFn({ data: { id: form.id, ...payload } });
      }
      return createFn({ data: payload });
    },
    onSuccess: () => {
      toast.success(form.id ? "Proxy atualizado" : "Proxy criado");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["whatsapp-proxies"] });
    },
    onError: (e: any) => toast.error(e.message ?? "Erro ao salvar"),
  });

  const testMut = useMutation({
    mutationFn: (id: string) => testFn({ data: { id } }),
    onSuccess: (res) => {
      if (res.ok) toast.success(`Proxy OK · handshake completo (${res.latency_ms}ms)`);
      else toast.error(`Falhou [${res.stage}]: ${res.error}`);
      qc.invalidateQueries({ queryKey: ["whatsapp-proxies"] });
    },
    onError: (e: any) => toast.error(e.message ?? "Erro"),
  });

  const testInlineMut = useMutation({
    mutationFn: () =>
      testFn({
        data: {
          inline: {
            protocol: form.protocol,
            host: form.host.trim(),
            port: Number(form.port),
            username: form.username || null,
            password: form.password || null,
          },
        },
      }),
    onSuccess: (res) => {
      if (res.ok) toast.success(`Proxy OK · handshake completo (${res.latency_ms}ms)`);
      else toast.error(`Falhou [${res.stage}]: ${res.error}`);
    },
    onError: (e: any) => toast.error(e.message ?? "Erro"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Proxy excluído");
      qc.invalidateQueries({ queryKey: ["whatsapp-proxies"] });
    },
    onError: (e: any) => toast.error(e.message ?? "Erro"),
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold">Proxies WhatsApp</h2>
          <p className="text-sm text-muted-foreground">
            Cadastre proxies e vincule a sessões. O proxy é aplicado automaticamente ao conectar.
          </p>
        </div>
        <Button size="sm" onClick={openCreate}>
          <Plus className="h-4 w-4" /> Novo proxy
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : proxies.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10">
              <Shield className="h-6 w-6 text-emerald-400" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-semibold">Nenhum proxy cadastrado</h3>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                Cadastre seu primeiro proxy para vincular a sessões WhatsApp.
              </p>
            </div>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4" /> Cadastrar proxy
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {proxies.map((p) => (
            <Card key={p.id}>
              <CardHeader className="pb-3">
                <div className="flex justify-between items-start">
                  <div className="min-w-0">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Shield className="h-4 w-4 text-emerald-400" /> {p.name}
                    </CardTitle>
                    <CardDescription className="text-xs mt-0.5 font-mono truncate">
                      {p.protocol}://{p.host}:{p.port}
                    </CardDescription>
                    {p.provider && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">{p.provider}</p>
                    )}
                  </div>
                  <Badge
                    variant="outline"
                    className={`text-[10px] ${
                      p.status === "active"
                        ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                        : "bg-slate-500/15 text-slate-400 border-slate-500/30"
                    }`}
                  >
                    {p.status === "active" ? "Ativo" : "Inativo"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {p.last_tested_at && (
                  <div
                    className={`text-[11px] rounded-md p-2 ${
                      p.last_test_ok
                        ? "bg-emerald-500/10 text-emerald-400"
                        : "bg-rose-500/10 text-rose-400"
                    }`}
                  >
                    Último teste: {p.last_test_ok ? "✓ OK" : `✗ ${p.last_test_error ?? "falhou"}`}
                  </div>
                )}
                <div className="flex gap-1.5 flex-wrap">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1"
                    onClick={() => testMut.mutate(p.id)}
                    disabled={testMut.isPending}
                  >
                    <Zap className="h-3.5 w-3.5" /> Testar
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => openEdit(p)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (!confirm(`Excluir proxy "${p.name}"?`)) return;
                      deleteMut.mutate(p.id);
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

      {/* Create / Edit dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{form.id ? "Editar proxy" : "Novo proxy"}</DialogTitle>
            <DialogDescription>
              Dados usados apenas para conectar sessões WhatsApp à Evolution.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label>Nome</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Pedro Mensal"
              />
            </div>
            <div>
              <Label>Protocolo</Label>
              <Select
                value={form.protocol}
                onValueChange={(v) => setForm({ ...form, protocol: v as any })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">HTTP</SelectItem>
                  <SelectItem value="https">HTTPS</SelectItem>
                  <SelectItem value="socks4">SOCKS4</SelectItem>
                  <SelectItem value="socks5">SOCKS5</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Provedor</Label>
              <Input
                value={form.provider}
                onChange={(e) => setForm({ ...form, provider: e.target.value })}
                placeholder="opcional"
              />
            </div>
            <div className="col-span-2 grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <Label>Host</Label>
                <Input
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                  placeholder="proxy.exemplo.com"
                />
              </div>
              <div>
                <Label>Porta</Label>
                <Input
                  type="number"
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
                />
              </div>
            </div>
            <div>
              <Label>Usuário</Label>
              <Input
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                placeholder="opcional"
              />
            </div>
            <div>
              <Label>Senha</Label>
              <Input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder={form.has_password ? "••••••••" : "opcional"}
              />
              {form.has_password && (
                <p className="text-[10px] text-muted-foreground mt-1">
                  Deixe em branco para manter a atual.
                </p>
              )}
            </div>
            <div className="col-span-2">
              <Label>Notas</Label>
              <Textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={2}
              />
            </div>
            <div className="col-span-2 flex items-center justify-between rounded-md border border-border p-3">
              <div>
                <div className="text-sm font-medium">Ativo</div>
                <div className="text-xs text-muted-foreground">
                  Proxies inativos não podem ser vinculados.
                </div>
              </div>
              <Switch
                checked={form.status === "active"}
                onCheckedChange={(c) =>
                  setForm({ ...form, status: c ? "active" : "inactive" })
                }
              />
            </div>
          </div>
          <DialogFooter className="flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => testInlineMut.mutate()}
              disabled={!form.host || !form.port || testInlineMut.isPending}
            >
              <Zap className="h-4 w-4" />
              {testInlineMut.isPending ? "Testando…" : "Testar conexão"}
            </Button>
            <div className="flex-1" />
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() => saveMut.mutate()}
              disabled={!form.name || !form.host || !form.port || saveMut.isPending}
            >
              {saveMut.isPending ? "Salvando…" : "Salvar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
