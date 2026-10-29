// Amber banner of the Financeiro painel (spec §5.2, §6, §7.3). Tenant scope
// counts the past days missing GGR or Anúncios (today is already left out by
// the server; the dates are not listed) with "Lançar agora", which opens
// Lançamentos at the first one;
// group/all scope names the houses with missing days. A second line warns
// about manual other costs that look like the automatic Betleads cost.
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";

import { pendingTitle } from "./display";

type PendingTenant = {
  id: string;
  nome: string;
  pendingDates: string[];
  /** Set when the pending dates come from the GGR do mês being out of date. */
  ggrUpdatedThrough?: string | null;
};

/** The earliest pending date, the one "Lançar agora" opens; null when none. */
export function firstPendingDate(dates: string[]): string | null {
  return [...dates].sort()[0] ?? null;
}

/** The small line under the tenant-scope title. */
export const PENDING_HINT =
  "Enquanto não forem lançados, contam como zero e o lucro abaixo fica incompleto.";

/**
 * The tenant-scope title: "GGR atualizado até DD/MM — …" when the pending
 * days come from the month's GGR total being out of date, else how many days
 * of which month are missing (the dates are not listed).
 */
export function tenantPendingText(dates: string[], ggrUpdatedThrough?: string | null) {
  if (ggrUpdatedThrough) {
    const ddmm = `${ggrUpdatedThrough.slice(8, 10)}/${ggrUpdatedThrough.slice(5, 7)}`;
    return `GGR atualizado até ${ddmm} — atualize para fechar o lucro.`;
  }
  return pendingTitle(dates);
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

  const ggrUpdatedThrough = pendingTenants[0]?.ggrUpdatedThrough;

  return (
    <div className="space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
      {showPending && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" aria-hidden />
          <p className="min-w-0 flex-1">
            {scopeKind === "tenant" ? (
              <>
                <span className="font-semibold text-amber-200">
                  {tenantPendingText(dates, ggrUpdatedThrough)}
                </span>
                {!ggrUpdatedThrough && (
                  <span className="mt-0.5 block text-xs text-amber-100/70">{PENDING_HINT}</span>
                )}
              </>
            ) : (
              <span className="font-semibold text-amber-200">
                Casas com dias faltando:{" "}
                {pendingTenants
                  .map((tenant) => `${tenant.nome} (${tenant.pendingDates.length})`)
                  .join(", ")}
              </span>
            )}
          </p>
          {scopeKind === "tenant" && first && onLaunchPending && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="shrink-0 bg-white font-semibold text-slate-950 hover:bg-white/90"
              onClick={() => onLaunchPending(first)}
            >
              Lançar agora
            </Button>
          )}
        </div>
      )}
      {duplicateBetleadsCosts > 0 && (
        <div className="flex items-center gap-3 text-xs text-amber-100/80">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" aria-hidden />
          <span>Pode haver custo Betleads contado duas vezes. Revise em Outros custos.</span>
        </div>
      )}
    </div>
  );
}
