// Pure view-model helpers for the super admin billing console (Task 9).
//
// Pure module: no React, no Supabase, no I/O — kept separate from the
// dialog/panel/list components so it stays unit-testable the same way
// `src/lib/billing/billing-view.ts` is (no DOM, no testing-library needed in
// this repo).

import { brl } from "@/lib/format";
import type { AdminBillingDashboard } from "@/lib/billing/billing-admin.functions";

// ---------------------------------------------------------------------------
// Motivo obrigatório (every action dialog)
// ---------------------------------------------------------------------------

/** Same rule as the server's `reasonSchema` (billing-admin.functions.ts): trimmed, 5+ chars.
 * The dialog uses this to disable its submit button client-side; the server re-validates. */
export function canSubmitReason(reason: string): boolean {
  return reason.trim().length >= 5;
}

// ---------------------------------------------------------------------------
// Painel — os 8 números da Task 8 (AdminBillingDashboard), formatados.
// ---------------------------------------------------------------------------

export type AdminBillingDashboardCard = { key: string; label: string; value: string };

/** One card per field of `AdminBillingDashboard`, in the order the design's "painel" item lists
 * them (section 6, item 9): MRR, recebido no mês, a receber em 5 dias, faturas vencidas, casas
 * bloqueadas (sem pagamento / manual), congeladas, e pagamentos em revisão. */
export function adminBillingDashboardCards(dashboard: AdminBillingDashboard): AdminBillingDashboardCard[] {
  return [
    { key: "mrr", label: "Receita mensal recorrente", value: brl(dashboard.mrrCents / 100) },
    { key: "receivedThisMonth", label: "Recebido no mês", value: brl(dashboard.receivedThisMonthCents / 100) },
    { key: "dueNext5Days", label: "A receber nos próximos 5 dias", value: brl(dashboard.dueNext5DaysCents / 100) },
    { key: "overdueInvoices", label: "Faturas vencidas", value: String(dashboard.overdueInvoices) },
    { key: "lockedUnpaid", label: "Bloqueadas por falta de pagamento", value: String(dashboard.lockedUnpaid) },
    { key: "lockedManual", label: "Bloqueadas manualmente", value: String(dashboard.lockedManual) },
    { key: "frozen", label: "Planos congelados", value: String(dashboard.frozen) },
    { key: "needsReview", label: "Pagamentos em revisão", value: String(dashboard.needsReview) },
  ];
}

// ---------------------------------------------------------------------------
// Situação da casa (lista de casas)
// ---------------------------------------------------------------------------

const SITUATION_LABEL: Record<string, string> = {
  exempt: "Isenta",
  frozen: "Congelada",
  locked_manual: "Bloqueada (manual)",
  awaiting_first_payment: "Aguardando primeiro pagamento",
  ok: "Em dia",
  due_soon: "A vencer",
  overdue: "Vencida",
  locked_unpaid: "Bloqueada (falta de pagamento)",
};

/** The list's status badge text for a house's `access_state` (ruling 1: "a aba 'Faturamento'
 * lista as casas com um selo de situação"). Independent of `today`/day counts — the per-house
 * table shows the open invoice's own due date alongside, so the badge only names the state. */
export function adminTenantSituationLabel(accessState: string): string {
  return SITUATION_LABEL[accessState] ?? accessState;
}

/** Badge tone, same semantics as the rest of the admin console (destructive = blocking). */
export function adminTenantSituationTone(accessState: string): "default" | "secondary" | "destructive" | "outline" {
  if (accessState === "locked_unpaid" || accessState === "locked_manual") return "destructive";
  if (accessState === "overdue" || accessState === "due_soon") return "secondary";
  if (accessState === "frozen") return "outline";
  return "default";
}

export function formatCentsBRL(cents: number): string {
  return brl(cents / 100);
}

