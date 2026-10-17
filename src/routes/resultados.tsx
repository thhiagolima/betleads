import { createFileRoute } from "@tanstack/react-router";
import { CentralResults } from "@/components/crm-results/central-results";
import { validateCentralSearch } from "@/components/crm-results/search";

export const Route = createFileRoute("/resultados")({
  validateSearch: validateCentralSearch,
  component: CentralResults,
});
