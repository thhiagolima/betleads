// Gates the app shell's content behind the first-access wizard. Super admins
// and non-admins never see the wizard (`getHouseSetupStatus.showWizard` is
// already `false` for them server-side — see `computeShowWizard`); while the
// status query is loading or has errored, children render anyway so a slow
// or failed call never blocks the app.
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { HOUSE_SETUP_STATUS_QUERY_KEY } from "@/components/house-config/house-config-query";
import { getHouseSetupStatus } from "@/lib/house-config.functions";
import { HouseSetupWizard } from "@/components/onboarding/house-setup-wizard";

export function OnboardingGate({ children }: { children: React.ReactNode }) {
  const fetchStatus = useServerFn(getHouseSetupStatus);
  const query = useQuery({
    queryKey: HOUSE_SETUP_STATUS_QUERY_KEY,
    queryFn: () => fetchStatus(),
  });

  if (query.isLoading || query.isError || !query.data?.showWizard) {
    return <>{children}</>;
  }

  // Full-viewport overlay, above the app shell (sidebar/header stay mounted
  // underneath but out of view) — its own scroll container, same dark
  // background as the rest of the app.
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background">
      <HouseSetupWizard />
    </div>
  );
}
