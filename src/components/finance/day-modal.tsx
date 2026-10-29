// The day modal of Lançamentos (docs/ESCOPO_AUDITORIA_FINANCEIRO_2026-10-29.md
// §3.4): "Veio do CRM" (automatic numbers of the day), "Você lança" (Anúncios,
// GGR and the day's other costs) and "Resultado do dia" (the day's waterfall,
// previewing the typed values). "Salvar" saves this day only; "Dia anterior"
// and "Próximo dia" walk the month up to today. A Sheet on a phone, a Dialog
// from `sm` up. Read-only (group manager, demo house) shows values only.
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronLeft, ChevronRight, Plus, Sparkles } from "lucide-react";
import { toast } from "sonner";

import {
  dayLabel,
  dayResult,
  dayStatus,
  neighborDays,
  todaySaoPaulo,
} from "@/components/finance/day-entry";
import { DayStatusChip } from "@/components/finance/day-list";
import { FINANCE_TERMS } from "@/components/finance/definitions";
import { formatBRL, formatInt, GGR_COLUMN_LABEL } from "@/components/finance/format";
import { MONTHLY_GGR_COLUMN_NOTE } from "@/components/finance/finance-monthly-ggr";
import {
  CategoryCombobox,
  CostValueLabel,
  isSkippedCost,
} from "@/components/finance/finance-other-costs";
import { invalidateFinanceAfterSave } from "@/components/finance/query-keys";
import { TermTooltip } from "@/components/finance/term-tooltip";
import { computeDay } from "@/lib/finance/calc";
import { sendLines } from "@/lib/finance/kpis";
import type { DayActivity, FinanceDay, SendUsage, WaterfallStep } from "@/lib/finance/types";
import { saveFinanceDays, saveOtherCost } from "@/lib/finance.functions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type DayModalCost = {
  id: string;
  descricao: string;
  valor: number;
  categoria: string;
  costDate: string;
  repeatMonthly: boolean;
};

