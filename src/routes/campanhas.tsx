import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";

import { CampaignsHub } from "@/components/campaigns/campaigns-hub";

export const Route = createFileRoute("/campanhas")({ component: CampaignsPage });

function CampaignsPage() {
  const location = useLocation();
  if (location.pathname !== "/campanhas") return <Outlet />;

  return (
    <div className="mx-auto w-full max-w-[1180px] space-y-6 p-4 sm:p-6">
      <CampaignsHub />
    </div>
  );
}
