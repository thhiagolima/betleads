// House "Financeiro" page (spec §5): month grid with CRM columns and manual
// Anúncios/GGR, other costs of the month and rates/viewer settings. Visible
// to anyone with `can_view_finance` (admin, group manager, super admin, or
// a gestor the admin released) — the server double-checks on every call.
import { createFileRoute } from "@tanstack/react-router";
import { Wallet } from "lucide-react";

import { useActiveTenant } from "@/hooks/use-active-tenant";
import { PageHeader } from "@/components/ui-premium";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FinanceMonthView } from "@/components/finance/finance-month-grid";
import { FinanceOtherCosts } from "@/components/finance/finance-other-costs";
import { FinanceSettingsPanel } from "@/components/finance/finance-settings-panel";

export const Route = createFileRoute("/financeiro")({ component: FinanceiroPage });

function FinanceiroPage() {
  const { active, isLoading } = useActiveTenant();

  if (isLoading || !active) {
    return <div className="h-64 animate-pulse rounded-lg border border-border/40" />;
  }

  const canSee = active.role === "super_admin" || active.can_view_finance === true;
  if (!canSee) {
    return (
      <p className="text-sm text-muted-foreground">
        Você não tem acesso ao financeiro desta casa.
      </p>
    );
  }

  return (
    <div className="space-y-6 max-w-6xl">
      <PageHeader
        title="Financeiro"
        subtitle="Fechamento mensal da casa: anúncios, GGR, taxas e resultado caixa."
        icon={<Wallet className="h-5 w-5 text-primary-foreground" />}
      />

      <Tabs defaultValue="mes">
        <TabsList>
          <TabsTrigger value="mes">Mês</TabsTrigger>
          <TabsTrigger value="outros-custos">Outros custos</TabsTrigger>
          <TabsTrigger value="configuracoes">Configurações</TabsTrigger>
        </TabsList>

        <TabsContent value="mes" className="mt-4">
          <FinanceMonthView tenantId={active.id} />
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
