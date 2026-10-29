// Month grid of the house's financial close (spec §5): one row per day, CRM
// columns always filled, Anúncios/GGR manual (batch-edited and saved with a
// single saveFinanceDays call). A missing manual field shows "pendente" in its
// cell, while the computed columns always show their numbers (computeDay
// counts a missing Anúncios or GGR as 0). A month with a "GGR do mês" total
// (finance-monthly-ggr.tsx) shows the allocated daily GGR read-only. Reused
// read-only by Task 7 (/grupo/casa) with `readOnly`.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";

import {
  betleadsUsageNote,
  formatBRL,
  formatRatio,
  GGR_COLUMN_LABEL,
} from "@/components/finance/format";
import {
  defaultValidThrough,
  MONTHLY_GGR_COLUMN_NOTE,
  MonthlyGgrFields,
  parseGgrInput,
  type MonthlyGgrFormValue,
} from "@/components/finance/finance-monthly-ggr";
import { financeMonthQueryKey, invalidateFinanceAfterSave } from "@/components/finance/query-keys";
import { num } from "@/lib/format";
import { averageFilledAdSpend, betleadsCostLabel, presetRange } from "@/lib/finance/calc";
import type { FinanceDay } from "@/lib/finance/types";
import { getTenantFinanceMonth, saveFinanceDays, setMonthlyGgr } from "@/lib/finance.functions";
import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** "YYYY-MM" of the current month in São Paulo, the same day boundary as the server. */
export function currentMonth() {
  return presetRange("today", new Date()).from.slice(0, 7);
}

type Edits = Record<string, { adSpend?: string; ggr?: string }>;
type EditableField = "adSpend" | "ggr";

