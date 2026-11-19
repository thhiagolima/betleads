// /grupo/casa — read-only financial close of one house of the active group
// (spec §4, §6): Painel (the house's dashboard) and Lançamentos
// (FinanceMonthView with readOnly). The house must belong to the active
// group, otherwise "Casa fora do grupo".
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, RefreshCw } from "lucide-react";

import { Page, PageHeader } from "@/components/ui-premium";
import { EmptyState } from "@/components/ui-premium/empty-state";
import { PageTabs } from "@/components/ui-premium/page-tabs";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FinanceDashboardView } from "@/components/finance/dashboard/finance-dashboard";
import { FinanceMonthView } from "@/components/finance/finance-month-grid";
import { useActiveGroup } from "@/hooks/use-active-group";
import { getGroupPeople } from "@/lib/groups.functions";
import { parseFinanceSearch, type FinanceTab } from "@/lib/finance/search";

const GROUP_HOUSE_TABS: readonly FinanceTab[] = ["painel", "lancamentos"];

const GROUP_HOUSE_TAB_ITEMS: ReadonlyArray<{ value: FinanceTab; label: string }> = [
  { value: "painel", label: "Painel" },
  { value: "lancamentos", label: "Lançamentos" },
];

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
    return (
      <Page className="max-w-6xl">
        <PageHeader title="Financeiro da casa" />
        <p className="text-sm text-muted-foreground">Você não gerencia nenhum grupo.</p>
      </Page>
    );
  }

  if (!active || query.isLoading) {
    return <div className="h-64 animate-pulse rounded-lg border border-border/40" />;
  }

  if (query.isError || !query.data) {
    return (
      <Page className="max-w-6xl">
        <PageHeader title="Financeiro da casa" />
        <Card>
          <EmptyState
            title="Não foi possível carregar as casas do grupo"
            description="Confira a internet e tente de novo."
            action={
              <Button
                variant="outline"
                disabled={query.isFetching}
                onClick={() => void query.refetch()}
              >
                <RefreshCw className="mr-2 size-4" aria-hidden="true" />
                Tentar novamente
              </Button>
            }
          />
        </Card>
      </Page>
    );
  }

  const tenant = query.data.tenants.find((t) => t.id === tenantId);
  if (!tenant) {
    return (
      <Page className="max-w-6xl">
        <PageHeader title="Financeiro da casa" />
        <Card>
          <EmptyState
            title="Casa fora do grupo"
            description="Esta casa não faz parte do grupo escolhido no topo da tela."
            action={
              <Button variant="outline" asChild>
                <Link to="/grupo">
                  <ArrowLeft className="mr-2 size-4" aria-hidden="true" />
                  Voltar ao grupo
                </Link>
              </Button>
            }
          />
        </Card>
      </Page>
    );
  }

  const tab = search.tab ?? "painel";

  return (
    <Page className="max-w-6xl">
      <PageHeader
        title={`Financeiro — ${tenant.nome}`}
        subtitle="Fechamento mensal, só leitura, visto do grupo."
      />
      <PageTabs
        value={tab}
        onValueChange={(next) =>
          void navigate({
            search: next === "painel" ? { tenant: tenantId } : { tenant: tenantId, tab: next },
          })
        }
        label="Seções do financeiro da casa"
        items={GROUP_HOUSE_TAB_ITEMS}
      />

      <div role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "painel" && (
          <FinanceDashboardView
            initialScope={{ kind: "tenant", tenantId: tenant.id }}
            canPickScope={false}
            // No "Lançar agora": this view is read-only, nothing to launch here.
          />
        )}

        {tab === "lancamentos" && (
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
        )}
      </div>
    </Page>
  );
}
