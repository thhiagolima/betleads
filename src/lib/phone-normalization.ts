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
