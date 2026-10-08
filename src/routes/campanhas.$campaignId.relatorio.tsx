import { createFileRoute } from "@tanstack/react-router";
import { ConversionReport } from "@/components/conversion-report";
export const Route = createFileRoute("/campanhas/$campaignId/relatorio")({
  component: () => (
    <ConversionReport sourceType="campaign" sourceId={Route.useParams().campaignId} />
  ),
});
