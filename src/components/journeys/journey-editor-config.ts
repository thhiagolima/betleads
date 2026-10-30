// Pure helpers of the journey editor (kept apart so they can be unit tested).

import { EXIT_REASON_LABELS } from "@/lib/player-journeys";
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

/** The SMS step's `extra` config to keep when the editor switches to a
 * different template: `short_domain_id` and `track_links` are picker/toggle
 * choices independent of which template is selected, so they carry over.
 * Everything else — `variants`, `sender` — is authored on the template
 * itself (or copied from it at save time via `template_snapshot`), so it's
 * dropped: keeping a previous template's `variants` here would make
 * `smsVariants()` prefer the stale list over the newly selected template's
 * content at send time. */
export function smsExtraForTemplateChange(
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  if (extra && "short_domain_id" in extra) picked.short_domain_id = extra.short_domain_id;
  if (extra && "track_links" in extra) picked.track_links = extra.track_links;
  return picked;
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

/** Sender/short-domain choice carried in the editor's local e-mail step
 * state. `null` means "padrão da casa" — the tenant's current default
 * verified sender/domain, so later default changes apply to this draft. */
export type EmailStepFields = {
  templateId: string;
  senderId: string | null;
  shortDomainId: string | null;
};

/** Builds the editor's local e-mail step fields from a saved step's config.
 * Absent `sender_id`/`short_domain_id` (legacy steps saved before this
 * picker existed, or a step left on "padrão da casa") both read as `null`. */
export function emailStepFromConfig(config: Record<string, unknown>): EmailStepFields {
  return {
    templateId: String(config.template_id ?? ""),
    senderId: (config.sender_id as string | undefined) ?? null,
    shortDomainId: (config.short_domain_id as string | null | undefined) ?? null,
  };
}

/** The sender_id/short_domain_id fields to merge into a saved e-mail step's
 * config. `senderId: null` ("padrão da casa") omits `sender_id` entirely —
 * the journey's email config schema makes it optional and resolves the
 * house's default sender at send time. `short_domain_id` is always written,
 * since its schema accepts `null` explicitly (the same "padrão da casa"
 * meaning there). */
export function emailStepIdsForConfig(fields: {
  senderId: string | null;
  shortDomainId: string | null;
}): { sender_id?: string; short_domain_id: string | null } {
  return {
    ...(fields.senderId ? { sender_id: fields.senderId } : {}),
    short_domain_id: fields.shortDomainId,
  };
}

/** Activity fields an inactivity journey can watch (values saved in trigger_config.field). */
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

/** Status names shown in Automações and in the editor (same words as the Ativar/Pausar actions). */
export const JOURNEY_STATUS_LABELS = {
  draft: "Rascunho",
  active: "Ativa",
  paused: "Pausada",
  archived: "Arquivada",
} as const;

export function journeyStatusLabel(status: string | null | undefined): string {
  return JOURNEY_STATUS_LABELS[status as keyof typeof JOURNEY_STATUS_LABELS] ?? "Rascunho";
}

/** Players inside a journey right now. Players enter the moment they qualify,
 * so "inside" = active + waiting + paused by priority (one rule for hub, map and editor). */
export function journeyInProgress(byStatus: Record<string, number> | null | undefined): number {
  return (
    Number(byStatus?.active ?? 0) +
    Number(byStatus?.waiting ?? 0) +
    Number(byStatus?.paused_by_priority ?? 0)
  );
}

/** Messages actually sent (SMS, e-mail, voice). `sentByChannel` also carries the
 * internal wait/end steps under "other", which are not messages. */
export function journeyMessagesSent(
  sentByChannel: Record<string, number> | null | undefined,
): number {
  return (
    Number(sentByChannel?.sms ?? 0) +
    Number(sentByChannel?.email ?? 0) +
    Number(sentByChannel?.voice ?? 0)
  );
}

// Override/extend the player page labels with the Automações vocabulary (Pausar, not Desligar).
const EXTRA_EXIT_REASON_LABELS: Record<string, string> = {
  journey_paused_closed: "encerrada ao pausar a jornada",
  duplicate_lower_priority: "entrada duplicada em jornada de menor prioridade",
  lock_expired_recovered: "envio retomado após travamento",
  dead_lead: "lead morto: várias mensagens seguidas sem nenhuma ação na casa",
};

/** Readable (pt-BR) exit reason. Known keys are translated; anything else is
 * a failure message written by the dispatcher and is shown as is. */
export function journeyExitReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const label = EXTRA_EXIT_REASON_LABELS[reason] ?? EXIT_REASON_LABELS[reason];
  if (label) return label.charAt(0).toUpperCase() + label.slice(1);
  return reason;
}

const PRIORITY_PAUSE_REASON_LABELS: Record<string, string> = {
  lower_priority_due_message: "outra jornada de maior prioridade tinha mensagem para enviar",
};

export function priorityPauseReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return PRIORITY_PAUSE_REASON_LABELS[reason] ?? null;
}

/** Who may enter a journey after meeting the trigger (entry_rules.audience; see audienceMatches). */
export const JOURNEY_AUDIENCES = {
  "system:all-leads": {
    label: "Todos os jogadores da casa",
    description: "Qualquer jogador que cumprir o gatilho entra, ativo ou não.",
  },
  all_active: {
    label: "Só jogadores ativos",
    description: "Entra quem cumprir o gatilho e estiver com status ativo.",
  },
  vip: {
    label: "Só VIP",
    description: "Entra quem cumprir o gatilho e estiver marcado como VIP.",
  },
  manual: {
    label: "Ninguém automaticamente",
    description: "Ninguém entra pelo gatilho; só por entrada manual ou API.",
  },
} as const;

export function journeyAudienceDescription(audience: string): string {
  const known = JOURNEY_AUDIENCES[audience as keyof typeof JOURNEY_AUDIENCES];
  return known?.description ?? "Público personalizado salvo nesta jornada.";
}

/** Units of a wait step in the editor; the step is saved in seconds (delay_seconds). */
export const WAIT_UNITS = {
  minutes: { label: "minutos", seconds: 60 },
  hours: { label: "horas", seconds: 3600 },
  days: { label: "dias", seconds: 86400 },
} as const;
export type WaitUnit = keyof typeof WAIT_UNITS;

/** Saved delay_seconds -> amount + unit to show: the largest unit that divides it
 * exactly (86400 -> 1 dia, 5400 -> 90 minutos); a value below 1 minute shows in minutes. */
export function splitWaitSeconds(seconds: number): { amount: string; unit: WaitUnit } {
  const value = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  if (value > 0 && value % WAIT_UNITS.days.seconds === 0)
    return { amount: String(value / WAIT_UNITS.days.seconds), unit: "days" };
  if (value > 0 && value % WAIT_UNITS.hours.seconds === 0)
    return { amount: String(value / WAIT_UNITS.hours.seconds), unit: "hours" };
  const minutes = value / WAIT_UNITS.minutes.seconds;
  return {
    amount: String(Number.isInteger(minutes) ? minutes : Number(minutes.toFixed(2))),
    unit: "minutes",
  };
}

/** Amount typed in the editor (accepts "1,5") + unit -> seconds, or null when not a positive number. */
export function waitToSeconds(amount: string, unit: WaitUnit): number | null {
  const value = Number(amount.trim().replace(",", "."));
  if (!amount.trim() || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * WAIT_UNITS[unit].seconds);
}
