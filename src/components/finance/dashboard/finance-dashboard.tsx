// Financeiro painel (spec §5–§6, mockup financeiro-painel-v1.html): one view
// for a house, a group or every house. It owns the scope (super admin can
// change it with "Ver:") and the period (month picker on), and reads
// getFinanceDashboard. Group/all scope adds "Lucro por casa" right after the
// cards, as in the mockup, and the goal scoreboard at the bottom.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, type ReactNode } from "react";

import {
  defaultGroupPeriod,
  GroupPeriodBar,
  type GroupPeriod,
} from "@/components/group/group-period-bar";
import { GroupScoreboard } from "@/components/group/group-scoreboard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getFinanceDashboard,
  type DashboardScope,
  type FinanceDashboard,
} from "@/lib/finance-dashboard.functions";

import { CostBreakdown } from "./cost-breakdown";
import { KpiCards } from "./kpi-cards";
import { PendingBanner } from "./pending-banner";
import { ProfitTrendChart } from "./profit-trend-chart";
import { ScopePicker, scopeToValue } from "./scope-picker";
import { TenantProfitTable } from "./tenant-profit-table";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 sm:px-5 sm:pb-5">{children}</CardContent>
    </Card>
  );
}

function DashboardBody({
  dashboard,
  onOpenTenant,
  onLaunchPending,
}: {
  dashboard: FinanceDashboard;
  onOpenTenant?: (tenantId: string) => void;
  onLaunchPending?: (firstDate: string) => void;
}) {
  const multi = dashboard.scope.kind !== "tenant";
  const { totals, tenants } = dashboard;

  return (
    <div className="space-y-4">
      <PendingBanner
        scopeKind={dashboard.scope.kind}
        tenants={tenants}
        duplicateBetleadsCosts={dashboard.duplicateBetleadsCosts}
        onLaunchPending={onLaunchPending}
      />
      <KpiCards
        current={totals.current}
        previous={totals.previous}
        houseCount={multi ? tenants.length : undefined}
      />
      {multi && (
        <Section title="Lucro por casa">
          <TenantProfitTable rows={tenants} onOpenTenant={onOpenTenant} />
        </Section>
      )}
      <Section
        title={
          multi
            ? "Lucro líquido · últimos 12 meses (empilhado por casa)"
            : "Lucro líquido · últimos 12 meses"
        }
      >
        <ProfitTrendChart
          months={dashboard.months}
          tenants={tenants}
          stacked={multi}
          betleadsSince={dashboard.betleadsSince}
        />
      </Section>
      <Section title={multi ? "Para onde foi o dinheiro (somado)" : "Para onde foi o dinheiro"}>
        <CostBreakdown costs={dashboard.costs} />
      </Section>
      {multi && <GroupScoreboard rows={tenants} onRowClick={onOpenTenant} />}
    </div>
  );
}

export function FinanceDashboardView({
  initialScope,
  canPickScope,
  onOpenTenant,
  onLaunchPending,
}: {
  initialScope: DashboardScope;
  canPickScope: boolean;
  onOpenTenant?: (tenantId: string) => void;
  onLaunchPending?: (firstDate: string) => void;
}) {
  const [scope, setScope] = useState<DashboardScope>(initialScope);
  const [period, setPeriod] = useState<GroupPeriod>(defaultGroupPeriod);

  // A new initialScope from the caller (e.g. the header's house switcher)
  // replaces the picked one.
  const initialKey = scopeToValue(initialScope);
  const [seenInitialKey, setSeenInitialKey] = useState(initialKey);
  if (initialKey !== seenInitialKey) {
    setSeenInitialKey(initialKey);
    setScope(initialScope);
  }

  const getDashboard = useServerFn(getFinanceDashboard);
  const query = useQuery({
    queryKey: ["finance-dashboard", scope, period],
    queryFn: () =>
      getDashboard({
        data: { scope, range: period.range, compare: period.compare, preset: period.preset },
      }),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-4">
      {canPickScope && <ScopePicker value={scope} onChange={setScope} />}
      <GroupPeriodBar value={period} onChange={setPeriod} monthPicker />
      {query.isError ? (
        <p className="text-sm text-destructive">
          {(query.error as Error).message || "Não foi possível carregar o painel."}
        </p>
      ) : query.isLoading || !query.data ? (
        <div className="h-64 animate-pulse rounded-lg border border-border/40" />
      ) : (
        <DashboardBody
          dashboard={query.data}
          onOpenTenant={onOpenTenant}
          onLaunchPending={onLaunchPending}
        />
      )}
    </div>
  );
}
