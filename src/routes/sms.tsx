import { createFileRoute } from "@tanstack/react-router";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRealtimeInvalidate } from "@/hooks/use-realtime-invalidate";
import {
  DashboardDateRangePicker,
  defaultTodayRange,
  rangeToKey,
  type DashboardRange,
} from "@/components/dashboard-date-range-picker";
import {
  MessageSquare,
  Send,
  CheckCircle2,
  XCircle,
  Clock,
  Workflow,
  Users,
  TrendingUp,
  Plus,
  Pencil,
  Pause,
  Play,
  Copy,
  Trash2,
  ChevronRight,
  Sparkles,
  Variable,
  Eye,
  Zap,
  Timer,
  Search,
  RotateCw,
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
import { TRIGGER_NAMES, TRIGGER_MEANINGS, type TriggerType } from "@/lib/triggers";
import { SendWindowCard } from "@/components/send-window-card";
import { ProvidersPausedBanner } from "@/components/providers-paused-banner";
import {
  smsProviderStatus,
  sendTestSms,
  listSmsLogs,
  sendBulkSms,
  getSmsDashboard,
  scheduleBulkSms,
  listScheduledSmsCampaigns,
  cancelScheduledSmsCampaign,
} from "@/lib/sms.functions";
import {
  getFailedSmsBreakdown,
  resendFailedSms,
} from "@/lib/sms.functions";
import { listPlayersForCalls } from "@/lib/calls.functions";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
} from "recharts";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { MessageVariablePicker } from "@/components/message-variable-picker";
import { HistoryShell } from "@/components/history/history-shell";
import { LeadSelector, type SelectedLead } from "@/components/ligacoes/lead-selector";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listSmsFlows,
  saveSmsFlow,
  toggleSmsFlow,
  duplicateSmsFlow,
  deleteSmsFlow,
} from "@/lib/sms-flows.functions";

export const Route = createFileRoute("/sms")({
  head: () => ({
    meta: [
      { title: "SMS — BETLEADS" },
      { name: "description", content: "Central de SMS, envios em massa e fluxos automáticos." },
    ],
  }),
  component: SmsPage,
});

type FluxoStatus = "ativo" | "inativo";
type Gatilho = TriggerType;

const GATILHOS: Gatilho[] = Object.keys(TRIGGER_NAMES) as Gatilho[];

type Etapa =
  | { tipo: "sms"; mensagem: string }
  | { tipo: "delay"; dias: number };

type Fluxo = {
  id: string;
  nome: string;
  status: FluxoStatus;
  gatilho: Gatilho;
  etapas: Etapa[];
  saida: string[];
  players: number;
  enviados: number;
  conversoes: number;
  atualizadoEm: string;
};

const FLUXOS_INICIAIS: Fluxo[] = [
  {
    id: "f1",
    nome: "Recuperação 7 dias sem depósito",
    status: "ativo",
    gatilho: "engajado_sem_converter",
    etapas: [
      { tipo: "sms", mensagem: "Fala {primeiro_nome}, sentimos sua falta! Bônus liberado: {link}" },
      { tipo: "delay", dias: 1 },
      { tipo: "sms", mensagem: "{primeiro_nome}, seu bônus expira em breve. Aproveite: {link}" },
      { tipo: "delay", dias: 2 },
      { tipo: "sms", mensagem: "Última chance, {primeiro_nome}! {link}" },
    ],
    saida: ["se fizer login", "se depositar", "se fizer primeiro depósito", "se voltar a jogar"],
    players: 0,
    enviados: 0,
    conversoes: 0,
    atualizadoEm: "há 2h",
  },
  {
    id: "f2",
    nome: "VIP esfriando",
    status: "ativo",
    gatilho: "vip_esfriando",
    etapas: [
      { tipo: "sms", mensagem: "{primeiro_nome}, seu gerente VIP quer falar contigo." },
      { tipo: "delay", dias: 2 },
      { tipo: "sms", mensagem: "Bônus exclusivo VIP liberado: {link}" },
    ],
    saida: ["se fizer login", "se depositar", "se fizer primeiro depósito"],
    players: 0,
    enviados: 0,
    conversoes: 0,
    atualizadoEm: "há 5h",
  },
  {
    id: "f3",
    nome: "Cadastrou e não depositou",
    status: "inativo",
    gatilho: "lead_quente_esfriando",
    etapas: [
      { tipo: "sms", mensagem: "Bem-vindo {primeiro_nome}! Seu bônus de boas-vindas: {link}" },
      { tipo: "delay", dias: 1 },
      { tipo: "sms", mensagem: "{primeiro_nome}, ative seu bônus antes que expire." },
    ],
    saida: ["se depositar", "se fizer primeiro depósito"],
    players: 0,
    enviados: 0,
    conversoes: 0,
    atualizadoEm: "há 3 dias",
  },
];

const VARIAVEIS = [
  "{primeiro_nome}",
  "{nome}",
  "{dias_sem_login}",
  "{dias_sem_deposito}",
  "{total_depositado}",
  "{saldo_atual}",
  "{expert}",
  "{link}",
];

function previewMensagem(msg: string) {
  return msg
    .replaceAll("{primeiro_nome}", "João")
    .replaceAll("{nome}", "João Silva")
    .replaceAll("{dias_sem_login}", "7")
    .replaceAll("{dias_sem_deposito}", "12")
    .replaceAll("{total_depositado}", "R$ 1.240")
    .replaceAll("{saldo_atual}", "R$ 38")
    .replaceAll("{expert}", "Carlos")
    .replaceAll("{link}", "bet.ly/x9k");
}

function smsCount(len: number) {
  if (len === 0) return 0;
  if (len <= 160) return 1;
  return Math.ceil(len / 153);
}

// ---------------- Page ----------------

