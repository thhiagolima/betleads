import { EMAIL_CAMPAIGN_CHANNEL_DISABLED_REASON } from "@/lib/tenant-channels.shared";

export type ChannelOperation = "sms" | "email" | "voice" | "webpush";

export type ChannelOperationState = {
  label: string;
  description: string;
  nextAction: string;
  actionLabel: string;
  actionTo: string;
  tone: string;
};

const SETTINGS_DESTINATION: Record<ChannelOperation, string> = {
  sms: "/sms#configuracoes",
  email: "/email#smtp",
  voice: "/ligacoes#configuracoes",
  webpush: "/webhooks#webpush",
};

const HISTORY_DESTINATION: Record<ChannelOperation, string> = {
  sms: "/sms#historico",
  email: "/email#historico",
  voice: "/ligacoes#historico",
  webpush: "/campanhas",
};

/**
 * Raw, non-display codes that end up in `last_error`/`blocked_reason` mapped
 * to a readable sentence — today just the e-mail channel's, which (unlike
 * SMS's `SMS_CAMPAIGN_CHANNEL_DISABLED_MESSAGE`) is stored as the bare code
 * `EMAIL_CAMPAIGN_CHANNEL_DISABLED_REASON` instead of a full sentence. Single
 * point used by every screen that shows a campaign's stop/block reason
 * (house and expert).
 */
export function friendlyChannelReason<T extends string | null | undefined>(reason: T): T | string {
  if (reason === EMAIL_CAMPAIGN_CHANNEL_DISABLED_REASON) {
    return "Canal E-mail desabilitado para a casa.";
  }
  return reason;
}

/** Reason shown for a cancelled, failed or paused campaign (null for any other status). */
export function campaignStopReason(
  status: string | null | undefined,
  lastError: string | null | undefined,
  updatedAt: string | null | undefined,
): string | null {
  const normalized = (status ?? "").trim().toLowerCase();
  if (["cancelada", "cancelled", "canceled"].includes(normalized)) {
    if (lastError) return friendlyChannelReason(lastError);
    // Cancelled before the reason was recorded: only the time is known.
    return updatedAt
      ? `Cancelada manualmente em ${new Date(updatedAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })}.`
      : "Cancelada manualmente.";
  }
  if (["falhou", "failed", "error", "rejected", "pausada"].includes(normalized))
    return friendlyChannelReason(lastError) || null;
  return null;
}

const FINISHED_STATUSES = [
  "enviado",
  "sent",
  "delivered",
  "concluida",
  "concluída",
  "completed",
  "answered",
  "falhou",
  "failed",
  "error",
  "rejected",
  "cancelada",
  "cancelled",
  "canceled",
];

/**
 * True when the campaign will not send anything else (finished, failed or
 * cancelled). A paused campaign can still resume, so it is not finished.
 */
export function isFinishedCampaignStatus(status: string | null | undefined): boolean {
  return FINISHED_STATUSES.includes((status ?? "").trim().toLowerCase());
}

const PAUSED_STATUSES = ["pausada", "paused", "paused_limit"];

/** True for a paused campaign (SMS/e-mail "pausada", voice "paused"/"paused_limit"). */
export function isPausedCampaignStatus(status: string | null | undefined): boolean {
  return PAUSED_STATUSES.includes((status ?? "").trim().toLowerCase());
}

/** Prefix of every "monthly cap reached" pause reason (wallet, SMS, e-mail, voice). */
export const EXPERT_CAP_PAUSE_PREFIX = "Teto mensal do expert atingido";

/** Extra context some statuses need to be told apart. */
export type ChannelOperationContext = {
  /** Why the campaign stopped (`last_error` / `blocked_reason`). */
  lastError?: string | null;
  /** E-mail: a batched send is between two batches (`stats.lote_em_andamento`). */
  batchInProgress?: boolean;
};

/** True when the pause/stop reason is the expert's monthly cap. */
export function isExpertCapReason(reason: string | null | undefined): boolean {
  return (reason ?? "").trim().startsWith(EXPERT_CAP_PAUSE_PREFIX);
}

