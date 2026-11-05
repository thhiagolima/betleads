// Gates the app shell's content behind the first-access wizard. Super admins
// and non-admins never see the wizard (`getHouseSetupStatus.showWizard` is
// already `false` for them server-side — see `computeShowWizard`); while the
// status query is loading or has errored, children render anyway so a slow
// or failed call never blocks the app.
//
// A house under an effective billing lock never sees the wizard: the lock
// card (TenantStatusGate) and /plano-e-creditos must stay reachable, and the
// wizard's overlay would cover them. The lock is read from the shared access
// status query (`useTenantAccessStatus`), not from the error the setup-status
// call throws for a locked house.
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import { useHelp } from "@/components/help/help-provider";
import { HOUSE_SETUP_STATUS_QUERY_KEY } from "@/components/house-config/house-config-query";
import { useTenantAccessStatus } from "@/components/tenant-status-gate";
import { billingView } from "@/lib/billing/billing-view";
import { getHouseSetupStatus } from "@/lib/house-config.functions";
import { HouseSetupWizard, type WizardStepId } from "@/components/onboarding/house-setup-wizard";

export function OnboardingGate({ children }: { children: React.ReactNode }) {
  const access = useTenantAccessStatus();
  const billing = access.data?.billing ?? null;
  const billingLocked = billing ? billingView(billing).lock !== null : false;

  const fetchStatus = useServerFn(getHouseSetupStatus);
  const query = useQuery({
    queryKey: HOUSE_SETUP_STATUS_QUERY_KEY,
    queryFn: () => fetchStatus(),
    enabled: !billingLocked,
  });

  const showWizard =
    !billingLocked && !query.isLoading && !query.isError && !!query.data?.showWizard;

  // The wizard's own step — mirrored from `HouseSetupWizard` (which owns the
  // real state) via `onStepChange`, just so the help override below can name
  // the right one.
  const [step, setStep] = useState<WizardStepId>("casa");

  // While the wizard shows, the screen underneath must not auto-start its
  // own tour (`setOverlayActive(true)`), and the help panel/tour must refer
  // to the wizard's own article instead (`setScreenOverride`), one tour per
  // step (`tour:onboarding#<passo>`). `OnboardingGate` is always mounted
  // under `__root`, never actually unmounting between a locked/loading state
  // and the wizard showing, so "ao montar"/"ao desmontar" is simply "while
  // showing"/"while not showing", applied on every render — no effect, no
  // cleanup needed.
  const { setOverlayActive, setScreenOverride } = useHelp();
  if (showWizard) {
    setOverlayActive(true);
    setScreenOverride("onboarding", step);
  } else {
    setOverlayActive(false);
    setScreenOverride(null);
  }

  if (!showWizard) {
    return <>{children}</>;
  }

  // Full-viewport overlay, above the app shell (sidebar/header stay mounted
  // underneath but out of view) — its own scroll container, same dark
  // background as the rest of the app.
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background">
      <HouseSetupWizard onStepChange={setStep} />
    </div>
  );
}