/** DD/MM/AAAA for a YYYY-MM-DD date-only string — never shifts by timezone (no `new Date()` parse). */
export function formatDateBR(dateStr: string | null): string {
  if (!dateStr) return "-";
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

// ---------------------------------------------------------------------------
// Validação dos campos extras de cada diálogo (fix round 1, m2-m4) — pt-BR,
// mesma forma que `canSubmitReason`: pura, usada pelos componentes para
// desabilitar o envio e mostrar a mensagem de erro perto do campo.
// ---------------------------------------------------------------------------

export type FieldValidation = { valid: boolean; message: string | null };

const VALID: FieldValidation = { valid: true, message: null };

/** "Dar baixa manual" — valor recebido: vazio usa o valor da fatura; senão precisa ser um
 * número finito maior que zero. */
export function validateManualSettleAmount(raw: string): FieldValidation {
  if (raw.trim() === "") return VALID;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return {
      valid: false,
      message: "Informe um valor maior que zero, ou deixe vazio para usar o valor da fatura.",
    };
  }
  return VALID;
}

/** "Dar baixa manual" — data do pagamento (PG3 Task 10; lower bound added in fix round 1,
 * Ruling T10): opcional (vazio = hoje, resolvido pelo servidor); quando preenchida, precisa ser
 * uma data de calendário real, não pode estar no futuro, e não pode ser anterior ao dia de
 * emissão da fatura (mesma regra que a função SQL aplica — `invalid_paid_at`). `todayBRT` and
 * `issuedOnBRT` (both YYYY-MM-DD) are passed by the caller — this module is pure and never reads
 * the clock or the invoice — and every comparison is lexicographic, valid because both sides are
 * YYYY-MM-DD. `issuedOnBRT` is optional so existing callers that don't have it yet still compile. */
export function validateManualSettlePaidAt(
  raw: string,
  todayBRT: string,
  issuedOnBRT?: string,
): FieldValidation {
  if (raw.trim() === "") return VALID;
  const calendar = validateCalendarDate(raw);
  if (!calendar.valid) return calendar;
  if (raw > todayBRT) {
    return { valid: false, message: "A data do pagamento não pode ser no futuro." };
  }
  if (issuedOnBRT != null && raw < issuedOnBRT) {
    return {
      valid: false,
      message: "A data do pagamento não pode ser anterior à emissão da fatura.",
    };
  }
  return VALID;
}

/** Desconto percentual (pontual ou contínuo): 0 (exclusivo) a 100. */
export function validatePercentDiscount(raw: string): FieldValidation {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n <= 0 || n > 100) {
    return { valid: false, message: "Informe um percentual entre 0 (exclusivo) e 100." };
  }
  return VALID;
}

/** Desconto em valor fixo (R$, pontual ou contínuo): número finito maior que zero. */
export function validateFixedDiscountAmount(raw: string): FieldValidation {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n <= 0) {
    return { valid: false, message: "Informe um valor em R$ maior que zero." };
  }
  return VALID;
}

/** "Desconto contínuo" — fim não pode ser antes do início, quando os dois estão preenchidos. */
export function validateDiscountDateRange(startsOn: string, endsOn: string): FieldValidation {
  if (startsOn.trim() !== "" && endsOn.trim() !== "" && endsOn < startsOn) {
    return { valid: false, message: "A data de fim não pode ser antes da data de início." };
  }
  return VALID;
}

/** A YYYY-MM-DD string that is a real calendar date (rejects e.g. 2026-02-30), not just a
 * regex-shaped one. Used by "Trocar dia de vencimento". */
export function validateCalendarDate(raw: string): FieldValidation {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return { valid: false, message: "Informe uma data válida." };
  const [, yStr, mStr, dStr] = match;
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  const date = new Date(Date.UTC(y, m - 1, d));
  const isRealDate =
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  if (!isRealDate) return { valid: false, message: "Essa data não existe no calendário." };
  return VALID;
}

/** Taxa do Pix — percentual: dentro do limite aceito pelo servidor (`adminSetPixFeeInput`,
 * 0 a 10). */
export function validatePixFeePercent(raw: string): FieldValidation {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n < 0 || n > 10) {
    return { valid: false, message: "Informe um percentual entre 0 e 10." };
  }
  return VALID;
}

/** Taxa do Pix — valor fixo em centavos: dentro do limite aceito pelo servidor
 * (`adminSetPixFeeInput`, 0 a 1000). */
export function validatePixFeeFixedCents(raw: string): FieldValidation {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(n) || n < 0 || n > 1000) {
    return { valid: false, message: "Informe um valor em centavos entre 0 e 1000." };
  }
  return VALID;
}
