import { createFileRoute, redirect } from "@tanstack/react-router";
import { CentralResults } from "@/components/crm-results/central-results";
import { validateCentralSearch } from "@/components/crm-results/search";

export const Route = createFileRoute("/resultados")({
  validateSearch: validateCentralSearch,
  // Old links to the "Base de jogadores" tab: retention now lives in Aquisição e LTV.
  beforeLoad: ({ search }) => {
    if (search.aba === "base") throw redirect({ to: "/midia-ltv", hash: "retencao" });
  },
  component: CentralResults,
});
