// /grupo/casa — read-only financial close of one house of the active group
// (spec §4, §6): Painel (the house's dashboard) and Lançamentos
// (FinanceMonthView with readOnly). The house must belong to the active
// group, otherwise "Casa fora do grupo".
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Wallet } from "lucide-react";

import { PageHeader } from "@/components/ui-premium";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FinanceDashboardView } from "@/components/finance/dashboard/finance-dashboard";
import { FinanceMonthView } from "@/components/finance/finance-month-grid";
import { useActiveGroup } from "@/hooks/use-active-group";
import { getGroupPeople } from "@/lib/groups.functions";
import { parseFinanceSearch, type FinanceTab } from "@/lib/finance/search";

const GROUP_HOUSE_TABS: readonly FinanceTab[] = ["painel", "lancamentos"];

export const Route = createFileRoute("/grupo_/casa")({
  validateSearch: (search: Record<string, unknown>) => ({
    tenant: typeof search.tenant === "string" && search.tenant.trim() ? search.tenant.trim() : "",
    ...parseFinanceSearch(search, GROUP_HOUSE_TABS),
  }),
  component: GrupoCasaPage,
});

function GrupoCasaPage() {
  const search = Route.useSearch();
  const tenantId = search.tenant;
  const navigate = Route.useNavigate();
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
      <Tabs
        value={search.tab ?? "painel"}
        onValueChange={(next) =>
          void navigate({
            search:
              next === "painel"
                ? { tenant: tenantId }
                : { tenant: tenantId, tab: next as FinanceTab },
          })
        }
      >
        <TabsList>
          <TabsTrigger value="painel">Painel</TabsTrigger>
          <TabsTrigger value="lancamentos">Lançamentos</TabsTrigger>
        </TabsList>

        <TabsContent value="painel" className="mt-4">
          <FinanceDashboardView
            initialScope={{ kind: "tenant", tenantId: tenant.id }}
            canPickScope={false}
            // No "Lançar agora": this view is read-only, nothing to launch here.
          />
        </TabsContent>

        <TabsContent value="lancamentos" className="mt-4">
          <FinanceMonthView
            tenantId={tenant.id}
            readOnly
            initialMonth={search.month}
            focusDate={search.dia}
            onDayChange={(dia) =>
              void navigate({
                search: (prev) => ({
                  ...prev,
                  month: dia ? dia.slice(0, 7) : prev.month,
                  dia: dia ?? undefined,
                }),
                replace: true,
              })
            }
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
