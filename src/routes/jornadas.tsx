import { createFileRoute, Navigate, Outlet, useLocation } from "@tanstack/react-router";

export const Route = createFileRoute("/jornadas")({ component: JourneysPage });
function JourneysPage() {
  const location = useLocation();
  if (location.pathname !== "/jornadas") return <Outlet />;
  return <Navigate to="/automacoes" replace />;
}
