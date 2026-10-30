// Área do Expert §8 — lado do admin das campanhas dos experts: fila de
// aprovação (por expert e global em /experts), revisão do conteúdo antes de
// aprovar (texto do SMS, assunto + HTML do e-mail num iframe sem scripts,
// roteiro/áudio da voz), Aprovar / Recusar (motivo obrigatório, no próprio
// diálogo) / Pausar / Retomar e a barra de uso do mês × teto.
//
// Os componentes de apresentação (`ExpertCampaignsTable`,
// `ExpertCampaignReviewBody`, `ExpertUsageBar`) não buscam nada: os
// "contêineres" (`ExpertCampaignsQueue`, `ExpertCampaignReviewDialog`) ligam
// as server functions. As regras de status e ações vivem em
// expert-campaigns-admin-model.ts.
import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import {
  EXPERT_CAMPAIGN_DETAIL_ADMIN_QUERY_KEY,
  EXPERT_CAMPAIGNS_ADMIN_QUERY_KEY,
  EXPERT_USAGE_ADMIN_QUERY_KEY,
} from "@/components/experts/experts-query";
import {
  CHANNEL_LABEL,
  REJECT_REASON_MAX,
  campaignActions,
  campaignStatusInfo,
  isPendingApproval,
  rejectReasonError,
  sortApprovalQueue,
  usageView,
  type AdminCampaign,
  type StatusTone,
} from "@/components/experts/expert-campaigns-admin-model";
import { useExpertCampaignsAdmin } from "@/components/experts/use-expert-campaigns-admin";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import {
  approveExpertCampaign,
  pauseExpertCampaign,
  rejectExpertCampaign,
  resumeExpertCampaign,
} from "@/lib/expert-campaigns.functions";
import { getExpertCampaignForAdmin } from "@/lib/expert-campaigns-admin.functions";
import type { ExpertCampaignAdminDetail } from "@/lib/expert-campaigns-admin.server";
import type { ExpertCampaignListItem } from "@/lib/expert-campaigns.server";
import { brl } from "@/lib/format";
import { cn } from "@/lib/utils";

type Target = { channel: ExpertCampaignListItem["channel"]; id: string };

const TONE_CLASS: Record<StatusTone, string> = {
  warning: "bg-warning/15 text-warning",
  danger: "bg-destructive/15 text-destructive",
  info: "bg-info/15 text-info",
  success: "bg-success/15 text-success",
  muted: "bg-muted text-muted-foreground",
};

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message
    ? error.message
    : "Não foi possível concluir. Tente de novo.";

const dateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—";

const count = (n: number) => n.toLocaleString("pt-BR");

export function ExpertCampaignStatusBadge({ campaign }: { campaign: AdminCampaign }) {
  const { label, tone } = campaignStatusInfo(campaign);
  return (
    <Badge className={cn("whitespace-nowrap border-transparent shadow-none", TONE_CLASS[tone])}>
      {label}
    </Badge>
  );
}

// ─── Uso × teto ─────────────────────────────────────────────────────────────

const BAR_CLASS = {
  ok: "bg-primary",
  warning: "bg-warning",
  danger: "bg-destructive",
  blocked: "bg-destructive",
  none: "bg-primary",
} as const;

/** "R$ 42,50 de R$ 100,00" + barra; sem teto mostra só o consumo. */
export function ExpertUsageBar({
  usage,
  compact = false,
}: {
  usage: { teto: number | null; usado: number };
  compact?: boolean;
}) {
  const view = usageView(usage);
  const label =
    usage.teto === null
      ? `${brl(usage.usado)} no mês`
      : `${brl(usage.usado)} de ${brl(usage.teto)}`;
  return (
    <div className={cn("space-y-1", compact ? "min-w-[9rem]" : "")}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
        <span className={compact ? "" : "text-sm font-medium"}>{label}</span>
        <span
          className={cn(
            "text-muted-foreground",
            (view.tone === "danger" || view.tone === "blocked") && "font-medium text-destructive",
            view.tone === "warning" && "text-warning",
          )}
        >
          {view.status}
        </span>
      </div>
      {view.percent !== null && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={view.percent}
          aria-label="Uso do teto mensal"
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn("h-full rounded-full", BAR_CLASS[view.tone])}
            style={{ width: `${view.percent}%` }}
          />
        </div>
      )}
    </div>
  );
}

// ─── Tabela da fila ─────────────────────────────────────────────────────────

