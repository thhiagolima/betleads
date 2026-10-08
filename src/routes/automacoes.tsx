import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";
import { JourneysHub } from "@/components/journeys/journeys-hub";

export const Route = createFileRoute("/automacoes")({ component: AutomationsPage });

function AutomationsPage() {
  const location = useLocation();
  if (location.pathname !== "/automacoes") return <Outlet />;
  return <JourneysHub />;
}
