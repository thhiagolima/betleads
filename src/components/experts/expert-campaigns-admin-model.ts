// Regras de exibição das campanhas de expert no lado do admin (fila de
// aprovação, status, ações possíveis e uso × teto). Puras, para os testes e
// para a tela não espalhar as regras de status pelos componentes. As ações
// espelham o que o servidor aceita (expert-campaigns.server.ts):
// aprovar/recusar só pendentes; pausar sms/e-mail agendada|enviando e voz
// enfileirada; retomar só pausada (e nunca uma recusada/pendente).
import type { ExpertCampaignListItem } from "@/lib/expert-campaigns.server";

export type AdminCampaign = Pick<
  ExpertCampaignListItem,
  "channel" | "status" | "approvalStatus" | "lastError" | "createdAt"
>;

export const CHANNEL_LABEL: Record<ExpertCampaignListItem["channel"], string> = {
  sms: "SMS",
  email: "E-mail",
  voice: "Voz",
};

/** Prefixo gravado pelos workers quando a reserva é recusada pelo teto. */
const CAP_PAUSE_PREFIX = "Teto mensal do expert atingido";

export function isPendingApproval(c: Pick<AdminCampaign, "status" | "approvalStatus">) {
  return c.status === "aguardando_aprovacao" && c.approvalStatus === "pendente";
}

export function isCapPause(c: Pick<AdminCampaign, "status" | "lastError">) {
  return c.status === "pausada" && (c.lastError ?? "").startsWith(CAP_PAUSE_PREFIX);
}

export type StatusTone = "warning" | "danger" | "info" | "success" | "muted";

const STATUS_LABEL: Record<string, { label: string; tone: StatusTone }> = {
  aguardando_aprovacao: { label: "Aguardando aprovação", tone: "warning" },
  recusada: { label: "Recusada", tone: "danger" },
  rascunho: { label: "Rascunho", tone: "muted" },
  agendada: { label: "Agendada", tone: "info" },
  enfileirada: { label: "Enfileirada", tone: "info" },
  enviando: { label: "Enviando", tone: "info" },
  enviado: { label: "Enviada", tone: "success" },
  concluida: { label: "Concluída", tone: "success" },
  falhou: { label: "Falhou", tone: "danger" },
  cancelada: { label: "Cancelada", tone: "muted" },
  pausada: { label: "Pausada", tone: "warning" },
};

export function campaignStatusInfo(c: AdminCampaign): { label: string; tone: StatusTone } {
  if (c.status === "pausada") {
    if (isCapPause(c)) return { label: "Pausada pelo teto", tone: "danger" };
    if ((c.lastError ?? "").startsWith("Pausada pelo admin"))
      return { label: "Pausada pelo admin", tone: "warning" };
  }
  return STATUS_LABEL[c.status] ?? { label: c.status, tone: "muted" };
}

export type CampaignAction = "review" | "pause" | "resume";

const PAUSABLE: Record<ExpertCampaignListItem["channel"], string[]> = {
  sms: ["agendada", "enviando"],
  email: ["agendada", "enviando"],
  voice: ["enfileirada"],
};

/** O que o admin pode fazer com a campanha agora. "review" abre Aprovar/Recusar. */
export function campaignActions(c: AdminCampaign): CampaignAction[] {
  if (isPendingApproval(c)) return ["review"];
  if (c.status === "pausada" && (c.approvalStatus == null || c.approvalStatus === "aprovada"))
    return ["resume"];
  if (PAUSABLE[c.channel].includes(c.status)) return ["pause"];
  return [];
}

/** Fila do admin: pendentes primeiro (a mais antiga primeiro), depois o resto (mais recente primeiro). */
export function sortApprovalQueue<T extends AdminCampaign>(items: readonly T[]): T[] {
  const pending = items
    .filter(isPendingApproval)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const rest = items
    .filter((c) => !isPendingApproval(c))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return [...pending, ...rest];
}

export const REJECT_REASON_MAX = 500;

/** Motivo da recusa: obrigatório (o expert vê esse texto). */
export function rejectReasonError(reason: string): string | null {
  const trimmed = reason.trim();
  if (!trimmed) return "Informe o motivo da recusa.";
  if (trimmed.length > REJECT_REASON_MAX) return `Use até ${REJECT_REASON_MAX} caracteres.`;
  return null;
}

export type UsageView = {
  /** 0–100, para a barra; null = sem teto (sem barra). */
  percent: number | null;
  tone: "ok" | "warning" | "danger" | "blocked" | "none";
  /** Situação curta: "Sem teto", "Envios bloqueados", "Teto atingido", "85% do teto". */
  status: string;
};

export function usageView(usage: { teto: number | null; usado: number }): UsageView {
  const { teto, usado } = usage;
  if (teto === null) return { percent: null, tone: "none", status: "Sem teto" };
  if (teto <= 0)
    return { percent: 100, tone: "blocked", status: "Envios bloqueados (teto R$ 0,00)" };
  const ratio = usado / teto;
  const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  if (ratio >= 1) return { percent: 100, tone: "danger", status: "Teto atingido" };
  return { percent, tone: ratio >= 0.8 ? "warning" : "ok", status: `${percent}% do teto` };
}
