/** Fixed cost categories, in the order defined by the plan's Global Constraints. */
export const FIXED_COST_CATEGORIES: readonly string[] = [
  "Afiliados e influenciadores",
  "Equipe",
  "Ferramentas",
  "Impostos",
  "Outros",
];

/** Longest category name the server accepts (saveOtherCost: z.string().max(60)). */
export const MAX_CATEGORY_LENGTH = 60;

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

/** The warning shown while typing a cost that looks like a Betleads charge (spec §7.3). */
export function betleadsHint(descricao: string, categoria: string | null): string | null {
  return looksLikeBetleadsCost(descricao, categoria) ? "o custo Betleads já entra sozinho" : null;
}

/**
 * Categories matching the typed text (all of them when empty, in the given
 * order: fixed first, then the house's), plus the typed name as a new
 * category when no existing one has that name and it fits MAX_CATEGORY_LENGTH.
 */
export function categoryChoices(
  categories: string[],
  search: string,
): { options: string[]; newName: string | null } {
  const typed = search.trim().replace(/\s+/g, " ");
  if (typed === "") return { options: categories, newName: null };
  const key = categoryKey(typed);
  const options = categories.filter((label) => categoryKey(label).includes(key));
  const exists = categories.some((label) => categoryKey(label) === key);
  return { options, newName: exists || typed.length > MAX_CATEGORY_LENGTH ? null : typed };
}
