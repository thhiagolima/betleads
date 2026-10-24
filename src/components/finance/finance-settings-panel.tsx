// "Configurações" of the house finance (spec §5): current GGR/movement
// rates plus history, editable from a given day on (canEditRates), and
// per-gestor viewer grants (canManageViewers). Both sections are read-only
// when the caller lacks the matching permission.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { formatPct } from "@/components/finance/format";
import { currentMonth, financeMonthQueryKey } from "@/components/finance/finance-month-grid";
import { getTenantFinanceMonth, setFinanceRates, setFinanceViewer } from "@/lib/finance.functions";
import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** "YYYY-MM-DD" of today, matching the server's default `validFrom`. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

export function FinanceSettingsPanel({ tenantId }: { tenantId: string }) {
  const isDemo = useIsDemoTenant();
  const qc = useQueryClient();
  const getMonth = useServerFn(getTenantFinanceMonth);
  const setRatesFn = useServerFn(setFinanceRates);
  const setViewerFn = useServerFn(setFinanceViewer);

  // Rates and viewer grants aren't tied to one month; any month's call
  // returns them, so this just reuses getTenantFinanceMonth's current month.
  const month = currentMonth();
  const [ggrFeePct, setGgrFeePct] = useState("");
  const [movementFeePct, setMovementFeePct] = useState("");
  const [validFrom, setValidFrom] = useState(today);

  const query = useQuery({
    queryKey: financeMonthQueryKey(tenantId, month),
    queryFn: () => getMonth({ data: { tenantId, month } }),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: financeMonthQueryKey(tenantId, month) });

  const saveRates = useMutation({
    mutationFn: () =>
      setRatesFn({
        data: {
          tenantId,
          validFrom,
          ggrFeePct: Number(ggrFeePct),
          movementFeePct: Number(movementFeePct),
        },
      }),
    onSuccess: () => {
      toast.success("Taxas atualizadas");
      setGgrFeePct("");
      setMovementFeePct("");
      setValidFrom(today());
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const setViewer = useMutation({
    mutationFn: (vars: { userId: string; canView: boolean }) =>
      setViewerFn({ data: { tenantId, ...vars } }),
    onSuccess: () => refresh(),
    onError: (error: Error) => toast.error(error.message),
  });

  if (query.isLoading || !query.data) {
    return <div className="h-40 animate-pulse rounded-lg border border-border/40" />;
  }

  const { rates, viewers, permissions } = query.data;

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Taxas</h3>
        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Taxa de GGR</p>
            <p className="font-medium">{formatPct(rates.current.ggrFeePct / 100)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Taxa de movimentação
            </p>
            <p className="font-medium">{formatPct(rates.current.movementFeePct / 100)}</p>
          </div>
        </div>

        {rates.history.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vale a partir de</TableHead>
                <TableHead>Taxa de GGR</TableHead>
                <TableHead>Taxa de movimentação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rates.history.map((rate) => (
                <TableRow key={rate.validFrom}>
                  <TableCell>{rate.validFrom}</TableCell>
                  <TableCell>{formatPct(rate.ggrFeePct / 100)}</TableCell>
                  <TableCell>{formatPct(rate.movementFeePct / 100)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {permissions.canEditRates && (
          <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border/40 bg-background/30 p-3">
            <div>
              <Label>Taxa de GGR (%)</Label>
              <Input
                type="number"
                step="0.01"
                min={0}
                max={100}
                value={ggrFeePct}
                onChange={(e) => setGgrFeePct(e.target.value)}
                disabled={isDemo}
                className="w-28"
              />
            </div>
            <div>
              <Label>Taxa de movimentação (%)</Label>
              <Input
                type="number"
                step="0.01"
                min={0}
                max={100}
                value={movementFeePct}
                onChange={(e) => setMovementFeePct(e.target.value)}
                disabled={isDemo}
                className="w-28"
              />
            </div>
            <div>
              <Label>Vale a partir de</Label>
              <Input
                type="date"
                value={validFrom}
                onChange={(e) => setValidFrom(e.target.value)}
                disabled={isDemo}
                className="w-40"
              />
            </div>
            <DemoDisabledTooltip active={isDemo}>
              <Button
                type="button"
                disabled={isDemo || !ggrFeePct || !movementFeePct || saveRates.isPending}
                onClick={() => saveRates.mutate()}
              >
                Salvar taxas
              </Button>
            </DemoDisabledTooltip>
          </div>
        )}
      </section>

      {permissions.canManageViewers && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Liberação para gestores</h3>
          <p className="text-sm text-muted-foreground">
            Cada gestor liberado passa a ver este financeiro (somente leitura).
          </p>
          <div className="space-y-2">
            {viewers.map((viewer) => (
              <div
                key={viewer.user_id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/30 p-3"
              >
                <span className="truncate text-sm">{viewer.email ?? viewer.user_id}</span>
                <DemoDisabledTooltip active={isDemo}>
                  <Switch
                    checked={viewer.canView}
                    disabled={isDemo || setViewer.isPending}
                    onCheckedChange={(checked) =>
                      setViewer.mutate({ userId: viewer.user_id, canView: checked })
                    }
                  />
                </DemoDisabledTooltip>
              </div>
            ))}
            {viewers.length === 0 && (
              <p className="text-sm text-muted-foreground">Nenhum gestor nesta casa ainda.</p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