function SmsPage() {
  const navigate = useNavigate();
  const hash = useLocation({ select: (l) => l.hash });
  const VALID = ["dashboard", "massa", "campanhas", "fluxos", "historico", "provedor"] as const;
  const currentTab = (VALID as readonly string[]).includes(hash) ? hash : "dashboard";
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-accent glow-blue">
          <MessageSquare className="h-5 w-5 text-primary-foreground" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight">SMS</h1>
          <p className="text-sm text-muted-foreground">
            Central de envios, campanhas e fluxos automáticos
          </p>
        </div>
      </div>

      <SendWindowCard compact />

      <ProvidersPausedBanner channel="sms" />

      <Tabs
        value={currentTab}
        onValueChange={(v) => navigate({ to: "/sms", hash: v, replace: true })}
        className="w-full"
      >
        <TabsList className="hidden">
          <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
          <TabsTrigger value="massa">Envio em Massa</TabsTrigger>
          <TabsTrigger value="campanhas">Campanhas</TabsTrigger>
          <TabsTrigger value="fluxos">Fluxos</TabsTrigger>
          <TabsTrigger value="historico">Histórico</TabsTrigger>
          <TabsTrigger value="provedor">Provedor</TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard" className="mt-6">
          <Dashboard />
        </TabsContent>
        <TabsContent value="massa" className="mt-6">
          <EnvioMassa />
        </TabsContent>
        <TabsContent value="campanhas" className="mt-6">
          <Campanhas />
        </TabsContent>
        <TabsContent value="fluxos" className="mt-6">
          <Fluxos />
        </TabsContent>
        <TabsContent value="historico" className="mt-6">
          <HistoryShell
            channel="sms"
            options={{
              title: "Histórico de SMS",
              subtitle: "Todos os disparos, fluxos e status.",
            }}
          />
        </TabsContent>
        <TabsContent value="provedor" className="mt-6">
          <Provedor />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------- Provedor (integração BusinessCode) ----------------

function Provedor() {
  const qc = useQueryClient();
  const statusFn = useServerFn(smsProviderStatus);
  const logsFn = useServerFn(listSmsLogs);
  const sendFn = useServerFn(sendTestSms);

  const status = useQuery({ queryKey: ["sms-provider-status"], queryFn: () => statusFn() });
  const logs = useQuery({ queryKey: ["sms-send-logs"], queryFn: () => logsFn() });

  const [to, setTo] = useState("");
  const [content, setContent] = useState("Teste BetLeads ✅");
  const [testLead, setTestLead] = useState<SelectedLead | null>(null);

  const webhookUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/public/sms-webhook`
      : "/api/public/sms-webhook";

  const send = useMutation({
    mutationFn: () =>
      sendFn({
        data: {
          to,
          content,
          playerId: testLead?.id ?? undefined,
        },
      }),
    onSuccess: (r: any) => {
      if (r?.ok) toast.success("SMS enviado com sucesso");
      else toast.error(`Falha: ${r?.error ?? "erro desconhecido"}`);
      qc.invalidateQueries({ queryKey: ["sms-send-logs"] });
    },
    onError: (e: any) => toast.error(`Erro: ${e?.message ?? e}`),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Provedor SMS — BusinessCode</CardTitle>
          <CardDescription>
            Integração via API REST. Endpoint:{" "}
            <code className="text-xs">dash.businesscode.com.br/api/v1/messaging/sms</code>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Token:</span>
            {status.data?.configured ? (
              <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
                <CheckCircle2 className="h-3 w-3 mr-1" /> Configurado
              </Badge>
            ) : (
              <Badge variant="destructive">
                <XCircle className="h-3 w-3 mr-1" /> Não configurado
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Os números são normalizados para E.164 (+55 + DDD + número) antes do envio.
            Cada requisição usa um <code>Idempotency-Key</code> único.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>URL de Callback (Webhook)</CardTitle>
          <CardDescription>
            Cole esta URL no painel da BusinessCode para receber o status de entrega dos SMS.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Input readOnly value={webhookUrl} className="font-mono text-xs" />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                navigator.clipboard.writeText(webhookUrl);
                toast.success("URL copiada");
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
            <li>Método: <code>POST</code> · Content-Type: <code>application/json</code></li>
            <li>
              Casamos o callback pelo campo <code>id</code> / <code>message_id</code> retornado
              no envio (com fallback no <code>idempotency_key</code>).
            </li>
            <li>
              Statuses reconhecidos: <code>delivered</code>, <code>sent</code>, <code>failed</code>,
              <code>undelivered</code>.
            </li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Enviar SMS de teste</CardTitle>
          <CardDescription>
            Envia direto pelo provedor, sem passar por fluxo.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-1">
              <Label>Telefone</Label>
              <Input
                placeholder="+5521980194445"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <div className="md:col-span-2">
              <Label>Mensagem</Label>
              <Textarea
                rows={2}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                maxLength={480}
              />
            </div>
          </div>
          <div>
            <Label>Player (opcional — para substituir variáveis)</Label>
            <LeadSelector value={testLead} onChange={setTestLead} />
            <p className="text-xs text-muted-foreground mt-1">
              Selecione um player para que tokens como{" "}
              <code>{"{primeiro_nome}"}</code> sejam substituídos pelo provedor.
              Sem player, os tokens chegam literais.
            </p>
          </div>
          <div className="flex justify-end">
            <Button
              onClick={() => send.mutate()}
              disabled={send.isPending || !to || !content || !status.data?.configured}
            >
              <Send className="h-4 w-4 mr-2" />
              {send.isPending ? "Enviando…" : "Enviar teste"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Últimos envios</CardTitle>
          <CardDescription>50 envios mais recentes</CardDescription>
        </CardHeader>
        <CardContent>
          {logs.isLoading ? (
            <p className="text-sm text-muted-foreground">Carregando…</p>
          ) : (logs.data?.logs ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum envio ainda.</p>
          ) : (
            <div className="space-y-2">
              {(logs.data?.logs ?? []).map((l: any) => (
                <div
                  key={l.id}
                  className="flex items-start gap-3 p-3 rounded-md border bg-card/50"
                >
                  {l.status === "sent" ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400 mt-0.5 shrink-0" />
                  ) : (
                    <XCircle className="h-4 w-4 text-red-400 mt-0.5 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium">{l.to_phone}</span>
                      {l.delivery_status && (
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-xs",
                            l.delivery_status === "delivered" &&
                              "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
                            l.delivery_status === "failed" &&
                              "bg-red-500/15 text-red-400 border-red-500/30",
                            l.delivery_status === "sent" &&
                              "bg-sky-500/15 text-sky-400 border-sky-500/30",
                          )}
                        >
                          {l.delivery_status === "delivered"
                            ? "entregue"
                            : l.delivery_status === "failed"
                            ? "falhou"
                            : l.delivery_status}
                        </Badge>
                      )}
                      {l.trigger_name && (
                        <Badge variant="outline" className="text-xs">
                          {l.trigger_name}
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground ml-auto">
                        {new Date(l.created_at).toLocaleString("pt-BR")}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground truncate">{l.content}</p>
                    {l.error && (
                      <p className="text-xs text-red-400 mt-1 break-all">{l.error}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------- Dashboard ----------------

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = "default",
  action,
}: {
  icon: any;
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "success" | "danger" | "warning" | "info";
  action?: ReactNode;
}) {
  const tones: Record<string, string> = {
    default: "text-primary bg-primary/10",
    success: "text-emerald-400 bg-emerald-400/10",
    danger: "text-rose-400 bg-rose-400/10",
    warning: "text-amber-400 bg-amber-400/10",
    info: "text-sky-400 bg-sky-400/10",
  };
  return (
    <Card className="border-border/60">
      <CardContent className="p-4 flex items-center gap-4">
        <div className={cn("flex h-10 w-10 items-center justify-center rounded-lg", tones[tone])}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
          <p className="text-2xl font-bold leading-tight">{value}</p>
          {hint && <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>}
          {action && <div className="mt-2">{action}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

function Dashboard() {
  const [range, setRange] = useState<DashboardRange>(() => defaultTodayRange());
  const rk = rangeToKey(range);
  const sameDay = rk.from === rk.to;
  const fn = useServerFn(getSmsDashboard);
  const qc = useQueryClient();
  const breakdownFn = useServerFn(getFailedSmsBreakdown);
  const resendFn = useServerFn(resendFailedSms);
  const [resendOpen, setResendOpen] = useState(false);
  const [includeRate, setIncludeRate] = useState(true);
  const [includeCarrier, setIncludeCarrier] = useState(false);
  const [resending, setResending] = useState(false);
  const breakdownQ = useQuery({
    queryKey: ["sms-failed-breakdown", rk.to],
    queryFn: () => breakdownFn({ data: { date: rk.to } }),
    enabled: resendOpen,
  });
  useRealtimeInvalidate(
    "sms-dashboard-realtime",
    ["sms_send_logs", "sms_flow_leads", "dispatcher_runs", "dispatch_rate_state"],
    [["sms-dashboard"]],
  );
  const { data } = useQuery({
    queryKey: ["sms-dashboard", rk.from, rk.to],
    queryFn: () => fn({ data: rk }),
    refetchInterval: 10_000,
    placeholderData: (prev) => prev,
  });

  const totals = data?.totals;
  const today = data?.today;
  const isLoading = !data;
  const fmtDay = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    if (sameDay) return d.toLocaleTimeString("pt-BR", { hour: "2-digit" });
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  };
  // Rótulo dinâmico do card "hoje": reflete o último dia do período filtrado.
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
  // Em range de vários dias, o card principal mostra o total do PERÍODO.
  // Em um único dia, mostra o desse dia (today.sent vem como "último dia").
  const sentHeadline = sameDay ? (today?.sent ?? 0) : (totals?.sent ?? 0);
  const sentHeadlineLabel = sameDay ? `SMS ${lastDayLabel}` : "SMS no período";
  const uniqHeadline = sameDay
    ? ((today as any)?.unique_recipients ?? 0)
    : ((totals as any)?.unique_recipients ?? 0);
  const sentHeadlineHint = sameDay
    ? `Período: ${totals?.sent ?? 0} · ${uniqHeadline} telefones únicos`
    : `${(lastDayLabel[0]?.toUpperCase() ?? "") + lastDayLabel.slice(1)}: ${today?.sent ?? 0} · ${uniqHeadline} telefones únicos`;
  const failedHeadline = sameDay ? (today?.failed ?? 0) : (totals?.failed ?? 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Visão geral</h2>
          <p className="text-xs text-muted-foreground">
            Métricas atualizadas a cada 30s · janela de conversão: 72h pós-SMS
          </p>
        </div>
        <DashboardDateRangePicker range={range} onChange={setRange} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={Send}
          label={sentHeadlineLabel}
          value={isLoading ? "…" : String(sentHeadline)}
          hint={sentHeadlineHint}
          tone="info"
        />
        <StatCard
          icon={CheckCircle2}
          label="Entregues"
          value={isLoading ? "…" : String(totals?.delivered ?? 0)}
          hint={
            totals && totals.sent > 0
              ? `${Math.round((totals.delivered / totals.sent) * 100)}% taxa`
              : "—"
          }
          tone="success"
        />
        <StatCard
          icon={XCircle}
          label="Falharam"
          value={isLoading ? "…" : String(failedHeadline)}
          hint={
            today
              ? sameDay
                ? `Período: ${totals?.failed ?? 0}`
                : `${(lastDayLabel[0]?.toUpperCase() ?? "") + lastDayLabel.slice(1)}: ${today.failed}`
              : "—"
          }
          tone="danger"
          action={
            failedHeadline > 0 ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 text-xs"
                onClick={() => setResendOpen(true)}
              >
                <RotateCw className="h-3 w-3" /> Reenviar
              </Button>
            ) : undefined
          }
        />
        <StatCard
          icon={Clock}
          label="Pendentes"
          value={isLoading ? "…" : String((totals as any)?.queue_total ?? totals?.pending ?? 0)}
          hint={
            ((totals as any)?.queue_due ?? 0) > 0
              ? `${(totals as any).queue_due} prontos agora`
              : "aguardando janela de envio"
          }
          tone="warning"
        />
        <StatCard
          icon={Workflow}
          label="Fluxos ativos"
          value={isLoading ? "…" : String(totals?.active_flows ?? 0)}
          tone="default"
        />
        <StatCard
          icon={Users}
          label="Players em fluxo"
          value={isLoading ? "…" : String(totals?.players_in_flow ?? 0)}
          tone="info"
        />
        <StatCard
          icon={TrendingUp}
          label="Conversões pós-SMS"
          value={isLoading ? "…" : String(totals?.conversions ?? 0)}
          hint="depósitos em 72h"
          tone="success"
        />
        <StatCard
          icon={Sparkles}
          label="Taxa de conversão"
          value={
            isLoading
              ? "…"
              : totals && totals.sent > 0
              ? `${Math.round((totals.conversions / totals.sent) * 100)}%`
              : "0%"
          }
          hint={totals ? `${totals.conversions} / ${totals.sent} SMS` : "—"}
          tone="default"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Envios e entregas</CardTitle>
            <CardDescription>
              {sameDay
                ? new Date(rk.from + "T00:00:00").toLocaleDateString("pt-BR")
                : `${new Date(rk.from + "T00:00:00").toLocaleDateString("pt-BR")} - ${new Date(rk.to + "T00:00:00").toLocaleDateString("pt-BR")}`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={data?.by_day ?? []}>
                <defs>
                  <linearGradient id="grad1" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="grad2" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#10b981" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  tickFormatter={fmtDay}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                  }}
                  labelFormatter={(v) => fmtDay(String(v))}
                />
                <Legend />
                <Area type="monotone" dataKey="enviados" stroke="hsl(var(--primary))" fill="url(#grad1)" />
                <Area type="monotone" dataKey="entregues" stroke="#10b981" fill="url(#grad2)" />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Conversões após SMS</CardTitle>
            <CardDescription>Players que depositaram após receber SMS</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={data?.conversions_by_day ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  tickFormatter={fmtDay}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                  }}
                  labelFormatter={(v) => fmtDay(String(v))}
                />
                <Line
                  type="monotone"
                  dataKey="conversoes"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={{ fill: "hsl(var(--primary))" }}
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <AlertDialog open={resendOpen} onOpenChange={(o) => !resending && setResendOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reenviar SMS que falharam</AlertDialogTitle>
            <AlertDialogDescription>
              Dia {new Date(rk.to + "T00:00:00").toLocaleDateString("pt-BR")}. Cada
              destinatário recebe no máximo uma vez (deduplicado por telefone +
              conteúdo). Quem já recebeu o mesmo SMS com sucesso nas últimas 24h
              é ignorado automaticamente.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3 py-2">
            <label className="flex items-start gap-3 rounded-md border border-border/60 p-3 cursor-pointer">
              <Checkbox
                checked={includeRate}
                onCheckedChange={(v) => setIncludeRate(v === true)}
                disabled={resending}
              />
              <div className="flex-1 text-sm">
                <div className="font-medium">Limite de envio (HTTP 429)</div>
                <div className="text-xs text-muted-foreground">
                  {breakdownQ.data
                    ? `${breakdownQ.data.rate_limited} SMS — recomendado, não chegaram nem a sair para a operadora`
                    : "carregando…"}
                </div>
              </div>
            </label>

            <label className="flex items-start gap-3 rounded-md border border-border/60 p-3 cursor-pointer">
              <Checkbox
                checked={includeCarrier}
                onCheckedChange={(v) => setIncludeCarrier(v === true)}
                disabled={resending}
              />
              <div className="flex-1 text-sm">
                <div className="font-medium">Falha de entrega na operadora</div>
                <div className="text-xs text-muted-foreground">
                  {breakdownQ.data
                    ? `${breakdownQ.data.carrier_failed} SMS — número inválido, chip desativado ou bloqueio; reenvio pode falhar de novo`
                    : "carregando…"}
                </div>
              </div>
            </label>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={resending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={
                resending || (!includeRate && !includeCarrier) || !breakdownQ.data
              }
              onClick={async (e) => {
                e.preventDefault();
                setResending(true);
                const tid = toast.loading("Reenviando SMS…");
                try {
                  const r = await resendFn({
                    data: {
                      date: rk.to,
                      includeRateLimited: includeRate,
                      includeCarrierFailed: includeCarrier,
                    },
                  });
                  toast.success(
                    `${r.sent} reenviados · ${r.failed} falharam · ${r.skipped_already_delivered} já entregues`,
                    { id: tid },
                  );
                  setResendOpen(false);
                  qc.invalidateQueries({ queryKey: ["sms-dashboard"] });
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : "Falha ao reenviar",
                    { id: tid },
                  );
                } finally {
                  setResending(false);
                }
              }}
            >
              {resending ? "Reenviando…" : "Reenviar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------- Envio em Massa ----------------

type CampanhaStatus =
  | "Rascunho"
  | "Enviando"
  | "Enviado"
  | "Falhou";

function statusTone(s: CampanhaStatus) {
  switch (s) {
    case "Rascunho":
      return "bg-muted text-muted-foreground";
    case "Enviando":
      return "bg-primary/15 text-primary border border-primary/30";
    case "Enviado":
      return "bg-emerald-400/15 text-emerald-300 border border-emerald-400/30";
    case "Falhou":
      return "bg-rose-400/15 text-rose-300 border border-rose-400/30";
  }
}

function EnvioMassa() {
  const navigate = useNavigate();
  const [nome, setNome] = useState("");
  const rota = "iGaming" as const;
  const [destinatarios, setDestinatarios] = useState("");
  const [mensagem, setMensagem] = useState("");
  const [status, setStatus] = useState<CampanhaStatus>("Rascunho");
  const [resultado, setResultado] = useState<
    { sent: number; failed: number; pending: number; firstError?: string | null } | null
  >(null);
  const bulkFn = useServerFn(sendBulkSms);
  const scheduleFn = useServerFn(scheduleBulkSms);
  const listScheduledFn = useServerFn(listScheduledSmsCampaigns);
  const cancelScheduledFn = useServerFn(cancelScheduledSmsCampaign);
  const listPlayersFn = useServerFn(listPlayersForCalls);
  const qcMassa = useQueryClient();
  const [whenMode, setWhenMode] = useState<"agora" | "agendar">("agora");
  // Ritmo de entrega (SMS por minuto). Padrão rápido.
  const [ritmo, setRitmo] = useState<number>(5000);
  const defaultScheduleDate = () => {
    const d = new Date(Date.now() + 60 * 60_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const defaultScheduleTime = () => {
    const d = new Date(Date.now() + 60 * 60_000);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const [scheduleDate, setScheduleDate] = useState<string>(defaultScheduleDate);
  const [scheduleTime, setScheduleTime] = useState<string>(defaultScheduleTime);

  const scheduledCampaigns = useQuery({
    queryKey: ["sms-scheduled-campaigns"],
    queryFn: () => listScheduledFn(),
    refetchInterval: 30_000,
  });
  const cancelMut = useMutation({
    mutationFn: (id: string) => cancelScheduledFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Campanha cancelada");
      qcMassa.invalidateQueries({ queryKey: ["sms-scheduled-campaigns"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Falha ao cancelar"),
  });
  const [leadSearch, setLeadSearch] = useState("");
  const { data: playersData, isFetching: isFetchingPlayers } = useQuery({
    queryKey: ["sms-bulk-players", leadSearch],
    queryFn: () => listPlayersFn({ data: { search: leadSearch, limit: 20 } }),
  });
  const players = (playersData?.players ?? []) as Array<{
    id: string;
    nome: string;
    telefone: string | null;
    status: string | null;
    vip: boolean | null;
  }>;

  const numeros = useMemo(() => {
    return Array.from(
      new Set(
        destinatarios
          .split(/[\s,;\n]+/)
          .map((n) => n.replace(/\D/g, ""))
          .filter((n) => n.length >= 10),
      ),
    );
  }, [destinatarios]);

  function addLeadPhone(phone: string | null) {
    const digits = (phone ?? "").replace(/\D/g, "");
    if (digits.length < 10) {
      toast.error("Lead sem telefone válido");
      return;
    }
    if (numeros.includes(digits)) {
      toast.info("Número já está na lista");
      return;
    }
    setDestinatarios((d) => (d.trim() ? `${d.trim()}\n${digits}` : digits));
  }

  const chars = mensagem.length;
  const qtdSms = smsCount(chars);
  const custoUnit = 0.18;
  const custoTotal = numeros.length * qtdSms * custoUnit;

  function inserirVar(v: string) {
    setMensagem((m) => m + v);
  }

  async function enviar() {
    if (!nome.trim()) return toast.error("Defina um nome para a campanha");
    if (numeros.length === 0) return toast.error("Adicione destinatários válidos");
    if (!mensagem.trim()) return toast.error("Escreva uma mensagem");
    if (/\{[^}]+\}/.test(mensagem)) {
      toast.info("Números encontrados no CRM terão as variáveis substituídas automaticamente");
    }
    if (whenMode === "agendar") {
      if (!scheduleDate || !scheduleTime) return toast.error("Escolha data e hora");
      const scheduledAt = new Date(`${scheduleDate}T${scheduleTime}:00`);
      if (!Number.isFinite(scheduledAt.getTime())) return toast.error("Data/hora inválida");
      if (scheduledAt.getTime() < Date.now() + 60_000) {
        return toast.error("O horário deve estar pelo menos 1 minuto no futuro");
      }
      const tid = toast.loading("Agendando campanha...");
      try {
        await scheduleFn({
          data: {
            phones: numeros,
            content: mensagem,
            campaignName: nome,
            route: rota,
            scheduledAt: scheduledAt.toISOString(),
            ratePerMinute: ritmo,
          },
        });
        toast.success(
          `Campanha agendada para ${scheduledAt.toLocaleString("pt-BR")}`,
          { id: tid },
        );
        qcMassa.invalidateQueries({ queryKey: ["sms-scheduled-campaigns"] });
        novoRascunho();
      } catch (err) {
        toast.error(
          `Erro ao agendar: ${err instanceof Error ? err.message : String(err)}`,
          { id: tid },
        );
      }
      return;
    }
    setStatus("Enviando");
    setResultado(null);
    const tid = toast.loading(`Disparando ${numeros.length} SMS...`);
    try {
      const r = await bulkFn({
        data: {
          phones: numeros,
          content: mensagem,
          campaignName: nome,
          route: rota,
          ratePerMinute: ritmo,
        },
      });
      // Enfileirado como campanha (>50 destinatários): o dispatcher processa
      // em background respeitando cadência e cursor persistente.
      if ((r as { queued?: boolean }).queued) {
        setStatus("Enviando");
        setResultado({ sent: 0, failed: 0, pending: r.total, firstError: null });
        toast.success(
          `Campanha enfileirada — ${r.total} destinatários. Acompanhe em Campanhas.`,
          { id: tid, duration: 8000 },
        );
        qcMassa.invalidateQueries({ queryKey: ["sms-scheduled-campaigns"] });
        novoRascunho();
        return;
      }
      const firstError = r.results.find((x: { ok: boolean; error?: string }) => !x.ok)?.error ?? null;
      const pending = (r as { pending?: number }).pending ?? 0;
      setResultado({ sent: r.sent, failed: r.failed, pending, firstError });
      if (r.sent === r.total) {
        setStatus("Enviado");
        toast.success(`${r.sent} SMS enviados com sucesso`, { id: tid });
      } else if (r.failed === 0 && pending > 0) {
        setStatus("Enviado");
        toast.info(`${pending} SMS ficaram pendentes para retentativa`, { id: tid });
      } else if (r.sent === 0 && pending === 0) {
        setStatus("Falhou");
        toast.error(firstError ?? `Falha em todos os envios (${r.failed})`, {
          id: tid,
          duration: 8000,
        });
      } else {
        setStatus("Enviado");
        toast.warning(
          `${r.sent} enviados, ${r.failed} falharam${firstError ? ` — ${firstError}` : ""}`,
          { id: tid, duration: 8000 },
        );
      }
    } catch (err) {
      setStatus("Falhou");
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Erro ao enviar: ${msg}`, { id: tid });
    }
  }

  function novoRascunho() {
    setNome("");
    setDestinatarios("");
    setMensagem("");
    setStatus("Rascunho");
    setResultado(null);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Nova campanha</CardTitle>
            <CardDescription>Configure o envio em massa</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Nome da campanha</Label>
              <Input
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                placeholder="Ex: Recuperação semanal"
              />
            </div>

            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Clock className="h-4 w-4" /> Quando enviar
              </Label>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant={whenMode === "agora" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setWhenMode("agora")}
                >
                  Enviar agora
                </Button>
                <Button
                  type="button"
                  variant={whenMode === "agendar" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setWhenMode("agendar")}
                >
                  Agendar
                </Button>
              </div>
              {whenMode === "agendar" && (
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Data</Label>
                    <Input
                      type="date"
                      value={scheduleDate}
                      onChange={(e) => setScheduleDate(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Hora (BRT)</Label>
                    <Input
                      type="time"
                      value={scheduleTime}
                      onChange={(e) => setScheduleTime(e.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Zap className="h-4 w-4" /> Ritmo de entrega
              </Label>
              <div className="grid grid-cols-4 gap-2">
                {(
                  [
                    { v: 5000, label: "Turbo", hint: "~5.000/min" },
                    { v: 1000, label: "Rápido", hint: "~1.000/min" },
                    { v: 300, label: "Normal", hint: "~300/min" },
                    { v: 100, label: "Gradual", hint: "~100/min" },
                  ]
                ).map((o) => (
                  <Button
                    key={o.v}
                    type="button"
                    variant={ritmo === o.v ? "default" : "outline"}
                    size="sm"
                    className="flex-col h-auto py-2"
                    onClick={() => setRitmo(o.v)}
                  >
                    <span className="text-xs font-medium">{o.label}</span>
                    <span className="text-[10px] opacity-70">{o.hint}</span>
                  </Button>
                ))}
              </div>
              {numeros.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {numeros.length.toLocaleString("pt-BR")} destinatários · conclusão em ~
                  {Math.max(1, Math.ceil(numeros.length / ritmo))} min
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Search className="h-4 w-4" /> Buscar leads
              </Label>
              <Input
                placeholder="Nome ou telefone..."
                value={leadSearch}
                onChange={(e) => setLeadSearch(e.target.value)}
              />
              <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-card/50">
                {isFetchingPlayers && (
                  <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                    Buscando...
                  </p>
                )}
                {!isFetchingPlayers && players.length === 0 && (
                  <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                    Nenhum lead encontrado
                  </p>
                )}
                {players.map((p) => {
                  const digits = (p.telefone ?? "").replace(/\D/g, "");
                  const added = digits.length >= 10 && numeros.includes(digits);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => addLeadPhone(p.telefone)}
                      disabled={added || digits.length < 10}
                      className="flex w-full items-center justify-between gap-2 border-b border-border/40 px-3 py-2 text-left text-sm last:border-0 hover:bg-muted disabled:opacity-50"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{p.nome}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {p.telefone ?? "sem telefone"} ·{" "}
                          {p.vip ? "VIP" : (p.status ?? "ativo")}
                        </p>
                      </div>
                      {added ? (
                        <Badge variant="secondary">adicionado</Badge>
                      ) : (
                        <Plus className="h-4 w-4 text-primary" />
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                Clique para adicionar o número do lead à lista de destinatários.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Destinatários</Label>
              <Textarea
                rows={5}
                placeholder="Cole os números (um por linha ou separados por vírgula)"
                value={destinatarios}
                onChange={(e) => setDestinatarios(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {numeros.length} destinatários únicos detectados
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Mensagem</Label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="h-7 gap-1">
                      <Variable className="h-3 w-3" /> Inserir variável
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    {VARIAVEIS.map((v) => (
                      <DropdownMenuItem key={v} onClick={() => inserirVar(v)}>
                        {v}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <Textarea
                rows={4}
                placeholder="Fala {primeiro_nome}, seu bônus está liberado: {link}"
                value={mensagem}
                onChange={(e) => setMensagem(e.target.value)}
              />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{chars} caracteres</span>
                <span>{qtdSms} SMS por destinatário</span>
              </div>
            </div>

            <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
              <div className="flex items-center gap-2 mb-2">
                <Eye className="h-3.5 w-3.5 text-primary" />
                <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Preview
                </span>
              </div>
              <p className="text-sm">
                {mensagem ? previewMensagem(mensagem) : (
                  <span className="text-muted-foreground italic">Sua mensagem aparecerá aqui</span>
                )}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Resumo do envio</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Destinatários únicos" value={String(numeros.length)} />
            <Row label="Rota" value={rota} />
            <Row label="Caracteres" value={String(chars)} />
            <Row label="SMS estimados" value={String(numeros.length * qtdSms)} />
            <Row
              label="Custo estimado"
              value={custoTotal.toLocaleString("pt-BR", {
                style: "currency",
                currency: "BRL",
              })}
            />
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Status</span>
              <Badge className={cn("font-medium", statusTone(status))}>{status}</Badge>
            </div>

            <div className="space-y-2 pt-2">
              {status === "Rascunho" && (
                <Button className="w-full gap-2" onClick={enviar}>
                  <Send className="h-4 w-4" />{" "}
                  {whenMode === "agendar" ? "Agendar envio" : "Enviar SMS"}
                </Button>
              )}
              {status === "Enviando" && (
                <Button className="w-full gap-2" disabled>
                  <Send className="h-4 w-4 animate-pulse" /> Enviando...
                </Button>
              )}
              {(status === "Enviado" || status === "Falhou") && (
                <>
                  {resultado && (
                    <div className="space-y-1.5">
                      <div className="text-xs text-muted-foreground text-center">
                        {resultado.sent} enviados · {resultado.pending} pendentes · {resultado.failed} falharam
                      </div>
                      {resultado.firstError && (
                        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-2 text-[11px] leading-snug text-rose-200">
                          <span className="font-semibold">Motivo:</span> {resultado.firstError}
                        </div>
                      )}
                    </div>
                  )}
                  <Button variant="outline" className="w-full gap-2" onClick={novoRascunho}>
                    <Plus className="h-4 w-4" /> Nova campanha
                  </Button>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Variáveis disponíveis</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-1.5">
            {VARIAVEIS.map((v) => (
              <button
                key={v}
                onClick={() => inserirVar(v)}
                className="text-[11px] px-2 py-1 rounded border border-border/60 bg-muted/40 hover:bg-primary/10 hover:border-primary/40 hover:text-primary transition-colors font-mono"
              >
                {v}
              </button>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="h-4 w-4" /> Campanhas agendadas
            </CardTitle>
            <CardDescription>
              Acompanhe todos os envios programados e o histórico na aba dedicada.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => navigate({ to: "/sms", hash: "campanhas", replace: true })}
            >
              Ver campanhas
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

// ---------------- Campanhas (agendadas + histórico) ----------------

function Campanhas() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const listFn = useServerFn(listScheduledSmsCampaigns);
  const cancelFn = useServerFn(cancelScheduledSmsCampaign);

  const q = useQuery({
    queryKey: ["sms-scheduled-campaigns"],
    queryFn: () => listFn(),
    refetchInterval: (query) => {
      const list = (query.state.data as any)?.campaigns ?? [];
      return list.some((c: any) => c.status === "enviando") ? 15_000 : 30_000;
    },
  });

  const cancelMut = useMutation({
    mutationFn: (id: string) => cancelFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Campanha cancelada");
      qc.invalidateQueries({ queryKey: ["sms-scheduled-campaigns"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Falha ao cancelar"),
  });

  const all = (q.data?.campaigns ?? []) as Array<any>;
  const pendentes = all
    .filter((c) => c.status === "agendada" || c.status === "enviando")
    .sort(
      (a, b) =>
        new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime(),
    );
  const historico = all
    .filter(
      (c) =>
        c.status === "enviado" || c.status === "falhou" || c.status === "cancelada",
    )
    .sort(
      (a, b) =>
        new Date(b.updated_at ?? b.scheduled_at).getTime() -
        new Date(a.updated_at ?? a.scheduled_at).getTime(),
    );

  const badgeTone: Record<string, string> = {
    agendada: "bg-primary/15 text-primary border-primary/30",
    enviando: "bg-amber-400/15 text-amber-300 border-amber-400/30",
    enviado: "bg-emerald-400/15 text-emerald-300 border-emerald-400/30",
    falhou: "bg-rose-400/15 text-rose-300 border-rose-400/30",
    cancelada: "bg-muted text-muted-foreground border-border",
  };

  const fmt = (iso?: string | null) =>
    iso ? new Date(iso).toLocaleString("pt-BR") : "—";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold">Campanhas de SMS</h2>
          <p className="text-sm text-muted-foreground">
            {pendentes.length} agendada{pendentes.length === 1 ? "" : "s"} ·{" "}
            {historico.length} no histórico (últimos 30 dias)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
          >
            <RotateCw
              className={cn("h-4 w-4 mr-2", q.isFetching && "animate-spin")}
            />
            Atualizar
          </Button>
          <Button
            size="sm"
            onClick={() => navigate({ to: "/sms", hash: "massa", replace: true })}
          >
            <Plus className="h-4 w-4 mr-2" /> Nova campanha
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4" /> Agendadas
          </CardTitle>
          <CardDescription>
            Campanhas que ainda vão disparar ou estão sendo enviadas agora.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {q.isLoading && (
            <p className="text-sm text-muted-foreground">Carregando…</p>
          )}
          {!q.isLoading && pendentes.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nenhuma campanha agendada.
            </p>
          )}
          {pendentes.map((c) => {
            const total = c.total_count ?? 0;
            const sent = c.sent_count ?? 0;
            const pct = total > 0 ? Math.round((sent / total) * 100) : 0;
            return (
              <div
                key={c.id}
                className="rounded-lg border border-border/60 bg-card/50 p-3 space-y-2"
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{c.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Disparo: {fmt(c.scheduled_at)} · {total} destinatário
                      {total === 1 ? "" : "s"}
                    </p>
                  </div>
                  <Badge
                    className={cn(
                      "font-medium capitalize border",
                      badgeTone[c.status] ?? "",
                    )}
                  >
                    {c.status}
                  </Badge>
                </div>
                {c.status === "enviando" && (
                  <div className="space-y-1">
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-amber-400 transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {sent}/{total} enviados
                      {c.failed_count ? ` · ${c.failed_count} falharam` : ""}
                    </p>
                  </div>
                )}
                {c.status === "agendada" && (
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => cancelMut.mutate(c.id)}
                      disabled={cancelMut.isPending}
                    >
                      <XCircle className="h-3.5 w-3.5 mr-1" /> Cancelar
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" /> Histórico
          </CardTitle>
          <CardDescription>
            Campanhas enviadas, canceladas ou com falha nos últimos 30 dias.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {!q.isLoading && historico.length === 0 && (
            <p className="text-sm text-muted-foreground">Nada por aqui ainda.</p>
          )}
          {historico.map((c) => {
            const total = c.total_count ?? 0;
            const sent = c.sent_count ?? 0;
            const failed = c.failed_count ?? 0;
            return (
              <div
                key={c.id}
                className="rounded-lg border border-border/60 bg-card/50 p-3 space-y-1"
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{c.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Agendada: {fmt(c.scheduled_at)} · Concluída: {fmt(c.updated_at)}
                    </p>
                  </div>
                  <Badge
                    className={cn(
                      "font-medium capitalize border",
                      badgeTone[c.status] ?? "",
                    )}
                  >
                    {c.status}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {sent}/{total} enviados{failed ? ` · ${failed} falharam` : ""}
                </p>
                {c.last_error && (
                  <p className="text-[11px] text-rose-300 truncate">
                    Erro: {c.last_error}
                  </p>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------- Fluxos ----------------

function Fluxos() {
  const qc = useQueryClient();
  const listFn = useServerFn(listSmsFlows);
  const saveFn = useServerFn(saveSmsFlow);
  const toggleFn = useServerFn(toggleSmsFlow);
  const dupFn = useServerFn(duplicateSmsFlow);
  const delFn = useServerFn(deleteSmsFlow);

  const { data, isLoading } = useQuery({
    queryKey: ["sms-flows"],
    queryFn: () => listFn(),
  });
  const fluxos: Fluxo[] = (data?.fluxos ?? []) as Fluxo[];

  const [editor, setEditor] = useState<Fluxo | null>(null);
  const [confirmarExclusao, setConfirmarExclusao] = useState<Fluxo | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["sms-flows"] });

  const saveMut = useMutation({
    mutationFn: (f: Fluxo) =>
      saveFn({
        data: {
          id: /^[0-9a-f-]{36}$/.test(f.id) ? f.id : undefined,
          nome: f.nome,
          gatilho: f.gatilho,
          status: f.status,
          etapas: f.etapas,
          saida: f.saida,
        },
      }),
    onSuccess: () => {
      toast.success("Fluxo salvo");
      setEditor(null);
      invalidate();
    },
    onError: (e: any) => toast.error(e?.message ?? "Erro ao salvar"),
  });

  const toggleMut = useMutation({
    mutationFn: (v: { id: string; is_active: boolean }) => toggleFn({ data: v }),
    onSuccess: invalidate,
  });
  const dupMut = useMutation({
    mutationFn: (id: string) => dupFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Fluxo duplicado");
      invalidate();
    },
  });
  const delMut = useMutation({
    mutationFn: (id: string) => delFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Fluxo excluído");
      invalidate();
    },
  });

  function novo() {
    setEditor({
      id: `new-${Date.now()}`,
      nome: "Novo fluxo",
      status: "inativo",
      gatilho: "engajado_sem_converter",
      etapas: [{ tipo: "sms", mensagem: "Olá {primeiro_nome}, ..." }],
      saida: ["se depositar", "se fizer primeiro depósito"],
      players: 0,
      enviados: 0,
      conversoes: 0,
      atualizadoEm: "agora",
    });
  }
  const salvar = (f: Fluxo) => saveMut.mutate(f);
  const toggleStatus = (id: string) => {
    const f = fluxos.find((x) => x.id === id);
    if (f) toggleMut.mutate({ id, is_active: f.status !== "ativo" });
  };
  const duplicar = (id: string) => dupMut.mutate(id);
  const excluir = (id: string) => delMut.mutate(id);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Fluxos automáticos</h2>
          <p className="text-sm text-muted-foreground">
            Sequências de SMS disparadas por comportamento do player
          </p>
        </div>
        <Button onClick={novo} className="gap-2">
          <Plus className="h-4 w-4" /> Novo fluxo
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {fluxos.map((f) => {
          const taxa = f.enviados > 0 ? ((f.conversoes / f.enviados) * 100).toFixed(1) : "0";
          return (
            <Card key={f.id} className="border-border/60">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="text-base truncate">{f.nome}</CardTitle>
                    <CardDescription className="flex items-center gap-1.5 mt-1">
                      <Zap className="h-3 w-3" /> {TRIGGER_NAMES[f.gatilho] ?? f.gatilho}
                    </CardDescription>
                  </div>
                  <Badge
                    className={cn(
                      f.status === "ativo"
                        ? "bg-emerald-400/15 text-emerald-300 border border-emerald-400/30"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {f.status === "ativo" ? "Ativo" : "Inativo"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-md bg-muted/40 p-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Players
                    </p>
                    <p className="text-sm font-semibold">{f.players}</p>
                  </div>
                  <div className="rounded-md bg-muted/40 p-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Enviados
                    </p>
                    <p className="text-sm font-semibold">{f.enviados}</p>
                  </div>
                  <div className="rounded-md bg-muted/40 p-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Conv.
                    </p>
                    <p className="text-sm font-semibold text-emerald-400">{taxa}%</p>
                  </div>
                </div>

                <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Clock className="h-3 w-3" /> Atualizado {f.atualizadoEm}
                </div>

                <div className="flex items-center gap-1 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 gap-1"
                    onClick={() => setEditor(f)}
                  >
                    <Pencil className="h-3.5 w-3.5" /> Editar
                  </Button>
                  <Button
                    size="icon"
                    variant="outline"
                    className="h-8 w-8"
                    onClick={() => toggleStatus(f.id)}
                    title={f.status === "ativo" ? "Pausar" : "Ativar"}
                  >
                    {f.status === "ativo" ? (
                      <Pause className="h-3.5 w-3.5" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <Button
                    size="icon"
                    variant="outline"
                    className="h-8 w-8"
                    onClick={() => duplicar(f.id)}
                    title="Duplicar"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="outline"
                    className="h-8 w-8 text-rose-400 hover:text-rose-300"
                    onClick={() => setConfirmarExclusao(f)}
                    title="Excluir"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {editor && (
        <EditorFluxo
          fluxo={editor}
          onClose={() => setEditor(null)}
          onSave={salvar}
        />
      )}

      <AlertDialog
        open={!!confirmarExclusao}
        onOpenChange={(o) => !o && setConfirmarExclusao(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir fluxo?</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir{" "}
              <span className="font-medium text-foreground">
                {confirmarExclusao?.nome}
              </span>
              ? Essa ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-500 hover:bg-rose-500/90 text-white"
              onClick={() => {
                if (confirmarExclusao) excluir(confirmarExclusao.id);
                setConfirmarExclusao(null);
              }}
            >
              Excluir fluxo
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EditorFluxo({
  fluxo,
  onClose,
  onSave,
}: {
  fluxo: Fluxo;
  onClose: () => void;
  onSave: (f: Fluxo) => void;
}) {
  const [draft, setDraft] = useState<Fluxo>(fluxo);

  function update<K extends keyof Fluxo>(k: K, v: Fluxo[K]) {
    setDraft((d) => ({ ...d, [k]: v }));
  }

  function updateEtapa(i: number, e: Etapa) {
    setDraft((d) => ({
      ...d,
      etapas: d.etapas.map((x, idx) => (idx === i ? e : x)),
    }));
  }

  function addEtapa(tipo: "sms" | "delay") {
    setDraft((d) => ({
      ...d,
      etapas: [
        ...d.etapas,
        tipo === "sms" ? { tipo: "sms", mensagem: "" } : { tipo: "delay", dias: 1 },
      ],
    }));
  }

  function removeEtapa(i: number) {
    setDraft((d) => ({ ...d, etapas: d.etapas.filter((_, idx) => idx !== i) }));
  }

  function toggleSaida(c: string) {
    setDraft((d) => ({
      ...d,
      saida: d.saida.includes(c) ? d.saida.filter((x) => x !== c) : [...d.saida, c],
    }));
  }

  const condicoes = [
    "se fizer login",
    "se depositar",
    "se fizer primeiro depósito",
    "se voltar a jogar",
  ];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Editor de fluxo</DialogTitle>
          <DialogDescription>
            Configure gatilho, mensagens, delays e condições de saída
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Nome do fluxo</Label>
              <Input value={draft.nome} onChange={(e) => update("nome", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Gatilho de entrada</Label>
              <Select
                value={draft.gatilho}
                onValueChange={(v: Gatilho) => update("gatilho", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GATILHOS.map((g) => (
                    <SelectItem key={g} value={g}>
                      <div className="flex flex-col">
                        <span>{TRIGGER_NAMES[g]}</span>
                        <span className="text-xs text-muted-foreground">{TRIGGER_MEANINGS[g]}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border border-border/60 p-3">
            <div>
              <p className="text-sm font-medium">Fluxo ativo</p>
              <p className="text-xs text-muted-foreground">
                Players entram automaticamente ao acionar o gatilho
              </p>
            </div>
            <Switch
              checked={draft.status === "ativo"}
              onCheckedChange={(c) => update("status", c ? "ativo" : "inativo")}
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Sequência</Label>
              <div className="flex gap-1">
                <Button size="sm" variant="outline" onClick={() => addEtapa("sms")} className="gap-1">
                  <MessageSquare className="h-3.5 w-3.5" /> SMS
                </Button>
                <Button size="sm" variant="outline" onClick={() => addEtapa("delay")} className="gap-1">
                  <Timer className="h-3.5 w-3.5" /> Delay
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              {draft.etapas.map((e, i) => (
                <div
                  key={i}
                  className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="font-mono">
                        {i + 1}
                      </Badge>
                      {e.tipo === "sms" ? (
                        <span className="text-xs font-medium flex items-center gap-1">
                          <MessageSquare className="h-3 w-3 text-primary" /> SMS
                        </span>
                      ) : (
                        <span className="text-xs font-medium flex items-center gap-1">
                          <Timer className="h-3 w-3 text-amber-400" /> Delay
                        </span>
                      )}
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      onClick={() => removeEtapa(i)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                  {e.tipo === "sms" ? (
                    <>
                      <Textarea
                        rows={2}
                        value={e.mensagem}
                        onChange={(ev) =>
                          updateEtapa(i, { tipo: "sms", mensagem: ev.target.value })
                        }
                        placeholder="Mensagem com {primeiro_nome}, {link}..."
                      />
                      <MessageVariablePicker
                        value={e.mensagem}
                        onChange={(next: string) =>
                          updateEtapa(i, { tipo: "sms", mensagem: next })
                        }
                      />
                      <p className="text-[11px] text-muted-foreground italic">
                        Preview: {previewMensagem(e.mensagem) || "—"}
                      </p>
                    </>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Aguardar</span>
                      <Input
                        type="number"
                        min={1}
                        value={e.dias}
                        onChange={(ev) =>
                          updateEtapa(i, {
                            tipo: "delay",
                            dias: Math.max(1, Number(ev.target.value) || 1),
                          })
                        }
                        className="w-20 h-8"
                      />
                      <span className="text-xs text-muted-foreground">dia(s)</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div>
            <Label className="mb-2 block">Condições de saída</Label>
            <div className="flex flex-wrap gap-2">
              {condicoes.map((c) => {
                const active = draft.saida.includes(c);
                return (
                  <button
                    key={c}
                    onClick={() => toggleSaida(c)}
                    className={cn(
                      "text-xs px-3 py-1.5 rounded-md border transition-colors",
                      active
                        ? "bg-primary/15 border-primary/40 text-primary"
                        : "border-border/60 text-muted-foreground hover:border-border",
                    )}
                  >
                    {active && <ChevronRight className="inline h-3 w-3 mr-0.5" />}
                    {c}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground mt-2">
              Quando a condição acontecer, o player é removido automaticamente do fluxo.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => onSave(draft)}>Salvar fluxo</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}