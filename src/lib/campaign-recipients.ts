// ENV-06/ENV-07 — campaign recipient resolution and throughput primitives.
// Pure and client-safe: used by the SMS campaign worker, the server functions
// that create campaigns, the composer preview and the campaign report.
import { normalizeBrazilianPhone } from "./phone-normalization";

/** Why a campaign recipient will not receive the message. */
export type UnresolvedReason =
  "sem_cadastro" | "telefone_invalido" | "sem_consentimento" | "grupo_controle" | "ja_jogador";

export const UNRESOLVED_REASONS: readonly UnresolvedReason[] = [
  "sem_cadastro",
  "telefone_invalido",
  "sem_consentimento",
  "grupo_controle",
  "ja_jogador",
] as const;

export const UNRESOLVED_REASON_LABEL: Record<UnresolvedReason, string> = {
  sem_cadastro: "Sem cadastro",
  telefone_invalido: "Telefone inválido",
  sem_consentimento: "Sem consentimento",
  grupo_controle: "Grupo de controle",
  ja_jogador: "Já é jogador",
};

export const UNRESOLVED_REASON_HINT: Record<UnresolvedReason, string> = {
  sem_cadastro: "O telefone não corresponde a nenhum jogador cadastrado nesta operação.",
  telefone_invalido: "O número não é um celular ou fixo brasileiro válido (DDD + número).",
  sem_consentimento: "O destinatário revogou o consentimento para SMS.",
  grupo_controle:
    "O jogador está no grupo de controle de uma jornada e não recebe campanhas em massa enquanto o teste estiver aberto.",
  ja_jogador:
    "O número já pertence a um jogador desta casa. Campanhas para lista de números só vão para quem ainda não se cadastrou.",
};

export type UnresolvedRecipient = { phone: string; reason: UnresolvedReason };
export type ResolvedRecipient = { phone: string; playerId: string };

export type RecipientAssignment =
  | { phone: string; playerId: string; reason: null }
  | { phone: string; playerId: null; reason: UnresolvedReason };

export type RecipientResolution = {
  resolved: ResolvedRecipient[];
  unresolved: UnresolvedRecipient[];
  /** Inputs dropped because the same player (or phone) was already in the list. */
  duplicates: number;
  /** One entry per input, same order, before duplicate removal (used by the worker). */
  assignments: RecipientAssignment[];
};

export function isUnresolvedReason(value: unknown): value is UnresolvedReason {
  return typeof value === "string" && (UNRESOLVED_REASONS as readonly string[]).includes(value);
}

/** Parses the persisted `sms_campaigns.unresolved_recipients` JSON defensively. */
export function parseUnresolvedRecipients(raw: unknown): UnresolvedRecipient[] {
  if (!Array.isArray(raw)) return [];
  const out: UnresolvedRecipient[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const phone = (item as { phone?: unknown }).phone;
    const reason = (item as { reason?: unknown }).reason;
    if (typeof phone === "string" && isUnresolvedReason(reason)) out.push({ phone, reason });
  }
  return out;
}

export function countUnresolvedByReason(
  unresolved: ReadonlyArray<{ reason: UnresolvedReason }>,
): Record<UnresolvedReason, number> {
  const counts: Record<UnresolvedReason, number> = {
    sem_cadastro: 0,
    telefone_invalido: 0,
    sem_consentimento: 0,
    grupo_controle: 0,
    ja_jogador: 0,
  };
  for (const item of unresolved) counts[item.reason] += 1;
  return counts;
}

/** "3 sem cadastro, 1 telefone inválido" (only non-zero reasons). */
export function describeUnresolvedCounts(counts: Record<UnresolvedReason, number>): string {
  return UNRESOLVED_REASONS.filter((reason) => counts[reason] > 0)
    .map((reason) => `${counts[reason]} ${UNRESOLVED_REASON_LABEL[reason].toLowerCase()}`)
    .join(", ");
}

