import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { brl, timeAgo } from "@/lib/format";
import { toast } from "sonner";
import {
  detectAlerts,
  priorityColor,
  classify,
  isRelevante,
  retentionScore,
  conversionScore,
  riskScore,
  prioridadeRank,
  topPrioridade,
  PRIORIDADE_LABEL,
  CLASSIFICACAO_LABEL,
  whatsappMessageFor,
  recoveryPotential,
  returnChance,
  ABORDAGEM_POR_TIPO,
  type PlayerLike,
  type Prioridade,
  type Classificacao,
  type Alerta,
  type AcaoRecomendada,
} from "@/lib/player-rules";
import {
  AlertTriangle,
  Crown,
  Lightbulb,
  Phone,
  RefreshCw,
  Gift,
  Megaphone,
  Bookmark,
  Target,
  Shield,
  TrendingUp,
  Wallet,
  Sparkles,
  HeartHandshake,
  Zap,
  CheckCircle2,
  Clock,
  Inbox,
} from "lucide-react";
import { PageHeader, MetricCard } from "@/components/ui-premium";

export const Route = createFileRoute("/alertas")({
  component: AlertasPage,
});

type Followup = {
  id: string;
  player_id: string;
  alerta_tipo: string;
  acao: AcaoRecomendada;
  created_at: string;
};

type EnrichedPlayer = PlayerLike & {
  alertas: Alerta[];
  scoreRet: number;
  scoreConv: number;
  scoreRisk: number;
  classif: Classificacao;
  topPrioridade: Prioridade;
  followups: Followup[];
};

