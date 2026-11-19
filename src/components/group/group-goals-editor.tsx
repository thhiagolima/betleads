// /grupo/metas (spec §7): one table per house, 8 metrics, each row editable
// (direction, daily value, "vale a partir de"). Saving calls setTenantGoal;
// an empty value removes the goal from that date on. The house list comes
// from getGroupPeople (already scoped to the group manager / super admin);
// members are ignored here, only {id, nome} is used.
//
// "Vale a partir de" always defaults to TODAY (fix round 1, item 2): it is
// the date a *new* change takes effect, not the date the currently-loaded
// goal became effective. Prefilling it with the old `validFrom` meant saving
// without touching that field silently upserted onto the historical row and
// rewrote past evaluations. The goal's current effective date, if any, is
// shown as read-only text instead.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FINANCE_TERMS } from "@/components/finance/definitions";
import { QueryErrorState } from "@/components/finance/query-error-state";
import { getTenantGoals, setTenantGoal, type TenantGoalCurrent } from "@/lib/finance.functions";
import type { GoalDirection, GoalMetric } from "@/lib/finance/types";
import { getGroupPeople } from "@/lib/groups.functions";

import { goalInputToValue, goalValueToInput, isPercentGoal } from "./goal-units";

const METRIC_LABEL: Record<GoalMetric, string> = {
  registrations: "Cadastros",
  ftds: "FTDs",
  deposits: "Depósitos totais",
  net: FINANCE_TERMS.net.label,
  cash_result: FINANCE_TERMS.cashResult.label,
  cost_per_registration: "Custo por cadastro",
  cost_per_ftd: "Custo por FTD",
  roi: "ROI caixa",
};

function todaySaoPauloLocal() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function formatDateBR(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// One grid for both layouts: a card per metric on phones, a table-like row
// from md up (the header row only shows from md). A single tree keeps the
// row's draft state in one place.
const ROW_GRID =
  "md:grid md:grid-cols-[minmax(0,1.4fr)_5.5rem_minmax(0,1.3fr)_minmax(0,1.2fr)_auto] md:items-start md:gap-3";

function GoalRow({
  tenantId,
  row,
  onSaved,
}: {
  tenantId: string;
  row: TenantGoalCurrent;
  onSaved: () => void;
}) {
  const [direction, setDirection] = useState<GoalDirection>(row.direction);
  // ROI is typed in % (30 = 30%) and stored as a fraction, see goal-units.
  const [value, setValue] = useState(() => goalValueToInput(row.metric, row.dailyValue));
  const today = todaySaoPauloLocal();
  // Always today: this is when a NEW change takes effect, not row.validFrom
  // (the currently-loaded goal's own effective date, shown read-only below).
  const [validFrom, setValidFrom] = useState(today);
  const fn = useServerFn(setTenantGoal);

  const mut = useMutation({
    mutationFn: () =>
      fn({
        data: {
          tenantId,
          metric: row.metric,
          direction,
          dailyValue: goalInputToValue(row.metric, value),
          validFrom,
        },
      }),
    onSuccess: () => {
      toast.success("Meta salva");
      onSaved();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const metricLabel = `${METRIC_LABEL[row.metric]}${isPercentGoal(row.metric) ? " (%)" : ""}`;
  const idBase = `goal-${tenantId}-${row.metric}`;

  return (
    <li
      className={`space-y-3 border-b border-border/40 p-3 last:border-0 md:space-y-0 md:px-3 md:py-2 ${ROW_GRID}`}
    >
      <div className="text-sm font-medium md:pt-2.5 md:font-normal">{metricLabel}</div>
      <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 md:contents">
        <div className="space-y-1">
          <label htmlFor={`${idBase}-dir`} className="text-meta text-muted-foreground md:sr-only">
            Direção
          </label>
          <Select value={direction} onValueChange={(v) => setDirection(v as GoalDirection)}>
            <SelectTrigger id={`${idBase}-dir`} className="w-full" aria-label="Direção">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="gte">≥</SelectItem>
              <SelectItem value="lte">≤</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-0 space-y-1">
          <label htmlFor={`${idBase}-val`} className="text-meta text-muted-foreground md:sr-only">
            Valor diário
          </label>
          <div className="flex items-center gap-1">
            <Input
              id={`${idBase}-val`}
              type="number"
              step="0.01"
              inputMode="decimal"
              placeholder="sem meta"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="min-w-0 flex-1"
            />
            {isPercentGoal(row.metric) && (
              <span className="text-meta text-muted-foreground">%</span>
            )}
          </div>
          <p className="text-meta text-muted-foreground">
            {row.validFrom ? `vigente desde ${formatDateBR(row.validFrom)}` : "sem meta atual"}
          </p>
        </div>
      </div>
      <div className="min-w-0 space-y-1">
        <label htmlFor={`${idBase}-from`} className="text-meta text-muted-foreground md:sr-only">
          Vale a partir de
        </label>
        <Input
          id={`${idBase}-from`}
          type="date"
          min={today}
          value={validFrom}
          onChange={(e) => setValidFrom(e.target.value)}
          className="w-full min-w-0"
        />
      </div>
      <div className="md:text-right">
        <Button
          size="sm"
          className="w-full md:w-auto"
          disabled={mut.isPending}
          onClick={() => mut.mutate()}
          aria-label={`Salvar meta de ${metricLabel}`}
        >
          {mut.isPending ? "Salvando…" : "Salvar"}
        </Button>
      </div>
    </li>
  );
}

function TenantGoalsTable({ tenant }: { tenant: { id: string; nome: string } }) {
  const qc = useQueryClient();
  const getGoals = useServerFn(getTenantGoals);
  const query = useQuery({
    queryKey: ["tenant-goals", tenant.id],
    queryFn: () => getGoals({ data: { tenantId: tenant.id } }),
  });

  if (query.isLoading) {
    return <div className="h-32 animate-pulse rounded-lg border border-border/40" />;
  }

  if (query.isError || !query.data) {
    return (
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{tenant.nome}</h3>
        <QueryErrorState
          title={`Não foi possível carregar as metas de ${tenant.nome}.`}
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{tenant.nome}</h3>
      <div className="rounded-lg border border-border/40">
        <div
          aria-hidden="true"
          className={`hidden border-b border-border/40 px-3 py-2 text-meta font-medium text-muted-foreground ${ROW_GRID}`}
        >
          <span>Métrica</span>
          <span>Direção</span>
          <span>Valor diário</span>
          <span>Vale a partir de</span>
          <span />
        </div>
        <ul>
          {query.data.map((row) => (
            <GoalRow
              key={row.metric}
              tenantId={tenant.id}
              row={row}
              onSaved={() => qc.invalidateQueries({ queryKey: ["tenant-goals", tenant.id] })}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

export function GroupGoalsEditor({ groupId }: { groupId: string }) {
  const getPeople = useServerFn(getGroupPeople);
  const query = useQuery({
    queryKey: ["group-people", groupId],
    queryFn: () => getPeople({ data: { groupId } }),
  });

  if (query.isLoading) {
    return <div className="h-64 animate-pulse rounded-lg border border-border/40" />;
  }

  if (query.isError || !query.data) {
    return (
      <QueryErrorState
        title="Não foi possível carregar as casas do grupo."
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    );
  }

  if (!query.data.tenants.length) {
    return <p className="text-sm text-muted-foreground">Nenhuma casa neste grupo ainda.</p>;
  }

  return (
    <div className="space-y-6">
      {query.data.tenants.map((tenant) => (
        <TenantGoalsTable key={tenant.id} tenant={tenant} />
      ))}
    </div>
  );
}
