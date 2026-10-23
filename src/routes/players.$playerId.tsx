import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, type ReactNode } from "react";
import {
  Check,
  Copy,
  Crown,
  ExternalLink,
  History,
  MessageCircle,
  MessageSquareText,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { HomeCard, KpiCard, MetricRow } from "@/components/home/home-cards";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { PlayerContactHistoryDialog } from "@/components/history/player-contact-history";
import { EnviarPeloWhatsAppDialog } from "@/components/whatsapp/send-dialog";
import { LevelBadge } from "@/components/players/level-badge";
import { SituationText } from "@/components/players/situation-text";
import { PlayerJourneysCard } from "@/components/players/player-journeys-card";
import { copyToClipboard, openCampaignWithAudience } from "@/components/players/campaign-audience";
import {
  alertTypeLabel,
  linkChannelLabel,
  linkSourceLabel,
  recordStatusLabel,
} from "@/components/players/player-labels";
import { brl, num, timeAgo } from "@/lib/format";
import { getPlayerDetail, type PlayerDetail } from "@/lib/player-detail.functions";
import { getPlayerLinkHistory } from "@/lib/shortio.functions";
import { nextPrecallCopy } from "@/lib/precall-copy";
import { cn } from "@/lib/utils";
import { describeEventType } from "@/lib/webhook-events";

export const Route = createFileRoute("/players/$playerId")({
  component: PlayerDetailPage,
});

type LinkRow = {
  id: string;
  channel: string;
  source_type: string;
  sent_url: string;
  sent_at?: string | null;
  clicks: number;
};

const RISK_LABEL: Record<string, string> = { alto: "Alto", medio: "Médio", baixo: "Baixo" };

function PlayerDetailPage() {
  const { playerId } = Route.useParams();
  const qc = useQueryClient();
  const fetchDetail = useServerFn(getPlayerDetail);
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["player-detail", playerId],
    queryFn: () => fetchDetail({ data: { playerId } }),
    staleTime: 15_000,
  });
  const fetchLinks = useServerFn(getPlayerLinkHistory);
  const links = useQuery({
    queryKey: ["player-links", playerId],
    queryFn: () => fetchLinks({ data: { playerId } }),
    staleTime: 15_000,
  });
  // Nome da casa para a mensagem pronta (mesma copy da lista de Jogadores).
  const { data: tenantBrand } = useQuery({
    queryKey: ["current-tenant-brand"],
    queryFn: async () => {
      const { data: tenant } = await supabase.from("tenants").select("nome").limit(1).maybeSingle();
      return (tenant?.nome as string | undefined) ?? "";
    },
    staleTime: 5 * 60_000,
  });
  const [messageOpen, setMessageOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [idCopied, setIdCopied] = useState(false);
  const [campaignBusy, setCampaignBusy] = useState(false);

  if (isLoading) return <DetailSkeleton />;

  if (error || !data) {
    return (
      <Page>
        <PageHeader />
        <HomeCard className="p-5 sm:p-6">
          <h2 className="text-section">Não foi possível abrir a ficha</h2>
          <p className="mt-1 text-body text-muted-foreground">
            {error instanceof Error ? error.message : "Tente novamente em alguns instantes."}
          </p>
          <Button
            variant="outline"
            className="mt-4 h-11 sm:h-9"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            Tentar de novo
          </Button>
        </HomeCard>
      </Page>
    );
  }

  const p = data.player;
  const ftd = p.ftd_em ?? data.attribution?.raw_payload?.raw?.primeiro_deposito ?? null;
  const lastDeposit =
    p.ultimo_deposito ?? data.attribution?.raw_payload?.raw?.ultimo_deposito ?? null;
  const externalId = String(p.player_external_id ?? "").trim();
  const phone = String(p.telefone ?? "").trim();
  const linkRows = (links.data ?? []) as LinkRow[];
  const linkClicks = linkRows.reduce((total, link) => total + Number(link.clicks ?? 0), 0);
  const createdAt = formatDate(p.created_at);

  async function copyExternalId() {
    if (!externalId) return;
    await copyToClipboard(externalId);
    setIdCopied(true);
    window.setTimeout(() => setIdCopied(false), 1500);
    toast.success("ID copiado.");
  }

  const actionClass = "h-11 px-4 sm:h-9";

  return (
    <Page>
      <PageHeader
        title={p.nome}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <LevelBadge level={data.level} />
            {p.vip && (
              <span className="inline-flex items-center gap-1 text-amber-300">
                <Crown className="h-3.5 w-3.5" aria-hidden="true" />
                VIP
              </span>
            )}
            <span aria-hidden="true">·</span>
            <SituationText situation={data.situation} />
            {data.days_without_deposit != null && data.situation !== "no_deposit" && (
              <span>
                (
                {data.days_without_deposit === 0
                  ? "depositou hoje"
                  : `${num(data.days_without_deposit)} ${data.days_without_deposit === 1 ? "dia" : "dias"} sem depositar`}
                )
              </span>
            )}
            {createdAt !== "—" && (
              <>
                <span aria-hidden="true">·</span>
                <span>cadastro em {createdAt}</span>
              </>
            )}
          </span>
        }
        actions={
          <>
            <Button
              variant="outline"
              className={actionClass}
              onClick={() => setMessageOpen(true)}
              disabled={!phone}
              title={phone ? undefined : "Jogador sem telefone cadastrado"}
            >
              <MessageCircle className="h-4 w-4" />
              Mensagem
            </Button>
            <Button
              className={actionClass}
              disabled={campaignBusy}
              onClick={async () => {
                setCampaignBusy(true);
                const opened = await openCampaignWithAudience({ playerIds: [p.id] });
                if (!opened) setCampaignBusy(false);
              }}
            >
              <MessageSquareText className="h-4 w-4" />
              Usar na campanha
            </Button>
            <Button variant="outline" className={actionClass} onClick={() => setHistoryOpen(true)}>
              <History className="h-4 w-4" />
              Histórico de contatos
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiCard title="Total depositado" value={brl(p.total_depositado)} />
        <KpiCard title="Total sacado" value={brl(p.total_sacado)} />
        <KpiCard title="Saldo informado" value={brl(data.metrics.saldo_total)} />
        <KpiCard
          title="Resultado da casa"
          value={brl(data.metrics.lucro)}
          detail="depositado menos sacado"
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Section title="Contato">
          <MetricRow label="Telefone" value={empty(p.telefone)} />
          <MetricRow label="E-mail" value={<span className="break-all">{empty(p.email)}</span>} />
          <MetricRow
            label="ID na plataforma"
            value={
              externalId ? (
                <button
                  type="button"
                  onClick={copyExternalId}
                  className="-my-2 inline-flex min-h-11 items-center gap-1.5 font-medium text-primary hover:underline sm:min-h-0"
                >
                  {idCopied ? (
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {idCopied ? "ID copiado" : "Copiar ID"}
                </button>
              ) : (
                <Muted>Sem ID</Muted>
              )
            }
          />
          <MetricRow label="Cadastro" value={createdAt} />
          <MetricRow label="Verificado" value={p.verificado ? "Sim" : "Não"} />
          <MetricRow
            label="Risco"
            value={p.risco ? (RISK_LABEL[p.risco] ?? p.risco) : <Muted>Sem dado</Muted>}
          />
        </Section>

        <Section title="Movimento do jogador">
          <MetricRow label="Depósitos" value={num(data.metrics.deposit_count)} />
          <MetricRow label="Saques" value={num(data.metrics.withdrawal_count)} />
          <MetricRow label="Último depósito" value={<When value={lastDeposit} />} />
          <MetricRow label="Primeiro depósito" value={<When value={ftd} />} />
          <MetricRow
            label="Última atividade"
            value={<When value={data.metrics.last_activity_at} />}
          />
          <MetricRow label="Último saque" value={<When value={p.ultimo_saque} />} />
        </Section>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Section
          title="Pontuação"
          subtitle="Notas de 0 a 100 calculadas pelo CRM. Em risco, quanto maior, mais chance de parar."
        >
          <MetricRow label="Score geral" value={<Score value={data.metrics.score} />} />
          <MetricRow label="Retenção" value={<Score value={data.metrics.retention_score} />} />
          <MetricRow label="Risco" value={<Score value={data.metrics.risk_score} />} />
          <MetricRow label="Conversão" value={<Score value={data.metrics.conversion_score} />} />
        </Section>

        <Section title="Sinais e alertas">
          {data.alerts.length === 0 ? (
            <p className="py-2.5 text-body text-muted-foreground">
              Nenhum alerta ativo para este jogador agora.
            </p>
          ) : (
            <ul className="divide-y divide-border/70">
              {data.alerts.map((alert) => (
                <li key={alert.tipo} className="flex gap-2.5 py-2.5">
                  <ShieldAlert
                    className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="text-body font-medium">{alert.titulo}</p>
                    <p className="mt-0.5 text-label text-muted-foreground">{alert.motivo}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <PlayerJourneysCard playerId={playerId} />

      <div className="grid gap-3 lg:grid-cols-2">
        <Section title="Como chegou" subtitle="Atribuição declarada no cadastro ou na importação.">
          <MetricRow label="Fonte" value={empty(data.media.source ?? p.origem)} />
          <MetricRow label="Meio" value={empty(data.attribution?.utm_medium ?? p.utm_medium)} />
          <MetricRow
            label="Campanha"
            value={
              <span className="break-all">{empty(data.media.campaign ?? p.utm_campaign)}</span>
            }
          />
          <MetricRow
            label="Criativo"
            value={<span className="break-all">{empty(data.media.creative ?? p.utm_content)}</span>}
          />
          <MetricRow label="ID do anúncio" value={empty(data.media.ad_id ?? p.utm_id)} />
          <MetricRow label="Expert" value={empty(p.expert)} />
          {(data.media.impressions != null || data.media.clicks != null) && (
            <MetricRow
              label="Alcance do anúncio"
              value={`${num(data.media.impressions ?? 0)} impressões · ${num(data.media.clicks ?? 0)} cliques`}
            />
          )}
        </Section>

        <Section title="CRM e mídia" subtitle="O que a casa fez com este jogador e quanto custou.">
          <MetricRow
            label="SMS enviados"
            value={
              <>
                {num(data.metrics.sms_sent)}
                {data.metrics.sms_failed > 0 && (
                  <span className="ml-1.5 font-normal text-muted-foreground">
                    · {num(data.metrics.sms_failed)} com falha
                  </span>
                )}
              </>
            }
          />
          <MetricRow
            label="Cliques nos links enviados"
            value={links.isLoading ? <Muted>…</Muted> : num(linkClicks)}
          />
          <MetricRow
            label="Gasto com mídia"
            value={
              data.media.spend_estimate == null ? (
                <Muted>Sem dado</Muted>
              ) : (
                <>
                  {brl(data.media.spend_estimate)}
                  <span className="ml-1.5 font-normal text-muted-foreground">
                    · {mediaBasis(data.media.spend_basis)}
                  </span>
                </>
              )
            }
          />
          <MetricRow
            label="Resultado da mídia"
            value={data.media.result == null ? <Muted>Sem dado</Muted> : brl(data.media.result)}
            valueClassName={
              data.media.result == null
                ? undefined
                : data.media.result >= 0
                  ? "text-success"
                  : "text-danger"
            }
          />
        </Section>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Section title="Cashback" subtitle="O que a casa devolveu e quando pagou.">
          <MetricRow
            label="Total recebido"
            value={
              <>
                {brl(p.total_cashback_paid)}
                <span className="ml-1.5 font-normal text-muted-foreground">
                  · {num(data.metrics.cashback_count)}{" "}
                  {data.metrics.cashback_count === 1 ? "pagamento" : "pagamentos"}
                </span>
              </>
            }
          />
          <MetricRow
            label="Último"
            value={
              p.last_cashback_paid_at ? (
                <>
                  {brl(p.last_cashback_amount)}
                  <span className="ml-1.5 font-normal text-muted-foreground">
                    · {formatDate(p.last_cashback_paid_at)}
                  </span>
                </>
              ) : (
                <Muted>Nenhum</Muted>
              )
            }
          />
          {data.cashbacks.length > 0 && (
            <ul className="mt-2 divide-y divide-border/70 border-t border-border/70">
              {data.cashbacks.slice(0, 6).map((c) => (
                <li
                  key={c.id}
                  className="grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)_auto] gap-3 py-2 text-body"
                >
                  <span className="text-muted-foreground">{formatDate(c.paid_at)}</span>
                  <span className="truncate">{recordStatusLabel(c.status) ?? "Cashback"}</span>
                  <span className="font-semibold tabular-nums">{brl(c.cashback_amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title="Links enviados"
          subtitle={
            linkRows.length > 0
              ? `${num(linkRows.length)} ${linkRows.length === 1 ? "link" : "links"} rastreados, ${num(linkClicks)} ${linkClicks === 1 ? "clique" : "cliques"}.`
              : "Links rastreados enviados a este jogador."
          }
        >
          {links.isLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : linkRows.length === 0 ? (
            <p className="py-2.5 text-body text-muted-foreground">Nenhum link rastreado enviado.</p>
          ) : (
            <ul className="divide-y divide-border/70">
              {linkRows.map((link) => {
                const source = linkSourceLabel(link.source_type);
                return (
                  <li key={link.id} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-body font-medium">
                        {linkChannelLabel(link.channel)}
                        {source && <span className="text-muted-foreground"> · {source}</span>}
                        {link.sent_at && (
                          <span className="font-normal text-muted-foreground">
                            {" "}
                            · {timeAgo(link.sent_at)}
                          </span>
                        )}
                      </p>
                      <a
                        className="inline-flex max-w-full items-center gap-1 text-label text-primary hover:underline"
                        href={link.sent_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <span className="truncate">{link.sent_url}</span>
                        <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                      </a>
                    </div>
                    <span className="shrink-0 text-label tabular-nums text-muted-foreground">
                      {num(link.clicks)} {link.clicks === 1 ? "clique" : "cliques"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>

      <Section
        title="Linha do tempo"
        subtitle="Depósitos, saques, acessos e mensagens, do mais recente ao mais antigo."
      >
        {data.timeline.length === 0 ? (
          <p className="py-2.5 text-body text-muted-foreground">
            Sem eventos registrados para este jogador.
          </p>
        ) : (
          <ul className="max-h-[560px] divide-y divide-border/60 overflow-y-auto pr-1">
            {data.timeline.map((item) => (
              <TimelineItem key={item.id} item={item} />
            ))}
          </ul>
        )}
      </Section>

      <EnviarPeloWhatsAppDialog
        open={messageOpen}
        onOpenChange={setMessageOpen}
        phone={p.telefone}
        leadName={p.nome}
        mensagem={nextPrecallCopy({ fullName: p.nome, brand: tenantBrand ?? "" })}
        onSent={() => {
          void qc.invalidateQueries({ queryKey: ["player-contact-history", playerId] });
          void qc.invalidateQueries({ queryKey: ["player-detail", playerId] });
        }}
      />
      <PlayerContactHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        playerId={historyOpen ? playerId : null}
        playerName={p.nome}
      />
    </Page>
  );
}

function DetailSkeleton() {
  return (
    <Page>
      <div className="space-y-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    </Page>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <HomeCard className="p-4 sm:p-5">
      <h2 className="text-section">{title}</h2>
      {subtitle && <p className="mt-0.5 text-label text-muted-foreground">{subtitle}</p>}
      <div className="mt-2">{children}</div>
    </HomeCard>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="font-normal text-muted-foreground">{children}</span>;
}

function When({ value }: { value: string | null | undefined }) {
  if (!value) return <Muted>Sem dado</Muted>;
  return (
    <span title={formatDateTime(value) ?? undefined}>
      {timeAgo(value)}
      <span className="ml-1.5 font-normal text-muted-foreground">· {formatDate(value)}</span>
    </span>
  );
}

function Score({ value }: { value: number }) {
  return (
    <span title={`${value} de 0 a 100`}>
      {num(value)}
      <span className="font-normal text-muted-foreground">/100</span>
    </span>
  );
}

function TimelineItem({ item }: { item: PlayerDetail["timeline"][number] }) {
  const label =
    item.type === "followup"
      ? `Contato · ${alertTypeLabel(item.label.replace(/^Follow-up - /, ""))}`
      : item.type === "event"
        ? eventLabel(item.label)
        : item.type === "sms"
          ? smsTimelineLabel(item.label)
          : item.label;
  // Provider event codes ("auth.login.success") are not for people; hide them.
  const description =
    item.description && !/^[a-z0-9_]+(\.[a-z0-9_]+)+$/i.test(item.description.trim())
      ? item.description
      : null;
  const status = recordStatusLabel(item.status);
  return (
    <li className="grid grid-cols-[10px_minmax(0,1fr)_auto] gap-3 py-2.5">
      <span
        className={cn("mt-1.5 h-2.5 w-2.5 rounded-full", timelineDot(item.type))}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="truncate text-body font-medium">{label}</p>
        {description && (
          <p className="mt-0.5 truncate text-label text-muted-foreground">{description}</p>
        )}
        {status && item.type !== "followup" && (
          <p className="mt-0.5 text-meta text-muted-foreground">{status}</p>
        )}
      </div>
      <div className="text-right">
        <p className="text-meta text-muted-foreground" title={formatDateTime(item.at) ?? undefined}>
          {timeAgo(item.at)}
        </p>
        {item.amount != null && (
          <p className="mt-0.5 text-body font-semibold tabular-nums">{brl(item.amount)}</p>
        )}
      </div>
    </li>
  );
}

/** "SMS - journey:<uuid>" → "SMS de jornada"; keeps readable trigger names. */
function smsTimelineLabel(label: string) {
  const trigger = label.replace(/^SMS - /, "");
  if (trigger === label) return label;
  if (/^journey[:_]/i.test(trigger)) return "SMS de jornada";
  if (/^campaign[:_]/i.test(trigger)) return "SMS de campanha";
  if (/^[0-9a-f-]{20,}$/i.test(trigger) || /[:][0-9a-f-]{20,}/i.test(trigger)) return "SMS enviado";
  return label;
}

function eventLabel(value: string) {
  const known = describeEventType(value);
  if (known.categoria) return known.label;
  const text = value.replace(/[_-]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Evento";
}

function timelineDot(type: string) {
  if (type === "deposit" || type === "cashback") return "bg-success";
  if (type === "withdrawal") return "bg-danger";
  if (type === "sms" || type === "followup") return "bg-primary";
  if (type === "session") return "bg-info";
  return "bg-warning";
}

function mediaBasis(basis: PlayerDetail["media"]["spend_basis"]) {
  if (basis === "ad") return "pelo anúncio";
  if (basis === "campaign") return "pela campanha";
  return "sem correspondência";
}

function empty(value: unknown): ReactNode {
  const text = String(value ?? "").trim();
  return text || <Muted>Sem dado</Muted>;
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
