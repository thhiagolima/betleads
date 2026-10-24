// "Outros custos do mês" (spec §5): free list of description + value rows
// (CRM, SMS, ...) that enter the month's result but not any single day's.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { formatBRL } from "@/components/finance/format";
import { currentMonth, financeMonthQueryKey } from "@/components/finance/finance-month-grid";
import { deleteOtherCost, getTenantFinanceMonth, saveOtherCost } from "@/lib/finance.functions";
import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function FinanceOtherCosts({ tenantId }: { tenantId: string }) {
  const isDemo = useIsDemoTenant();
  const qc = useQueryClient();
  const getMonth = useServerFn(getTenantFinanceMonth);
  const saveFn = useServerFn(saveOtherCost);
  const removeFn = useServerFn(deleteOtherCost);

  const [month, setMonth] = useState(currentMonth);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [descricao, setDescricao] = useState("");
  const [valor, setValor] = useState("");

  const resetForm = () => {
    setEditingId(null);
    setDescricao("");
    setValor("");
  };

  const startEdit = (cost: { id: string; descricao: string; valor: number }) => {
    setEditingId(cost.id);
    setDescricao(cost.descricao);
    setValor(String(cost.valor));
  };

  const query = useQuery({
    queryKey: financeMonthQueryKey(tenantId, month),
    queryFn: () => getMonth({ data: { tenantId, month } }),
  });

  useEffect(() => resetForm(), [tenantId, month]);

  const refresh = () => qc.invalidateQueries({ queryKey: financeMonthQueryKey(tenantId, month) });

  const save = useMutation({
    mutationFn: () =>
      saveFn({
        data: {
          tenantId,
          month,
          descricao,
          valor: Number(valor),
          id: editingId ?? undefined,
        },
      }),
    onSuccess: () => {
      toast.success("Custo salvo");
      resetForm();
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => removeFn({ data: { tenantId, id } }),
    onSuccess: (_result, id) => {
      toast.success("Custo removido");
      if (editingId === id) resetForm();
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (query.isLoading || !query.data) {
    return <div className="h-24 animate-pulse rounded-lg border border-border/40" />;
  }

  const canEdit = query.data.permissions.canEditValues;
  const otherCosts = query.data.otherCosts;
  const total = otherCosts.reduce((sum, cost) => sum + cost.valor, 0);

  return (
    <div className="space-y-4">
      <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-44" />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Descrição</TableHead>
            <TableHead>Valor</TableHead>
            {canEdit && <TableHead className="w-10" />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {otherCosts.map((cost) => (
            <TableRow key={cost.id}>
              <TableCell>{cost.descricao}</TableCell>
              <TableCell>{formatBRL(cost.valor)}</TableCell>
              {canEdit && (
                <TableCell>
                  <div className="flex items-center gap-1">
                    <DemoDisabledTooltip active={isDemo}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        disabled={isDemo}
                        onClick={() => startEdit(cost)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </DemoDisabledTooltip>
                    <DemoDisabledTooltip active={isDemo}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        disabled={isDemo || remove.isPending}
                        onClick={() => remove.mutate(cost.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </DemoDisabledTooltip>
                  </div>
                </TableCell>
              )}
            </TableRow>
          ))}
          {otherCosts.length === 0 && (
            <TableRow>
              <TableCell colSpan={canEdit ? 3 : 2} className="py-6 text-center text-sm text-muted-foreground">
                Nenhum custo lançado neste mês.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {otherCosts.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Total do mês: <span className="font-medium text-foreground">{formatBRL(total)}</span>
        </p>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border/40 bg-background/30 p-3">
          <div className="flex-1 min-w-[160px]">
            <Input
              placeholder="Descrição (ex.: CRM, SMS)"
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              disabled={isDemo}
            />
          </div>
          <div className="w-32">
            <Input
              type="number"
              step="0.01"
              min={0}
              placeholder="Valor"
              value={valor}
              onChange={(e) => setValor(e.target.value)}
              disabled={isDemo}
            />
          </div>
          <DemoDisabledTooltip active={isDemo}>
            <Button
              type="button"
              disabled={isDemo || !descricao.trim() || !valor || save.isPending}
              onClick={() => save.mutate()}
              className="gap-2"
            >
              <Plus className="h-4 w-4" />
              {editingId ? "Salvar custo" : "Adicionar"}
            </Button>
          </DemoDisabledTooltip>
          {editingId && (
            <Button type="button" variant="ghost" onClick={resetForm} className="gap-2">
              <X className="h-4 w-4" />
              Cancelar
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
