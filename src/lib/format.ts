export function brl(n: number | null | undefined) {
  return (n ?? 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    // Money always has two decimals ("R$ 10.137,90", never "R$ 10.137,9").
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function num(n: number | null | undefined) {
  return (n ?? 0).toLocaleString("pt-BR");
}

/**
 * Unit price formatting (PG1 Task 8): a balance always shows 2 decimals
 * (`brl`), but a per-unit price can be a fraction of a cent (e-mail is
 * R$ 0,002) — this shows up to 4 decimals (the price book's
 * `numeric(12,4)`), never fewer than 2.
 */
export function brlUnitPrice(n: number | null | undefined) {
  return (n ?? 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

/** pt-BR label for a `wallet_ledger.entry_type` (PG1 Task 8, ruling 3). */
export const WALLET_ENTRY_TYPE_LABEL: Record<string, string> = {
  purchase: "Compra",
  manual_adjustment: "Ajuste",
  usage_reservation: "Consumo",
  usage_refund: "Estorno",
  migration: "Conversão de créditos",
};

export function walletEntryTypeLabel(entryType: string) {
  return WALLET_ENTRY_TYPE_LABEL[entryType] ?? entryType;
}

/** pt-BR label for a `wallet_ledger.item`/price-book item (PG1 Task 8, ruling 3). */
export const BILLING_ITEM_LABEL: Record<string, string> = {
  sms: "SMS",
  voice_30s: "Voz",
  email: "E-mail",
};

export function billingItemLabel(item: string | null | undefined) {
  if (!item) return "-";
  return BILLING_ITEM_LABEL[item] ?? item;
}

export function timeAgo(date: string | Date | null | undefined) {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return `${diff}s atrás`;
  if (diff < 3600) return `${Math.floor(diff / 60)}min atrás`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h atrás`;
  return `${Math.floor(diff / 86400)}d atrás`;
}
