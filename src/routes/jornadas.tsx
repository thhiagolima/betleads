import { createFileRoute } from "@tanstack/react-router";
import { JourneysHub } from "@/components/journeys/journeys-hub";

export const Route = createFileRoute("/jornadas")({ component: JourneysPage });
function JourneysPage() {
  return <JourneysHub />;
}
