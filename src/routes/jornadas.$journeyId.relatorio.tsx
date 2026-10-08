import { createFileRoute } from "@tanstack/react-router";
import { ConversionReport } from "@/components/conversion-report";
export const Route = createFileRoute("/jornadas/$journeyId/relatorio")({
  component: () => <ConversionReport sourceType="journey" sourceId={Route.useParams().journeyId} />,
});
