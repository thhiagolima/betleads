import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";

import { CampaignsHub } from "@/components/campaigns/campaigns-hub";
import { ExpertCampaignsHub } from "@/components/campaigns/expert-campaigns-hub";
import { Page } from "@/components/ui-premium/page-header";
import { useCampaignDataSource } from "@/hooks/use-campaign-data-source";

export const Route = createFileRoute("/campanhas")({ component: CampaignsPage });

function CampaignsPage() {
  const location = useLocation();
  // Same screen for the house and the expert; the shell mounts it only once
  // the role is known (shellContentState), so this never flips while mounted.
  const { isExpert } = useCampaignDataSource();
  if (location.pathname !== "/campanhas") return <Outlet />;

  return <Page>{isExpert ? <ExpertCampaignsHub /> : <CampaignsHub />}</Page>;
}
