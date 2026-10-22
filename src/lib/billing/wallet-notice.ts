// Balance notice for paying houses (not exempt). Pix top-ups (PG2) are only
// available to the tenant admin of a paying, non-demo house with the
// gateway on (`canBuy`); for anyone else (gestor, exempt, demo, gateway
// off) the only way to add balance remains the super admin's manual
// adjustment, so the notice keeps pointing to support.

/** Below this balance a paying house is warned (spec PG3-06 default). */
export const LOW_BALANCE_THRESHOLD = 200;

export type WalletNotice = { kind: "empty" | "low"; title: string; text: string };

const SUPPORT_CLOSING_TEXT =
  "A compra por Pix chega em breve; enquanto isso, fale com o suporte para adicionar saldo.";
const PIX_CLOSING_TEXT = "Compre créditos por Pix nesta página.";

export function walletBalanceNotice(args: {
  balance: number;
  exempt: boolean;
  smsUnitPrice: number | null;
  canBuy: boolean;
}): WalletNotice | null {
  if (args.exempt) return null;
  const minimum = args.smsUnitPrice ?? 0;
  const closing = args.canBuy ? PIX_CLOSING_TEXT : SUPPORT_CLOSING_TEXT;
  if (args.balance <= 0 || (minimum > 0 && args.balance < minimum)) {
    return {
      kind: "empty",
      title: "Seu saldo acabou",
      text: `Os envios de SMS estão bloqueados até entrar saldo. ${closing}`,
    };
  }
  if (args.balance < LOW_BALANCE_THRESHOLD) {
    return {
      kind: "low",
      title: "Saldo baixo",
      text: `Quando o saldo acabar, os envios de SMS param. ${closing}`,
    };
  }
  return null;
}
