// Regra única de situação do jogador (Ativo / Esfriando / Dormindo / Sem depósito).
// A lista de Jogadores e a ficha usam esta função com os dias configurados em
// gamification_settings (cooling_after_days / sleeping_after_days); é a mesma regra
// do snapshot de gamificação (enrichPlayer). Conta os dias desde o último depósito
// ou, quando não há, desde o primeiro depósito (FTD).

export type PlayerSituation = "active" | "cooling" | "sleeping" | "no_deposit";

export type SituationSettings = {
  coolingAfterDays: number;
  sleepingAfterDays: number;
};

export const DEFAULT_SITUATION_SETTINGS: SituationSettings = {
  coolingAfterDays: 2,
  sleepingAfterDays: 7,
};

export const SITUATION_LABEL: Record<PlayerSituation, string> = {
  active: "Ativo",
  cooling: "Esfriando",
  sleeping: "Dormindo",
  no_deposit: "Sem depósito",
};

export type SituationInput = {
  total_depositado?: number | string | null;
  ftd_em?: string | null;
  ultimo_deposito?: string | null;
};

const DAY_MS = 86_400_000;

/** Dias inteiros desde o último depósito (ou FTD). `null` quando não há data válida. */
export function daysWithoutDeposit(player: SituationInput, now: number = Date.now()) {
  const value = player.ultimo_deposito ?? player.ftd_em;
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((now - timestamp) / DAY_MS));
}

export function playerSituation(
  player: SituationInput,
  settings: SituationSettings = DEFAULT_SITUATION_SETTINGS,
  now: number = Date.now(),
): PlayerSituation {
  const total = Number(player.total_depositado ?? 0);
  if (!player.ftd_em && total <= 0) return "no_deposit";
  const days = daysWithoutDeposit(player, now);
  if (days == null) return "no_deposit";
  if (days >= settings.sleepingAfterDays) return "sleeping";
  if (days >= settings.coolingAfterDays) return "cooling";
  return "active";
}

/** Lê os dias de gamification_settings com os padrões do snapshot. */
export function situationSettingsFromRow(raw: unknown): SituationSettings {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = (value: unknown, fallback: number) => {
    const n = Number(value);
    return value != null && Number.isFinite(n) ? Math.trunc(n) : fallback;
  };
  return {
    coolingAfterDays: pick(row.cooling_after_days, DEFAULT_SITUATION_SETTINGS.coolingAfterDays),
    sleepingAfterDays: pick(row.sleeping_after_days, DEFAULT_SITUATION_SETTINGS.sleepingAfterDays),
  };
}
