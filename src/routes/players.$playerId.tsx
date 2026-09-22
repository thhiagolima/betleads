import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type React from "react";
import {
  ArrowLeft,
  BadgeDollarSign,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Crown,
  Gem,
  Mail,
  MessageSquareText,
  Phone,
  ShieldAlert,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  User,
  Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { brl, num, timeAgo } from "@/lib/format";
import { getPlayerDetail, type PlayerDetail } from "@/lib/player-detail.functions";

export const Route = createFileRoute("/players/$playerId")({
  component: PlayerDetailPage,
});

function PlayerDetailPage() {
  const { playerId } = Route.useParams();
  const fetchDetail = useServerFn(getPlayerDetail);
  const { data, isLoading, error } = useQuery({
    queryKey: ["player-detail", playerId],
    queryFn: () => fetchDetail({ data: { playerId } }),
    staleTime: 15_000,
  });

  if (isLoading) return <DetailSkeleton />;

  if (error || !data) {
    return (
      <div className="space-y-4">
        <BackButton />
        <Card className="border-border/50 bg-card/60">
          <CardContent className="p-6">
            <div className="text-lg font-semibold">Nao foi possivel abrir a ficha</div>
            <div className="mt-1 text-sm text-muted-foreground">
              {error instanceof Error ? error.message : "Tente novamente em alguns instantes."}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const p = data.player;
  const level = levelFor(Number(p.total_depositado ?? 0), Boolean(p.vip));
  const ftd = p.ftd_em ?? data.attribution?.raw_payload?.raw?.primeiro_deposito ?? null;
  const lastDeposit = p.ultimo_deposito ?? data.attribution?.raw_payload?.raw?.ultimo_deposito ?? null;

  return (
    <div className="space-y-5">
      <BackButton />

      <section className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <Card className="border-border/50 bg-card/70">
          <CardContent className="p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-primary/30 bg-primary/15">
                    <User className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <h1 className="truncate text-2xl font-bold tracking-normal">{p.nome}</h1>
                    <div className="mt-0.5 truncate text-sm text-muted-foreground">
                      {p.player_external_id ?? p.id}
                    </div>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Badge className={`${level.className} border`}>{level.label}</Badge>
                  <StatusBadge active={data.metrics.days_since_activity != null && data.metrics.days_since_activity <= 4} />
                  {p.risco && (
                    <Badge variant="outline" className="border-border/70 text-muted-foreground">
                      risco {p.risco}
                    </Badge>
                  )}
                  {p.verificado && (
                    <Badge className="border-emerald-500/30 bg-emerald-500/15 text-emerald-300">
                      <CheckCircle2 className="mr-1 h-3 w-3" /> verificado
                    </Badge>
                  )}
                </div>
              </div>

              <div className="grid min-w-[260px] gap-2 text-sm">
                <ContactLine icon={<Phone className="h-4 w-4" />} label="Telefone" value={p.telefone} />
                <ContactLine icon={<Mail className="h-4 w-4" />} label="E-mail" value={p.email} />
                <ContactLine icon={<CalendarDays className="h-4 w-4" />} label="Cadastro" value={formatDate(p.created_at)} />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/50 bg-card/70">
          <CardContent className="grid gap-3 p-5 sm:grid-cols-2">
            <ScoreTile label="Score geral" value={`${data.metrics.score}/100`} tone="blue" />
            <ScoreTile label="Retencao" value={`${data.metrics.retention_score}/100`} tone="green" />
            <ScoreTile label="Risco" value={`${data.metrics.risk_score}/100`} tone="red" />
            <ScoreTile label="Conversao" value={`${data.metrics.conversion_score}/100`} tone="amber" />
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={<BadgeDollarSign />} label="Total depositado" value={brl(p.total_depositado)} />
        <MetricCard icon={<TrendingDown />} label="Total sacado" value={brl(p.total_sacado)} />
        <MetricCard icon={<Wallet />} label="Saldo informado" value={brl(data.metrics.saldo_total)} />
        <MetricCard
          icon={<TrendingUp />}
          label="Resultado da casa"
          value={brl(data.metrics.lucro)}
          valueClass={data.metrics.lucro >= 0 ? "text-emerald-400" : "text-rose-400"}
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <Card className="border-border/50 bg-card/70">
          <CardContent className="p-5">
            <SectionTitle title="Movimento do player" subtitle="Datas e contagens conhecidas pelo CRM." />
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <InfoBox label="Depositos" value={num(data.metrics.deposit_count)} />
              <InfoBox label="Saques" value={num(data.metrics.withdrawal_count)} />
              <InfoBox label="Ultimo deposito" value={timeAgo(lastDeposit)} detail={formatDateTime(lastDeposit)} />
              <InfoBox label="Primeiro deposito" value={timeAgo(ftd)} detail={formatDateTime(ftd)} />
              <InfoBox label="Ultima atividade" value={timeAgo(data.metrics.last_activity_at)} detail={formatDateTime(data.metrics.last_activity_at)} />
              <InfoBox label="Ultimo saque" value={timeAgo(p.ultimo_saque)} detail={formatDateTime(p.ultimo_saque)} />
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/50 bg-card/70">
          <CardContent className="p-5">
            <SectionTitle title="Como chegou" subtitle="Atribuicao declarada no cadastro/importacao." />
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <InfoRow label="Fonte" value={data.media.source ?? p.origem} />
              <InfoRow label="Meio" value={data.attribution?.utm_medium ?? p.utm_medium} />
              <InfoRow label="Campanha" value={data.media.campaign ?? p.utm_campaign} wide />
              <InfoRow label="Criativo" value={data.media.creative ?? p.utm_content} />
              <InfoRow label="ID do anuncio" value={data.media.ad_id ?? p.utm_id} />
              <InfoRow label="Expert" value={p.expert} />
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <Card className="border-border/50 bg-card/70">
          <CardContent className="p-5">
            <SectionTitle title="Cashback" subtitle="O que a casa devolveu e quando pagou." />
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <InfoBox label="Total recebido" value={brl(p.total_cashback_paid)} detail={`${data.metrics.cashback_count} registros`} />
              <InfoBox label="Ultimo" value={brl(p.last_cashback_amount)} detail={formatDateTime(p.last_cashback_paid_at)} />
              <InfoBox label="SMS de cashback" value={num(p.last_cashback_sms_template_sent ?? 0)} detail="template enviado" />
            </div>
            <CompactList
              rows={data.cashbacks.slice(0, 6).map((c) => ({
                id: c.id,
                left: formatDate(c.paid_at),
                title: c.status ?? "cashback",
                right: brl(c.cashback_amount),
              }))}
              empty="Nenhum cashback registrado."
            />
          </CardContent>
        </Card>

        <Card className="border-border/50 bg-card/70">
          <CardContent className="p-5">
            <SectionTitle title="CRM e midia" subtitle="Custo de comunicacao e origem paga quando houver dados." />
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <InfoBox label="SMS enviados" value={num(data.metrics.sms_sent)} detail={`${data.metrics.sms_delivered} entregues`} />
              <InfoBox label="Cliques/eventos" value={num(data.metrics.sms_clicked)} detail="eventos de clique" />
              <InfoBox label="Gasto midia" value={data.media.spend_estimate == null ? "Sem dado" : brl(data.media.spend_estimate)} detail={mediaBasis(data.media.spend_basis)} />
              <InfoBox label="Trouxe" value={brl(p.total_depositado)} detail="depositado pelo player" />
              <InfoBox
                label="Resultado midia"
                value={data.media.result == null ? "Sem dado" : brl(data.media.result)}
                valueClass={data.media.result == null || data.media.result >= 0 ? "text-emerald-400" : "text-rose-400"}
              />
              <InfoBox label="Impressoes/cliques" value={`${num(data.media.impressions ?? 0)} / ${num(data.media.clicks ?? 0)}`} detail="Meta/ads sincronizados" />
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
        <Card className="border-border/50 bg-card/70">
          <CardContent className="p-5">
            <SectionTitle title="Sinais e alertas" subtitle="O que merece atencao operacional." />
            <div className="mt-4 space-y-2">
              {data.alerts.length === 0 && (
                <div className="rounded-md border border-border/50 bg-background/40 p-3 text-sm text-muted-foreground">
                  Nenhum alerta ativo para este player agora.
                </div>
              )}
              {data.alerts.map((alert) => (
                <div key={alert.tipo} className="rounded-md border border-border/50 bg-background/40 p-3">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <ShieldAlert className="h-4 w-4 text-amber-400" />
                    {alert.titulo}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{alert.motivo}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/50 bg-card/70">
          <CardContent className="p-5">
            <SectionTitle title="Linha do tempo" subtitle="Eventos, dinheiro, sessoes e mensagens em ordem recente." />
            <div className="mt-4 max-h-[560px] space-y-1 overflow-y-auto pr-1">
              {data.timeline.length === 0 && (
                <div className="rounded-md border border-border/50 bg-background/40 p-3 text-sm text-muted-foreground">
                  Sem eventos individuais registrados para este player.
                </div>
              )}
              {data.timeline.map((item) => (
                <TimelineItem key={item.id} item={item} />
              ))}
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function BackButton() {
  return (
    <Button variant="ghost" size="sm" asChild className="gap-2 text-muted-foreground">
      <Link to="/players">
        <ArrowLeft className="h-4 w-4" />
        Voltar para players
      </Link>
    </Button>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <BackButton />
      <Skeleton className="h-32 w-full" />
      <div className="grid gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
      </div>
      <Skeleton className="h-96 w-full" />
    </div>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
    </div>
  );
}

function MetricCard({ icon, label, value, valueClass }: { icon: React.ReactNode; label: string; value: string; valueClass?: string }) {
  return (
    <Card className="border-border/50 bg-card/70">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          <span className="text-primary [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
          {label}
        </div>
        <div className={`mt-3 text-2xl font-bold ${valueClass ?? ""}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function InfoBox({ label, value, detail, valueClass }: { label: string; value: string; detail?: string | null; valueClass?: string }) {
  return (
    <div className="rounded-md border border-border/50 bg-background/50 p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-2 text-lg font-bold ${valueClass ?? ""}`}>{value}</div>
      {detail && <div className="mt-1 truncate text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}

function InfoRow({ label, value, wide }: { label: string; value: unknown; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2" : ""}>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 break-words text-sm font-medium">{empty(value)}</div>
    </div>
  );
}

function ScoreTile({ label, value, tone }: { label: string; value: string; tone: "blue" | "green" | "red" | "amber" }) {
  const color =
    tone === "green" ? "text-emerald-400"
    : tone === "red" ? "text-rose-400"
    : tone === "amber" ? "text-amber-400"
    : "text-primary";
  return (
    <div className="rounded-md border border-border/50 bg-background/50 p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-2 text-xl font-bold ${color}`}>{value}</div>
    </div>
  );
}

function ContactLine({ icon, label, value }: { icon: React.ReactNode; label: string; value: unknown }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border/50 bg-background/40 px-3 py-2">
      <span className="text-muted-foreground">{icon}</span>
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-sm font-medium">{empty(value)}</span>
    </div>
  );
}

function StatusBadge({ active }: { active: boolean }) {
  return active ? (
    <Badge className="border-emerald-500/30 bg-emerald-500/15 text-emerald-300">Ativo</Badge>
  ) : (
    <Badge variant="outline" className="border-border/70 text-muted-foreground">Sem atividade recente</Badge>
  );
}

function CompactList({ rows, empty }: { rows: Array<{ id: string; left: string; title: string; right: string }>; empty: string }) {
  if (rows.length === 0) return <div className="mt-4 text-sm text-muted-foreground">{empty}</div>;
  return (
    <div className="mt-4 divide-y divide-border/50 overflow-hidden rounded-md border border-border/50">
      {rows.map((row) => (
        <div key={row.id} className="grid grid-cols-[95px_1fr_auto] gap-3 bg-background/30 px-3 py-2 text-sm">
          <span className="text-muted-foreground">{row.left}</span>
          <span className="truncate">{row.title}</span>
          <span className="font-semibold">{row.right}</span>
        </div>
      ))}
    </div>
  );
}

function TimelineItem({ item }: { item: PlayerDetail["timeline"][number] }) {
  const style = timelineStyle(item.type);
  return (
    <div className="grid grid-cols-[18px_1fr_auto] gap-3 rounded-md px-2 py-2 hover:bg-background/45">
      <span className={`mt-1.5 h-2.5 w-2.5 rounded-full ${style}`} />
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold">{item.label}</div>
        {item.description && <div className="mt-0.5 truncate text-xs text-muted-foreground">{item.description}</div>}
        {item.status && <div className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">{item.status}</div>}
      </div>
      <div className="text-right">
        <div className="text-xs text-muted-foreground">{timeAgo(item.at)}</div>
        {item.amount != null && <div className="mt-1 text-sm font-semibold">{brl(item.amount)}</div>}
      </div>
    </div>
  );
}

function timelineStyle(type: string) {
  if (type === "deposit" || type === "cashback") return "bg-emerald-400";
  if (type === "withdrawal") return "bg-rose-400";
  if (type === "sms" || type === "followup") return "bg-primary";
  if (type === "session") return "bg-sky-400";
  return "bg-amber-400";
}

function levelFor(total: number, vip: boolean) {
  if (vip || total >= 3000) {
    return { label: "Black VIP", className: "border-violet-400/40 bg-violet-500/15 text-violet-300", icon: Crown };
  }
  if (total >= 1000) {
    return { label: "Diamante", className: "border-cyan-400/40 bg-cyan-500/15 text-cyan-300", icon: Gem };
  }
  if (total >= 500) return { label: "Ouro", className: "border-amber-400/40 bg-amber-500/15 text-amber-300", icon: Sparkles };
  if (total >= 200) return { label: "Prata", className: "border-slate-300/40 bg-slate-300/10 text-slate-200", icon: Target };
  if (total >= 10) return { label: "Bronze", className: "border-orange-400/40 bg-orange-500/15 text-orange-300", icon: Target };
  return { label: "Novato", className: "border-emerald-400/40 bg-emerald-500/15 text-emerald-300", icon: User };
}

function mediaBasis(basis: PlayerDetail["media"]["spend_basis"]) {
  if (basis === "ad") return "criativo/anuncio";
  if (basis === "campaign") return "campanha";
  return "sem match";
}

function empty(value: unknown) {
  const text = String(value ?? "").trim();
  return text || "—";
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return null;
  return new Date(value).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
