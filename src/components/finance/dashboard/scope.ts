// Pure helpers for the dashboard scope (spec §4): the Select encoding used by
// the "Ver:" picker and what a click on a house row does. No server imports,
// so they can be unit tested without the server-fn runtime.
import type { DashboardScope } from "@/lib/finance-dashboard.functions";

export function scopeToValue(scope: DashboardScope): string {
  if (scope.kind === "tenant") return `tenant:${scope.tenantId}`;
  if (scope.kind === "group") return `group:${scope.groupId}`;
  return "all";
}

export function valueToScope(value: string): DashboardScope {
  if (value.startsWith("tenant:")) return { kind: "tenant", tenantId: value.slice(7) };
  if (value.startsWith("group:")) return { kind: "group", groupId: value.slice(6) };
  return { kind: "all" };
}

type ScopeOption = { id: string; nome: string };

/**
 * The picker's options plus the current scope when it is not among them
 * (the demo house or an inactive house picked from elsewhere), labeled with
 * the dashboard's label, so the Select never shows a blank value. Without a
 * label yet, the options are returned as they are.
 */
export function withCurrentScope<T extends { groups: ScopeOption[]; tenants: ScopeOption[] }>(
  options: T,
  scope: DashboardScope,
  label: string | undefined,
): T {
  if (!label) return options;
  if (scope.kind === "tenant" && !options.tenants.some((t) => t.id === scope.tenantId)) {
    return { ...options, tenants: [...options.tenants, { id: scope.tenantId, nome: label }] };
  }
  if (scope.kind === "group" && !options.groups.some((g) => g.id === scope.groupId)) {
    return { ...options, groups: [...options.groups, { id: scope.groupId, nome: label }] };
  }
  return options;
}

/**
 * What a click on a house row (Lucro por casa, placar) does:
 * - "open": call the caller's onOpenTenant (e.g. /grupo → /grupo/casa). Only
 *   while the view still shows the caller's own scope, since the caller's
 *   page only knows that one (a house from "Todas as casas" or from another
 *   group would land on "Casa fora do grupo").
 * - "switch": the super admin's picker moves to that house (tenant scope) —
 *   in any other scope, or when the caller passed no onOpenTenant
 *   (/financeiro).
 * - null: rows are not clickable (tenant scope has no rows).
 */
export function tenantClickAction({
  scope,
  initialScope,
  canPickScope,
  hasOnOpenTenant,
}: {
  scope: DashboardScope;
  initialScope: DashboardScope;
  canPickScope: boolean;
  hasOnOpenTenant: boolean;
}): "open" | "switch" | null {
  if (scope.kind === "tenant") return null;
  if (hasOnOpenTenant && scopeToValue(scope) === scopeToValue(initialScope)) return "open";
  if (canPickScope) return "switch";
  return null;
}
