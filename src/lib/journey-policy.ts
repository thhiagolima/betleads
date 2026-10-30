export type ReentryMode = "once" | "never" | "per_occurrence" | "after_cooldown";

const BRT = "America/Sao_Paulo";

function brtParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BRT,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((all, part) => {
      all[part.type] = part.value;
      return all;
    }, {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday),
    minute: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

export function nextJourneyWindowOpen(
  rules: Record<string, unknown>,
  now = new Date(),
): string | null {
  const start = typeof rules.window_start === "string" ? rules.window_start : null;
  const end = typeof rules.window_end === "string" ? rules.window_end : null;
  if (!start || !end || !/^\d\d:\d\d$/.test(start) || !/^\d\d:\d\d$/.test(end)) return null;
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) return null;
  const local = brtParts(now);
  const weekdays = Array.isArray(rules.weekdays)
    ? [
        ...new Set(
          rules.weekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6),
        ),
      ]
    : [];
  const startAt = startHour * 60 + startMinute;
  const endAt = endHour * 60 + endMinute;
  const inWindow =
    startAt <= endAt
      ? local.minute >= startAt && local.minute < endAt
      : local.minute >= startAt || local.minute < endAt;
  if (inWindow && (!weekdays.length || weekdays.includes(local.weekday))) return null;
  for (let offset = 0; offset < 8; offset++) {
    const localNoonUtc = new Date(Date.UTC(local.year, local.month - 1, local.day + offset, 15));
    const day = brtParts(localNoonUtc);
    if (weekdays.length && !weekdays.includes(day.weekday)) continue;
    const candidate = new Date(
      Date.UTC(day.year, day.month - 1, day.day, startHour + 3, startMinute),
    );
    if (candidate.getTime() > now.getTime()) return candidate.toISOString();
  }
  return new Date(now.getTime() + 7 * 86400_000).toISOString();
}