export function getChannelOperationState(
  status: string | null | undefined,
  channel: ChannelOperation,
  context: ChannelOperationContext = {},
): ChannelOperationState {
  const normalized = (status ?? "").trim().toLowerCase();

  if (normalized === "aguardando_aprovacao") {
    return {
      label: "Aguardando aprovação",
      description: "A campanha foi enviada ao admin da casa e só sai depois de aprovada.",
      nextAction: "Aguarde a aprovação; o agendamento vale a partir dela.",
      actionLabel: "Ver campanhas",
      actionTo: "/campanhas",
      tone: "border-info/30 bg-info/10 text-info",
    };
  }

  if (normalized === "recusada") {
    return {
      label: "Recusada",
      description: "O admin da casa recusou a campanha; nada foi enviado.",
      nextAction: "Veja o motivo da recusa e crie uma nova campanha.",
      actionLabel: "Ver campanhas",
      actionTo: "/campanhas",
      tone: "border-danger/30 bg-danger/10 text-danger",
    };
  }

  if (
    ["paused", "pausada", "paused_limit"].includes(normalized) &&
    isExpertCapReason(context.lastError)
  ) {
    return {
      label: "Pausada pelo teto",
      description: "O teto mensal de envios do expert foi atingido durante o envio.",
      nextAction: "O envio volta quando o mês virar ou o admin aumentar o teto.",
      actionLabel: "Ver campanhas",
      actionTo: "/campanhas",
      tone: "border-warning/30 bg-warning/10 text-warning",
    };
  }

  if (
    channel === "email" &&
    context.batchInProgress &&
    ["agendada", "enviando"].includes(normalized)
  ) {
    return {
      label: "Enviando em lotes",
      description: "A campanha é enviada em lotes; o próximo lote sai automaticamente.",
      nextAction: "Acompanhe os envios no relatório da campanha.",
      actionLabel: "Ver histórico",
      actionTo: HISTORY_DESTINATION[channel],
      tone: "border-info/30 bg-info/10 text-info",
    };
  }

  if (["rascunho", "draft"].includes(normalized)) {
    return {
      label: "Rascunho",
      description: "A campanha ainda não foi agendada nem enviada.",
      nextAction: "Termine a edição e agende o envio.",
      actionLabel: "Ver campanhas",
      actionTo: "/campanhas",
      tone: "border-border bg-muted/40 text-muted-foreground",
    };
  }

  if (["agendada", "scheduled"].includes(normalized)) {
    return {
      label: "Agendada",
      description: "A campanha está revisada e aguarda o horário definido.",
      nextAction: "Confira o horário e acompanhe o disparo.",
      actionLabel: "Ver campanhas",
      actionTo: "/campanhas",
      tone: "border-info/30 bg-info/10 text-info",
    };
  }

  if (["pending", "queued", "pending_audio", "audio_ready"].includes(normalized)) {
    return {
      label: "Aguardando provedor",
      description: "O conteúdo está na fila e depende da disponibilidade operacional do canal.",
      nextAction: "Verifique a configuração e o status do provedor.",
      actionLabel: "Ver configurações",
      actionTo: SETTINGS_DESTINATION[channel],
      tone: "border-warning/30 bg-warning/10 text-warning",
    };
  }

  if (["retry", "retrying", "retry_scheduled", "rate_limited"].includes(normalized)) {
    return {
      label: "Tentando de novo",
      description: "Uma tentativa anterior não foi concluída e o sistema tentará novamente.",
      nextAction: "Acompanhe a fila; revise o provedor se a retentativa falhar.",
      actionLabel: "Ver histórico",
      actionTo: HISTORY_DESTINATION[channel],
      tone: "border-info/30 bg-info/10 text-info",
    };
  }

  if (
    ["paused", "pausada", "paused_limit", "limit_reached", "quota_exceeded"].includes(normalized)
  ) {
    return {
      label: channel === "voice" ? "Pausada por limite" : "Pausada",
      description:
        channel === "voice"
          ? "As ligações respeitam o intervalo entre contatos e o limite de ligações por jogador em 24 horas."
          : "O envio foi interrompido para respeitar um limite de saldo, volume ou janela.",
      nextAction:
        channel === "voice"
          ? "A ligação sai quando o limite de contato permitir."
          : "Revise os limites do canal antes de retomar.",
      actionLabel: channel === "sms" || channel === "webpush" ? "Ver saldo" : "Ver configurações",
      actionTo:
        channel === "sms" || channel === "webpush"
          ? "/plano-e-creditos"
          : SETTINGS_DESTINATION[channel],
      tone: "border-warning/30 bg-warning/10 text-warning",
    };
  }

  if (["cancelled", "canceled", "cancelada"].includes(normalized)) {
    return {
      label: "Cancelada",
      description: "A campanha foi cancelada antes do envio; nenhuma mensagem saiu.",
      nextAction: "Para enviar, crie ou agende uma nova campanha.",
      actionLabel: "Ver campanhas",
      actionTo: "/campanhas",
      tone: "border-border bg-muted/40 text-muted-foreground",
    };
  }

  if (["failed", "falhou", "error", "rejected"].includes(normalized)) {
    return {
      label: "Falhou",
      description: "O envio não foi concluído e precisa de revisão antes de uma nova tentativa.",
      nextAction: "Revise destinatários, conteúdo e configuração do canal.",
      actionLabel: "Abrir histórico",
      actionTo: HISTORY_DESTINATION[channel],
      tone: "border-danger/30 bg-danger/10 text-danger",
    };
  }

  if (
    [
      "enviando",
      "running",
      "processing",
      "dispatched",
      "in_progress",
      "waiting_provider",
      // Expert voice campaign: approved, its calls are in the queue.
      "enfileirada",
    ].includes(normalized)
  ) {
    return {
      label: "Enviando",
      description: "O provedor está processando os destinatários desta campanha.",
      nextAction: "Acompanhe os envios no relatório da campanha.",
      actionLabel: "Ver histórico",
      actionTo: HISTORY_DESTINATION[channel],
      tone: "border-info/30 bg-info/10 text-info",
    };
  }

  if (
    ["enviado", "sent", "delivered", "concluida", "concluída", "completed", "answered"].includes(
      normalized,
    )
  ) {
    return {
      label: "Concluída",
      description: "O processamento da campanha foi finalizado.",
      nextAction: "Consulte os resultados e as falhas no histórico.",
      actionLabel: "Ver histórico",
      actionTo: HISTORY_DESTINATION[channel],
      tone: "border-success/30 bg-success/10 text-success",
    };
  }

  return {
    label: "Status desconhecido",
    description: "O estado recebido não pôde ser classificado automaticamente.",
    nextAction: "Atualize a lista ou consulte o histórico do canal.",
    actionLabel: "Ver histórico",
    actionTo: HISTORY_DESTINATION[channel],
    tone: "border-border text-muted-foreground",
  };
}

