import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/regras")({
  component: RegrasRedirect,
});

function RegrasRedirect() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate({ to: "/gamificacao", replace: true });
  }, [navigate]);

  return null;
}
