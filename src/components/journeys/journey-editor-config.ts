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