async function fetchAlertsData(): Promise<EnrichedPlayer[]> {
  const iso30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const iso60 = new Date(Date.now() - 60 * 86400000).toISOString();

  const [playersRes, depsRes, wd30Res, sessionsRes, followupsRes] =
    await Promise.all([
      supabase
        .from("players")
        .select(
          "id,nome,telefone,status,vip,total_depositado,total_sacado,saldo_carteira,ultimo_login,ultimo_jogo,ultimo_deposito,created_at,ftd_em,expert,origem,utm_source",
        )
        .order("total_depositado", { ascending: false })
        .limit(800),
      supabase
        .from("deposits")
        .select("player_id,valor,created_at")
        .gte("created_at", iso60)
        .eq("status", "aprovado")
        .limit(8000),
      supabase
        .from("withdrawals")
        .select("player_id,valor,created_at")
        .gte("created_at", iso30)
        .limit(5000),
      supabase
        .from("sessions")
        .select("player_id,iniciado_em")
        .gte("iniciado_em", iso60)
        .limit(10000),
      supabase
        .from("lead_followups")
        .select("id,player_id,alerta_tipo,acao,created_at")
        .gte("created_at", iso30)
        .order("created_at", { ascending: false }),
    ]);

  const dep30 = new Map<string, number>();
  const dep3060 = new Map<string, number>();
  const depDates = new Map<string, string[]>();
  for (const d of depsRes.data ?? []) {
    if (!d.player_id) continue;
    const key = d.player_id as string;
    const created = d.created_at as string;
    if (created >= iso30) dep30.set(key, (dep30.get(key) ?? 0) + Number(d.valor ?? 0));
    else dep3060.set(key, (dep3060.get(key) ?? 0) + Number(d.valor ?? 0));
    const arr = depDates.get(key) ?? [];
    arr.push(created);
    depDates.set(key, arr);
  }

  const saqRec = new Map<string, number>();
  for (const w of wd30Res.data ?? []) {
    if (!w.player_id) continue;
    saqRec.set(w.player_id as string, (saqRec.get(w.player_id as string) ?? 0) + Number(w.valor ?? 0));
  }

  const logins30 = new Map<string, number>();
  const logins3060 = new Map<string, number>();
  const hourBuckets = new Map<string, number[]>();
  for (const s of sessionsRes.data ?? []) {
    if (!s.player_id) continue;
    const ts = s.iniciado_em as string;
    const key = s.player_id as string;
    if (ts >= iso30) logins30.set(key, (logins30.get(key) ?? 0) + 1);
    else logins3060.set(key, (logins3060.get(key) ?? 0) + 1);
    const h = new Date(ts).getHours();
    const arr = hourBuckets.get(key) ?? new Array(24).fill(0);
    arr[h] = (arr[h] ?? 0) + 1;
    hourBuckets.set(key, arr);
  }

  const followupsByPlayer = new Map<string, Followup[]>();
  for (const f of followupsRes.data ?? []) {
    const list = followupsByPlayer.get(f.player_id as string) ?? [];
    list.push(f as Followup);
    followupsByPlayer.set(f.player_id as string, list);
  }

  const out: EnrichedPlayer[] = [];
  for (const p of playersRes.data ?? []) {
    // sequência de dias seguidos depositando (últimos 14d)
    const dates = (depDates.get(p.id) ?? [])
      .map((d) => new Date(d).toISOString().slice(0, 10))
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort()
      .reverse();
    let seg = 0;
    let cursor = new Date();
    for (let i = 0; i < 14; i++) {
      const ymd = cursor.toISOString().slice(0, 10);
      if (dates[seg] === ymd) seg++;
      cursor = new Date(cursor.getTime() - 86400000);
    }
    const media = dates.length ? (dep30.get(p.id) ?? 0) / Math.max(1, dates.length) : 0;

    // reativação: primeiro depósito recente após gap >= 14d
    let reativadoEm: string | null = null;
    const sortedAsc = (depDates.get(p.id) ?? []).slice().sort();
    for (let i = 1; i < sortedAsc.length; i++) {
      const gap = (new Date(sortedAsc[i]).getTime() - new Date(sortedAsc[i - 1]).getTime()) / 86400000;
      if (gap >= 14 && new Date(sortedAsc[i]).getTime() >= Date.now() - 7 * 86400000) {
        reativadoEm = sortedAsc[i];
        break;
      }
    }

    // horário pico
    const hours = hourBuckets.get(p.id);
    let horarioPico: number | null = null;
    if (hours) {
      let max = 0;
      hours.forEach((cnt, h) => {
        if (cnt > max) {
          max = cnt;
          horarioPico = h;
        }
      });
    }

    const enriched: PlayerLike = {
      ...p,
      dep_30d: dep30.get(p.id) ?? 0,
      dep_30_60d: dep3060.get(p.id) ?? 0,
      saques_recentes: saqRec.get(p.id) ?? 0,
      qtd_logins_30d: logins30.get(p.id) ?? 0,
      qtd_logins_30_60d: logins3060.get(p.id) ?? 0,
      dias_seguidos_depositando: seg,
      media_deposito: media,
      reativado_em: reativadoEm,
      horario_pico: horarioPico,
    };

    if (!isRelevante(enriched)) continue;
    const alertas = detectAlerts(enriched);
    if (!alertas.length) continue;

    out.push({
      ...enriched,
      alertas,
      scoreRet: retentionScore(enriched),
      scoreConv: conversionScore(enriched),
      scoreRisk: riskScore(enriched),
      classif: classify(enriched),
      topPrioridade: topPrioridade(alertas),
      followups: followupsByPlayer.get(p.id) ?? [],
    });
  }

  out.sort((a, b) => {
    const pa = prioridadeRank(a.topPrioridade);
    const pb = prioridadeRank(b.topPrioridade);
    if (pa !== pb) return pa - pb;
    // dentro da mesma prioridade: maior oportunidade (potencial × chance) primeiro
    const oa = recoveryPotential(a).max * (returnChance(a) / 100);
    const ob = recoveryPotential(b).max * (returnChance(b) / 100);
    return ob - oa;
  });
  return out;
}

const ACAO_LABEL: Record<AcaoRecomendada, string> = {
  whatsapp: "WhatsApp",
  sms: "SMS",
  bonus: "Enviar bônus",
  campanha: "Adic. campanha",
  acompanhamento: "Tentativa enviada",
  copiar: "Copiar mensagem",
};

type LeadStatus = "pendente" | "aguardando" | "recuperado" | "convertido";

const STATUS_LABEL: Record<LeadStatus, string> = {
  pendente: "Pendente",
  aguardando: "Aguardando retorno",
  recuperado: "Recuperado",
  convertido: "Convertido",
};

