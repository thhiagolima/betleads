// Lançamentos of the house's financial close (spec §5;
// docs/ESCOPO_AUDITORIA_FINANCEIRO_2026-10-29.md §3.4): the "GGR do mês"
// block, the list of days (day-list.tsx) whose rows open the day modal
// (day-modal.tsx, where Anúncios, GGR and the day's other costs are typed and
// saved one day at a time), the "Usar gasto da Meta nos dias vazios" shortcut
// and the month summary. `dia` in the URL opens the modal on that day.
// Reused read-only by /grupo/casa with `readOnly`; the demo house is
// read-only too.
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";

import { SendCostAmount } from "@/components/finance/dashboard/sends-block";
import { betleadsUsageNote, formatBRL } from "@/components/finance/format";
import { FINANCE_TERMS } from "@/components/finance/definitions";
import { currentMonth, metaFillEntries, todaySaoPaulo } from "@/components/finance/day-entry";
import { DayList } from "@/components/finance/day-list";
import { DayModal } from "@/components/finance/day-modal";
import {
  defaultValidThrough,
  MonthlyGgrFields,
  parseGgrInput,
  type MonthlyGgrFormValue,
} from "@/components/finance/finance-monthly-ggr";
import { financeMonthQueryKey, invalidateFinanceAfterSave } from "@/components/finance/query-keys";
import { round2 } from "@/lib/finance/calc";
import type { PeriodSummary } from "@/lib/finance/types";
import { getTenantFinanceMonth, saveFinanceDays, setMonthlyGgr } from "@/lib/finance.functions";
import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export { currentMonth };

