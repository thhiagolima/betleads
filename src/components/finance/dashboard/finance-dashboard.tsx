// Financeiro painel (spec §5–§6, mockup financeiro-painel-v1.html): one view
// for a house, a group or every house. It owns the scope (super admin can
// change it with "Ver:") and the period (GroupPeriodBar), and reads
// getFinanceDashboard. Top to bottom (spec §3.2): result band, the "Do
// depósito ao lucro" waterfall, the KPI blocks (Movimentação, Aquisição, GGR,
// Envios e CRM), the 12-month chart and, in group/all scope, "Lucro por
// casa" and the goal scoreboard.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, type ReactNode } from "react";

import { GroupPeriodBar } from "@/components/group/group-period-bar";
import { defaultGroupPeriod, type GroupPeriod } from "@/components/group/period-options";
import { GroupScoreboard } from "@/components/group/group-scoreboard";
import { Card } from "@/components/ui/card";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  getFinanceDashboard,
  type DashboardScope,
  type FinanceDashboard,
} from "@/lib/finance-dashboard.functions";

import { FINANCE_DASHBOARD_QUERY_KEY } from "@/components/finance/query-keys";

import { periodLabel } from "./display";
import { KpiBlocks } from "./kpi-blocks";
import { PendingBanner } from "./pending-banner";
import { ProfitTrendChart, trendChartTitle, type TrendMetric } from "./profit-trend-chart";
import { ResultBand } from "./result-band";
import { scopeToValue, tenantClickAction } from "./scope";
import { ScopePicker } from "./scope-picker";
import { sendsBetleadsNote } from "./sends-block";
import { TenantProfitTable } from "./tenant-profit-table";
import { WaterfallChart } from "./waterfall-chart";

/** A painel card: 18px title on the left, an optional label on the right. */
function Section({
  title,
  aside,
  children,
}: {
  title?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0 rounded-[14px] p-5 sm:p-6">
      {title && (
        <div className="mb-3.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-lg font-semibold leading-tight">{title}</h2>
          {aside && <span className="text-[13px] text-muted-foreground">{aside}</span>}
        </div>
      )}
      {children}
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
  const { totals, tenants, kpis } = dashboard;
  // The 12-month chart's metric: its card title follows it.
  const [trendMetric, setTrendMetric] = useState<TrendMetric>("cashResult");

  return (
    // One TooltipProvider for every TermTooltip of the painel.
    <TooltipProvider delayDuration={150}>
      <div className="space-y-8">
        <PendingBanner
          scopeKind={dashboard.scope.kind}
          tenants={tenants}
          duplicateBetleadsCosts={dashboard.duplicateBetleadsCosts}
          onLaunchPending={onLaunchPending}
        />
        <ResultBand
          current={totals.current}
          previous={totals.previous}
          kpis={kpis}
          roiReference={dashboard.roiReference}
          houseCount={multi ? tenants.length : undefined}
        />
        <Section
          title={multi ? "Do depósito ao lucro (somado)" : "Do depósito ao lucro"}
          aside={periodLabel(dashboard.range)}
        >
          <WaterfallChart
            steps={dashboard.waterfall}
            withoutFee={totals.current.betleadsFee === null}
          />
        </Section>
        <KpiBlocks
          totals={totals}
          kpis={kpis}
          sends={dashboard.sends}
          exemptHouse={dashboard.exemptHouse}
          betleadsNote={sendsBetleadsNote(dashboard.range.from, dashboard.betleadsSince)}
        />
        <Section>
          <ProfitTrendChart
            title={trendChartTitle(multi, trendMetric)}
            months={dashboard.months}
            tenants={tenants}
            stacked={multi}
            betleadsSince={dashboard.betleadsSince}
            metric={trendMetric}
            onMetricChange={setTrendMetric}
          />
        </Section>
        {multi && (
          <Section title="Lucro por casa">
            <TenantProfitTable rows={tenants} onOpenTenant={onOpenTenant} />
          </Section>
        )}
        {multi && <GroupScoreboard rows={tenants} onRowClick={onOpenTenant} />}
      </div>
    </TooltipProvider>
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

  // A house row opens the caller's page, or moves the super admin's picker to
  // that house (see tenantClickAction).
  const clickAction = tenantClickAction({
    scope,
    initialScope,
    canPickScope,
    hasOnOpenTenant: !!onOpenTenant,
  });
  const openTenant =
    clickAction === "open"
      ? onOpenTenant
      : clickAction === "switch"
        ? (tenantId: string) => setScope({ kind: "tenant", tenantId })
        : undefined;

  const getDashboard = useServerFn(getFinanceDashboard);
  const query = useQuery({
    queryKey: [...FINANCE_DASHBOARD_QUERY_KEY, scope, period],
    queryFn: () =>
      getDashboard({
        data: { scope, range: period.range, compare: period.compare, preset: period.preset },
      }),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-4">
      {canPickScope && (
        <ScopePicker
          value={scope}
          currentLabel={
            query.data && scopeToValue(query.data.scope) === scopeToValue(scope)
              ? query.data.label
              : undefined
          }
          onChange={setScope}
        />
      )}
      <GroupPeriodBar value={period} onChange={setPeriod} />
      {query.isError ? (
        <p className="text-sm text-destructive">
          {(query.error as Error).message || "Não foi possível carregar o painel."}
        </p>
      ) : query.isLoading || !query.data ? (
        <div className="h-64 animate-pulse rounded-lg border border-border/40" />
      ) : (
        <DashboardBody
          dashboard={query.data}
          onOpenTenant={openTenant}
          // "Lançar agora" opens the caller's own grid, so it only applies
          // while the scope is still the one the caller passed in.
          onLaunchPending={scopeToValue(scope) === initialKey ? onLaunchPending : undefined}
        />
      )}
    </div>
  );
}
