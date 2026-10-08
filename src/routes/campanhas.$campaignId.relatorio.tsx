import { createFileRoute } from "@tanstack/react-router";
import { ConversionReport } from "@/components/conversion-report";

function CampaignReportRoute() {
  const { campaignId } = Route.useParams();
  return <ConversionReport sourceType="campaign" sourceId={campaignId} />;
}

export const Route = createFileRoute("/campanhas/$campaignId/relatorio")({
  component: CampaignReportRoute,
});
