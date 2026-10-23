import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";

import { CampaignsHub } from "@/components/campaigns/campaigns-hub";
import { Page } from "@/components/ui-premium/page-header";

export const Route = createFileRoute("/campanhas")({ component: CampaignsPage });

function CampaignsPage() {
  const location = useLocation();
  if (location.pathname !== "/campanhas") return <Outlet />;

  return (
    <Page>
      <CampaignsHub />
    </Page>
  );
}
