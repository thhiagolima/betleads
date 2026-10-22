import { Link } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";

import { useTenantAccessStatus } from "@/components/tenant-status-gate";
import { Button } from "@/components/ui/button";
import { billingView } from "@/lib/billing/billing-view";
import { cn } from "@/lib/utils";

/**
 * The yellow/red mensalidade banner, below the top bar, on every house
 * screen including the payment page itself — only the lock (not the
 * banner) is suppressed there. Can't be dismissed (binding constraint).
 */
export function BillingBanner() {
  const { data } = useTenantAccessStatus();
  const billing = data?.billing ?? null;
  if (!billing) return null;

  const view = billingView(billing);
  if (!view.banner) return null;

  const { tone, text, showPay, memberHint } = view.banner;

  return (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-center gap-3 border-b px-4 py-2.5 text-sm sm:px-6",
        tone === "yellow"
          ? "border-amber-500/40 bg-amber-500/10 text-amber-100"
          : "border-red-500/40 bg-red-500/10 text-red-100",
      )}
    >
      <AlertTriangle
        className={cn("h-4 w-4 shrink-0", tone === "yellow" ? "text-amber-400" : "text-red-400")}
        aria-hidden="true"
      />
      <p className="min-w-0 flex-1 basis-full leading-relaxed sm:basis-auto">
        {text}
        {memberHint && <span className="ml-1 text-xs opacity-80">{memberHint}</span>}
      </p>
      {showPay && (
        <Button
          asChild
          size="sm"
          className={cn(
            "w-full sm:w-auto",
            tone === "yellow"
              ? "bg-amber-500 text-amber-950 hover:bg-amber-500/90"
              : "bg-red-500 text-white hover:bg-red-500/90",
          )}
        >
          <Link to="/plano-e-creditos">Pagar agora</Link>
        </Button>
      )}
    </div>
  );
}