/** One `call_queue` item as returned by `listCallQueue`. Optional fields are used when present. */
export type VoiceQueueItem = {
  id: string;
  status?: string | null;
  provider_status?: string | null;
  scheduled_at?: string | null;
  created_at?: string | null;
  audio_url?: string | null;
  /** Bulk voice dispatch stores the campaign name here. */
  trigger_name?: string | null;
  script_id?: string | null;
  voice_asset_id?: string | null;
  /** Campaign entity (`voice_campaigns`); null for items created before it existed. */
  voice_campaign_id?: string | null;
};

export type VoiceCampaignGroup = {
  /** Id of the earliest queue item of the group (stable while that item is listed). */
  id: string;
  itemIds: string[];
  name: string;
  scheduledAt: string;
  status: string;
  total: number;
  /** Handed to the provider (calling, waiting for the provider or finished). */
  sent: number;
  /** Calls the provider finished (completed or answered). */
  completed: number;
  failed: number;
  cancelled: number;
  /** Items that will not change any more (completed, failed or cancelled). */
  finished: number;
};

/**
 * Items of the same bulk dispatch are created one after the other; a gap longer
 * than this between two consecutive items starts a new campaign.
 */
export const VOICE_BATCH_GAP_MS = 2 * 60_000;

const VOICE_SENT = ["dispatched", "sent", "calling", "waiting_provider", "completed", "answered"];
const VOICE_COMPLETED = ["completed", "answered"];
const VOICE_FAILED = ["failed", "error"];
const VOICE_CANCELLED = ["cancelled", "canceled"];
const VOICE_PAUSED = ["paused", "paused_limit"];

/**
 * Display status of a queue item from its stored status, provider status and
 * whether its time (scheduled_at, else created_at) is still ahead. Shared by
 * the row-based and the count-based summaries so both label alike.
 */
function voiceDisplayStatus(
  status: string | null | undefined,
  providerStatus: string | null | undefined,
  isFuture: boolean,
): string {
  const value = status ?? "pending_audio";
  if (value !== "audio_ready") return value;
  // `audio_ready` means the audio is prepared; it may only be waiting for the
  // chosen time or for the contact policy, not for the provider.
  if (["rolling_24h_limit", "cooldown"].includes(providerStatus ?? "")) return "paused_limit";
  return isFuture ? "agendada" : value;
}

function voiceItemStatus(item: VoiceQueueItem, now: number): string {
  const at = new Date(item.scheduled_at ?? item.created_at ?? 0).getTime();
  return voiceDisplayStatus(item.status, item.provider_status, at > now);
}

function voiceItemTime(item: VoiceQueueItem): number {
  const at = new Date(item.scheduled_at ?? item.created_at ?? 0).getTime();
  return Number.isFinite(at) ? at : 0;
}