function parseMoney(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** "YYYY-MM-DD" of today in São Paulo, the same day boundary as the server. */
function todaySaoPaulo() {
  return presetRange("today", new Date()).from;
}

/** Background of the typed columns (Anúncios, GGR), apart from the CRM ones (spec §9). */
const MANUAL_CELL = "bg-primary/5";

function PendingCell() {
  return <span className="text-xs italic text-muted-foreground">pendente</span>;
}

export function FinanceMonthView({
  tenantId,
  readOnly = false,
  initialMonth,
  focusDate,
}: {
  tenantId: string;
  readOnly?: boolean;
  /** "YYYY-MM" to open on (default: the current month). */
  initialMonth?: string;
  /** "YYYY-MM-DD" whose row is scrolled into view and ringed ("Lançar agora"). */
  focusDate?: string;
}) {
  const isDemo = useIsDemoTenant();
  const qc = useQueryClient();
  const getMonth = useServerFn(getTenantFinanceMonth);
  const saveDaysFn = useServerFn(saveFinanceDays);
  const setMonthlyGgrFn = useServerFn(setMonthlyGgr);

  const [month, setMonth] = useState(() => initialMonth ?? currentMonth());
  const [edits, setEdits] = useState<Edits>({});

  // A new initialMonth from the caller (the URL) replaces the picked month.
  const [seenInitialMonth, setSeenInitialMonth] = useState(initialMonth);
  if (initialMonth !== seenInitialMonth) {
    setSeenInitialMonth(initialMonth);
    if (initialMonth) setMonth(initialMonth);
  }

  const query = useQuery({
    queryKey: financeMonthQueryKey(tenantId, month),
    queryFn: () => getMonth({ data: { tenantId, month } }),
  });

  // A new month starts clean: don't carry edits from the previous one across.
  useEffect(() => {
    setEdits({});
  }, [tenantId, month]);

  const data = query.data;

  // The "GGR do mês" form follows the loaded month (its saved total, or empty
  // with "atualizado até" = yesterday clamped into the month).
  const [ggrForm, setGgrForm] = useState<MonthlyGgrFormValue>({ ggr: "", validThrough: "" });
  const savedMonthlyGgr = data?.monthlyGgr ?? null;
  const savedGgrKey = `${tenantId}|${month}|${savedMonthlyGgr?.ggr ?? ""}|${savedMonthlyGgr?.validThrough ?? ""}`;
  useEffect(() => {
    setGgrForm(
      savedMonthlyGgr
        ? { ggr: String(savedMonthlyGgr.ggr), validThrough: savedMonthlyGgr.validThrough }
        : { ggr: "", validThrough: defaultValidThrough(month, todaySaoPaulo()) },
    );
    // savedGgrKey stands for savedMonthlyGgr (a new object on every fetch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedGgrKey]);

  // Scroll the focused day into view once its row is rendered (once per date).
  const focusRowRef = useRef<HTMLTableRowElement | null>(null);
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!focusDate || scrolledFor.current === focusDate || !focusRowRef.current) return;
    scrolledFor.current = focusDate;
    focusRowRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusDate, data]);

  const canEditValues = !readOnly && data?.permissions.canEditValues === true;
  const hasEdits = Object.keys(edits).length > 0;

  const setEdit = (date: string, field: EditableField, value: string) =>
    setEdits((prev) => ({ ...prev, [date]: { ...prev[date], [field]: value } }));

  const effectiveAdSpend = (day: FinanceDay) =>
    edits[day.date]?.adSpend ?? (day.adSpend === null ? "" : String(day.adSpend));
  const effectiveGgr = (day: FinanceDay) =>
    edits[day.date]?.ggr ?? (day.ggr === null ? "" : String(day.ggr));

  const applyMetaSuggestion = (day: FinanceDay) => {
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
      void invalidateFinanceAfterSave(qc, tenantId, month);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const saveMonthlyGgr = useMutation({
    mutationFn: () => {
      const ggr = parseGgrInput(ggrForm.ggr);
      return setMonthlyGgrFn({
        data: {
          tenantId,
          month,
          ggr,
          validThrough: ggr === null ? undefined : ggrForm.validThrough,
        },
      });
    },
    onSuccess: () => {
      toast.success("GGR do mês salvo");
      void invalidateFinanceAfterSave(qc, tenantId, month);
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
  const betleadsNote = betleadsUsageNote(month, data.betleadsSince);
  // With a month total the daily GGR is the allocated estimate, read-only.
  const usingMonthlyGgr = data.monthlyGgr !== null;
  const canEditDailyGgr = canEditValues && !usingMonthlyGgr;

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

      {month <= currentMonth() && (
        <MonthlyGgrFields
          value={ggrForm}
          month={month}
          today={todaySaoPaulo()}
          current={data.monthlyGgr}
          canEdit={canEditValues}
          disabled={isDemo}
          saving={saveMonthlyGgr.isPending}
          onChange={setGgrForm}
          onSave={() => saveMonthlyGgr.mutate()}
        />
      )}

      <div className="overflow-x-auto rounded-lg border border-border/40">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Data</TableHead>
              <TableHead className={MANUAL_CELL}>Anúncios</TableHead>
              <TableHead>Cadastros</TableHead>
              <TableHead>Custo/cadastro</TableHead>
              <TableHead>FTDs</TableHead>
              <TableHead>Custo/FTD</TableHead>
              <TableHead>Depósitos FTD</TableHead>
              <TableHead>Depósitos totais</TableHead>
              <TableHead>Saques</TableHead>
              <TableHead>Net bruto</TableHead>
              <TableHead className={MANUAL_CELL}>
                {GGR_COLUMN_LABEL}
                {usingMonthlyGgr && (
                  <span className="block text-[10px] font-normal italic text-muted-foreground">
                    {MONTHLY_GGR_COLUMN_NOTE}
                  </span>
                )}
              </TableHead>
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
              <TableRow
                key={day.date}
                ref={day.date === focusDate ? focusRowRef : undefined}
                data-date={day.date}
                // Cell backgrounds (MANUAL_CELL) hide a row ring, so the
                // focused row also tints every cell.
                className={cn(
                  day.date === focusDate && "ring-2 ring-inset ring-primary [&>td]:bg-primary/10",
                )}
              >
                <TableCell>{day.date.slice(8, 10)}</TableCell>
                <TableCell className={MANUAL_CELL}>
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
                            onClick={() => applyMetaSuggestion(day)}
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
                <TableCell>{formatBRL(day.net)}</TableCell>
                <TableCell className={MANUAL_CELL}>
                  {canEditDailyGgr ? (
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
                  ) : day.ggrEstimated ? (
                    <span className="italic" title="Estimado a partir do total do mês">
                      {formatBRL(day.ggr)}
                    </span>
                  ) : (
                    formatBRL(day.ggr)
                  )}
                </TableCell>
                <TableCell>{formatBRL(day.cashResult)}</TableCell>
                <TableCell>{formatRatio(day.roi)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="font-semibold">TOTAL</TableCell>
              <TableCell className={MANUAL_CELL}>{formatBRL(summary.adSpend)}</TableCell>
              <TableCell>{num(summary.registrations)}</TableCell>
              <TableCell>{formatBRL(summary.costPerRegistration)}</TableCell>
              <TableCell>{num(summary.ftds)}</TableCell>
              <TableCell>{formatBRL(summary.costPerFtd)}</TableCell>
              <TableCell>{formatBRL(summary.ftdDepositAmount)}</TableCell>
              <TableCell>{formatBRL(summary.depositAmount)}</TableCell>
              <TableCell>{formatBRL(summary.withdrawalAmount)}</TableCell>
              <TableCell>{formatBRL(summary.net)}</TableCell>
              <TableCell className={MANUAL_CELL}>{formatBRL(summary.ggr)}</TableCell>
              <TableCell>{formatBRL(summary.cashResult)}</TableCell>
              <TableCell>{formatRatio(summary.roi)}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="text-muted-foreground">MÉDIA DIÁRIA</TableCell>
              <TableCell className={MANUAL_CELL}>{formatBRL(averageFilledAdSpend(days))}</TableCell>
              <TableCell colSpan={9} />
              <TableCell>{formatBRL(summary.avgDailyCashResult)}</TableCell>
              <TableCell />
            </TableRow>
          </TableFooter>
        </Table>
      </div>

      <div className="grid gap-2 rounded-lg border border-border/40 bg-background/30 p-4 text-sm sm:grid-cols-2 lg:grid-cols-5">
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
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            {betleadsCostLabel(data.betleadsExempt)}
          </p>
          <p className="font-medium">
            {formatBRL(summary.betleadsUsage + (summary.betleadsFee ?? 0))}
          </p>
          {betleadsNote && <p className="text-xs text-muted-foreground">{betleadsNote}</p>}
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Resultado do mês</p>
          <p className="text-lg font-semibold">{formatBRL(summary.cashResult)}</p>
        </div>
      </div>
    </div>
  );
}
