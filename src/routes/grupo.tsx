// Financeiro do grupo (spec §4, §6): the finance dashboard in the active
// group's scope — cards, "Lucro por casa", 12-month chart, costs and the
// goal scoreboard. A house row opens /grupo/casa. The super admin also gets
// the "Ver:" picker (all houses / any group / any house); outside the active
// group a row click moves the picker to that house instead (tenantClickAction).
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Trophy } from "lucide-react";

import { FinanceDashboardView } from "@/components/finance/dashboard/finance-dashboard";
import { PageHeader } from "@/components/ui-premium";
import { useActiveGroup } from "@/hooks/use-active-group";
import { useIsSuperAdmin } from "@/hooks/use-is-super-admin";

export const Route = createFileRoute("/grupo")({ component: GrupoFinanceiroPage });

function GrupoFinanceiroPage() {
  const { groups, active } = useActiveGroup();
  const { isSuperAdmin } = useIsSuperAdmin();
  const navigate = useNavigate();

  if (!groups.length) {
    return <p className="text-sm text-muted-foreground">Você não gerencia nenhum grupo.</p>;
  }

  if (!active) {
    return <div className="h-64 animate-pulse rounded-lg border border-border/40" />;
  }

  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader
        title={`Grupo ${active.nome}`}
        subtitle="Resultado consolidado do grupo e de cada casa."
        icon={<Trophy className="h-5 w-5 text-primary-foreground" />}
      />
      {/* Keyed by the group: switching it in the header resets scope and period. */}
      <FinanceDashboardView
        key={active.id}
        initialScope={{ kind: "group", groupId: active.id }}
        canPickScope={isSuperAdmin}
        onOpenTenant={(tenantId) =>
          void navigate({ to: "/grupo/casa", search: { tenant: tenantId } })
        }
      />
    </div>
  );
}
