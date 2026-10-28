// Amber banner of the Financeiro painel (spec §5.2, §6, §7.3). Tenant scope
// lists the past days missing GGR or Anúncios (today is already left out by
// the server) with "Lançar agora", which opens Lançamentos at the first one;
// group/all scope names the houses with missing days. A second line warns
// about manual other costs that look like the automatic Betleads cost.
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";

type PendingTenant = { id: string; nome: string; pendingDates: string[] };

/** The earliest pending date, the one "Lançar agora" opens; null when none. */
export function firstPendingDate(dates: string[]): string | null {
  return [...dates].sort()[0] ?? null;
}

/** "12, 18, 19" inside one month; "30/09, 01/10" when the dates span months. */
function datesLabel(dates: string[]) {
  const sorted = [...dates].sort();
  const oneMonth = new Set(sorted.map((date) => date.slice(0, 7))).size === 1;
  return sorted
    .map((date) =>
      oneMonth ? String(Number(date.slice(8, 10))) : `${date.slice(8, 10)}/${date.slice(5, 7)}`,
    )
    .join(", ");
}

export function PendingBanner({
  scopeKind,
  tenants,
  duplicateBetleadsCosts,
  onLaunchPending,
}: {
  scopeKind: "tenant" | "group" | "all";
  tenants: PendingTenant[];
  duplicateBetleadsCosts: number;
  onLaunchPending?: (firstDate: string) => void;
}) {
  const pendingTenants = tenants.filter((tenant) => tenant.pendingDates.length > 0);
  const dates = scopeKind === "tenant" ? (pendingTenants[0]?.pendingDates ?? []) : [];
  const first = firstPendingDate(dates);
  const showPending = scopeKind === "tenant" ? dates.length > 0 : pendingTenants.length > 0;

  if (!showPending && duplicateBetleadsCosts <= 0) return null;

  return (
    <div className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
      {showPending && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" aria-hidden />
          {scopeKind === "tenant" ? (
            <span>
              {dates.length === 1 ? "Falta 1 dia" : `Faltam ${dates.length} dias`} de lançamento (
              {datesLabel(dates)}). O lucro está incompleto.
            </span>
          ) : (
            <span>
              Casas com dias faltando:{" "}
              {pendingTenants
                .map((tenant) => `${tenant.nome} (${tenant.pendingDates.length})`)
                .join(", ")}
            </span>
          )}
          {scopeKind === "tenant" && first && onLaunchPending && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 border-amber-500/50 text-amber-100"
              onClick={() => onLaunchPending(first)}
            >
              Lançar agora
            </Button>
          )}
        </div>
      )}
      {duplicateBetleadsCosts > 0 && (
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" aria-hidden />
          <span>Pode haver custo Betleads contado duas vezes. Revise em Outros custos.</span>
        </div>
      )}
    </div>
  );
}