function computeLeadStatus(p: {
  followups: Followup[];
  ultimo_login?: string | null;
  ultimo_deposito?: string | null;
}): LeadStatus {
  if (!p.followups.length) return "pendente";
  const fTime = new Date(p.followups[0].created_at).getTime();
  // Depósito após o contato => convertido (prioridade máxima)
  if (p.ultimo_deposito && new Date(p.ultimo_deposito).getTime() > fTime) return "convertido";
  // Login após o contato => recuperado
  if (p.ultimo_login && new Date(p.ultimo_login).getTime() > fTime) return "recuperado";
  const ageH = (Date.now() - fTime) / 3600000;
  // Após 48h sem retorno volta para a fila como Pendente
  if (ageH >= 48) return "pendente";
  return "aguardando";
}

function ScoreBlock({
  label,
  value,
  good,
  icon: Icon,
}: {
  label: string;
  value: number;
  good: "high" | "low";
  icon: typeof TrendingUp;
}) {
  const tone =
    good === "high"
      ? value >= 70
        ? "text-emerald-400"
        : value >= 40
          ? "text-amber-400"
          : "text-rose-400"
      : value >= 70
        ? "text-rose-400"
        : value >= 40
          ? "text-amber-400"
          : "text-emerald-400";
  return (
    <div className="rounded-md bg-muted/30 px-3 py-2 flex items-center gap-2">
      <Icon className={`h-4 w-4 ${tone}`} />
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <p className={`text-base font-bold leading-none mt-0.5 ${tone}`}>{value}</p>
      </div>
    </div>
  );
}

