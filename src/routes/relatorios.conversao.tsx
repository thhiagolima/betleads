import { createFileRoute, redirect } from "@tanstack/react-router";

// The executive conversion report was folded into the Central de Resultados;
// old links and bookmarks land there.
export const Route = createFileRoute("/relatorios/conversao")({
  beforeLoad: () => {
    throw redirect({ to: "/resultados" });
  },
});
