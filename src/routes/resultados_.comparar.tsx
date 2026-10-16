import { createFileRoute } from "@tanstack/react-router";
import { TenantComparison } from "@/components/crm-results/tenant-comparison";

export const Route = createFileRoute("/resultados_/comparar")({
  component: TenantComparison,
});