/**
 * Groups `call_queue` items into campaigns. The queue has no campaign id, so a
 * campaign is a run of items with the same content (campaign name, script or
 * audio when known, audio URL otherwise) whose times are at most
 * `VOICE_BATCH_GAP_MS` apart.
 */
export function groupVoiceQueueItems(
  items: VoiceQueueItem[],
  now: number = Date.now(),
): VoiceCampaignGroup[] {
  const sorted = [...items].sort((a, b) => voiceItemTime(a) - voiceItemTime(b));
  const open = new Map<string, { group: VoiceCampaignGroup; lastAt: number }>();
  const groups: VoiceCampaignGroup[] = [];
  const statuses = new Map<VoiceCampaignGroup, Map<string, number>>();

  for (const item of sorted) {
    const at = voiceItemTime(item);
    const key = [
      item.trigger_name ?? "",
      item.script_id ?? "",
      item.voice_asset_id ?? "",
      item.audio_url ?? "",
    ].join("|");
    const current = open.get(key);
    let group: VoiceCampaignGroup;
    if (current && at - current.lastAt <= VOICE_BATCH_GAP_MS) {
      group = current.group;
    } else {
      group = emptyVoiceGroup(item.id, item.trigger_name?.trim() || "", new Date(at).toISOString());
      groups.push(group);
      statuses.set(group, new Map());
    }
    open.set(key, { group, lastAt: at });
    addVoiceItem(group, statuses.get(group)!, item, now);
  }

  for (const group of groups) finishVoiceGroup(group, statuses.get(group) ?? new Map());

  return groups;
}

function emptyVoiceGroup(id: string, name: string, scheduledAt: string): VoiceCampaignGroup {
  return {
    id,
    itemIds: [],
    name,
    scheduledAt,
    status: "",
    total: 0,
    sent: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    finished: 0,
  };
}

/** Adds `count` items of one display status to a group's counters. */
function addVoiceStatusCount(
  group: VoiceCampaignGroup,
  statuses: Map<string, number>,
  status: string,
  count: number,
) {
  group.total += count;
  if (VOICE_SENT.includes(status)) group.sent += count;
  if (VOICE_COMPLETED.includes(status)) group.completed += count;
  if (VOICE_FAILED.includes(status)) group.failed += count;
  if (VOICE_CANCELLED.includes(status)) group.cancelled += count;
  statuses.set(status, (statuses.get(status) ?? 0) + count);
}

function addVoiceItem(
  group: VoiceCampaignGroup,
  statuses: Map<string, number>,
  item: VoiceQueueItem,
  now: number,
) {
  group.itemIds.push(item.id);
  addVoiceStatusCount(group, statuses, voiceItemStatus(item, now), 1);
}

/** Fills the derived fields (finished, fallback name, status) of a group. */
function finishVoiceGroup(group: VoiceCampaignGroup, statuses: Map<string, number>) {
  group.finished = group.completed + group.failed + group.cancelled;
  if (!group.name) group.name = group.total > 1 ? "Campanha de voz" : "Ligação por voz";
  const present = [...statuses.entries()]
    .filter(([, count]) => count > 0)
    .map(([status]) => status);
  const pending = present.filter(
    (status) => ![...VOICE_COMPLETED, ...VOICE_FAILED, ...VOICE_CANCELLED].includes(status),
  );
  const active = pending.filter(
    (status) => status !== "agendada" && !VOICE_PAUSED.includes(status),
  );
  if (active.length > 0) {
    // Prepared calls that are past their time wait for the provider.
    group.status = active.every((status) => status === "audio_ready") ? "audio_ready" : "enviando";
  } else if (pending.some((status) => VOICE_PAUSED.includes(status))) {
    group.status = "paused_limit";
  } else if (pending.length > 0) {
    group.status = "agendada";
  } else if (group.completed > 0) {
    group.status = "concluida";
  } else if (group.failed > 0) {
    group.status = "falhou";
  } else {
    group.status = "cancelada";
  }
}

/** One `voice_campaigns` row, as the campaigns hub needs it. */
export type VoiceCampaignRecord = {
  id: string;
  name: string | null;
  status: string | null;
  scheduled_at: string | null;
  created_at: string | null;
  recipient_count?: number | null;
};

/** Status label of a `voice_campaigns` row with no queue item listed (same labels as a group). */
const VOICE_CAMPAIGN_STATUS_LABEL: Record<string, string> = {
  draft: "agendada",
  scheduled: "agendada",
  sending: "enviando",
  paused: "paused_limit",
  cancelled: "cancelada",
  finished: "concluida",
};

