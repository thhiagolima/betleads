// Pure constants shared by the "Resolver revisão" dialog (client) and the
// server action (billing-review.server.ts). No server imports here.

export const REVIEW_OUTCOMES = ["creditado_manual", "devolvido"] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

export const REVIEW_OUTCOME_LABELS: Record<ReviewOutcome, string> = {
  creditado_manual: "Creditado manualmente (Ajustar saldo ou baixa manual)",
  devolvido: "Devolvido fora do sistema",
};

export const REVIEW_REASON_MIN_LENGTH = 5;
