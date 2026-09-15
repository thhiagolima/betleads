import { brl, timeAgo } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  classify,
  playerScore,
  classificacaoPrioridade,
  priorityColor,
  scoreColor,
  CLASSIFICACAO_LABEL,
  type Classificacao,
} from "@/lib/player-rules";
import {
  Phone,
  TrendingUp,
  TrendingDown,
  Crown,
  Activity,
  AlertTriangle,
  CheckCircle2,
  Info,
  Lightbulb,
  MessageCircle,
} from "lucide-react";
import { useState } from "react";
import { AIFeedback } from "@/components/ai-feedback";

export type AIPlayer = {
  id?: string;
  nome: string;
  telefone?: string | null;
  total_depositado?: number;
  total_sacado?: number;
  lucro?: number;
  depositado_hoje?: number;
  qtd_depositos_hoje?: number;
  sacado_hoje?: number;
  qtd_saques_hoje?: number;
  ultimo_login?: string | null;
  ultimo_deposito?: string | null;
  ultimo_jogo?: string | null;
  status?: string;
  vip?: boolean;
  motivo?: string;
  classificacao?: Classificacao;
  score?: number;
  saldo_atual?: number;
  expert?: string | null;
  origem?: string | null;
};

// Accept both PT (nome/telefone/total_depositado) and EN (name/phone/totalDeposited) keys.
function normalize(raw: any): AIPlayer {
  const dep = raw.total_depositado ?? raw.totalDeposited ?? raw.deposited ?? 0;
  const saq = raw.total_sacado ?? raw.totalWithdrawn ?? raw.withdrawn ?? 0;
  const base = {
    id: raw.id,
    nome: raw.nome ?? raw.name ?? "—",
    telefone: raw.telefone ?? raw.phone ?? null,
    total_depositado: Number(dep) || 0,
    total_sacado: Number(saq) || 0,
    lucro: Number(raw.lucro ?? raw.profit ?? Number(dep) - Number(saq)) || 0,
    depositado_hoje: raw.depositado_hoje != null ? Number(raw.depositado_hoje) : undefined,
    qtd_depositos_hoje: raw.qtd_depositos_hoje != null ? Number(raw.qtd_depositos_hoje) : undefined,
    sacado_hoje: raw.sacado_hoje != null ? Number(raw.sacado_hoje) : undefined,
    qtd_saques_hoje: raw.qtd_saques_hoje != null ? Number(raw.qtd_saques_hoje) : undefined,
    ultimo_login: raw.ultimo_login ?? raw.lastLogin ?? null,
    ultimo_deposito: raw.ultimo_deposito ?? raw.lastDeposit ?? null,
    ultimo_jogo: raw.ultimo_jogo ?? raw.lastGame ?? null,
    status:
      raw.status === "active" ? "ativo" : raw.status === "inactive" ? "inativo" : raw.status,
    vip: !!raw.vip,
    motivo: raw.motivo ?? raw.reason,
    saldo_atual: raw.saldo_atual != null ? Number(raw.saldo_atual) : undefined,
    expert: raw.expert ?? null,
    origem: raw.origem ?? null,
  };
  const classificacao: Classificacao =
    raw.classificacao ?? classify(base);
  const score: number =
    typeof raw.score === "number" ? raw.score : playerScore(base);
  return { ...base, classificacao, score };
}

function normalizeInsight(raw: any): AIInsight {
  if (typeof raw === "string") return { titulo: raw, descricao: "", tipo: "info" };
  return {
    titulo: raw.titulo ?? raw.title ?? "",
    descricao: raw.descricao ?? raw.description ?? "",
    tipo: raw.tipo ?? raw.type ?? "info",
  };
}

export type AIInsight = {
  titulo: string;
  descricao: string;
  tipo?: "info" | "alerta" | "sucesso" | "atencao";
};

export type AIMetric = {
  label: string;
  valor: string;
  tipo?: "neutro" | "positivo" | "negativo";
};

export type AIAnswer = {
  summary?: string;
  criterio?: string;
  players?: AIPlayer[];
  insights?: AIInsight[];
  metrics?: AIMetric[];
  ai_log_id?: string | null;
  pergunta?: string;
};

function waLink(phone?: string | null) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  return `https://wa.me/${digits.startsWith("55") ? digits : "55" + digits}`;
}