function AlertRow({
  p,
  onAction,
  onSimulate,
}: {
  p: EnrichedPlayer;
  onAction: (player: EnrichedPlayer, alerta: Alerta, acao: AcaoRecomendada) => void;
  onSimulate: (player: EnrichedPlayer) => void;
}) {
  const c = priorityColor(p.topPrioridade);
  const dep = Number(p.total_depositado ?? 0);
  const saldo = Number(p.saldo_carteira ?? 0);
  const ultimoFollowup = p.followups[0];
  // alerta principal: maior prioridade
  const principal = p.alertas[0] ?? p.alertas.reduce((a, b) => a, p.alertas[0]);
  const outros = p.alertas.slice(1);
  const recup = recoveryPotential(p);
  const chance = returnChance(p);
  const abordagem = principal ? ABORDAGEM_POR_TIPO[principal.tipo] : null;
  const chanceTone =
    chance >= 70 ? "text-emerald-400" : chance >= 40 ? "text-amber-400" : "text-rose-400";

  return (
    <div
      className={`rounded-xl border ${c.border} ${c.bg} p-4 transition-colors`}
    >
      {/* Header: identidade + saldo em destaque */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-semibold text-sm truncate">{p.nome}</p>
            {p.vip && (
              <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30 gap-1">
                <Crown className="h-3 w-3" /> VIP
              </Badge>
            )}
            <Badge variant="outline" className={c.badge}>
              {PRIORIDADE_LABEL[p.topPrioridade]}
            </Badge>
            {ultimoFollowup && (
              <Badge variant="outline" className="bg-muted/40 text-muted-foreground border-border/40 gap-1">
                <Bookmark className="h-3 w-3" />
                {ACAO_LABEL[ultimoFollowup.acao]} · {timeAgo(ultimoFollowup.created_at)}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
            {p.telefone && (
              <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{p.telefone}</span>
            )}
            <span>· {CLASSIFICACAO_LABEL[p.classif]}</span>
            {p.expert && <span>· Expert: <span className="text-foreground/80">{p.expert}</span></span>}
          </div>
        </div>
        {/* SALDO em destaque */}
        <div className={cn(
          "rounded-lg border px-3 py-2 text-right shrink-0",
          saldo >= 200
            ? "border-emerald-500/40 bg-emerald-500/10"
            : saldo > 0
              ? "border-amber-500/30 bg-amber-500/5"
              : "border-border/40 bg-muted/20",
        )}>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center justify-end gap-1">
            <Wallet className="h-3 w-3" /> Saldo atual
          </p>
          <p className={cn(
            "text-lg font-bold leading-none mt-1",
            saldo >= 200 ? "text-emerald-400" : saldo > 0 ? "text-amber-400" : "text-muted-foreground",
          )}>{brl(saldo)}</p>
        </div>
      </div>

      {/* Métricas do lead */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs mb-3">
        <div className="rounded-md bg-muted/30 px-2.5 py-1.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Depositado</p>
          <p className="font-semibold mt-0.5">{brl(dep)}</p>
        </div>
        <div className="rounded-md bg-muted/30 px-2.5 py-1.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Últ. login</p>
          <p className="font-semibold mt-0.5">{timeAgo(p.ultimo_login)}</p>
        </div>
        <div className="rounded-md bg-muted/30 px-2.5 py-1.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Últ. depósito</p>
          <p className="font-semibold mt-0.5">{timeAgo(p.ultimo_deposito)}</p>
        </div>
        <div className="rounded-md bg-muted/30 px-2.5 py-1.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Origem</p>
          <p className="font-semibold mt-0.5 truncate">{p.origem ?? p.utm_source ?? "—"}</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-3">
        <ScoreBlock label="Retention" value={p.scoreRet} good="high" icon={Shield} />
        <ScoreBlock label="Risk" value={p.scoreRisk} good="low" icon={AlertTriangle} />
      </div>

      {/* Alerta principal + motivo + ação ideal */}
      {principal && (
        <div className={cn("rounded-lg border px-3 py-2.5 mb-3", priorityColor(principal.prioridade).border, priorityColor(principal.prioridade).bg)}>
          <div className="flex items-start gap-2">
            <AlertTriangle className={cn("h-4 w-4 mt-0.5 shrink-0", priorityColor(principal.prioridade).text)} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{principal.titulo}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{principal.motivo}</p>
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="flex items-start gap-2 rounded-md bg-background/40 px-2 py-1.5">
                  <Target className="h-3.5 w-3.5 mt-0.5 shrink-0 text-primary" />
                  <p className="text-xs"><span className="text-muted-foreground">Ação ideal: </span><span className="font-medium">{principal.acaoLabel}</span></p>
                </div>
                {abordagem && (
                  <div className="flex items-start gap-2 rounded-md bg-background/40 px-2 py-1.5">
                    <HeartHandshake className="h-3.5 w-3.5 mt-0.5 shrink-0 text-violet-400" />
                    <p className="text-xs"><span className="text-muted-foreground">Abordagem: </span><span className="font-medium">{abordagem}</span></p>
                  </div>
                )}
              </div>
              {outros.length > 0 && (
                <p className="text-[11px] text-muted-foreground mt-2 flex items-center gap-1">
                  <Lightbulb className="h-3 w-3" /> +{outros.length} alerta(s): {outros.map(o => o.titulo).join(" · ")}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Potencial de recuperação + chance de retorno */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
            <Sparkles className="h-3 w-3 text-emerald-400" /> Potencial de recuperação
          </p>
          <p className="text-sm font-bold text-emerald-300 mt-1 leading-none">
            {brl(recup.min)} <span className="text-muted-foreground font-normal">–</span> {brl(recup.max)}
          </p>
        </div>
        <div className="rounded-lg border border-border/40 bg-muted/20 px-3 py-2">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
            <TrendingUp className={cn("h-3 w-3", chanceTone)} /> Chance de retorno
          </p>
          <div className="flex items-center gap-2 mt-1">
            <p className={cn("text-sm font-bold leading-none", chanceTone)}>{chance}%</p>
            <div className="flex-1 h-1.5 rounded-full bg-background/60 overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full",
                  chance >= 70 ? "bg-emerald-400" : chance >= 40 ? "bg-amber-400" : "bg-rose-400",
                )}
                style={{ width: `${chance}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Botões de ação direta */}
      {principal && (
        <div className="grid grid-cols-1 gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-9 gap-1.5 border-sky-500/40 text-sky-300 hover:bg-sky-500/10"
            onClick={() => onSimulate(p)}
            title="Simula login + atividade agora — testa atualização em tempo real"
          >
            <Zap className="h-4 w-4" /> Simular
          </Button>
        </div>
      )}
    </div>
  );
}

function AlertasPage() {
  const qc = useQueryClient();
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["alertas"],
    queryFn: fetchAlertsData,
    refetchInterval: 60000,
  });

  // Realtime: atualiza automaticamente quando players/deposits/sessions/followups mudam
  useEffect(() => {
    const channel = supabase
      .channel("alertas-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "players" }, () => {
        qc.invalidateQueries({ queryKey: ["alertas"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "deposits" }, () => {
        qc.invalidateQueries({ queryKey: ["alertas"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, () => {
        qc.invalidateQueries({ queryKey: ["alertas"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "lead_followups" }, () => {
        qc.invalidateQueries({ queryKey: ["alertas"] });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [qc]);

  type PrioridadeFiltro = "todos" | "critico" | "alto" | "medio" | "baixo";
  const [prioridade, setPrioridade] = useState<PrioridadeFiltro>("todos");
  const [statusTab, setStatusTab] = useState<LeadStatus>("pendente");

  const enriched = useMemo(() => {
    return (data ?? []).map((p) => ({ ...p, status: computeLeadStatus(p) }));
  }, [data]);

  const statusCounts = useMemo(() => {
    const c: Record<LeadStatus, number> = { pendente: 0, aguardando: 0, recuperado: 0, convertido: 0 };
    for (const p of enriched) c[p.status]++;
    return c;
  }, [enriched]);

  const filtered = useMemo(() => {
    const byStatus = enriched.filter((p) => p.status === statusTab);
    if (prioridade === "todos") return byStatus;
    return byStatus.filter((p) => p.topPrioridade === prioridade);
  }, [enriched, prioridade, statusTab]);

  const counts = useMemo(() => {
    const c = { critico: 0, alto: 0, medio: 0, baixo: 0 };
    for (const p of enriched.filter((p) => p.status === statusTab)) c[p.topPrioridade]++;
    return c;
  }, [enriched, statusTab]);

  const handleAction = async (player: EnrichedPlayer, alerta: Alerta, acao: AcaoRecomendada) => {
    if (acao === "sms") {
      const msg = whatsappMessageFor(alerta, player);
      const tel = (player.telefone ?? "").replace(/\D/g, "");
      // tenta abrir app de SMS nativo
      if (tel) window.open(`sms:${tel}?body=${encodeURIComponent(msg)}`, "_blank");
      else {
        toast.error("Player sem telefone cadastrado.");
        return;
      }
    }
    if (acao === "copiar") {
      const msg = whatsappMessageFor(alerta, player);
      try {
        await navigator.clipboard.writeText(msg);
        toast.success("Mensagem copiada para a área de transferência.");
      } catch {
        toast.error("Não foi possível copiar a mensagem.");
        return;
      }
    }
    if (acao === "bonus") {
      toast.info("Envio de bônus precisa de integração com a plataforma da casa. Registrando como acompanhamento.");
    }

    const { data: userRes } = await supabase.auth.getUser();
    const { error } = await supabase.from("lead_followups").insert({
      player_id: player.id!,
      alerta_tipo: alerta.tipo,
      acao,
      created_by: userRes.user?.id ?? null,
    });
    if (error) {
      toast.error("Não foi possível registrar a ação: " + error.message);
      return;
    }
    if (acao === "acompanhamento") {
      toast.success(`${player.nome} marcado como "Tentativa enviada". Movido para Aguardando retorno.`);
    } else {
      toast.success(`${ACAO_LABEL[acao]} registrado para ${player.nome}.`);
    }
    qc.invalidateQueries({ queryKey: ["alertas"] });
    qc.invalidateQueries({ queryKey: ["players-recent-followup-keys"] });
    qc.invalidateQueries({ queryKey: ["players-pending-conversion"] });
    qc.invalidateQueries({ queryKey: ["players-page"] });
  };

  const handleSimulate = async (player: EnrichedPlayer) => {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("players")
      .update({ ultimo_login: now, ultimo_jogo: now, status: "ativo" })
      .eq("id", player.id!);
    if (error) {
      toast.error("Falha ao simular atividade: " + error.message);
      return;
    }
    await supabase.from("sessions").insert({ player_id: player.id!, iniciado_em: now });
    toast.success(`Atividade simulada para ${player.nome}. Alertas devem sumir em segundos.`);
    qc.invalidateQueries({ queryKey: ["alertas"] });
    qc.invalidateQueries({ queryKey: ["players"] });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Central de Recuperação de Receita"
        subtitle="Fila de oportunidades — players com maior potencial de retorno e receita recuperável primeiro."
        icon={<HeartHandshake className="h-5 w-5 text-primary-foreground" />}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
            Atualizar
          </Button>
        }
      />

      <div className="grid gap-3 grid-cols-2 md:grid-cols-5">
        <MetricCard label="Críticos" value={counts.critico} accent="danger" icon={<AlertTriangle className="h-4 w-4" />} />
        <MetricCard label="Alto" value={counts.alto} accent="warning" icon={<Zap className="h-4 w-4" />} />
        <MetricCard label="Médio" value={counts.medio} accent="warning" icon={<Clock className="h-4 w-4" />} />
        <MetricCard label="Baixo" value={counts.baixo} accent="primary" icon={<Clock className="h-4 w-4" />} />
        <MetricCard label="Players na fila" value={enriched.filter((p) => p.status === statusTab).length} icon={<Inbox className="h-4 w-4" />} />
      </div>

      {/* Tabs de status do lead */}
      <div className="flex flex-wrap items-center gap-2">
        {([
          { id: "pendente", label: "Pendente", icon: Inbox, cls: "bg-rose-500/15 text-rose-300 border-rose-500/50" },
          { id: "aguardando", label: "Aguardando retorno", icon: Clock, cls: "bg-amber-500/15 text-amber-300 border-amber-500/50" },
          { id: "recuperado", label: "Recuperado", icon: CheckCircle2, cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/50" },
          { id: "convertido", label: "Convertido", icon: Sparkles, cls: "bg-violet-500/15 text-violet-300 border-violet-500/50" },
        ] as const).map((t) => {
          const active = statusTab === t.id;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setStatusTab(t.id)}
              className={cn(
                "h-9 px-3 rounded-lg text-xs font-semibold border transition-colors inline-flex items-center gap-1.5",
                active ? t.cls : "bg-card/40 text-muted-foreground border-border/50 hover:text-foreground hover:border-border",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
              <span className="ml-1 rounded-full bg-background/60 px-1.5 py-0.5 text-[10px]">{statusCounts[t.id]}</span>
            </button>
          );
        })}
      </div>

      {/* Filtro por prioridade */}
      <div className="flex flex-wrap items-center gap-2">
        {([
          { id: "todos", label: "Todos", cls: "bg-foreground text-background border-foreground" },
          { id: "critico", label: "Crítico", cls: "bg-rose-500/15 text-rose-300 border-rose-500/50" },
          { id: "alto", label: "Alto", cls: "bg-orange-500/15 text-orange-300 border-orange-500/50" },
          { id: "medio", label: "Médio", cls: "bg-amber-500/15 text-amber-300 border-amber-500/50" },
          { id: "baixo", label: "Baixo", cls: "bg-sky-500/15 text-sky-300 border-sky-500/50" },
        ] as const).map((f) => {
          const active = prioridade === f.id;
          return (
            <button
              key={f.id}
              onClick={() => setPrioridade(f.id)}
              className={cn(
                "h-8 px-4 rounded-full text-xs font-semibold border transition-colors",
                active
                  ? f.cls
                  : "bg-card/40 text-muted-foreground border-border/50 hover:text-foreground hover:border-border",
              )}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      <Card className="border-border/50 bg-card/60 backdrop-blur">
        <CardHeader>
          <CardTitle className="text-sm font-semibold">
            {filtered.length} lead(s) na fila
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-48" />)
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              {statusTab === "pendente"
                ? "Fila zerada. Todos os leads críticos já receberam tentativa."
                : `Nenhum lead em "${STATUS_LABEL[statusTab]}" no momento.`}
            </p>
          ) : (
            filtered.map((p) => (
              <AlertRow key={p.id} p={p} onAction={handleAction} onSimulate={handleSimulate} />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}