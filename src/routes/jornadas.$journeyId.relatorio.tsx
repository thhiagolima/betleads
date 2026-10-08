import { createFileRoute } from "@tanstack/react-router";
import { ConversionReport } from "@/components/conversion-report";

function JourneyReportRoute() {
  const { journeyId } = Route.useParams();
  return <ConversionReport sourceType="journey" sourceId={journeyId} />;
}

export const Route = createFileRoute("/jornadas/$journeyId/relatorio")({
  component: JourneyReportRoute,
});
