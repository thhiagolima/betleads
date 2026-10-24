// /grupo/metas (spec §7): one table per house, 8 metrics, each row editable
// (direction, daily value, "vale a partir de"). Saving calls setTenantGoal;
// an empty value removes the goal from that date on. The house list comes
// from getGroupPeople (already scoped to the group manager / super admin);
// members are ignored here, only {id, nome} is used.
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getTenantGoals, setTenantGoal, type TenantGoalCurrent } from "@/lib/finance.functions";
import type { GoalDirection, GoalMetric } from "@/lib/finance/types";
import { getGroupPeople } from "@/lib/groups.functions";

const METRIC_LABEL: Record<GoalMetric, string> = {
  registrations: "Cadastros",
  ftds: "FTDs",
  deposits: "Depósitos totais",
  net: "Net bruto",
  cash_result: "Resultado caixa",
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
  const [value, setValue] = useState(row.dailyValue === null ? "" : String(row.dailyValue));
  const [validFrom, setValidFrom] = useState(row.validFrom ?? todaySaoPauloLocal());
  const fn = useServerFn(setTenantGoal);

  const mut = useMutation({
    mutationFn: () =>
      fn({
        data: {
          tenantId,
          metric: row.metric,
          direction,
          dailyValue: value.trim() === "" ? null : Number(value),
          validFrom,
        },
      }),
    onSuccess: () => {
      toast.success("Meta salva");
      onSaved();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <TableRow>
      <TableCell>{METRIC_LABEL[row.metric]}</TableCell>
      <TableCell>
        <Select value={direction} onValueChange={(v) => setDirection(v as GoalDirection)}>
          <SelectTrigger className="w-20">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="gte">≥</SelectItem>
            <SelectItem value="lte">≤</SelectItem>
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <Input
          type="number"
          step="0.01"
          inputMode="decimal"
          placeholder="sem meta"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-8 w-28"
        />
      </TableCell>
      <TableCell>
        <Input
          type="date"
          value={validFrom}
          onChange={(e) => setValidFrom(e.target.value)}
          className="h-8 w-40"
        />
      </TableCell>
      <TableCell className="text-right">
        <Button size="sm" disabled={mut.isPending} onClick={() => mut.mutate()}>
          Salvar
        </Button>
      </TableCell>
    </TableRow>
  );
}

function TenantGoalsTable({ tenant }: { tenant: { id: string; nome: string } }) {
  const qc = useQueryClient();
  const getGoals = useServerFn(getTenantGoals);
  const query = useQuery({
    queryKey: ["tenant-goals", tenant.id],
    queryFn: () => getGoals({ data: { tenantId: tenant.id } }),
  });

  if (query.isLoading || !query.data) {
    return <div className="h-32 animate-pulse rounded-lg border border-border/40" />;
  }

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{tenant.nome}</h3>
      <div className="overflow-x-auto rounded-lg border border-border/40">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Métrica</TableHead>
              <TableHead>Direção</TableHead>
              <TableHead>Valor diário</TableHead>
              <TableHead>Vale a partir de</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.data.map((row) => (
              <GoalRow
                key={row.metric}
                tenantId={tenant.id}
                row={row}
                onSaved={() => qc.invalidateQueries({ queryKey: ["tenant-goals", tenant.id] })}
              />
            ))}
          </TableBody>
        </Table>
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

  if (query.isLoading || !query.data) {
    return <div className="h-64 animate-pulse rounded-lg border border-border/40" />;
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
