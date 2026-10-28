// House "Financeiro" page (spec §4, §5, §9): Painel (default) with the
// result dashboard, Lançamentos (month grid with CRM columns and manual
// Anúncios/GGR), other costs of the month and rates/viewer settings. Visible
// to anyone with `can_view_finance` (admin, group manager, super admin, or
// a gestor the admin released) — the server double-checks on every call.
// The open tab, and the month/day "Lançar agora" lands on, live in the URL.
import { createFileRoute } from "@tanstack/react-router";
import { Wallet } from "lucide-react";

import { useActiveTenant } from "@/hooks/use-active-tenant";
import { PageHeader } from "@/components/ui-premium";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FinanceDashboardView } from "@/components/finance/dashboard/finance-dashboard";
import { FinanceMonthView } from "@/components/finance/finance-month-grid";
import { FinanceOtherCosts } from "@/components/finance/finance-other-costs";
import { FinanceSettingsPanel } from "@/components/finance/finance-settings-panel";
import {
  launchPendingSearch,
  parseFinanceSearch,
  type FinanceSearch,
  type FinanceTab,
} from "@/lib/finance/search";

export const Route = createFileRoute("/financeiro")({
  validateSearch: (search: Record<string, unknown>): FinanceSearch => parseFinanceSearch(search),
  component: FinanceiroPage,
});

function FinanceiroPage() {
  const { active, isLoading } = useActiveTenant();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  if (isLoading || !active) {
    return <div className="h-64 animate-pulse rounded-lg border border-border/40" />;
  }

  const canSee = active.role === "super_admin" || active.can_view_finance === true;
  if (!canSee) {
    return (
      <p className="text-sm text-muted-foreground">Você não tem acesso ao financeiro desta casa.</p>
    );
  }

  const tab = search.tab ?? "painel";
  // Changing tab drops month/dia: they only mean something for "Lançar agora".
  const openTab = (next: string) =>
    void navigate({ search: next === "painel" ? {} : { tab: next as FinanceTab } });

  return (
    <div className="space-y-6 max-w-6xl">
      <PageHeader
        title="Financeiro"
        subtitle="Fechamento mensal da casa: anúncios, GGR, taxas e resultado caixa."
        icon={<Wallet className="h-5 w-5 text-primary-foreground" />}
      />

      <Tabs value={tab} onValueChange={openTab}>
        <div className="max-w-full overflow-x-auto">
          <TabsList>
            <TabsTrigger value="painel">Painel</TabsTrigger>
            <TabsTrigger value="lancamentos">Lançamentos</TabsTrigger>
            <TabsTrigger value="outros-custos">Outros custos</TabsTrigger>
            <TabsTrigger value="configuracoes">Configurações</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="painel" className="mt-4">
          <FinanceDashboardView
            initialScope={{ kind: "tenant", tenantId: active.id }}
            canPickScope={active.role === "super_admin"}
            onLaunchPending={(date) => void navigate({ search: launchPendingSearch(date) })}
          />
        </TabsContent>

        <TabsContent value="lancamentos" className="mt-4">
          <FinanceMonthView
            tenantId={active.id}
            initialMonth={search.month}
            focusDate={search.dia}
          />
        </TabsContent>

        <TabsContent value="outros-custos" className="mt-4">
          <FinanceOtherCosts tenantId={active.id} />
        </TabsContent>

        <TabsContent value="configuracoes" className="mt-4">
          <FinanceSettingsPanel tenantId={active.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