export function FinanceMonthView({
  tenantId,
  readOnly = false,
  initialMonth,
  focusDate,
  onDayChange,
}: {
  tenantId: string;
  readOnly?: boolean;
  /** "YYYY-MM" to open on (default: the current month). */
  initialMonth?: string;
  /** "YYYY-MM-DD" whose day modal opens ("Lançar agora", `dia` in the URL). */
  focusDate?: string;
  /** The open day changed (null = modal closed), so the caller can keep `dia` in the URL. */
  onDayChange?: (date: string | null) => void;
}) {
  const isDemo = useIsDemoTenant();
  const qc = useQueryClient();
  const getMonth = useServerFn(getTenantFinanceMonth);
  const saveDaysFn = useServerFn(saveFinanceDays);
  const setMonthlyGgrFn = useServerFn(setMonthlyGgr);

  const [month, setMonth] = useState(() => initialMonth ?? currentMonth());
  const [openDate, setOpenDate] = useState<string | null>(focusDate ?? null);

  // A new initialMonth from the caller (the URL) replaces the picked month.
  const [seenInitialMonth, setSeenInitialMonth] = useState(initialMonth);
  if (initialMonth !== seenInitialMonth) {
    setSeenInitialMonth(initialMonth);
    if (initialMonth) setMonth(initialMonth);
  }
  // A new `dia` from the caller opens (or, cleared, closes) the day modal.
  const [seenFocusDate, setSeenFocusDate] = useState(focusDate);
  if (focusDate !== seenFocusDate) {
    setSeenFocusDate(focusDate);
    setOpenDate(focusDate ?? null);
  }

  const openDay = (date: string | null) => {
    setOpenDate(date);
    onDayChange?.(date);
  };

  const query = useQuery({
    queryKey: financeMonthQueryKey(tenantId, month),
    queryFn: () => getMonth({ data: { tenantId, month } }),
  });

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

  const canEditValues = !readOnly && data?.permissions.canEditValues === true;
  const metaEntries = data ? metaFillEntries(data.days, todaySaoPaulo()) : [];

  // "Usar gasto da Meta nos dias vazios": every empty day with a suggestion, one save.
  const fillFromMeta = useMutation({
    mutationFn: () => saveDaysFn({ data: { tenantId, entries: metaEntries } }),
    onSuccess: () => {
      toast.success(
        metaEntries.length === 1
          ? "Gasto da Meta lançado em 1 dia"
          : `Gasto da Meta lançado em ${metaEntries.length} dias`,
      );
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Input
            type="month"
            value={month}
            onChange={(e) => {
              setMonth(e.target.value);
              if (openDate) openDay(null);
            }}
            className="w-44"
          />
          {summary.pendingDays > 0 && (
            <span className="text-xs text-muted-foreground">
              {summary.pendingDays} {summary.pendingDays === 1 ? "dia pendente" : "dias pendentes"}
            </span>
          )}
        </div>
        {canEditValues && metaEntries.length > 0 && (
          <DemoDisabledTooltip active={isDemo}>
            <Button
              variant="outline"
              className="gap-2"
              disabled={isDemo || fillFromMeta.isPending}
              onClick={() => fillFromMeta.mutate()}
            >
              <Sparkles className="h-4 w-4" />
              Usar gasto da Meta nos dias vazios
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

      <DayList
        days={days}
        sendsByDay={data.sendsByDay}
        otherCosts={data.otherCosts}
        onOpen={openDay}
        focusDate={focusDate}
        usingMonthlyGgr={data.monthlyGgr !== null}
      />
      <p className="text-xs text-muted-foreground">
        A mensalidade entra só no total do mês fechado, não nos dias.
      </p>

      <DayModal
        tenantId={tenantId}
        month={month}
        date={openDate}
        data={data}
        // The demo house is read-only here: values without inputs.
        readOnly={!canEditValues || isDemo}
        onDateChange={openDay}
      />

      <MonthSummary
        summary={summary}
        sendCostIncomplete={data.sendCostIncomplete}
        betleadsNote={betleadsNote}
      />
    </div>
  );
}

function SummaryTile({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div data-tile={id}>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

/**
 * The month summary under the day list: one tile per cost (Envios and
 * Mensalidade apart, each under its own term) and the Lucro líquido. A
 * partial Envios (a send without provider cost) says so instead of reading as
 * a complete total.
 */
export function MonthSummary({
  summary,
  sendCostIncomplete,
  betleadsNote,
}: {
  summary: PeriodSummary;
  sendCostIncomplete: boolean;
  /** betleadsUsageNote(month, betleadsSince): no usage data before a date. */
  betleadsNote: string | null;
}) {
  return (
    <div className="grid gap-2 rounded-lg border border-border/40 bg-background/30 p-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
      <SummaryTile id="movementFee" label={FINANCE_TERMS.movementFee.label}>
        <p className="font-medium">{formatBRL(summary.movementFee)}</p>
      </SummaryTile>
      <SummaryTile id="ggrFee" label={FINANCE_TERMS.ggrFee.label}>
        <p className="font-medium">{formatBRL(summary.ggrFee)}</p>
      </SummaryTile>
      <SummaryTile id="otherCosts" label={FINANCE_TERMS.otherCosts.label}>
        <p className="font-medium">{formatBRL(summary.otherCosts)}</p>
      </SummaryTile>
      <SummaryTile id="sends" label={FINANCE_TERMS.sends.label}>
        <p className="font-medium">
          <SendCostAmount amount={round2(summary.betleadsUsage)} incomplete={sendCostIncomplete} />
        </p>
        {betleadsNote && <p className="text-xs text-muted-foreground">{betleadsNote}</p>}
      </SummaryTile>
      <SummaryTile id="fee" label={FINANCE_TERMS.fee.label}>
        <p className="font-medium">{formatBRL(round2(summary.betleadsFee ?? 0))}</p>
      </SummaryTile>
      <SummaryTile id="cashResult" label={FINANCE_TERMS.cashResult.label}>
        <p className="text-lg font-semibold">{formatBRL(summary.cashResult)}</p>
      </SummaryTile>
    </div>
  );
}
