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
import { useEffect, useState } from "react";

import { useHelp } from "@/components/help/help-provider";
import { HOUSE_SETUP_STATUS_QUERY_KEY } from "@/components/house-config/house-config-query";
import { useTenantAccessStatus } from "@/components/tenant-status-gate";
import { billingView } from "@/lib/billing/billing-view";
import { getHouseSetupStatus } from "@/lib/house-config.functions";
import { HouseSetupWizard, type WizardStepId } from "@/components/onboarding/house-setup-wizard";

/** Pure: what the help context should look like while the wizard
 * shows/doesn't show — `OnboardingGate`'s `useEffect` just applies this.
 * Kept pure (and exported) so it's unit-testable without React: effects
 * never run under `renderToStaticMarkup` (no jsdom in this repo).
 *
 * While the setup-status query is still loading nobody knows yet whether
 * the wizard will cover the screen, so the overlay flag is already on (the
 * screen underneath must not auto-start its tour in that window); the
 * override to the wizard's own article only happens once it really shows.
 * A billing-locked house never sees the wizard, so it never blocks. */
export function onboardingHelpTarget(
  state: { billingLocked: boolean; loading: boolean; showWizard: boolean },
  step: WizardStepId,
): { overlayActive: boolean; overrideRoute: string | null; overrideTab: string | null } {
  const overlayActive = !state.billingLocked && (state.loading || state.showWizard);
  if (!state.showWizard) return { overlayActive, overrideRoute: null, overrideTab: null };
  return { overlayActive, overrideRoute: "onboarding", overrideTab: step };
}

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

  const loading = query.isLoading;
  const showWizard = !billingLocked && !loading && !query.isError && !!query.data?.showWizard;

  // The wizard's own step — mirrored from `HouseSetupWizard` (which owns the
  // real state) via `onStepChange`, just so the help override below can name
  // the right one.
  const [step, setStep] = useState<WizardStepId>("casa");

  // While the wizard shows, the screen underneath must not auto-start its
  // own tour (`setOverlayActive(true)`), and the help panel/tour must refer
  // to the wizard's own article instead (`setScreenOverride`), one tour per
  // step (`tour:onboarding#<passo>`). Both are state setters owned by the
  // ancestor `HelpProvider` — calling them during this component's own
  // render (instead of an effect) triggers a render-phase update to a
  // different component and, since `setScreenOverride` used to build a new
  // object on every call, re-renders `HelpProvider` → re-renders this gate →
  // calls it again: an infinite loop in a real browser. A `useEffect` is
  // the correct place for this; cleanup reverts both when the wizard stops
  // showing or the step changes.
  const { setOverlayActive, setScreenOverride } = useHelp();
  useEffect(() => {
    const target = onboardingHelpTarget({ billingLocked, loading, showWizard }, step);
    setOverlayActive(target.overlayActive);
    setScreenOverride(target.overrideRoute, target.overrideTab);
    return () => {
      setOverlayActive(false);
      setScreenOverride(null);
    };
  }, [billingLocked, loading, showWizard, step, setOverlayActive, setScreenOverride]);

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
