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
  return config;
}
