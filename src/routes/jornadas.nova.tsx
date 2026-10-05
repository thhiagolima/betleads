import { createFileRoute } from "@tanstack/react-router";
import { JourneyEditor } from "@/components/journeys/journey-editor";
export const Route = createFileRoute("/jornadas/nova")({ component: JourneyNewPage });
function JourneyNewPage() {
  return <JourneyEditor />;
}
