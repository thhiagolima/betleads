// Period + compare chips for the group panel (spec §6). Controlled: the
// caller (routes/grupo.tsx) owns the GroupPeriod state and passes it back to
// the server fn getGroupOverview. "Mesmo dia da semana passada" only makes
// sense for a one-day window, so it is hidden otherwise.
import {
  DashboardDateRangePicker,
  rangeToKey,
  type DashboardRange,
} from "@/components/dashboard-date-range-picker";
import { presetRange } from "@/lib/finance/calc";
import type { CompareMode, DateRange, PeriodPreset } from "@/lib/finance/types";
import { cn } from "@/lib/utils";

export type GroupPeriod = { preset: PeriodPreset; range: DateRange; compare: CompareMode };

const PRESETS: { value: PeriodPreset; label: string }[] = [
  { value: "today", label: "Hoje" },
  { value: "yesterday", label: "Ontem" },
  { value: "7d", label: "7 dias" },
  { value: "month", label: "Mês" },
  { value: "custom", label: "Personalizado" },
];

const COMPARES: { value: CompareMode; label: string }[] = [
  { value: "previous", label: "período anterior" },
  { value: "same_weekday_last_week", label: "mesmo dia da semana passada" },
  { value: "last_week", label: "mesmo período da semana passada" },
];

function isOneDay(range: DateRange) {
  return range.from === range.to;
}

function dateFromIso(iso: string) {
  return new Date(`${iso}T00:00:00`);
}

export function defaultGroupPeriod(): GroupPeriod {
  return { preset: "month", range: presetRange("month", new Date()), compare: "previous" };
}

export function GroupPeriodBar({
  value,
  onChange,
}: {
  value: GroupPeriod;
  onChange: (next: GroupPeriod) => void;
}) {
  const oneDay = isOneDay(value.range);
  const compares = COMPARES.filter((c) => c.value !== "same_weekday_last_week" || oneDay);

  const chipClass = (active: boolean) =>
    cn(
      "rounded-full border px-3 py-1 text-xs transition-colors",
      active
        ? "border-primary bg-primary text-primary-foreground"
        : "border-border/60 text-muted-foreground hover:text-foreground",
    );

  const setPreset = (preset: PeriodPreset) => {
    if (preset === "custom") {
      onChange({ ...value, preset });
      return;
    }
    const range = presetRange(preset, new Date());
    const compare =
      value.compare === "same_weekday_last_week" && !isOneDay(range) ? "previous" : value.compare;
    onChange({ preset, range, compare });
  };

  const setCustomRange = (dashboardRange: DashboardRange) => {
    onChange({ preset: "custom", range: rangeToKey(dashboardRange), compare: value.compare });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {PRESETS.map((preset) => (
        <button
          key={preset.value}
          type="button"
          className={chipClass(value.preset === preset.value)}
          onClick={() => setPreset(preset.value)}
        >
          {preset.label}
        </button>
      ))}
      {value.preset === "custom" && (
        <DashboardDateRangePicker
          range={{ from: dateFromIso(value.range.from), to: dateFromIso(value.range.to) }}
          onChange={setCustomRange}
        />
      )}
      <span className="text-xs text-muted-foreground">comparar com</span>
      {compares.map((compare) => (
        <button
          key={compare.value}
          type="button"
          className={chipClass(value.compare === compare.value)}
          onClick={() => onChange({ ...value, compare: compare.value })}
        >
          {compare.label}
        </button>
      ))}
    </div>
  );
}