export function ExpertCampaignsTable({
  items,
  showExpert,
  emptyText,
  disabled = false,
  busyId = null,
  onReview,
  onPause,
  onResume,
}: {
  items: ExpertCampaignListItem[];
  showExpert: boolean;
  emptyText: string;
  disabled?: boolean;
  busyId?: string | null;
  onReview: (target: Target) => void;
  onPause: (target: Target) => void;
  onResume: (target: Target) => void;
}) {
  const rows = sortApprovalQueue(items);
  const columns = showExpert ? 8 : 7;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Campanha</TableHead>
            {showExpert && <TableHead>Expert</TableHead>}
            <TableHead>Canal</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Destinatários</TableHead>
            <TableHead className="text-right">Custo estimado</TableHead>
            <TableHead>Criada em</TableHead>
            <TableHead className="text-right">Ações</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((c) => {
            const target = { channel: c.channel, id: c.id };
            const actions = campaignActions(c);
            const busy = busyId === c.id;
            const note =
              c.status === "recusada"
                ? c.rejectionReason
                : c.status === "pausada"
                  ? c.lastError
                  : null;
            return (
              <TableRow key={`${c.channel}:${c.id}`}>
                <TableCell className="max-w-[18rem]">
                  <div className="truncate font-medium">{c.name || "Sem nome"}</div>
                  {note && <div className="line-clamp-2 text-xs text-muted-foreground">{note}</div>}
                </TableCell>
                {showExpert && <TableCell>{c.expertNome || "—"}</TableCell>}
                <TableCell>{CHANNEL_LABEL[c.channel]}</TableCell>
                <TableCell>
                  <ExpertCampaignStatusBadge campaign={c} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{count(c.totalCount)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {c.estimatedCost == null ? "—" : brl(c.estimatedCost)}
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm">{dateTime(c.createdAt)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex flex-wrap justify-end gap-2">
                    {actions.includes("review") && (
                      <Button size="sm" onClick={() => onReview(target)}>
                        Revisar
                      </Button>
                    )}
                    {actions.includes("pause") && (
                      <DemoDisabledTooltip active={disabled}>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={disabled || busy}
                          onClick={() => onPause(target)}
                        >
                          Pausar
                        </Button>
                      </DemoDisabledTooltip>
                    )}
                    {actions.includes("resume") && (
                      <DemoDisabledTooltip active={disabled}>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={disabled || busy}
                          onClick={() => onResume(target)}
                        >
                          Retomar
                        </Button>
                      </DemoDisabledTooltip>
                    )}
                    {!isPendingApproval(c) && actions.length === 0 && (
                      <Button size="sm" variant="ghost" onClick={() => onReview(target)}>
                        Ver
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={columns} className="py-8 text-center text-muted-foreground">
                {emptyText}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

// ─── Conteúdo e revisão ─────────────────────────────────────────────────────

export function CampaignContentPreview({ detail }: { detail: ExpertCampaignAdminDetail }) {
  const content = detail.content;
  if (content.kind === "sms") {
    return (
      <div className="space-y-1">
        <div className="text-xs font-medium text-muted-foreground">
          Texto do SMS · {content.segments} {content.segments === 1 ? "segmento" : "segmentos"}
        </div>
        <p className="whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 p-3 text-sm">
          {content.text}
        </p>
      </div>
    );
  }
  if (content.kind === "email") {
    return (
      <div className="space-y-2">
        <div className="text-sm">
          <span className="text-muted-foreground">Assunto: </span>
          <span className="font-medium">{content.subject || "—"}</span>
        </div>
        {content.preheader && (
          <div className="text-xs text-muted-foreground">Pré-cabeçalho: {content.preheader}</div>
        )}
        <div className="overflow-hidden rounded-md border border-border/60 bg-white">
          <iframe
            title="Prévia do e-mail"
            srcDoc={content.html}
            sandbox=""
            className="h-[420px] w-full"
            style={{ border: 0 }}
          />
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">
        {content.source === "script" ? "Roteiro de voz (TTS)" : "Áudio da biblioteca"}
        {content.name ? ` · ${content.name}` : ""}
        {content.durationSeconds ? ` · ${content.durationSeconds}s` : ""}
      </div>
      {content.text ? (
        <p className="whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 p-3 text-sm">
          {content.text}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          {content.source === "asset" ? "Áudio gravado (sem texto)." : "Roteiro indisponível."}
        </p>
      )}
    </div>
  );
}

export type ReviewMode = "review" | "reject";

/** Corpo do diálogo de revisão (sem busca), para os testes e o contêiner. */
export function ExpertCampaignReviewBody({
  detail,
  loading = false,
  loadError = null,
  mode,
  reason,
  error,
  pending,
  disabled = false,
  onReasonChange,
  onApprove,
  onStartReject,
  onCancelReject,
  onConfirmReject,
  onClose,
}: {
  detail: ExpertCampaignAdminDetail | null;
  loading?: boolean;
  loadError?: string | null;
  mode: ReviewMode;
  reason: string;
  /** Erro da última ação (mensagem do servidor, em pt-BR). */
  error: string | null;
  pending: boolean;
  disabled?: boolean;
  onReasonChange: (value: string) => void;
  onApprove: () => void;
  onStartReject: () => void;
  onCancelReject: () => void;
  onConfirmReject: () => void;
  onClose: () => void;
}) {
  const reasonId = useId();
  const reasonHelpId = `${reasonId}-help`;
  const [reasonTouched, setReasonTouched] = useState(false);
  const reasonHint = rejectReasonError(reason);
  const decidable = !!detail && isPendingApproval(detail);

  return (
    <>
      {loading && <p className="text-sm text-muted-foreground">Carregando…</p>}
      {loadError && (
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      )}
      {detail && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="outline">{CHANNEL_LABEL[detail.channel]}</Badge>
            <ExpertCampaignStatusBadge campaign={detail} />
            {detail.expertNome && (
              <span className="text-muted-foreground">por {detail.expertNome}</span>
            )}
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Destinatários</dt>
              <dd className="font-medium tabular-nums">{count(detail.totalCount)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Custo estimado</dt>
              <dd className="font-medium tabular-nums">
                {detail.estimatedCost == null ? "—" : brl(detail.estimatedCost)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Envio</dt>
              <dd className="font-medium">
                {detail.scheduledAt ? dateTime(detail.scheduledAt) : "Ao aprovar"}
              </dd>
            </div>
            <div className="sm:col-span-3">
              <dt className="text-xs text-muted-foreground">Público</dt>
              <dd>{detail.audienceDescription}</dd>
            </div>
          </dl>
          {detail.status === "recusada" && detail.rejectionReason && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
              <span className="font-medium">Motivo da recusa: </span>
              {detail.rejectionReason}
            </p>
          )}
          {detail.lastError && detail.status !== "recusada" && (
            <p className="text-sm text-muted-foreground">{detail.lastError}</p>
          )}
          <CampaignContentPreview detail={detail} />
          {decidable && (
            <p className="text-xs text-muted-foreground">
              Ao aprovar, o público, os links e o teto do expert são conferidos de novo, e a
              contagem e o custo podem mudar.
            </p>
          )}
        </div>
      )}

      {decidable && mode === "reject" && (
        <div className="space-y-2 border-t border-border/60 pt-4">
          <Label htmlFor={reasonId}>Motivo da recusa</Label>
          <Textarea
            id={reasonId}
            value={reason}
            maxLength={REJECT_REASON_MAX}
            rows={3}
            autoFocus
            aria-describedby={reasonHelpId}
            aria-invalid={reasonTouched && !!reasonHint}
            onBlur={() => setReasonTouched(true)}
            onChange={(e) => onReasonChange(e.target.value)}
            placeholder="ex: o link do bônus está errado"
          />
          <p
            id={reasonHelpId}
            className={cn(
              "text-xs",
              reasonTouched && reasonHint ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {reasonTouched && reasonHint
              ? reasonHint
              : "Obrigatório. O expert vê este motivo e pode corrigir e reenviar."}
          </p>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <DialogFooter className="gap-2 sm:gap-2">
        {!decidable && (
          <Button variant="outline" onClick={onClose}>
            Fechar
          </Button>
        )}
        {decidable && mode === "review" && (
          <>
            <Button variant="outline" onClick={onClose} disabled={pending}>
              Cancelar
            </Button>
            <DemoDisabledTooltip active={disabled}>
              <Button
                variant="outline"
                className="text-destructive hover:text-destructive"
                disabled={disabled || pending}
                onClick={onStartReject}
              >
                Recusar
              </Button>
            </DemoDisabledTooltip>
            <DemoDisabledTooltip active={disabled}>
              <Button disabled={disabled || pending} onClick={onApprove}>
                {pending ? "Aprovando…" : "Aprovar"}
              </Button>
            </DemoDisabledTooltip>
          </>
        )}
        {decidable && mode === "reject" && (
          <>
            <Button variant="outline" onClick={onCancelReject} disabled={pending}>
              Voltar
            </Button>
            <Button
              variant="destructive"
              disabled={disabled || pending || !!reasonHint}
              onClick={onConfirmReject}
            >
              {pending ? "Recusando…" : "Recusar campanha"}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}

function useInvalidateExpertCampaigns() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: EXPERT_CAMPAIGNS_ADMIN_QUERY_KEY });
    qc.invalidateQueries({ queryKey: EXPERT_CAMPAIGN_DETAIL_ADMIN_QUERY_KEY });
    qc.invalidateQueries({ queryKey: EXPERT_USAGE_ADMIN_QUERY_KEY });
  };
}

export function ExpertCampaignReviewDialog({
  target,
  onClose,
}: {
  target: Target | null;
  onClose: () => void;
}) {
  const isDemo = useIsDemoTenant();
  const invalidate = useInvalidateExpertCampaigns();
  const detailFn = useServerFn(getExpertCampaignForAdmin);
  const approveFn = useServerFn(approveExpertCampaign);
  const rejectFn = useServerFn(rejectExpertCampaign);

  const [mode, setMode] = useState<ReviewMode>("review");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const targetKey = target ? `${target.channel}:${target.id}` : null;
  useEffect(() => {
    setMode("review");
    setReason("");
    setError(null);
  }, [targetKey]);

  const detailQuery = useQuery({
    queryKey: [...EXPERT_CAMPAIGN_DETAIL_ADMIN_QUERY_KEY, target?.channel, target?.id],
    queryFn: () => detailFn({ data: target! }),
    enabled: !!target,
  });
  const detail = detailQuery.data ?? null;

  const approve = useMutation({
    mutationFn: () =>
      approveFn({ data: { ...target!, expectedUpdatedAt: detail?.updatedAt ?? null } }),
    onSuccess: (result) => {
      toast.success(
        `Campanha aprovada: ${count(result.totalCount)} destinatários, custo estimado ${brl(result.estimatedCost)}.`,
      );
      invalidate();
      onClose();
    },
    onError: (err) => {
      setError(errorMessage(err));
      invalidate();
    },
  });

  const reject = useMutation({
    mutationFn: () => rejectFn({ data: { ...target!, reason: reason.trim() } }),
    onSuccess: () => {
      toast.success("Campanha recusada. O expert vê o motivo.");
      invalidate();
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{detail?.name || "Campanha do expert"}</DialogTitle>
          <DialogDescription>
            Confira o conteúdo, o público e o custo antes de decidir.
          </DialogDescription>
        </DialogHeader>
        <ExpertCampaignReviewBody
          detail={detail}
          loading={detailQuery.isLoading}
          loadError={detailQuery.isError ? errorMessage(detailQuery.error) : null}
          mode={mode}
          reason={reason}
          error={error}
          pending={approve.isPending || reject.isPending}
          disabled={isDemo}
          onReasonChange={setReason}
          onApprove={() => {
            setError(null);
            approve.mutate();
          }}
          onStartReject={() => {
            setError(null);
            setMode("reject");
          }}
          onCancelReject={() => {
            setError(null);
            setMode("review");
          }}
          onConfirmReject={() => {
            setError(null);
            reject.mutate();
          }}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}

// ─── Contêiner da fila ──────────────────────────────────────────────────────

/** Fila de campanhas: de um expert (`expertId`) ou só as pendentes da casa (`pendingOnly`). */
export function ExpertCampaignsQueue({
  expertId,
  pendingOnly = false,
  emptyText,
}: {
  expertId?: string;
  pendingOnly?: boolean;
  emptyText: string;
}) {
  const isDemo = useIsDemoTenant();
  const invalidate = useInvalidateExpertCampaigns();
  const pauseFn = useServerFn(pauseExpertCampaign);
  const resumeFn = useServerFn(resumeExpertCampaign);
  const [reviewing, setReviewing] = useState<Target | null>(null);

  const query = useExpertCampaignsAdmin({ expertId, pendingOnly });
  const items = query.data?.items ?? [];

  const pause = useMutation({
    mutationFn: (target: Target) => pauseFn({ data: target }),
    onSuccess: () => {
      toast.success("Campanha pausada.");
      invalidate();
    },
    onError: (err) => {
      toast.error(errorMessage(err));
      invalidate();
    },
  });
  const resume = useMutation({
    mutationFn: (target: Target) => resumeFn({ data: target }),
    onSuccess: () => {
      toast.success("Campanha retomada.");
      invalidate();
    },
    onError: (err) => {
      toast.error(errorMessage(err));
      invalidate();
    },
  });

  const busyId = pause.isPending
    ? (pause.variables?.id ?? null)
    : resume.isPending
      ? (resume.variables?.id ?? null)
      : null;

  if (query.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {errorMessage(query.error)}
      </p>
    );
  }

  return (
    <>
      <ExpertCampaignsTable
        items={items}
        showExpert={!expertId}
        emptyText={query.isLoading ? "Carregando…" : emptyText}
        disabled={isDemo}
        busyId={busyId}
        onReview={setReviewing}
        onPause={(t) => pause.mutate(t)}
        onResume={(t) => resume.mutate(t)}
      />
      <ExpertCampaignReviewDialog target={reviewing} onClose={() => setReviewing(null)} />
    </>
  );
}
