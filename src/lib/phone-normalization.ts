/** Canonical Brazilian phone representation used at every CRM boundary. */
export function normalizeBrazilianPhone(raw: string | null | undefined): string | null {
  if (raw == null || !String(raw).trim()) return null;
  const digits = String(raw).replace(/\D/g, "");
  // Length disambiguates country code 55 from Brazilian area code 55.
  const local = digits.startsWith("55") && (digits.length === 12 || digits.length === 13)
    ? digits.slice(2)
    : digits;
  if (!/^[1-9]{2}(?:9\d{8}|[2-8]\d{7})$/.test(local)) return null;
  return `+55${local}`;
}

export function requireBrazilianPhone(raw: string): string {
  const phone = normalizeBrazilianPhone(raw);
  if (!phone) throw new Error("Telefone brasileiro inválido. Informe DDD e número.");
  return phone;
}

/**
 * Telefone como a casa mandou no webhook, com o DDI quando o player é de fora
 * do Brasil. Casas internacionais (ex.: Los Hermanos) mandam o número local em
 * `phone` e o país em `ddi`/`phone_e164`; sem isso o número argentino
 * "3483451193" virava "+553483451193", um celular brasileiro de outra pessoa.
 * DDI 55 ou ausente: devolve o número como veio (regra brasileira de sempre).
 */
export function phoneWithCountryCode(
  phone: string | null | undefined,
  ddi: unknown,
  e164: unknown,
): string | null {
  const ddiDigits = typeof ddi === "string" || typeof ddi === "number" ? String(ddi).replace(/\D/g, "") : "";
  const raw = phone == null ? "" : String(phone).trim();
  if (!ddiDigits || ddiDigits === "55") return raw || null;
  const e164Digits = typeof e164 === "string" ? e164.replace(/\D/g, "") : "";
  if (e164Digits.startsWith(ddiDigits)) return `+${e164Digits}`;
  const localDigits = raw.replace(/\D/g, "");
  if (!localDigits) return null;
  return localDigits.startsWith(ddiDigits) && raw.startsWith("+")
    ? `+${localDigits}`
    : `+${ddiDigits}${localDigits}`;
}

/**
 * Forma gravada em `players.telefone` (espelha `public.normalize_player_phone`):
 * brasileiro → "+55…" como sempre; internacional explícito ("+54…") → E.164 como
 * veio. Um número internacional não passa em `normalizeBrazilianPhone`, então
 * continua inelegível para SMS/voz (envio é só para o Brasil por enquanto).
 */
export function normalizePlayerPhone(raw: string | null | undefined): string | null {
  const brazilian = normalizeBrazilianPhone(raw);
  if (brazilian) return brazilian;
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!trimmed.startsWith("+") || digits.startsWith("55")) return null;
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}