/** "" → null; anything not a finite number → null too (the inputs are type=number). */
export function parseMoneyInput(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const moneyString = (value: number | null) => (value === null ? "" : String(value));

export type DayModalContentProps = {
  day: FinanceDay;
  sends: SendUsage[];
  activity: DayActivity | null;
  otherCosts: DayModalCost[];
  /** The month has a "GGR do mês" total: the day's GGR is its allocation, read-only. */
  usingMonthlyGgr: boolean;
  readOnly: boolean;
  adSpend: string;
  ggr: string;
  onAdSpendChange: (value: string) => void;
  onGgrChange: (value: string) => void;
  neighbors: { prev: string | null; next: string | null };
  onPrev: () => void;
  onNext: () => void;
  onSave: () => void;
  saving: boolean;
  dirty: boolean;
  /** The add form of "Outros custos deste dia" (stateful, given by DayModal). */
  costForm?: ReactNode;
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Figure({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

const withCount = (amount: number, count: number | undefined) =>
  count === undefined ? formatBRL(amount) : `${formatBRL(amount)} (${formatInt(count)})`;

const Pending = () => <span className="text-xs italic text-muted-foreground">pendente</span>;

export function DayModalContent({
  day,
  sends,
  activity,
  otherCosts,
  usingMonthlyGgr,
  readOnly,
  adSpend,
  ggr,
  onAdSpendChange,
  onGgrChange,
  neighbors,
  onPrev,
  onNext,
  onSave,
  saving,
  dirty,
  costForm,
}: DayModalContentProps) {
  // "Resultado do dia" previews what is typed (still unsaved).
  const preview = readOnly
    ? day
    : computeDay({
        ...day,
        adSpend: parseMoneyInput(adSpend),
        ggr: usingMonthlyGgr ? day.ggr : parseMoneyInput(ggr),
      });
  const { steps } = dayResult(preview, sends, otherCosts);
  const lines = sendLines(sends, null);
  const canTypeGgr = !readOnly && !usingMonthlyGgr;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="min-w-0 space-y-6">
        <Section title="Veio do CRM">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            <Figure label="Cadastros">{formatInt(day.registrations)}</Figure>
            <Figure label="FTDs">{formatInt(day.ftds)}</Figure>
            <Figure label="Valor de FTD">{formatBRL(day.ftdDepositAmount)}</Figure>
            <Figure label="Depósitos">
              {withCount(day.depositAmount, activity?.depositCount)}
            </Figure>
            <Figure label="Saques">
              {withCount(day.withdrawalAmount, activity?.withdrawalCount)}
            </Figure>
            <Figure
              label={
                <>
                  {FINANCE_TERMS.net.label}
                  <TermTooltip term="net" />
                </>
              }
            >
              {formatBRL(day.net)}
            </Figure>
            {day.adSpendSuggested !== null && (
              <Figure label="Gasto da Meta">{formatBRL(day.adSpendSuggested)}</Figure>
            )}
          </dl>
          <div className="rounded-md border border-border/40 px-3 py-2">
            <p className="mb-1 text-[11px] text-muted-foreground">
              {FINANCE_TERMS.sends.label} por canal
            </p>
            {lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhum envio neste dia.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {lines.map((line) => (
                  <li key={line.item} className="flex flex-wrap justify-between gap-x-3">
                    <span>
                      {line.label}{" "}
                      <span className="text-muted-foreground">
                        {formatInt(line.units)} {line.unitLabel}
                      </span>
                    </span>
                    <span className="tabular-nums">
                      {formatBRL(line.amount)}
                      {line.missingCost && (
                        <span className="ml-1 text-xs text-muted-foreground">(sem custo)</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Section>

        <Section title="Você lança">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0 space-y-1">
              <p className="text-[11px] text-muted-foreground">Anúncios</p>
              {readOnly ? (
                <p className="text-sm font-medium tabular-nums">
                  {day.adSpend === null ? <Pending /> : formatBRL(day.adSpend)}
                </p>
              ) : (
                <>
                  <Input
                    type="number"
                    step="0.01"
                    min={0}
                    inputMode="decimal"
                    aria-label="Anúncios"
                    value={adSpend}
                    onChange={(e) => onAdSpendChange(e.target.value)}
                  />
                  {day.adSpendSuggested !== null && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-auto w-full gap-1.5 whitespace-normal py-1.5 text-xs"
                      onClick={() => onAdSpendChange(String(day.adSpendSuggested))}
                    >
                      <Sparkles className="h-3.5 w-3.5 shrink-0" />
                      {`Usar valor da Meta (${formatBRL(day.adSpendSuggested)})`}
                    </Button>
                  )}
                </>
              )}
            </div>
            <div className="min-w-0 space-y-1">
              <p className="text-[11px] text-muted-foreground">
                {GGR_COLUMN_LABEL}
                <TermTooltip term="ggr" />
              </p>
              {canTypeGgr ? (
                <Input
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  aria-label={GGR_COLUMN_LABEL}
                  value={ggr}
                  onChange={(e) => onGgrChange(e.target.value)}
                />
              ) : (
                <p className="text-sm font-medium tabular-nums">
                  {day.ggr === null ? (
                    <Pending />
                  ) : (
                    <span className={cn(day.ggrEstimated && "italic")}>{formatBRL(day.ggr)}</span>
                  )}
                </p>
              )}
              {usingMonthlyGgr && (
                <p className="text-[11px] italic text-muted-foreground">
                  {MONTHLY_GGR_COLUMN_NOTE}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-2 rounded-md border border-border/40 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">Outros custos deste dia</p>
            {otherCosts.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhum custo neste dia.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {otherCosts.map((cost) => (
                  <li key={cost.id} className="flex flex-wrap justify-between gap-x-3">
                    <span className="min-w-0 break-words">
                      {cost.descricao}{" "}
                      <span className="text-muted-foreground">· {cost.categoria}</span>
                      {cost.repeatMonthly && (
                        <span className="text-muted-foreground"> · todo mês</span>
                      )}
                    </span>
                    <span className="tabular-nums">
                      <CostValueLabel valor={cost.valor} skipped={isSkippedCost(cost)} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {!readOnly && costForm}
          </div>
        </Section>

        <Section title="Resultado do dia">
          <MiniWaterfall steps={steps} />
        </Section>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-4">
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={neighbors.prev === null}
              onClick={onPrev}
            >
              <ChevronLeft className="h-4 w-4" />
              Dia anterior
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={neighbors.next === null}
              onClick={onNext}
            >
              Próximo dia
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          {!readOnly && (
            <Button type="button" disabled={!dirty || saving} onClick={onSave}>
              {saving ? "Salvando…" : "Salvar"}
            </Button>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

/** The day's waterfall as compact rows: label, amount and a bar of its size. */
export function MiniWaterfall({ steps }: { steps: WaterfallStep[] }) {
  const size = (step: WaterfallStep) =>
    step.kind === "down" || step.kind === "up"
      ? Math.abs(step.end - step.start)
      : Math.abs(step.end);
  const max = Math.max(...steps.map(size), 0);

  return (
    <ul className="space-y-1.5 text-sm">
      {steps.map((step) => {
        const isMove = step.kind === "down" || step.kind === "up";
        const amount = isMove ? Math.abs(step.end - step.start) : step.end;
        const strong = step.kind === "subtotal" || step.kind === "total";
        return (
          <li key={step.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3">
            <span className={cn("truncate", strong && "font-medium")}>
              {step.label}
              {step.kind === "total" && <TermTooltip term="cashResult" />}
            </span>
            <span
              className={cn(
                "text-right tabular-nums",
                strong && "font-semibold",
                step.kind === "down" && "text-muted-foreground",
                step.kind === "total" && step.end < 0 && "text-destructive",
              )}
            >
              {step.kind === "down" ? "− " : step.kind === "up" ? "+ " : ""}
              {formatBRL(amount)}
            </span>
            <span className="col-span-2 h-1 overflow-hidden rounded-full bg-muted/40">
              <span
                className={cn(
                  "block h-full rounded-full",
                  step.kind === "down"
                    ? "bg-amber-500/60"
                    : step.kind === "total" && step.end < 0
                      ? "bg-destructive/70"
                      : "bg-primary/70",
                )}
                style={{ width: `${max === 0 ? 0 : (size(step) / max) * 100}%` }}
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** True from Tailwind's `sm` (640 px) up; false on the server and on a phone. */
function useIsSmUp() {
  const query = "(min-width: 640px)";
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return matches;
}

/** "Outros custos deste dia": add a cost dated on the day (saveOtherCost). */
function DayCostForm({
  tenantId,
  month,
  date,
  categories,
}: {
  tenantId: string;
  month: string;
  date: string;
  categories: string[];
}) {
  const qc = useQueryClient();
  const saveFn = useServerFn(saveOtherCost);
  const [descricao, setDescricao] = useState("");
  const [categoria, setCategoria] = useState("Outros");
  const [valor, setValor] = useState("");
  const [repeatMonthly, setRepeatMonthly] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      saveFn({
        data: {
          tenantId,
          costDate: date,
          descricao,
          categoria,
          valor: Number(valor),
          repeatMonthly,
        },
      }),
    onSuccess: () => {
      toast.success("Custo salvo");
      setDescricao("");
      setValor("");
      setRepeatMonthly(false);
      void invalidateFinanceAfterSave(qc, tenantId, month);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="flex flex-wrap items-end gap-2 pt-1">
      <Input
        className="min-w-0 flex-1 basis-40"
        placeholder="Descrição"
        aria-label="Descrição"
        value={descricao}
        onChange={(e) => setDescricao(e.target.value)}
      />
      <div className="w-full sm:w-44">
        <CategoryCombobox
          categories={categories}
          value={categoria}
          onChange={setCategoria}
          disabled={false}
        />
      </div>
      <Input
        className="w-28"
        type="number"
        step="0.01"
        min={0}
        placeholder="Valor"
        aria-label="Valor"
        value={valor}
        onChange={(e) => setValor(e.target.value)}
      />
      <label className="flex h-9 items-center gap-2 text-sm">
        <Switch
          checked={repeatMonthly}
          onCheckedChange={setRepeatMonthly}
          aria-label="Repetir todo mês"
        />
        Repetir todo mês
      </label>
      <Button
        type="button"
        variant="outline"
        className="gap-1.5"
        disabled={!descricao.trim() || !valor || save.isPending}
        onClick={() => save.mutate()}
      >
        <Plus className="h-4 w-4" />
        Adicionar
      </Button>
    </div>
  );
}

export type DayModalData = {
  days: FinanceDay[];
  sendsByDay: Record<string, SendUsage[]>;
  activityByDay: Record<string, DayActivity>;
  otherCosts: DayModalCost[];
  categories: string[];
  monthlyGgr: unknown;
};

/** The stateful body: the typed values of one day (keyed by date in DayModal). */
function DayModalBody({
  tenantId,
  month,
  day,
  data,
  readOnly,
  onDateChange,
}: {
  tenantId: string;
  month: string;
  day: FinanceDay;
  data: DayModalData;
  readOnly: boolean;
  onDateChange: (date: string | null) => void;
}) {
  const qc = useQueryClient();
  const saveDaysFn = useServerFn(saveFinanceDays);
  const usingMonthlyGgr = data.monthlyGgr !== null;
  const [adSpend, setAdSpend] = useState(() => moneyString(day.adSpend));
  const [ggr, setGgr] = useState(() => moneyString(day.ggr));

  const parsedAdSpend = parseMoneyInput(adSpend);
  const parsedGgr = parseMoneyInput(ggr);
  const dirty = parsedAdSpend !== day.adSpend || (!usingMonthlyGgr && parsedGgr !== day.ggr);

  const save = useMutation({
    mutationFn: () => {
      const entry: { date: string; adSpend: number | null; ggr?: number | null } = {
        date: day.date,
        adSpend: parsedAdSpend,
      };
      if (!usingMonthlyGgr) entry.ggr = parsedGgr;
      return saveDaysFn({ data: { tenantId, entries: [entry] } });
    },
    onSuccess: () => {
      toast.success("Dia salvo");
      void invalidateFinanceAfterSave(qc, tenantId, month);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const neighbors = neighborDays(
    data.days.map((d) => d.date),
    day.date,
    todaySaoPaulo(),
  );

  return (
    <DayModalContent
      day={day}
      sends={data.sendsByDay[day.date] ?? []}
      activity={data.activityByDay[day.date] ?? null}
      otherCosts={data.otherCosts.filter((cost) => cost.costDate === day.date)}
      usingMonthlyGgr={usingMonthlyGgr}
      readOnly={readOnly}
      adSpend={adSpend}
      ggr={ggr}
      onAdSpendChange={setAdSpend}
      onGgrChange={setGgr}
      neighbors={neighbors}
      onPrev={() => neighbors.prev && onDateChange(neighbors.prev)}
      onNext={() => neighbors.next && onDateChange(neighbors.next)}
      onSave={() => save.mutate()}
      saving={save.isPending}
      dirty={dirty}
      costForm={
        <DayCostForm
          tenantId={tenantId}
          month={month}
          date={day.date}
          categories={data.categories}
        />
      }
    />
  );
}

export function DayModal({
  tenantId,
  month,
  date,
  data,
  readOnly,
  onDateChange,
}: {
  tenantId: string;
  month: string;
  /** The open day ("YYYY-MM-DD"); null (or a day not in the month) = closed. */
  date: string | null;
  data: DayModalData;
  readOnly: boolean;
  onDateChange: (date: string | null) => void;
}) {
  const smUp = useIsSmUp();
  const day = date ? data.days.find((d) => d.date === date) : undefined;
  const open = day !== undefined;
  const onOpenChange = (next: boolean) => {
    if (!next) onDateChange(null);
  };

  const title = day ? (
    <span className="flex flex-wrap items-center gap-2">
      {dayLabel(day.date)}
      <DayStatusChip status={dayStatus(day)} />
    </span>
  ) : null;
  const body = day ? (
    <DayModalBody
      key={day.date}
      tenantId={tenantId}
      month={month}
      day={day}
      data={data}
      readOnly={readOnly}
      onDateChange={onDateChange}
    />
  ) : null;
  const description = "Números do CRM, o que você lança e o resultado do dia.";

  if (smUp) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="sr-only">{description}</DialogDescription>
          </DialogHeader>
          {body}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="h-[100dvh] overflow-y-auto overflow-x-hidden px-4 pb-6 pt-5"
      >
        <SheetHeader className="mb-4 text-left">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription className="sr-only">{description}</SheetDescription>
        </SheetHeader>
        {body}
      </SheetContent>
    </Sheet>
  );
}
