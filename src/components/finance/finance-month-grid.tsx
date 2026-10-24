// Month grid of the house's financial close (spec §5): one row per day, CRM
// columns always filled, Anúncios/GGR manual (batch-edited and saved with a
// single saveFinanceDays call), computed columns "pendente" until both
// manual fields of the day are confirmed. Reused read-only by Task 7
// (/grupo/casa) with `readOnly`.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";

import { formatBRL, formatRatio } from "@/components/finance/format";
import { num } from "@/lib/format";
import { round2 } from "@/lib/finance/calc";
import type { FinanceDay } from "@/lib/finance/types";
import { getTenantFinanceMonth, saveFinanceDays } from "@/lib/finance.functions";
import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** "YYYY-MM" of the current month, in the viewer's local time (same as the input[type=month] widget). */
export function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export const financeMonthQueryKey = (tenantId: string, month: string) => [
  "finance-month",
  tenantId,
  month,
] as const;

type Edits = Record<string, { adSpend?: string; ggr?: string }>;
type EditableField = "adSpend" | "ggr";

function parseMoney(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function PendingCell() {
  return <span className="text-xs italic text-muted-foreground">pendente</span>;
}

export function FinanceMonthView({
  tenantId,
  readOnly = false,
}: {
  tenantId: string;
  readOnly?: boolean;
}) {
  const isDemo = useIsDemoTenant();
  const qc = useQueryClient();
  const getMonth = useServerFn(getTenantFinanceMonth);
  const saveDaysFn = useServerFn(saveFinanceDays);

  const [month, setMonth] = useState(currentMonth);
  const [edits, setEdits] = useState<Edits>({});

  const query = useQuery({
    queryKey: financeMonthQueryKey(tenantId, month),
    queryFn: () => getMonth({ data: { tenantId, month } }),
  });

  // A new month starts clean: don't carry edits from the previous one across.
  useEffect(() => {
    setEdits({});
  }, [tenantId, month]);

  const data = query.data;
  const canEditValues = !readOnly && data?.permissions.canEditValues === true;
  const hasEdits = Object.keys(edits).length > 0;

  const setEdit = (date: string, field: EditableField, value: string) =>
    setEdits((prev) => ({ ...prev, [date]: { ...prev[date], [field]: value } }));

  const effectiveAdSpend = (day: FinanceDay) =>
    edits[day.date]?.adSpend ?? (day.adSpend === null ? "" : String(day.adSpend));
  const effectiveGgr = (day: FinanceDay) =>
    edits[day.date]?.ggr ?? (day.ggr === null ? "" : String(day.ggr));

  const useMetaSuggestion = (day: FinanceDay) => {
    if (day.adSpendSuggested === null) return;
    setEdit(day.date, "adSpend", String(day.adSpendSuggested));
  };

  const save = useMutation({
    mutationFn: () => {
      const entries = Object.entries(edits)
        .map(([date, fields]) => {
          const entry: { date: string; adSpend?: number | null; ggr?: number | null } = { date };
          if (fields.adSpend !== undefined) entry.adSpend = parseMoney(fields.adSpend);
          if (fields.ggr !== undefined) entry.ggr = parseMoney(fields.ggr);
          return entry;
        })
        .filter((entry) => entry.adSpend !== undefined || entry.ggr !== undefined);
      return saveDaysFn({ data: { tenantId, entries } });
    },
    onSuccess: () => {
      toast.success("Alterações salvas");
      setEdits({});
      qc.invalidateQueries({ queryKey: financeMonthQueryKey(tenantId, month) });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (query.isError) {
    return (
      <p className="text-sm text-destructive">
        {(query.error as Error).message || "Não foi possível carregar o financeiro."}
      </p>
    );
  }

  if (query.isLoading || !data) {
    return <div className="h-64 animate-pulse rounded-lg border border-border/40" />;
  }

  const { days, summary } = data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="w-44"
          />
          {summary.pendingDays > 0 && (
            <span className="text-xs text-muted-foreground">
              {summary.pendingDays} {summary.pendingDays === 1 ? "dia pendente" : "dias pendentes"}
            </span>
          )}
        </div>
        {canEditValues && (
          <DemoDisabledTooltip active={isDemo}>
            <Button disabled={isDemo || !hasEdits || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Salvando…" : "Salvar alterações"}
            </Button>
          </DemoDisabledTooltip>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border/40">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Data</TableHead>
              <TableHead>Anúncios</TableHead>
              <TableHead>Cadastros</TableHead>
              <TableHead>Custo/cadastro</TableHead>
              <TableHead>FTDs</TableHead>
              <TableHead>Custo/FTD</TableHead>
              <TableHead>Depósitos FTD</TableHead>
              <TableHead>Depósitos totais</TableHead>
              <TableHead>Saques</TableHead>
              <TableHead>Net bruto</TableHead>
              <TableHead>GGR</TableHead>
              <TableHead>Resultado caixa</TableHead>
              <TableHead>ROI caixa</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {days.length === 0 && (
              <TableRow>
                <TableCell colSpan={13} className="py-8 text-center text-sm text-muted-foreground">
                  Nenhum dia neste mês ainda.
                </TableCell>
              </TableRow>
            )}
            {days.map((day) => (
              <TableRow key={day.date}>
                <TableCell>{day.date.slice(8, 10)}</TableCell>
                <TableCell>
                  {canEditValues ? (
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        step="0.01"
                        inputMode="decimal"
                        value={effectiveAdSpend(day)}
                        placeholder={
                          day.adSpend === null && day.adSpendSuggested !== null
                            ? String(day.adSpendSuggested)
                            : undefined
                        }
                        onChange={(e) => setEdit(day.date, "adSpend", e.target.value)}
                        disabled={isDemo}
                        className="h-8 w-28"
                      />
                      {day.adSpend === null &&
                        day.adSpendSuggested !== null &&
                        effectiveAdSpend(day) === "" && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            title="Usar valor da Meta"
                            disabled={isDemo}
                            onClick={() => useMetaSuggestion(day)}
                          >
                            <Sparkles className="h-3.5 w-3.5" />
                          </Button>
                        )}
                    </div>
                  ) : day.adSpend === null ? (
                    <PendingCell />
                  ) : (
                    formatBRL(day.adSpend)
                  )}
                </TableCell>
                <TableCell>{num(day.registrations)}</TableCell>
                <TableCell>{formatBRL(day.costPerRegistration)}</TableCell>
                <TableCell>{num(day.ftds)}</TableCell>
                <TableCell>{formatBRL(day.costPerFtd)}</TableCell>
                <TableCell>{formatBRL(day.ftdDepositAmount)}</TableCell>
                <TableCell>{formatBRL(day.depositAmount)}</TableCell>
                <TableCell>{formatBRL(day.withdrawalAmount)}</TableCell>
                <TableCell>{day.pending ? <PendingCell /> : formatBRL(day.net)}</TableCell>
                <TableCell>
                  {canEditValues ? (
                    <Input
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      value={effectiveGgr(day)}
                      onChange={(e) => setEdit(day.date, "ggr", e.target.value)}
                      disabled={isDemo}
                      className="h-8 w-28"
                    />
                  ) : day.ggr === null ? (
                    <PendingCell />
                  ) : (
                    formatBRL(day.ggr)
                  )}
                </TableCell>
                <TableCell>{day.pending ? <PendingCell /> : formatBRL(day.cashResult)}</TableCell>
                <TableCell>{day.pending ? <PendingCell /> : formatRatio(day.roi)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="font-semibold">TOTAL</TableCell>
              <TableCell>{formatBRL(summary.adSpend)}</TableCell>
              <TableCell>{num(summary.registrations)}</TableCell>
              <TableCell>{formatBRL(summary.costPerRegistration)}</TableCell>
              <TableCell>{num(summary.ftds)}</TableCell>
              <TableCell>{formatBRL(summary.costPerFtd)}</TableCell>
              <TableCell>{formatBRL(summary.ftdDepositAmount)}</TableCell>
              <TableCell>{formatBRL(summary.depositAmount)}</TableCell>
              <TableCell>{formatBRL(summary.withdrawalAmount)}</TableCell>
              <TableCell>{formatBRL(summary.net)}</TableCell>
              <TableCell>{formatBRL(summary.ggr)}</TableCell>
              <TableCell>{formatBRL(summary.cashResult)}</TableCell>
              <TableCell>{formatRatio(summary.roi)}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="text-muted-foreground">MÉDIA DIÁRIA</TableCell>
              <TableCell>
                {formatBRL(summary.days ? round2(summary.adSpend / summary.days) : null)}
              </TableCell>
              <TableCell colSpan={7} />
              <TableCell>{formatBRL(summary.avgDailyCashResult)}</TableCell>
              <TableCell colSpan={2} />
            </TableRow>
          </TableFooter>
        </Table>
      </div>

      <div className="grid gap-2 rounded-lg border border-border/40 bg-background/30 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Taxa de movimentação
          </p>
          <p className="font-medium">{formatBRL(summary.movementFee)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Taxa GGR</p>
          <p className="font-medium">{formatBRL(summary.ggrFee)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Outros custos</p>
          <p className="font-medium">{formatBRL(summary.otherCosts)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Resultado do mês</p>
          <p className="text-lg font-semibold">{formatBRL(summary.cashResult)}</p>
        </div>
      </div>
    </div>
  );
}
