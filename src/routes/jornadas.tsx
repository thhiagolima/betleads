import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";
import { JourneysHub } from "@/components/journeys/journeys-hub";

export const Route = createFileRoute("/jornadas")({ component: JourneysPage });
function JourneysPage() {
  const location = useLocation();
  if (location.pathname !== "/jornadas") return <Outlet />;
  return <JourneysHub />;
}