/**
 * A `sending` campaign with no queue item after this long is a "Disparar
 * agora" that inserted nothing (the request died or every insert failed): the
 * hub shows it cancelled instead of "enviando" forever.
 */
export const VOICE_EMPTY_SENDING_STALE_MS = 10 * 60_000;

/**
 * One row of `public.voice_campaign_item_counts`: the queue items of a
 * campaign grouped by (status, provider_status, time still ahead).
 * `sample_item_id` is the item id when the group has exactly one item.
 */
export type VoiceItemCount = {
  voice_campaign_id?: string | null;
  status: string | null;
  provider_status: string | null;
  is_future: boolean | null;
  item_count: number | string;
  sample_item_id?: string | null;
};

type VoiceCampaignSummary = VoiceCampaignGroup & { campaignStatus: string; isCampaign: true };

function emptyCampaignGroup(campaign: VoiceCampaignRecord): VoiceCampaignGroup {
  const at = campaign.scheduled_at ?? campaign.created_at ?? new Date(0).toISOString();
  return emptyVoiceGroup(campaign.id, campaign.name?.trim() || "", new Date(at).toISOString());
}

/** Derived fields shared by the row-based and the count-based summaries. */
function finishVoiceCampaign(
  campaign: VoiceCampaignRecord,
  group: VoiceCampaignGroup,
  statuses: Map<string, number>,
  now: number,
): VoiceCampaignSummary {
  finishVoiceGroup(group, statuses);
  let stored = campaign.status ?? "scheduled";
  if (group.total === 0) {
    const createdAt = new Date(campaign.created_at ?? "").getTime();
    if (
      stored === "sending" &&
      Number.isFinite(createdAt) &&
      now - createdAt > VOICE_EMPTY_SENDING_STALE_MS
    ) {
      stored = "cancelled";
    }
    group.status = VOICE_CAMPAIGN_STATUS_LABEL[stored] ?? "agendada";
    if (!campaign.name?.trim()) {
      group.name =
        Number(campaign.recipient_count ?? 0) > 1 ? "Campanha de voz" : "Ligação por voz";
    }
  }
  const pending = group.total - group.finished;
  const campaignStatus =
    stored !== "cancelled" && group.total > 0 && pending === 0 ? "finished" : stored;
  return { ...group, campaignStatus, isCampaign: true };
}

/**
 * Summarizes a campaign entity from its queue items. Counts and status come from
 * the items exactly like a grouped (legacy) campaign, so both look the same in
 * the hub; the campaign row only supplies id, name, time and, with no item, the
 * status. `campaignStatus` is the entity status with `finished` derived when no
 * item is pending any more (a cancelled campaign stays cancelled).
 */
export function summarizeVoiceCampaign(
  campaign: VoiceCampaignRecord,
  items: VoiceQueueItem[],
  now: number = Date.now(),
): VoiceCampaignSummary {
  const group = emptyCampaignGroup(campaign);
  const statuses = new Map<string, number>();
  for (const item of items) addVoiceItem(group, statuses, item, now);
  return finishVoiceCampaign(campaign, group, statuses, now);
}

/**
 * Same summary as `summarizeVoiceCampaign`, from the grouped counts the
 * database aggregates (`voice_campaign_item_counts`) instead of every item.
 * `itemIds` holds the only item of a one-call campaign (its report link) and
 * is empty otherwise.
 */
export function summarizeVoiceCampaignCounts(
  campaign: VoiceCampaignRecord,
  counts: VoiceItemCount[],
  now: number = Date.now(),
): VoiceCampaignSummary {
  const group = emptyCampaignGroup(campaign);
  const statuses = new Map<string, number>();
  const samples: string[] = [];
  for (const row of counts) {
    const count = Number(row.item_count);
    if (!Number.isFinite(count) || count <= 0) continue;
    const status = voiceDisplayStatus(row.status, row.provider_status, row.is_future === true);
    addVoiceStatusCount(group, statuses, status, count);
    if (count === 1 && row.sample_item_id) samples.push(String(row.sample_item_id));
  }
  group.itemIds = group.total === 1 ? samples.slice(0, 1) : [];
  return finishVoiceCampaign(campaign, group, statuses, now);
}

/**
 * Audience id passed in `/campanhas?newCampaign=1&audience=…` (Públicos, Níveis).
 * Accepts system audiences (`system:…`) and saved ones (uuid); anything else is
 * dropped so a malformed link opens the composer without a preselected audience.
 */
export function audienceFromSearch(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (!value || value.length > 120) return "";
  if (/^system:[a-z0-9:_-]+$/i.test(value)) return value;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value;
  return "";
}
