// Web Push billing mode of a house: per send (`webpush`), per new
// subscription / lead (`webpush_lead`), or both. There is no mode column —
// the mode IS the pair of per-tenant prices (tenant_price_overrides): an item
// whose effective price is 0 is not charged. Pure logic, so the
// derive/plan rules are unit-testable without a database.

export type WebpushBillingMode = "envio" | "lead" | "ambos";

export const WEBPUSH_BILLING_MODES: readonly WebpushBillingMode[] = ["envio", "lead", "ambos"];

export type WebpushBillingItem = "webpush" | "webpush_lead";

/** What `billing_effective_price` says about one item for one house. */
export type WebpushItemPrice = {
  /** null = no price configured at all (treated as not charged). */
  unitPrice: number | null;
  /** true when the price comes from a tenant override (`source = 'override'`). */
  hasOverride: boolean;
};

export type WebpushItemPrices = Record<WebpushBillingItem, WebpushItemPrice>;

export type WebpushBillingStep =
  { item: WebpushBillingItem; action: "set_zero" } | { item: WebpushBillingItem; action: "clear" };

const charged = (price: WebpushItemPrice) => (price.unitPrice ?? 0) > 0;

/** Which items a mode charges. */
export function itemsChargedBy(mode: WebpushBillingMode): Record<WebpushBillingItem, boolean> {
  return { webpush: mode !== "lead", webpush_lead: mode !== "envio" };
}

/**
 * Current mode from the two effective prices. `null` when neither item is
 * charged (both at R$ 0 — the house's Web Push is free), which is not one of
 * the three selectable modes.
 */
export function deriveWebpushBillingMode(prices: WebpushItemPrices): WebpushBillingMode | null {
  const send = charged(prices.webpush);
  const lead = charged(prices.webpush_lead);
  if (send && lead) return "ambos";
  if (send) return "envio";
  if (lead) return "lead";
  return null;
}

/**
 * Overrides to write so the house ends up in `mode`, per item:
 * - must be OFF and is not already pinned at 0 by an override → `set_zero`
 *   (an override of 0 even when the catalog price is 0, so a later catalog
 *   change doesn't silently start charging);
 * - must be ON and is currently an override of 0 (or an override with no
 *   price) → `clear` (back to the catalog price);
 * - otherwise nothing: an ON item with a non-zero custom override, or on the
 *   catalog price, keeps its price.
 */
export function planWebpushBillingMode(
  mode: WebpushBillingMode,
  prices: WebpushItemPrices,
): WebpushBillingStep[] {
  const wanted = itemsChargedBy(mode);
  const steps: WebpushBillingStep[] = [];
  for (const item of ["webpush", "webpush_lead"] as const) {
    const price = prices[item];
    if (!wanted[item]) {
      const pinnedAtZero = price.hasOverride && (price.unitPrice ?? 0) === 0;
      if (!pinnedAtZero) steps.push({ item, action: "set_zero" });
    } else if (price.hasOverride && !charged(price)) {
      steps.push({ item, action: "clear" });
    }
  }
  return steps;
}
