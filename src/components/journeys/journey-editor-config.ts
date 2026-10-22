// Pure helpers of the journey editor (kept apart so they can be unit tested).

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
