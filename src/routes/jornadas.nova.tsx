import { createFileRoute } from "@tanstack/react-router";
import { JourneyEditor } from "@/components/journeys/journey-editor";
export const Route = createFileRoute("/jornadas/nova")({
  validateSearch: (search: Record<string, unknown>): { audience?: "system:all-leads" } =>
    search.audience === "system:all-leads" ? { audience: "system:all-leads" } : {},
  component: JourneyNewPage,
});
function JourneyNewPage() {
  const { audience } = Route.useSearch();
  return <JourneyEditor initialAudience={audience} />;
}
