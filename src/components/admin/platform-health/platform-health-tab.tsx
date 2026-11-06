// Super-admin "Saúde" tab (Task 4, spec §5.2–5.3; Task 5/F3: alert state,
// actions and history): wires Task 3's `adminPlatformHealth` loader to the
// alert strip and house table. Polls every 60 s (same cadence as the server
// cache) so the super admin always sees a result at most a minute stale. A
// failed background refetch keeps the last data on screen (with a "Falha ao
// atualizar" line); the error screen only shows when there is no data at all.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CircleAlert, History } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DataCard } from "@/components/ui-premium/data-card";
import { HISTORY_DAYS } from "@/lib/platform-health/alert-lifecycle";
import {
  adminAcknowledgeAlert,
  adminAlertHistory,
  adminSilenceAlert,
} from "@/lib/platform-health/platform-alerts.functions";
import { adminPlatformHealth } from "@/lib/platform-health/platform-health.functions";
import type { PlatformHealth } from "@/lib/platform-health/platform-health.server";

import {
  AlertHistoryList,
  type AlertHistoryItem,
  type AlertWithStored,
  formatCheckedAt,
  HealthAlertsStrip,
} from "./health-alerts-strip";
import { HouseHealthTable } from "./house-health-table";

const QUERY_KEY = ["admin-platform-health"];
const HISTORY_QUERY_KEY = ["admin-platform-health", "history"];
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

function AlertHistoryDialog() {
  const [open, setOpen] = useState(false);
  const historyFn = useServerFn(adminAlertHistory);
  const { data, isLoading, isError } = useQuery({
    queryKey: HISTORY_QUERY_KEY,
    queryFn: () => historyFn() as Promise<AlertHistoryItem[]>,
    enabled: open,
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <History className="size-3.5" />
          Histórico ({HISTORY_DAYS} dias)
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Histórico de alertas ({HISTORY_DAYS} dias)</DialogTitle>
          <DialogDescription>Alertas resolvidos nos últimos {HISTORY_DAYS} dias.</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="h-10 animate-pulse rounded-md bg-muted" />
        ) : isError || !data ? (
          <p className="text-sm text-muted-foreground">Não foi possível carregar o histórico.</p>
        ) : (
          <AlertHistoryList history={data} />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function PlatformHealthTab() {
  const fn = useServerFn(adminPlatformHealth);
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => fn(),
    refetchInterval: 60_000,
  });

  const ackFn = useServerFn(adminAcknowledgeAlert);
  const silenceFn = useServerFn(adminSilenceAlert);
  // Fix round 1 (controller ruling): per-row pending state as a Set, not one shared
  // "pendingKey" between the two mutations — acting on two rows in quick succession must not
  // re-enable the wrong row's buttons.
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(() => new Set());

  function addPending(key: string) {
    setPendingKeys((prev) => new Set(prev).add(key));
  }
  function removePending(key: string) {
    setPendingKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }

  function invalidateHealth() {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }

  const ackMut = useMutation({
    mutationFn: (key: string) => ackFn({ data: { key } }),
    onMutate: (key) => addPending(key),
    onSuccess: invalidateHealth,
    onError: (error: Error) => toast.error(error.message),
    onSettled: (_data, _error, key) => removePending(key),
  });
  const silenceMut = useMutation({
    mutationFn: (key: string) => silenceFn({ data: { key } }),
    onMutate: (key) => addPending(key),
    onSuccess: invalidateHealth,
    onError: (error: Error) => toast.error(error.message),
    onSettled: (_data, _error, key) => removePending(key),
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
  const alerts = health.alerts as AlertWithStored[];

  function openAlert(alert: AlertWithStored & { href: string }) {
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
        actions={
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">verificado às {checkedAt}</span>
            <AlertHistoryDialog />
          </div>
        }
      >
        <HealthAlertsStrip
          alerts={alerts}
          checkedAt={health.checkedAt}
          onOpen={openAlert}
          onAcknowledge={(key) => ackMut.mutate(key)}
          onSilence={(key) => silenceMut.mutate(key)}
          pendingKeys={pendingKeys}
        />
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
