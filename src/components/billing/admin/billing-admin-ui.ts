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
