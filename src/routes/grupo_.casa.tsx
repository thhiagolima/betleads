// /grupo/casa — read-only financial close of one house of the active group
// (spec §6). Reuses FinanceMonthView (Task 6) with readOnly; the house must
// belong to the active group, otherwise "Casa fora do grupo".
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Wallet } from "lucide-react";

import { PageHeader } from "@/components/ui-premium";
import { FinanceMonthView } from "@/components/finance/finance-month-grid";
import { useActiveGroup } from "@/hooks/use-active-group";
import { getGroupPeople } from "@/lib/groups.functions";

export const Route = createFileRoute("/grupo_/casa")({
  validateSearch: (search: Record<string, unknown>) => ({
    tenant: typeof search.tenant === "string" && search.tenant.trim() ? search.tenant.trim() : "",
  }),
  component: GrupoCasaPage,
});

function GrupoCasaPage() {
  const { tenant: tenantId } = Route.useSearch();
  const { groups, active } = useActiveGroup();

  const getPeople = useServerFn(getGroupPeople);
  const query = useQuery({
    queryKey: ["group-people", active?.id],
    queryFn: () => getPeople({ data: { groupId: active!.id } }),
    enabled: !!active,
  });

  if (!groups.length) {
    return <p className="text-sm text-muted-foreground">Você não gerencia nenhum grupo.</p>;
  }

  if (!active || query.isLoading || !query.data) {
    return <div className="h-64 animate-pulse rounded-lg border border-border/40" />;
  }

  const tenant = query.data.tenants.find((t) => t.id === tenantId);
  if (!tenant) {
    return <p className="text-sm text-muted-foreground">Casa fora do grupo.</p>;
  }

  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader
        title={`Financeiro — ${tenant.nome}`}
        subtitle="Fechamento mensal, só leitura, visto do grupo."
        icon={<Wallet className="h-5 w-5 text-primary-foreground" />}
      />
      <FinanceMonthView tenantId={tenant.id} readOnly />
    </div>
  );
}
