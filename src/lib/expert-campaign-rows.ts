// Área do Expert §8 — linhas do hub /campanhas a partir de
// `listExpertCampaigns`, e os filtros de status do expert (com "Pendentes").

import type { Campaign } from "@/components/campaigns/campaigns-hub";
import { isFinishedCampaignStatus, isPausedCampaignStatus } from "@/lib/channel-operation-state";

/** Same shape as `ExpertCampaignListItem` (expert-campaigns.server.ts). */
export type ExpertCampaignItem = {
  id: string;
  channel: "sms" | "email" | "voice";
  name: string;
  status: string;
  approvalStatus: "pendente" | "aprovada" | "recusada" | null;
  rejectionReason: string | null;
  lastError: string | null;
  scheduledAt: string | null;
  createdAt: string;
  updatedAt: string | null;
  totalCount: number;
  sentCount: number;
  failedCount: number;
  estimatedCost: number | null;
  batchInProgress?: boolean;
};

/** Statuses the expert may cancel (server: CANCELLABLE in expert-campaigns.server.ts). */
export const EXPERT_CANCELLABLE: Record<ExpertCampaignItem["channel"], readonly string[]> = {
  sms: ["aguardando_aprovacao", "recusada", "agendada", "pausada"],
  email: ["rascunho", "aguardando_aprovacao", "recusada", "agendada", "pausada"],
  voice: ["aguardando_aprovacao", "recusada", "enfileirada", "pausada"],
};

export function expertCampaignToRow(item: ExpertCampaignItem): Campaign {
  return {
    id: item.id,
    name: item.name,
    scheduled_at: item.scheduledAt ?? item.createdAt,
    date_is_creation: !item.scheduledAt,
    status: item.status,
    total_count: item.totalCount,
    sent_count: item.sentCount,
    failed_count: item.failedCount,
    // Voice: queued calls are the progress the expert list knows about.
    finished_count: item.channel === "voice" ? item.sentCount + item.failedCount : undefined,
    has_planned_total: item.totalCount > 0,
    last_error: item.lastError,
    updated_at: item.updatedAt,
    rejection_reason: item.rejectionReason,
    batch_in_progress: item.batchInProgress === true,
    channel: item.channel,
    cancellable: EXPERT_CANCELLABLE[item.channel].includes(item.status),
    resumable: false,
  };
}

export type ExpertStatusFilter =
  "todos" | "pendentes" | "agendadas" | "enviando" | "pausadas" | "finalizadas";

export const EXPERT_STATUS_FILTERS: ReadonlyArray<{ value: ExpertStatusFilter; label: string }> = [
  { value: "todos", label: "Todas" },
  { value: "pendentes", label: "Pendentes" },
  { value: "agendadas", label: "Agendadas" },
  { value: "enviando", label: "Enviando" },
  { value: "pausadas", label: "Pausadas" },
  { value: "finalizadas", label: "Finalizadas" },
];

export function matchesExpertStatus(filter: ExpertStatusFilter, status: string): boolean {
  if (filter === "todos") return true;
  if (filter === "pendentes") return status === "aguardando_aprovacao";
  if (filter === "agendadas") return ["agendada", "scheduled"].includes(status);
  if (filter === "enviando") return ["enviando", "enfileirada"].includes(status);
  if (filter === "pausadas") return isPausedCampaignStatus(status);
  return status === "recusada" || isFinishedCampaignStatus(status);
}

/** React Query key of `listExpertCampaigns`. */
export const EXPERT_CAMPAIGNS_QUERY_KEY = ["expert-campaigns"];
