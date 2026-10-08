export type ReentryMode = "once" | "never" | "per_occurrence" | "after_cooldown";

const BRT = "America/Sao_Paulo";

function brtParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BRT, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit",
  }).formatToParts(date).reduce<Record<string, string>>((all, part) => {
    all[part.type] = part.value;
    return all;
  }, {});
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday),
    minute: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

export function nextJourneyWindowOpen(rules: Record<string, unknown>, now = new Date()): string | null {
  const start = typeof rules.window_start === "string" ? rules.window_start : null;
  const end = typeof rules.window_end === "string" ? rules.window_end : null;
  if (!start || !end || !/^\d\d:\d\d$/.test(start) || !/^\d\d:\d\d$/.test(end)) return null;
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) return null;
  const local = brtParts(now);
  const weekdays = Array.isArray(rules.weekdays)
    ? [...new Set(rules.weekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
    : [];
  const startAt = startHour * 60 + startMinute;
  const endAt = endHour * 60 + endMinute;
  const inWindow = startAt <= endAt
    ? local.minute >= startAt && local.minute < endAt
    : local.minute >= startAt || local.minute < endAt;
  if (inWindow && (!weekdays.length || weekdays.includes(local.weekday))) return null;
  for (let offset = 0; offset < 8; offset++) {
    const localNoonUtc = new Date(Date.UTC(local.year, local.month - 1, local.day + offset, 15));
    const day = brtParts(localNoonUtc);
    if (weekdays.length && !weekdays.includes(day.weekday)) continue;
    const candidate = new Date(Date.UTC(day.year, day.month - 1, day.day, startHour + 3, startMinute));
    if (candidate.getTime() > now.getTime()) return candidate.toISOString();
  }
  return new Date(now.getTime() + 7 * 86400_000).toISOString();
}

export function qualifiesForInactivity(player: Record<string, unknown>, config: Record<string, unknown>, now = new Date()) {
  const field = String(config.field ?? "ultimo_login");
  if (!["ultimo_login", "ultimo_jogo", "ultimo_deposito"].includes(field)) return false;
  const hours = Number(config.hours ?? 0);
  const value = player[field];
  if (!Number.isFinite(hours) || hours < 1 || typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now.getTime() - hours * 3600_000;
}

export function journeyEntryKey(trigger: string, rules: Record<string, unknown>, occurrence: string, now = new Date()) {
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
  if (trigger === "inactivity") return String(player[String(triggerConfig.field ?? "ultimo_login")] ?? "missing");
  if (trigger === "lead_cadastrado" || trigger === "cadastrados_sem_deposito") return String(player.created_at ?? "missing");
  if (trigger.includes("login") || trigger.includes("inativo")) return String(player.ultimo_login ?? "missing");
  if (trigger.includes("deposit") || trigger === "depositou_nunca_apostou") return String(player.ultimo_deposito ?? player.ftd_em ?? "missing");
  if (trigger.includes("jogo") || trigger.includes("perdeu") || trigger.includes("ganhou")) return String(player.ultimo_jogo ?? "missing");
  if (trigger === "cashback_pago") return String(player.last_cashback_paid_at ?? "missing");
  return String(player.updated_at ?? player.created_at ?? "missing");
}
