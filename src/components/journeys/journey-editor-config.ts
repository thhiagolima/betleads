// Pure helpers of the journey editor (kept apart so they can be unit tested).

import { TRIGGER_NAMES } from "@/lib/triggers";

/** Config keys of an SMS step the editor does not edit (links, variations). */
export function smsExtra(config: Record<string, unknown>) {
  const {
    content: _content,
    template_id: _templateId,
    template_snapshot: _snapshot,
    ...extra
  } = config;
  return extra;
}

/** ISO instant -> value of a datetime-local input in Brasília time. */
export function toBrtInput(iso: string | null | undefined) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(new Date(iso))
    .reduce<Record<string, string>>((all, part) => ({ ...all, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
}

/** datetime-local value typed in Brasília time -> ISO instant (Brazil has no DST). */
export function fromBrtInput(value: string) {
  return value ? new Date(`${value}:00-03:00`).toISOString() : null;
}

/** Activity fields an inactivity journey can watch (same values the new-journey dialog saves). */
export const INACTIVITY_FIELDS = {
  ultimo_login: "Login",
  ultimo_jogo: "Jogo",
  ultimo_deposito: "Depósito",
} as const;

export const INACTIVITY_TRIGGER_NAME = "Quando nada acontece";

function inactivityHoursText(hours: number) {
  if (hours > 0 && hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? "1 dia" : `${days} dias`;
  }
  return hours === 1 ? "1 hora" : `${hours} horas`;
}

/** Readable name of a journey entry trigger, including the inactivity rule. */
export function journeyTriggerLabel(
  trigger: string,
  config?: Record<string, unknown> | null,
): string {
  if (trigger === "manual") return "Entrada manual";
  if (trigger === "inactivity") {
    const field = INACTIVITY_FIELDS[String(config?.field ?? "") as keyof typeof INACTIVITY_FIELDS];
    const hours = Number(config?.hours);
    if (!field || !Number.isFinite(hours) || hours <= 0) return INACTIVITY_TRIGGER_NAME;
    return `${INACTIVITY_TRIGGER_NAME}: sem ${field.toLowerCase()} há ${inactivityHoursText(hours)}`;
  }
  return TRIGGER_NAMES[trigger as keyof typeof TRIGGER_NAMES] ?? trigger;
}