function fmtDate(d?: string | null) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function MetricCard({ m }: { m: AIMetric }) {
  const tone =
    m.tipo === "positivo"
      ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/5"
      : m.tipo === "negativo"
        ? "text-rose-400 border-rose-500/30 bg-rose-500/5"
        : "text-foreground border-border/50 bg-muted/30";
  return (
    <div className={`rounded-xl border px-4 py-3 ${tone}`}>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{m.label}</p>
      <p className="text-lg font-semibold mt-0.5">{m.valor}</p>
    </div>
  );
}

function InsightCard({ i }: { i: AIInsight }) {
  const map = {
    alerta: { icon: AlertTriangle, cls: "text-rose-400 bg-rose-500/10 border-rose-500/30" },
    atencao: { icon: AlertTriangle, cls: "text-amber-400 bg-amber-500/10 border-amber-500/30" },
    sucesso: { icon: CheckCircle2, cls: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30" },
    info: { icon: Info, cls: "text-sky-400 bg-sky-500/10 border-sky-500/30" },
  } as const;
  const cfg = map[i.tipo ?? "info"] ?? map.info;
  const Icon = cfg.icon;
  return (
    <div className={`rounded-xl border p-3 flex gap-3 ${cfg.cls}`}>
      <Icon className="h-4 w-4 shrink-0 mt-0.5" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{i.titulo}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{i.descricao}</p>
      </div>
    </div>
  );
}

function PlayerCard({ p }: { p: AIPlayer }) {
  const dep = p.total_depositado ?? 0;
  const saq = p.total_sacado ?? 0;
  const lucro = p.lucro ?? dep - saq;
  const wa = waLink(p.telefone);
  const ativo = (p.status ?? "").toLowerCase() === "ativo";
  const hasHoje = p.depositado_hoje != null || p.sacado_hoje != null;
  const hasSaldo = p.saldo_atual != null;
  const classificacao: Classificacao = p.classificacao ?? "neutro";
  const score = typeof p.score === "number" ? p.score : 0;
  const cls = priorityColor(classificacaoPrioridade(classificacao));

  return (
    <div className="rounded-xl border border-border/50 bg-background/40 hover:border-primary/40 hover:bg-background/60 transition-colors p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-semibold text-sm truncate">{p.nome}</p>
            {p.vip && (
              <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30 hover:bg-amber-500/20 gap-1">
                <Crown className="h-3 w-3" /> VIP
              </Badge>
            )}
            {classificacao !== "neutro" && classificacao !== "vip" && (
              <Badge variant="outline" className={cls.badge}>
                {CLASSIFICACAO_LABEL[classificacao]}
              </Badge>
            )}
            {p.status && (
              <Badge
                variant="outline"
                className={
                  ativo
                    ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10"
                    : "border-rose-500/40 text-rose-400 bg-rose-500/10"
                }
              >
                <Activity className="h-3 w-3 mr-1" />
                {p.status}
              </Badge>
            )}
          </div>
          {p.telefone && (
            <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
              <Phone className="h-3 w-3" />
              <span>{p.telefone}</span>
              {wa && (
                <a
                  href={wa}
                  target="_blank"
                  rel="noreferrer"
                  className="text-emerald-400 hover:text-emerald-300 inline-flex items-center gap-1"
                >
                  <MessageCircle className="h-3 w-3" /> WhatsApp
                </a>
              )}
            </div>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Lucro</p>
          <p
            className={`text-sm font-semibold inline-flex items-center gap-1 ${
              lucro >= 0 ? "text-emerald-400" : "text-rose-400"
            }`}
          >
            {lucro >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {brl(lucro)}
          </p>
        </div>
      </div>

      <div className="mb-3 flex items-center gap-3">
        <div className="flex-1">
          <div className="flex items-center justify-between mb-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Score do player
            </p>
            <p className={`text-xs font-bold ${scoreColor(score)}`}>{score}/100</p>
          </div>
          <Progress value={score} className="h-1.5" />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        {hasSaldo ? (
          <>
            <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1.5">
              <p className="text-[10px] uppercase tracking-wider text-emerald-300/90">Saldo na banca</p>
              <p className="font-semibold text-emerald-300">{brl(p.saldo_atual ?? 0)}</p>
            </div>
            <div className="rounded-lg bg-muted/30 px-2.5 py-1.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Depositado</p>
              <p className="font-medium text-foreground">{brl(dep)}</p>
            </div>
            <div className="rounded-lg bg-muted/30 px-2.5 py-1.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Sacado</p>
              <p className="font-medium text-foreground">{brl(saq)}</p>
            </div>
          </>
        ) : hasHoje ? (
          <>
            <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1.5">
              <p className="text-[10px] uppercase tracking-wider text-emerald-300/90">
                {p.depositado_hoje != null ? "Depositado hoje" : "Sacado hoje"}
                {p.qtd_depositos_hoje ? ` (${p.qtd_depositos_hoje}x)` : p.qtd_saques_hoje ? ` (${p.qtd_saques_hoje}x)` : ""}
              </p>
              <p className="font-semibold text-emerald-300">
                {brl(p.depositado_hoje ?? p.sacado_hoje ?? 0)}
              </p>
            </div>
            <div className="rounded-lg bg-muted/30 px-2.5 py-1.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total histórico</p>
              <p className="font-medium text-foreground">{brl(dep)}</p>
            </div>
          </>
        ) : (
          <>
            <div className="rounded-lg bg-muted/30 px-2.5 py-1.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Depositado</p>
              <p className="font-medium text-foreground">{brl(dep)}</p>
            </div>
            <div className="rounded-lg bg-muted/30 px-2.5 py-1.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Sacado</p>
              <p className="font-medium text-foreground">{brl(saq)}</p>
            </div>
          </>
        )}
        <div className="rounded-lg bg-muted/30 px-2.5 py-1.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Últ. login</p>
          <p className="font-medium text-foreground" title={fmtDate(p.ultimo_login)}>
            {timeAgo(p.ultimo_login)}
          </p>
        </div>
        <div className="rounded-lg bg-muted/30 px-2.5 py-1.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Últ. depósito</p>
          <p className="font-medium text-foreground" title={fmtDate(p.ultimo_deposito)}>
            {timeAgo(p.ultimo_deposito)}
          </p>
        </div>
      </div>

      {p.motivo && (
        <p className="mt-3 text-xs text-muted-foreground border-l-2 border-primary/40 pl-2 italic">
          {p.motivo}
        </p>
      )}
    </div>
  );
}

const PAGE = 6;

export function AIResponse({ data }: { data: AIAnswer }) {
  const [shown, setShown] = useState(PAGE);
  const players = (data.players ?? []).map(normalize);
  const insights = (data.insights ?? []).map(normalizeInsight);
  const metrics = data.metrics ?? [];
  const visible = players.slice(0, shown);

  // Strip stray markdown table pipes if model misbehaved.
  const summary =
    typeof data.summary === "string"
      ? data.summary.replace(/\|/g, " ").replace(/`+/g, "").trim()
      : data.summary;

  return (
    <div className="space-y-4">
      {summary && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 flex gap-3">
          <Lightbulb className="h-4 w-4 text-primary shrink-0 mt-0.5" />
          <p className="text-sm text-foreground leading-relaxed">{summary}</p>
        </div>
      )}

      {metrics.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {metrics.map((m, i) => (
            <MetricCard key={i} m={m} />
          ))}
        </div>
      )}

      {insights.length > 0 && (
        <div className="grid sm:grid-cols-2 gap-2">
          {insights.map((i, idx) => (
            <InsightCard key={idx} i={i} />
          ))}
        </div>
      )}

      {players.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Players ({players.length})
            </p>
            {data.criterio && (
              <p className="text-[10px] text-muted-foreground italic max-w-[60%] text-right truncate" title={data.criterio}>
                {data.criterio}
              </p>
            )}
          </div>
          <div className="space-y-2">
            {visible.map((p, i) => (
              <PlayerCard key={p.id ?? i} p={p} />
            ))}
          </div>
          {shown < players.length && (
            <button
              onClick={() => setShown((s) => s + PAGE)}
              className="w-full rounded-lg border border-border/50 bg-muted/20 hover:bg-muted/40 py-2 text-xs font-medium transition-colors"
            >
              Ver mais ({players.length - shown} restantes)
            </button>
          )}
        </div>
      )}

      {!data.summary && players.length === 0 && insights.length === 0 && metrics.length === 0 && (
        <p className="text-sm text-muted-foreground">Sem dados para mostrar.</p>
      )}

      {data.pergunta && (
        <AIFeedback
          aiLogId={data.ai_log_id ?? null}
          pergunta={data.pergunta}
          respostaSummary={typeof data.summary === "string" ? data.summary : undefined}
        />
      )}
    </div>
  );
}