/** Error shown when a campaign would have no recipient at all (the only blocking case). */
export function noRecipientResolvedMessage(
  unresolved: ReadonlyArray<{ reason: UnresolvedReason }>,
) {
  const detail = describeUnresolvedCounts(countUnresolvedByReason(unresolved));
  return `Nenhum destinatário corresponde a um jogador cadastrado desta operação${detail ? ` (${detail})` : ""}. A campanha não foi criada.`;
}

/** UI masking: every digit hidden except the last four ("•••• •••• 4321"). */
export function maskPhone(raw: string | null | undefined): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return "—";
  if (digits.length <= 4) return `•••${digits}`;
  return `${"•".repeat(Math.min(digits.length - 4, 9))}${digits.slice(-4)}`;
}

const csvCell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;

/** CSV for the tenant's own users (full phone; masked only in the UI). */
export function buildUnresolvedRecipientsCsv(unresolved: ReadonlyArray<UnresolvedRecipient>) {
  return [
    "telefone,motivo,descricao",
    ...unresolved.map((row) =>
      [row.phone, row.reason, UNRESOLVED_REASON_LABEL[row.reason]].map(csvCell).join(","),
    ),
  ].join("\n");
}

/** Canonical phone used to match `players.telefone` (normalized by trigger). */
export function campaignPhoneKey(raw: string | null | undefined): string | null {
  return normalizeBrazilianPhone(raw);
}

/** Subject format used by `channel_consents` for SMS ("55" + DDD + number). */
export function smsConsentSubject(e164: string): string {
  return e164.replace(/\D/g, "");
}

// ------------------------------------------------------------------
// Throughput (ENV-07)
// ------------------------------------------------------------------

/**
 * Real cadence of the worker: pg_cron job `betleads-dispatch-sms` is scheduled
 * with `* * * * *` (supabase/migrations/20261003143000_enable_validated_automation_crons.sql),
 * i.e. ONE run per minute. The old code assumed 12 runs/minute (5 s ticks).
 */
export const SMS_CAMPAIGN_TICK_SECONDS = 60;
/** Wall-clock budget of one run; the remaining minute is slack for flows and overlap. */
export const SMS_CAMPAIGN_RUN_BUDGET_MS = 45_000;
/** Hard cap per campaign per tick (matches the max `ratePerMinute` accepted by the API). */
export const SMS_CAMPAIGN_MAX_PER_TICK = 5_000;
export const SMS_CAMPAIGN_DEFAULT_RATE = 1_000;

/** Sends one campaign may perform in one tick so `rate_per_minute` is actually achieved. */
export function campaignTickQuota(
  ratePerMinute: number | null | undefined,
  tickSeconds: number = SMS_CAMPAIGN_TICK_SECONDS,
): number {
  const rate = Math.max(1, Math.floor(Number(ratePerMinute) || SMS_CAMPAIGN_DEFAULT_RATE));
  const perTick = Math.floor((rate * Math.max(1, tickSeconds)) / 60);
  return Math.min(SMS_CAMPAIGN_MAX_PER_TICK, Math.max(1, perTick));
}

/** Parallel provider calls for a campaign rate (unchanged from the previous worker). */
export function campaignConcurrency(ratePerMinute: number): number {
  if (ratePerMinute >= 4000) return 80;
  if (ratePerMinute >= 2500) return 60;
  if (ratePerMinute >= 1000) return 25;
  if (ratePerMinute >= 300) return 10;
  return 5;
}

/**
 * Recipients processed between two cursor checkpoints. The cursor is persisted
 * after every batch, so a crash re-processes at most one batch, and those
 * re-sends are absorbed by the per-recipient delivery key.
 */
export function campaignBatchSize(concurrency: number, remainingQuota: number): number {
  return Math.max(1, Math.min(remainingQuota, Math.max(100, concurrency * 4), 250));
}

/**
 * Deterministic, UUID-shaped delivery key for (campaign, player). Passed to
 * sendSmsInternal: a second attempt for the same recipient finds the accepted
 * log and never reaches the provider or billing again.
 */
export async function campaignDeliveryKey(campaignId: string, playerId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`sms-campaign|${campaignId}|${playerId}`),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  // Version nibble 5 / RFC 4122 variant: name-based, stable and valid as a UUID.
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
