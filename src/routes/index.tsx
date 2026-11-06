import { Navigate, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo } from "react";

import {
  CashflowChart,
  CrmCard,
  DashboardError,
  DashboardSkeleton,
  HomeHeader,
  HomeKpiCards,
  LiveFeed,
  SecondaryMetrics,
} from "@/components/home/dashboard-blocks";
import { PeriodPicker } from "@/components/home/period-picker";
import { DomainVerifiedNotice } from "@/components/onboarding/domain-verified-notice";
import { HouseSetupChecklist } from "@/components/onboarding/house-setup-checklist";
import { useActiveTenant } from "@/hooks/use-active-tenant";
import { brtDayKeyLocal, useHomePeriod } from "@/hooks/use-home-period";
import { POLL_INTERVALS, useUpdatedAgo } from "@/hooks/use-updated-ago";
import { getDashboardSummary } from "@/lib/dashboard.functions";
import { greetingFor } from "@/lib/home-dashboard";
import { homeRedirect } from "@/lib/navigation";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

// The blocks (KPIs, chart, Recuperado, secondary metrics, Ao vivo) live in
// dashboard-blocks.tsx and are shared with the expert home (/expert), which
// shows the same layout restricted to the expert's leads.
function Dashboard() {
  const period = useHomePeriod();
  const { from, to, includesToday } = period;

  // The house is chosen only in the header; the home follows it.
  const tenant = useActiveTenant();
  const tenantId = tenant.data?.activeTenantId ?? null;

  const fetchDashboard = useServerFn(getDashboardSummary);
  const { data, isLoading, isFetching, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["dashboard", tenantId, brtDayKeyLocal(from), brtDayKeyLocal(to)],
    queryFn: () =>
      fetchDashboard({
        data: {
          tenantId: tenantId as string,
          from: from.toISOString(),
          to: to.toISOString(),
        },
      }),
    enabled: !!tenantId,
    staleTime: includesToday ? 20_000 : 5 * 60_000,
    refetchInterval: includesToday ? POLL_INTERVALS.dashboard : false,
    placeholderData: (previous) => previous,
    retry: 1,
  });
  const updatedAgo = useUpdatedAgo(dataUpdatedAt || undefined);
  const greeting = useMemo(() => greetingFor(), []);
  const sparkline = useMemo(
    () => (data?.cashflowChart ?? []).map((row) => ({ value: row.deposits })),
    [data?.cashflowChart],
  );

  if (tenant.isLoading || (Boolean(tenantId) && isLoading)) return <DashboardSkeleton />;

  // A group manager with no house role has nothing here: send them to the group panel.
  const redirectTo = homeRedirect(tenant.tenants.length, tenant.data?.groups?.length ?? 0);
  if (redirectTo) return <Navigate to={redirectTo} replace />;

  const loadError = tenant.error ?? error;
  if (loadError || !tenantId || !data) {
    const message =
      loadError instanceof Error
        ? loadError.message
        : !tenantId
          ? "Nenhuma casa disponível para este usuário."
          : "Não foi possível carregar os dados do painel.";
    return (
      <DashboardError
        message={message}
        onRetry={() => {
          void tenant.refetch();
          void refetch();
        }}
      />
    );
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 pb-4 sm:space-y-5" aria-busy={isFetching}>
      <HomeHeader
        title={greeting}
        rangeText={period.rangeText}
        isFetching={isFetching}
        updatedAgo={updatedAgo}
        includesToday={includesToday}
        picker={
          <PeriodPicker preset={period.preset} range={period.range} onChange={period.onChange} />
        }
      />

      <DomainVerifiedNotice />
      <HouseSetupChecklist />

      <HomeKpiCards data={data} sparkline={sparkline} />

      <div className="grid gap-3 sm:gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="order-2 min-w-0 lg:order-1">
          <CashflowChart data={data} />
        </div>
        <div className="order-1 lg:order-2">
          <CrmCard data={data} house={data} />
        </div>
      </div>

      <SecondaryMetrics data={data} />

      <LiveFeed events={data.liveEvents} showAllEventsLink />

      <p className="text-xs leading-relaxed text-muted-foreground">
        Recuperado pelo CRM considera depósitos feitos em até 7 dias depois de um clique humano em
        link de campanha ou jornada, sem quem já estava ativo; gasto em SMS é o preço por segmento
        vezes os segmentos enviados. Datas no fuso de Brasília.
      </p>
    </div>
  );
}
