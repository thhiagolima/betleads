import { createFileRoute, redirect } from "@tanstack/react-router";

// Old "Regras" page moved to Gamificação. Redirect before rendering (no blank flash).
export const Route = createFileRoute("/regras")({
  beforeLoad: () => {
    throw redirect({ to: "/gamificacao", replace: true });
  },
});
