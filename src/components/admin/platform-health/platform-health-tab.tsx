// Super-admin "Saúde" tab (Task 4, spec §5.2–5.3): wires Task 3's
// `adminPlatformHealth` loader to the alert strip and house table. Polls
// every 60 s (same cadence as the server cache) so the super admin always
// sees a result at most a minute stale. A failed background refetch keeps
// the last data on screen (with a "Falha ao atualizar" line); the error
// screen only shows when there is no data at all.
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CircleAlert } from "lucide-react";

import { DataCard } from "@/components/ui-premium/data-card";
import type { PlatformAlert } from "@/lib/platform-health/alert-rules";
import { adminPlatformHealth } from "@/lib/platform-health/platform-health.functions";
import type { PlatformHealth } from "@/lib/platform-health/platform-health.server";

import { formatCheckedAt, HealthAlertsStrip } from "./health-alerts-strip";
import { HouseHealthTable } from "./house-health-table";

const QUERY_KEY = ["admin-platform-health"];
const ACTIVE_TENANT_KEY = "betleads:active-tenant";

/**
 * Same mechanism as `ActiveTenantSwitcher`: set the house, then
 * hard-navigate. `/admin` screens are platform-wide, so they keep the
 * current active house.
 */
export function openHref(href: string, tenantId: string | null) {
  const isAdminScreen =
    href === "/admin" || href.startsWith("/admin#") || href.startsWith("/admin/");
  if (tenantId && !isAdminScreen) window.localStorage.setItem(ACTIVE_TENANT_KEY, tenantId);
  window.location.assign(href);
}

export function PlatformHealthTab() {
  const fn = useServerFn(adminPlatformHealth);
  const { data, isLoading, isError } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => fn(),
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-28 animate-pulse rounded-2xl border border-border bg-card/80" />
        <div className="h-28 animate-pulse rounded-2xl border border-border bg-card/80" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
        <CircleAlert className="size-4" />
        Não foi possível carregar a saúde das casas.
      </div>
    );
  }

  const health = data as PlatformHealth;
  const checkedAt = formatCheckedAt(health.checkedAt);

  function openAlert(alert: PlatformAlert & { href: string }) {
    openHref(alert.href, alert.tenantId);
  }

  function openHouse(tenantId: string) {
    openHref("/resultados", tenantId);
  }

  return (
    <div className="space-y-4">
      {isError && (
        <p className="flex items-center gap-2 text-xs text-warning" role="status">
          <CircleAlert className="size-3.5" />
          Falha ao atualizar — mostrando dados de {checkedAt}
        </p>
      )}
      <DataCard
        title="Alertas técnicos"
        description="Robôs, webhooks, filas, fornecedores, saldo e cobrança. Clique em um alerta para resolver."
        actions={<span className="text-xs text-muted-foreground">verificado às {checkedAt}</span>}
      >
        <HealthAlertsStrip alerts={health.alerts} checkedAt={health.checkedAt} onOpen={openAlert} />
      </DataCard>
      <DataCard
        title="Casas"
        description="Últimos 7 dias contra a média das 4 semanas anteriores. Clique em uma casa para abrir os resultados dela."
      >
        <HouseHealthTable
          houses={health.houses}
          quietHouses={health.quietHouses}
          range={health.window}
          housesUnavailable={health.housesUnavailable}
          recoveryUnavailable={health.recoveryUnavailable}
          onOpenHouse={openHouse}
        />
      </DataCard>
    </div>
  );
}
