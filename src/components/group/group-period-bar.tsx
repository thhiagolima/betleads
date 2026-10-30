// Period filter of the finance dashboard (also on /grupo). Controlled: the
// caller (FinanceDashboardView) owns the GroupPeriod and passes it to the
// server fn getFinanceDashboard. Two fields, "Período" vs "Comparar com", each
// showing the option and its exact dates, then one-click chips. The Período
// menu is a popover (shortcuts + 2-month calendar) on desktop and a bottom
// sheet on phones; the compare options depend on the period (period-options).
import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ptBR } from "react-day-picker/locale";

import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import type { DateRange } from "@/lib/finance/types";
import { cn } from "@/lib/utils";

import {
  calendarFooter,
  compareLabel,
  compareOptions,
  formatRange,
  fullDate,
  periodFromRange,
  periodFromShortcut,
  periodLabel,
  QUICK_SHORTCUTS,
  rangeDays,
  SHORTCUT_GROUPS,
  SHORTCUT_LABELS,
  shortcutRange,
  todayIso,
  type GroupPeriod,
  type PeriodShortcut,
} from "./period-options";

/** The server refuses longer ranges (finance-data.server MAX_RANGE_DAYS). */
const MAX_RANGE_DAYS = 366;

const isoToDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};

const dateToIso = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/70">
        {label}
      </span>
      {children}
    </div>
  );
}

function fieldButtonClass() {
  return "flex w-full min-w-0 items-center justify-between gap-2.5 rounded-[10px] border border-border bg-card px-3 py-2 text-left text-sm transition-colors hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto sm:min-w-[230px]";
}

function FieldText({ name, dates }: { name: string; dates: string | null }) {
  return (
    <>
      <span className="min-w-0 truncate">
        <span className="font-semibold">{name}</span>
        {dates && <span className="text-[12.5px] text-muted-foreground"> · {dates}</span>}
      </span>
      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground/70" aria-hidden />
    </>
  );
}

/** Two clicks pick the start and the end; "Aplicar" sends the range. */
function RangeCalendar({
  initial,
  today,
  months,
  onCancel,
  onApply,
}: {
  initial: DateRange;
  today: string;
  months: 1 | 2;
  onCancel: () => void;
  onApply: (range: DateRange) => void;
}) {
  const [draft, setDraft] = useState<{ from: string; to: string | null }>(initial);
  const [month, setMonth] = useState(() => {
    const end = isoToDate(initial.to);
    return new Date(end.getFullYear(), end.getMonth() - (months - 1), 1);
  });

  const pick = (day: string) => {
    if (draft.to !== null) setDraft({ from: day, to: null });
    else if (day < draft.from) setDraft({ from: day, to: draft.from });
    else setDraft({ from: draft.from, to: day });
  };

  const complete = draft.to !== null ? { from: draft.from, to: draft.to } : null;
  const tooLong = complete !== null && rangeDays(complete) > MAX_RANGE_DAYS;

  return (
    <div className="flex min-w-0 flex-col">
      <Calendar
        mode="range"
        locale={ptBR}
        weekStartsOn={1}
        numberOfMonths={months}
        month={month}
        onMonthChange={setMonth}
        endMonth={isoToDate(today)}
        disabled={{ after: isoToDate(today) }}
        selected={{
          from: isoToDate(draft.from),
          to: draft.to ? isoToDate(draft.to) : undefined,
        }}
        onSelect={(_, day) => pick(dateToIso(day))}
        className="p-2 sm:p-3"
      />
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 pt-2.5 pb-1 text-[12.5px] text-muted-foreground">
        <span>
          {complete ? calendarFooter(complete) : `${fullDate(draft.from)} a …`}
          {tooLong && <span className="text-destructive"> · máximo {MAX_RANGE_DAYS} dias</span>}
        </span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            className="rounded-md px-2.5 py-1.5 hover:text-foreground"
            onClick={onCancel}
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={!complete || tooLong}
            className="rounded-md bg-primary px-3.5 py-1.5 font-semibold text-primary-foreground disabled:opacity-50"
            onClick={() => complete && onApply(complete)}
          >
            Aplicar
          </button>
        </span>
      </div>
    </div>
  );
}

