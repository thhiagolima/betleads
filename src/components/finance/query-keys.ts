// React Query keys of the finance screens, and what a save must refresh.
import type { QueryClient } from "@tanstack/react-query";

export const financeMonthQueryKey = (tenantId: string, month: string) =>
  ["finance-month", tenantId, month] as const;

/** Prefix of every dashboard query (any scope, any period). */
export const FINANCE_DASHBOARD_QUERY_KEY = ["finance-dashboard"] as const;

/**
 * After a save in Lançamentos / Outros custos / Configurações: the month
 * view of that house and every dashboard (the Painel shows the same profit
 * and pending days, and a group or "Todas as casas" may include the house).
 */
export function invalidateFinanceAfterSave(
  qc: Pick<QueryClient, "invalidateQueries">,
  tenantId: string,
  month: string,
) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: financeMonthQueryKey(tenantId, month) }),
    qc.invalidateQueries({ queryKey: FINANCE_DASHBOARD_QUERY_KEY }),
  ]);
}
