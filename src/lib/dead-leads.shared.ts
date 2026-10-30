/**
 * "Leads mortos" (dead leads): per-house opt-in rule. After N consecutive
 * journey messages (SMS, e-mail or voice) with no action in the house, the
 * lead leaves every journey and joins the system audience below. Pure helpers
 * shared by the server functions and the Automações hub.
 */

export { DEAD_LEADS_SYSTEM_AUDIENCE_ID as DEAD_LEADS_AUDIENCE_ID } from "@/lib/sms-audience-criteria";
export const DEAD_LEADS_AUDIENCE_LABEL = "Leads mortos";

export const DEAD_LEAD_THRESHOLD_DEFAULT = 5;
export const DEAD_LEAD_THRESHOLD_MIN = 2;
export const DEAD_LEAD_THRESHOLD_MAX = 50;

/** Backfill: the UI calls the RPC repeatedly while `remaining` is true, up to this many rounds. */
export const DEAD_LEAD_BACKFILL_MAX_ROUNDS = 50;

export const DEAD_LEAD_RULE_TEXT =
  "Após N mensagens seguidas de jornada (SMS, e-mail ou voz) sem nenhuma ação na casa — depósito, PIX gerado, saque, login, jogo ou clique — o lead sai de todas as jornadas e vai para o público Leads mortos. Se voltar a agir, é reativado automaticamente.";

export type DeadLeadStatus = "dead" | "revived";

const ACTION_LABELS: Record<string, string> = {
  deposito: "Depósito",
  ftd: "1º depósito",
  login: "Login",
  jogo: "Jogo",
  clique: "Clique em link",
  pix_gerado: "PIX gerado",
  saque: "Saque",
};

/** Last action type in Portuguese; `null` means the lead never acted. */
export function deadLeadActionLabel(type: string | null | undefined): string {
  if (!type) return "Nunca agiu";
  return ACTION_LABELS[type] ?? type;
}

const REVIVED_REASON_LABELS: Record<string, string> = {
  activity: "voltou a agir",
  manual: "reativado manualmente",
};

export function deadLeadRevivedReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return REVIVED_REASON_LABELS[reason] ?? reason;
}

/**
 * Threshold typed in the settings dialog. Blank falls back to the default;
 * anything that is not an integer in range returns `null` (invalid).
 */
export function parseDeadLeadThreshold(raw: string): number | null {
  const clean = raw.trim();
  if (!clean) return DEAD_LEAD_THRESHOLD_DEFAULT;
  if (!/^\d+$/.test(clean)) return null;
  const value = Number(clean);
  if (value < DEAD_LEAD_THRESHOLD_MIN || value > DEAD_LEAD_THRESHOLD_MAX) return null;
  return value;
}

export type DeadLeadBackfillResult = { evaluated: number; marked: number; remaining: boolean };

/** Normalizes the `backfill_dead_leads` jsonb (numbers may come back as strings). */
export function normalizeBackfillResult(value: unknown): DeadLeadBackfillResult {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const num = (input: unknown) => {
    const parsed = Number(input ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    evaluated: num(raw.evaluated),
    marked: num(raw.marked),
    remaining: raw.remaining === true || raw.remaining === "true",
  };
}

export type DeadLeadBackfillProgress = { rounds: number; evaluated: number; marked: number };

/**
 * Runs the backfill RPC in rounds until it reports nothing remaining, the
 * round cap is hit, or a round marks nobody (guards against a loop). Every
 * round re-scores the whole candidate pool, so `evaluated` is the latest
 * round's count while `marked` accumulates.
 */
export async function runBackfillRounds(
  step: () => Promise<DeadLeadBackfillResult>,
  onProgress?: (progress: DeadLeadBackfillProgress) => void,
  maxRounds = DEAD_LEAD_BACKFILL_MAX_ROUNDS,
): Promise<DeadLeadBackfillProgress & { complete: boolean }> {
  const progress: DeadLeadBackfillProgress = { rounds: 0, evaluated: 0, marked: 0 };
  while (progress.rounds < maxRounds) {
    const result = await step();
    progress.rounds += 1;
    progress.evaluated = result.evaluated;
    progress.marked += result.marked;
    onProgress?.({ ...progress });
    if (!result.remaining || result.marked === 0)
      return { ...progress, complete: !result.remaining };
  }
  return { ...progress, complete: false };
}

/** PostgREST `or()` needs commas/parentheses removed from user input. */
export function sanitizeDeadLeadSearch(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/[\\%,()*]/g, " ")
    .trim()
    .slice(0, 80);
}

/** UI masking for e-mails: first letter and domain only ("j•••@gmail.com"). */
export function maskDeadLeadEmail(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const at = raw.indexOf("@");
  if (at <= 0) return "•••";
  return `${raw[0]}•••${raw.slice(at)}`;
}
