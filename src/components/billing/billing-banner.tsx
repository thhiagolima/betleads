import { Link } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";

import { useTenantAccessStatus } from "@/components/tenant-status-gate";
import { Button } from "@/components/ui/button";
import { tourAnchor } from "@/help/anchor";
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
      {...tourAnchor("shell.faixa.mensalidade")}
      className={cn(
        "border-b px-4 py-2.5 text-sm text-foreground sm:px-6",
        tone === "yellow" ? "border-warning/40 bg-warning/10" : "border-danger/40 bg-danger/10",
      )}
    >
      {/* Same width as the page content and the other banners (max-w-[1600px]). */}
      <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 basis-full items-start gap-2 sm:basis-auto">
          <AlertTriangle
            className={cn(
              "h-4 w-4 shrink-0 translate-y-0.5",
              tone === "yellow" ? "text-warning" : "text-danger",
            )}
            aria-hidden="true"
          />
          <p className="min-w-0 leading-relaxed">
            {text}
            {memberHint && (
              <span className="ml-1 text-meta text-muted-foreground">{memberHint}</span>
            )}
          </p>
        </div>
        {showPay && (
          <Button
            asChild
            size="sm"
            className={cn(
              "w-full sm:w-auto",
              tone === "yellow"
                ? "bg-warning text-background hover:bg-warning/90"
                : "bg-danger text-white hover:bg-danger/90",
            )}
          >
            <Link to="/plano-e-creditos">Pagar agora</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
