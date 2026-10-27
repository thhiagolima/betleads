/** Fixed cost categories, in the order defined by the plan's Global Constraints. */
export const FIXED_COST_CATEGORIES: readonly string[] = [
  "Afiliados e influenciadores",
  "Equipe",
  "Ferramentas",
  "Impostos",
  "Outros",
];

/** A cost category's display label: trimmed, with internal spaces collapsed; "Outros" when empty/null. */
export function categoryLabel(categoria: string | null): string {
  const trimmed = (categoria ?? "").trim().replace(/\s+/g, " ");
  return trimmed === "" ? "Outros" : trimmed;
}

/** Case/locale-insensitive key used to merge categories by name. */
export function categoryKey(label: string): string {
  return label.toLocaleLowerCase("pt-BR");
}

/**
 * Fixed categories first (in their given order), then the used categories not
 * already present (by categoryKey), sorted pt-BR.
 */
export function mergeCategories(fixed: readonly string[], used: string[]): string[] {
  const fixedKeys = new Set(fixed.map(categoryKey));
  const seen = new Set<string>();
  const extra: string[] = [];
  for (const label of used) {
    const key = categoryKey(label);
    if (fixedKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    extra.push(label);
  }
  extra.sort((a, b) => a.localeCompare(b, "pt-BR"));
  return [...fixed, ...extra];
}

/** Matches a cost whose description or category looks like a Betleads charge (SMS, mensalidade...). */
const BETLEADS_COST_PATTERN = /\b(sms|betleads|mensalidade|voz|e-?mail|crm)\b/i;

export function looksLikeBetleadsCost(descricao: string, categoria: string | null): boolean {
  return (
    BETLEADS_COST_PATTERN.test(descricao) ||
    (categoria !== null && BETLEADS_COST_PATTERN.test(categoria))
  );
}
