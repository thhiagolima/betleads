import { Link } from "@tanstack/react-router";
import { LockKeyhole } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { BillingLock as BillingLockView } from "@/lib/billing/billing-view";

/** The full-screen lock card for a billing-locked house (Task 6). */
export function BillingLock({ view }: { view: BillingLockView | null }) {
  if (!view) return null;

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="w-full max-w-xl border-red-500/40 bg-red-500/10 shadow-xl shadow-black/20">
        <CardContent className="space-y-3 p-6 text-center">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg bg-red-500/15">
            <LockKeyhole className="h-5 w-5 text-red-300" />
          </div>
          <p className="text-lg font-semibold text-red-100">{view.title}</p>
          <p className="text-sm leading-relaxed text-red-200/90">{view.text}</p>
          {view.showPay && (
            <div className="pt-2">
              <Button asChild className="bg-red-500 text-white hover:bg-red-500/90">
                <Link to="/plano-e-creditos">Ir para o pagamento</Link>
              </Button>
            </div>
          )}
          {view.memberHint && (
            <p className="text-xs text-muted-foreground">{view.memberHint}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
