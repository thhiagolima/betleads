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