export function qualifiesForInactivity(
  player: Record<string, unknown>,
  config: Record<string, unknown>,
  now = new Date(),
) {
  const field = String(config.field ?? "ultimo_login");
  if (!["ultimo_login", "ultimo_jogo", "ultimo_deposito"].includes(field)) return false;
  const hours = Number(config.hours ?? 0);
  const value = player[field];
  if (!Number.isFinite(hours) || hours < 1 || typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  const startAfter = typeof config.start_after === "string" ? Date.parse(config.start_after) : NaN;
  // Bands (Esfriando 48–168 h, Dormindo 168–720 h) are exclusive: a player
  // already past `hours_max` belongs to the next band, not this one.
  const hoursMax = Number(config.hours_max);
  const withinUpperBound =
    !Number.isFinite(hoursMax) ||
    hoursMax <= hours ||
    timestamp > now.getTime() - hoursMax * 3600_000;
  return (
    Number.isFinite(timestamp) &&
    timestamp <= now.getTime() - hours * 3600_000 &&
    withinUpperBound &&
    (!Number.isFinite(startAfter) || timestamp >= startAfter)
  );
}

/**
 * Upper bound of an inactivity band. An explicit `trigger_config.hours_max`
 * wins; otherwise the journey's own exit threshold (`inactivity_over_hours`)
 * is used, so a player can never enter a band they would leave immediately.
 */
export function inactivityUpperBoundHours(
  triggerConfig: Record<string, unknown> | null | undefined,
  exitRules: Record<string, unknown> | null | undefined,
): number | null {
  for (const value of [triggerConfig?.hours_max, exitRules?.inactivity_over_hours]) {
    const hours = Number(value);
    if (value != null && value !== "" && Number.isFinite(hours) && hours > 0) return hours;
  }
  return null;
}

/** Trigger config of an inactivity journey with its band upper bound applied. */
export function inactivityBandConfig(
  triggerConfig: Record<string, unknown> | null | undefined,
  exitRules: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const hoursMax = inactivityUpperBoundHours(triggerConfig, exitRules);
  return hoursMax == null ? { ...triggerConfig } : { ...triggerConfig, hours_max: hoursMax };
}

/**
 * Default max age (hours) of the event that ENTERS a journey (P0.3). Without
 * it an imported base enters as new: betgreen's "Cadastrou e não depositou"
 * enrolled 5,280 players, 4,800 of them signed up 7 days to 2 months before,
 * and sent them "Bem-vindo, seu cadastro foi concluído".
 */
const DEFAULT_EVENT_MAX_AGE_HOURS: Record<string, number> = {
  cadastrados_sem_deposito: 168,
  primeiro_deposito: 72,
  saque_pago: 24,
};

/**
 * Only events younger than this enter the journey. Entry only: an enrollment
 * already in the journey is not cut when its event ages.
 * `trigger_config.max_event_age_hours` overrides the default; 0 disables.
 * PIX keeps its own `expire_hours` (pixExpiryHours).
 */
export function eventMaxAgeHours(
  triggerType: string,
  triggerConfig: Record<string, unknown> | null | undefined,
): number | null {
  const configured = Number(triggerConfig?.max_event_age_hours);
  if (triggerConfig && "max_event_age_hours" in triggerConfig && Number.isFinite(configured)) {
    return configured > 0 ? configured : null;
  }
  return DEFAULT_EVENT_MAX_AGE_HOURS[triggerType] ?? null;
}

/** True when the event at `occurredAt` (epoch ms) is still young enough to enter. */
export function eventYoungEnough(
  triggerType: string,
  triggerConfig: Record<string, unknown> | null | undefined,
  occurredAt: number,
  now = Date.now(),
): boolean {
  const maxAge = eventMaxAgeHours(triggerType, triggerConfig);
  return maxAge == null || now - occurredAt <= maxAge * 3600_000;
}

/**
 * A pending PIX stops driving its journey after this many hours (D-6).
 * `trigger_config.expire_hours` overrides the 72 h default; 0 disables.
 */
export function pixExpiryHours(triggerConfig: Record<string, unknown> | null | undefined) {
  const configured = Number(triggerConfig?.expire_hours);
  if (triggerConfig && "expire_hours" in triggerConfig && Number.isFinite(configured)) {
    return configured > 0 ? configured : null;
  }
  return 72;
}

/** Message variations of an SMS step; a step without `variants` has one. */
export function smsVariants(config: Record<string, unknown>): string[] {
  const variants = Array.isArray(config.variants)
    ? config.variants.filter(
        (item): item is string => typeof item === "string" && item.trim() !== "",
      )
    : [];
  return variants.length ? variants : [String(config.content ?? "")];
}

function seedHash(seed: string) {
  // FNV-1a: stable across processes, so a retried send picks the same text.
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Picks the variation for one send (D-8): deterministic for the seed and
 * avoiding variations the player already received today, until all were used.
 */
export function pickSmsVariant(variants: string[], seed: string, usedToday: number[]) {
  const all = variants.map((_, index) => index);
  const fresh = all.filter((index) => !usedToday.includes(index));
  const pool = fresh.length ? fresh : all;
  return pool[seedHash(seed) % pool.length];
}

export function journeyEntryKey(
  trigger: string,
  rules: Record<string, unknown>,
  occurrence: string,
  now = new Date(),
) {
  const mode = String(rules.reentry ?? "once") as ReentryMode;
  if (mode === "per_occurrence") return `${trigger}:${occurrence}`.slice(0, 160);
  if (mode === "after_cooldown") {
    const hours = Math.max(1, Number(rules.reentry_cooldown_hours ?? 24));
    return `${trigger}:cooldown:${Math.floor(now.getTime() / (hours * 3600_000))}`.slice(0, 160);
  }
  return "once";
}

export function triggerOccurrence(
  trigger: string,
  player: Record<string, unknown>,
  triggerConfig: Record<string, unknown> = {},
) {
  if (trigger === "inactivity")
    return String(player[String(triggerConfig.field ?? "ultimo_login")] ?? "missing");
  if (trigger === "lead_cadastrado" || trigger === "cadastrados_sem_deposito")
    return String(player.created_at ?? "missing");
  if (trigger.includes("login") || trigger.includes("inativo"))
    return String(player.ultimo_login ?? "missing");
  if (trigger.includes("deposit") || trigger === "depositou_nunca_apostou")
    return String(player.ultimo_deposito ?? player.ftd_em ?? "missing");
  if (trigger.includes("jogo") || trigger.includes("perdeu") || trigger.includes("ganhou"))
    return String(player.ultimo_jogo ?? "missing");
  if (trigger === "cashback_pago") return String(player.last_cashback_paid_at ?? "missing");
  return String(player.updated_at ?? player.created_at ?? "missing");
}

export type JourneyEntryScope = "new_only" | "include_base";

/** Triggers that describe a single event: re-sending for past events makes no sense (E-02). */
const EVENT_TRIGGERS = new Set([
  "pix_gerado_nao_pago",
  "saque_pago",
  "cashback_pago",
  "primeiro_deposito",
  "cadastrados_sem_deposito",
  "lead_cadastrado",
]);

/** Level journeys only take players at the moment they change level. */
export function activationAsksEntryScope(triggerType: string) {
  return triggerType !== "nivel_alterado" && triggerType !== "manual";
}

export function defaultEntryScope(triggerType: string): JourneyEntryScope {
  return EVENT_TRIGGERS.has(triggerType) ? "new_only" : "include_base";
}

/**
 * Trigger config to publish with (E-02). "new_only" starts the journey now
 * (`start_after`). "include_base" lifts a previous `start_after` only for
 * state triggers (inactivity bands); on event triggers it is kept, because
 * removing it would replay past PIX, withdrawals or sign-ups.
 *
 * P0.4: an event journey activated without `start_after` gets the activation
 * time from the `journeys_default_start_after` trigger, so loading the base
 * needs an explicit start: "include_base" on an event trigger with none sets
 * INCLUDE_BASE_START_AFTER (the entry max age of P0.3 still applies).
 */
export function activationTriggerConfig(
  triggerType: string,
  triggerConfig: Record<string, unknown> | null | undefined,
  scope: JourneyEntryScope | undefined,
  now = new Date(),
): Record<string, unknown> {
  const config = { ...(triggerConfig ?? {}) };
  if (scope === "new_only") return { ...config, start_after: now.toISOString() };
  if (scope === "include_base" && !EVENT_TRIGGERS.has(triggerType)) {
    const { start_after: _startAfter, ...rest } = config;
    return rest;
  }
  if (scope === "include_base" && !String(config.start_after ?? "")) {
    return { ...config, start_after: INCLUDE_BASE_START_AFTER };
  }
  return config;
}

/** Explicit "whole base" start for an event journey (see activationTriggerConfig). */
export const INCLUDE_BASE_START_AFTER = "1970-01-01T00:00:00.000Z";

/** Player fields the audience and entry filters read. */
export type AudiencePlayer = {
  status?: string | null;
  vip?: boolean | null;
  ftd_em?: string | null;
  total_depositado?: number | string | null;
  ultimo_deposito?: string | null;
};

/** Whether a player belongs to the journey's audience (entry and every step, E-06). */
export function audienceMatches(
  journey: { entry_rules?: Record<string, unknown> | null },
  player: AudiencePlayer,
  now = Date.now(),
) {
  const audience = String(journey.entry_rules?.audience ?? "all_active");
  if (audience === "manual") return false;
  if (audience === "all_active" && player.status !== "ativo") return false;
  if (audience === "vip" && player.vip !== true) return false;
  return entryFiltersMatch(journeyEntryFilters(journey.entry_rules), player, now);
}

/**
 * Who may be in the journey beyond the audience (P1.1,
 * docs/ESCOPO_AUDITORIA_JORNADAS_CUSTO_RECUPERACAO_2026-10-29.md), kept in
 * `entry_rules.filters`. Checked with the audience: at entry and before each
 * step, so a player who stops matching leaves the journey.
 */
export type JourneyEntryFilters = {
  /** Only players who already made a first deposit. */
  require_ftd?: boolean;
  /** Total deposited (R$) at least / at most. */
  min_total_deposited?: number;
  max_total_deposited?: number;
  /** Leave out a player who deposited within this many hours. */
  no_deposit_within_hours?: number;
  /** Only players whose last deposit is within this many days. */
  last_deposit_within_days?: number;
};

const FILTER_NUMBER_KEYS = [
  "min_total_deposited",
  "max_total_deposited",
  "no_deposit_within_hours",
  "last_deposit_within_days",
] as const;

/** The usable filters of `entry_rules.filters`; invalid values are dropped. */
export function journeyEntryFilters(
  entryRules: Record<string, unknown> | null | undefined,
): JourneyEntryFilters {
  const raw = entryRules?.filters;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const filters: JourneyEntryFilters = {};
  if (source.require_ftd === true) filters.require_ftd = true;
  for (const key of FILTER_NUMBER_KEYS) {
    const value = source[key];
    if (value === null || value === undefined || value === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) filters[key] = parsed;
  }
  return filters;
}

export function entryFiltersMatch(
  filters: JourneyEntryFilters,
  player: AudiencePlayer,
  now = Date.now(),
): boolean {
  const total = Number(player.total_depositado ?? 0) || 0;
  const lastDeposit = Date.parse(String(player.ultimo_deposito ?? ""));
  if (filters.require_ftd && !player.ftd_em && total <= 0) return false;
  if (filters.min_total_deposited != null && total < filters.min_total_deposited) return false;
  if (filters.max_total_deposited != null && total > filters.max_total_deposited) return false;
  if (
    filters.no_deposit_within_hours != null &&
    Number.isFinite(lastDeposit) &&
    now - lastDeposit < filters.no_deposit_within_hours * 3600_000
  )
    return false;
  if (
    filters.last_deposit_within_days != null &&
    !(
      Number.isFinite(lastDeposit) &&
      now - lastDeposit <= filters.last_deposit_within_days * 86400_000
    )
  )
    return false;
  return true;
}
