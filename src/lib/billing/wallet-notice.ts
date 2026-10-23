// Balance notice for paying houses (not exempt). Pix top-ups (PG2) are only
// available to the tenant admin of a paying, non-demo house with the
// gateway on (`canBuy`); for anyone else (gestor, exempt, demo, gateway
// off) the only way to add balance remains the super admin's manual
// adjustment, so the notice keeps pointing to support.

/**
 * Default low-balance threshold (PG3 decision 10). Each house can change its
 * own (`tenant_wallets.low_balance_threshold`, read via `wallet_summary`);
 * this is only the fallback when the summary does not carry one.
 */
export const DEFAULT_LOW_BALANCE_THRESHOLD = 200;

/** The house threshold when it is a usable number (>= 0), else the default. */
export function effectiveLowBalanceThreshold(threshold: number | null | undefined): number {
  return typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 0
    ? threshold
    : DEFAULT_LOW_BALANCE_THRESHOLD;
}

export type WalletNotice = { kind: "empty" | "low"; title: string; text: string };

const SUPPORT_CLOSING_TEXT =
  "A compra por Pix chega em breve; enquanto isso, fale com o suporte para adicionar saldo.";
/** Page name the canBuy text points to; WalletBalanceNotice links it to /plano-e-creditos. */
export const WALLET_PAGE_LINK_LABEL = "Saldo e consumo";
/** Page-neutral: the notice also shows on the SMS, voice and e-mail pages. */
const PIX_CLOSING_TEXT = `Compre créditos por Pix em ${WALLET_PAGE_LINK_LABEL}.`;

export function walletBalanceNotice(args: {
  balance: number;
  exempt: boolean;
  smsUnitPrice: number | null;
  canBuy: boolean;
  /** The house's own threshold (`wallet_summary.low_balance_threshold`); 0 turns "low" off. */
  threshold?: number | null;
}): WalletNotice | null {
  if (args.exempt) return null;
  const minimum = args.smsUnitPrice ?? 0;
  const closing = args.canBuy ? PIX_CLOSING_TEXT : SUPPORT_CLOSING_TEXT;
  if (args.balance <= 0 || (minimum > 0 && args.balance < minimum)) {
    return {
      kind: "empty",
      title: "Seu saldo acabou",
      text: `Os envios de SMS, voz e e-mail estão bloqueados até entrar saldo. ${closing}`,
    };
  }
  if (args.balance < effectiveLowBalanceThreshold(args.threshold)) {
    return {
      kind: "low",
      title: "Saldo baixo",
      text: `Quando o saldo acabar, os envios de SMS, voz e e-mail param. ${closing}`,
    };
  }
  return null;
}

function finiteOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The `walletBalanceNotice` inputs out of a `getSmsCreditPortal` result
 * (`summary` is `wallet_summary`, supplier cost already stripped).
 */
export function walletNoticeInputFromPortal(portal: unknown): {
  balance: number;
  exempt: boolean;
  smsUnitPrice: number | null;
  threshold: number | null;
  canBuy: boolean;
} {
  const data = (portal ?? {}) as { canBuy?: unknown; summary?: unknown };
  const summary = (data.summary ?? {}) as {
    balance?: unknown;
    exempt?: unknown;
    low_balance_threshold?: unknown;
    prices?: { sms?: { unit_price?: unknown } | null } | null;
  };
  return {
    balance: finiteOrNull(summary.balance) ?? 0,
    exempt: summary.exempt === true,
    smsUnitPrice: finiteOrNull(summary.prices?.sms?.unit_price),
    threshold: finiteOrNull(summary.low_balance_threshold),
    canBuy: data.canBuy === true,
  };
}

/** Highest low-balance threshold a house can set (same bound as the SQL setter). */
export const MAX_LOW_BALANCE_THRESHOLD = 100000;

/**
 * Parses what the house typed in the threshold field ("200", "199,99",
 * "R$ 1.000,50") into reais; null when empty, invalid, outside
 * 0-100000 or with more than 2 decimals.
 */
export function parseThresholdInput(raw: string): number | null {
  const cleaned = raw.replace(/R\$/i, "").replace(/\s/g, "");
  if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+(,\d{1,2})?$/.test(cleaned)) return null;
  const value = Number(cleaned.replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(value) || value < 0 || value > MAX_LOW_BALANCE_THRESHOLD) return null;
  return value;
}
