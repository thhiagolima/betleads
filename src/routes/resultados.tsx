import { createFileRoute } from "@tanstack/react-router";
import { CentralResults } from "@/components/crm-results/central-results";

export const Route = createFileRoute("/resultados")({
  component: CentralResults,
});