function PeriodPicker({
  value,
  today,
  onChange,
}: {
  value: GroupPeriod;
  today: string;
  onChange: (next: GroupPeriod) => void;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetCalendar, setSheetCalendar] = useState(false);
  const label = periodLabel(value, today);

  const applyShortcut = (shortcut: PeriodShortcut) => {
    onChange(periodFromShortcut(shortcut, value.compare, today));
    setPopoverOpen(false);
    setSheetOpen(false);
  };
  const applyRange = (range: DateRange) => {
    onChange(periodFromRange(range, value.compare, today));
    setPopoverOpen(false);
    setSheetOpen(false);
  };

  const open = () => {
    // Phones (< sm) get the bottom sheet, larger screens the popover.
    if (typeof window !== "undefined" && window.matchMedia("(min-width: 640px)").matches) {
      setPopoverOpen(true);
    } else {
      setSheetCalendar(false);
      setSheetOpen(true);
    }
  };

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverAnchor asChild>
          <button
            type="button"
            aria-haspopup="dialog"
            className={fieldButtonClass()}
            onClick={open}
          >
            <FieldText name={label.name} dates={label.dates} />
          </button>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="flex w-auto max-w-[calc(100vw-2rem)] overflow-hidden rounded-[14px] p-0"
        >
          <div className="w-[190px] shrink-0 border-r border-border p-2">
            {SHORTCUT_GROUPS.map((group) => (
              <div key={group.label}>
                <p className="px-2 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/70">
                  {group.label}
                </p>
                {group.shortcuts.map((shortcut) => {
                  const oneDay = shortcut === "today" || shortcut === "yesterday";
                  return (
                    <button
                      key={shortcut}
                      type="button"
                      className={cn(
                        "flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent",
                        value.shortcut === shortcut &&
                          "bg-primary/15 text-primary hover:bg-primary/20",
                      )}
                      onClick={() => applyShortcut(shortcut)}
                    >
                      {SHORTCUT_LABELS[shortcut]}
                      {oneDay && (
                        <span className="text-xs text-muted-foreground">
                          {formatRange(shortcutRange(shortcut, today), today)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="p-2">
            <RangeCalendar
              key={`${value.range.from}:${value.range.to}`}
              initial={value.range}
              today={today}
              months={2}
              onCancel={() => setPopoverOpen(false)}
              onApply={applyRange}
            />
          </div>
        </PopoverContent>
      </Popover>
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="bottom" className="max-h-[90vh] overflow-y-auto rounded-t-2xl p-4">
          <SheetTitle className="mb-3 text-base">Período</SheetTitle>
          {sheetCalendar ? (
            <div className="flex justify-center">
              <RangeCalendar
                initial={value.range}
                today={today}
                months={1}
                onCancel={() => setSheetCalendar(false)}
                onApply={applyRange}
              />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {SHORTCUT_GROUPS.flatMap((group) => group.shortcuts).map((shortcut) => (
                <button
                  key={shortcut}
                  type="button"
                  className={cn(
                    "min-w-0 rounded-[10px] border border-border px-2.5 py-2.5 text-left text-[13px]",
                    value.shortcut === shortcut && "border-primary bg-primary/15 text-primary",
                  )}
                  onClick={() => applyShortcut(shortcut)}
                >
                  {SHORTCUT_LABELS[shortcut]}
                  <span className="block truncate text-[11.5px] text-muted-foreground">
                    {formatRange(shortcutRange(shortcut, today), today)}
                  </span>
                </button>
              ))}
              <button
                type="button"
                className={cn(
                  "min-w-0 rounded-[10px] border border-border px-2.5 py-2.5 text-left text-[13px]",
                  value.shortcut === null && "border-primary bg-primary/15 text-primary",
                )}
                onClick={() => setSheetCalendar(true)}
              >
                Escolher datas…
                <span className="block text-[11.5px] text-muted-foreground">calendário</span>
              </button>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function ComparePicker({
  value,
  today,
  onChange,
}: {
  value: GroupPeriod;
  today: string;
  onChange: (next: GroupPeriod) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = compareLabel(value, today);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={fieldButtonClass()}>
          <FieldText name={current.label} dates={current.dates} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(320px,calc(100vw-2rem))] rounded-xl p-1.5">
        {compareOptions(value, today).map((option) => (
          <button
            key={option.mode}
            type="button"
            className={cn(
              "flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left text-[13px] transition-colors hover:bg-accent",
              option.mode === current.mode && "bg-primary/15 text-primary hover:bg-primary/20",
            )}
            onClick={() => {
              onChange({ ...value, compare: option.mode });
              setOpen(false);
            }}
          >
            {option.label}
            {option.dates && (
              <span className="shrink-0 text-xs text-muted-foreground">{option.dates}</span>
            )}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function GroupPeriodBar({
  value,
  onChange,
}: {
  value: GroupPeriod;
  onChange: (next: GroupPeriod) => void;
}) {
  const today = todayIso();
  return (
    <div className="min-w-0 space-y-2.5">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-end">
        <Field label="Período">
          <PeriodPicker value={value} today={today} onChange={onChange} />
        </Field>
        <span className="hidden pb-2 text-sm text-muted-foreground/70 sm:block">vs</span>
        <Field label="Comparar com">
          <ComparePicker value={value} today={today} onChange={onChange} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {QUICK_SHORTCUTS.map((chip) => {
          const active = value.shortcut === chip.shortcut;
          return (
            <button
              key={chip.shortcut}
              type="button"
              aria-pressed={active}
              className={cn(
                "rounded-full border px-3 py-1 text-[12.5px] transition-colors",
                active
                  ? "border-primary bg-primary font-semibold text-primary-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
              onClick={() => onChange(periodFromShortcut(chip.shortcut, value.compare, today))}
            >
              {chip.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
