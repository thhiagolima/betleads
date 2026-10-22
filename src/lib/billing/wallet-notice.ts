// Balance notice for paying houses (not exempt). Until Pix top-ups exist
// (PG2), the only way to add balance is the super admin's manual adjustment,
// so the notice points to support.

/** Below this balance a paying house is warned (spec PG3-06 default). */
export const LOW_BALANCE_THRESHOLD = 200;

export type WalletNotice = { kind: "empty" | "low"; title: string; text: string };

export function walletBalanceNotice(args: {
  balance: number;
  exempt: boolean;
  smsUnitPrice: number | null;
}): WalletNotice | null {
  if (args.exempt) return null;
  const minimum = args.smsUnitPrice ?? 0;
  if (args.balance <= 0 || (minimum > 0 && args.balance < minimum)) {
    return {
      kind: "empty",
      title: "Seu saldo acabou",
      text: "Os envios de SMS estão bloqueados até entrar saldo. A compra por Pix chega em breve; enquanto isso, fale com o suporte para adicionar saldo.",
    };
  }
  if (args.balance < LOW_BALANCE_THRESHOLD) {
    return {
      kind: "low",
      title: "Saldo baixo",
      text: "Quando o saldo acabar, os envios de SMS param. A compra por Pix chega em breve; enquanto isso, fale com o suporte para adicionar saldo.",
    };
  }
  return null;
}
