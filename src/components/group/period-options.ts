// Pure helpers of the finance period filter (GroupPeriodBar): the shortcut
// ranges, the preset sent to the server, the compare options offered for a
// period and the date labels. Every function takes today ("YYYY-MM-DD", São
// Paulo) explicitly so it stays testable.
import { compareRange, isWholeMonth, presetRange } from "@/lib/finance/calc";
import type { CompareMode, DateRange, PeriodPreset } from "@/lib/finance/types";

export type PeriodShortcut =
  | "today"
  | "yesterday"
  | "7d"
  | "15d"
  | "30d"
  | "this_week"
  | "last_week"
  | "this_month"
  | "last_month"
  | "3m"
  | "this_year";

/**
 * The dashboard's period: `shortcut` is the option picked (null for dates
 * chosen in the calendar that match none); `preset`, `range` and `compare`
 * go to the server.
 */
export type GroupPeriod = {
  shortcut: PeriodShortcut | null;
  preset: PeriodPreset;
  range: DateRange;
  compare: CompareMode;
};

export const SHORTCUT_LABELS: Record<PeriodShortcut, string> = {
  today: "Hoje",
  yesterday: "Ontem",
  "7d": "Últimos 7 dias",
  "15d": "Últimos 15 dias",
  "30d": "Últimos 30 dias",
  this_week: "Esta semana",
  last_week: "Semana passada",
  this_month: "Este mês",
  last_month: "Mês passado",
  "3m": "Últimos 3 meses",
  this_year: "Este ano",
};

/** The Período menu's side list, by group. */
export const SHORTCUT_GROUPS: { label: string; shortcuts: PeriodShortcut[] }[] = [
  { label: "Dias", shortcuts: ["today", "yesterday", "7d", "15d", "30d"] },
  { label: "Semanas", shortcuts: ["this_week", "last_week"] },
  { label: "Meses", shortcuts: ["this_month", "last_month", "3m", "this_year"] },
];

/** The one-click chips under the fields. */
export const QUICK_SHORTCUTS: { shortcut: PeriodShortcut; label: string }[] = [
  { shortcut: "today", label: "Hoje" },
  { shortcut: "yesterday", label: "Ontem" },
  { shortcut: "7d", label: "7 dias" },
  { shortcut: "30d", label: "30 dias" },
  { shortcut: "this_month", label: "Este mês" },
  { shortcut: "last_month", label: "Mês passado" },
];

const ALL_SHORTCUTS = SHORTCUT_GROUPS.flatMap((group) => group.shortcuts);

// ─── Dates ("YYYY-MM-DD", calendar arithmetic in UTC) ───────────────────────

const DAY_MS = 86_400_000;

function toUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function fromUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(iso: string, delta: number): string {
  return fromUtc(new Date(toUtc(iso).getTime() + delta * DAY_MS));
}

/** The first day of the month `delta` months from iso's. */
function monthStart(iso: string, delta = 0): string {
  const date = toUtc(iso);
  return fromUtc(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, 1)));
}

/** Days of the range, both ends included. */
export function rangeDays(range: DateRange): number {
  return Math.round((toUtc(range.to).getTime() - toUtc(range.from).getTime()) / DAY_MS) + 1;
}

/** Today in São Paulo. */
export function todayIso(now: Date = new Date()): string {
  return presetRange("today", now).from;
}

export function shortcutRange(shortcut: PeriodShortcut, today: string): DateRange {
  switch (shortcut) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const yesterday = addDays(today, -1);
      return { from: yesterday, to: yesterday };
    }
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "15d":
      return { from: addDays(today, -14), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "this_week":
    case "last_week": {
      // Weeks run Monday to Sunday.
      const sinceMonday = (toUtc(today).getUTCDay() + 6) % 7;
      const monday = addDays(today, -sinceMonday);
      return shortcut === "this_week"
        ? { from: monday, to: today }
        : { from: addDays(monday, -7), to: addDays(monday, -1) };
    }
    case "this_month":
      return { from: monthStart(today), to: today };
    case "last_month":
      return { from: monthStart(today, -1), to: addDays(monthStart(today), -1) };
    case "3m":
      return { from: monthStart(today, -2), to: today };
    case "this_year":
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

const sameRange = (a: DateRange, b: DateRange) => a.from === b.from && a.to === b.to;

/** The first shortcut (menu order) whose range is exactly `range`, else null. */
export function matchShortcut(range: DateRange, today: string): PeriodShortcut | null {
  return ALL_SHORTCUTS.find((shortcut) => sameRange(shortcutRange(shortcut, today), range)) ?? null;
}

/**
 * The preset sent to the server: "Este mês" is "month"; anything else is
 * "custom" unless its range is exactly today, yesterday or the last 7 days.
 */
export function presetFor(
  shortcut: PeriodShortcut | null,
  range: DateRange,
  today: string,
): PeriodPreset {
  if (shortcut === "this_month") return "month";
  for (const preset of ["today", "yesterday", "7d"] as const) {
    if (sameRange(shortcutRange(preset, today), range)) return preset;
  }
  return "custom";
}

// ─── Compare options ────────────────────────────────────────────────────────

export type PeriodKind = "day" | "month" | "range";

/** Este mês, Mês passado or a whole calendar month is a month; then one day; else a range. */
export function periodKind(period: Pick<GroupPeriod, "shortcut" | "range">): PeriodKind {
  if (period.shortcut === "this_month" || period.shortcut === "last_month") return "month";
  if (period.range.from === period.range.to) return "day";
  return isWholeMonth(period.range) ? "month" : "range";
}

const COMPARE_LABELS: Record<PeriodKind, { mode: CompareMode; label: string }[]> = {
  day: [
    { mode: "previous", label: "Dia anterior" },
    { mode: "same_weekday_last_week", label: "Mesmo dia da semana passada" },
    { mode: "same_period_last_year", label: "Mesmo dia do ano passado" },
    { mode: "none", label: "Sem comparação" },
  ],
  month: [
    { mode: "previous", label: "Mês anterior" },
    { mode: "same_period_last_year", label: "Mesmo mês do ano passado" },
    { mode: "none", label: "Sem comparação" },
  ],
  range: [
    { mode: "previous", label: "Período anterior" },
    { mode: "same_period_last_year", label: "Mesmo período do ano passado" },
    { mode: "none", label: "Sem comparação" },
  ],
};

export type CompareOption = { mode: CompareMode; label: string; dates: string | null };

/** The "Comparar com" options of the period, each with its dates (null for none). */
export function compareOptions(
  period: Pick<GroupPeriod, "shortcut" | "range" | "preset">,
  today: string,
): CompareOption[] {
  return COMPARE_LABELS[periodKind(period)].map(({ mode, label }) => {
    const window = compareRange(period.range, mode, period.preset);
    return { mode, label, dates: window ? formatRange(window, today) : null };
  });
}

/** The compare mode kept for a new period: the current one if offered, else the first option. */
function keptCompare(
  period: Pick<GroupPeriod, "shortcut" | "range" | "preset">,
  compare: CompareMode,
): CompareMode {
  const offered = COMPARE_LABELS[periodKind(period)];
  return offered.some((option) => option.mode === compare) ? compare : offered[0].mode;
}

export function periodFromShortcut(
  shortcut: PeriodShortcut,
  compare: CompareMode,
  today: string,
): GroupPeriod {
  const range = shortcutRange(shortcut, today);
  const preset = presetFor(shortcut, range, today);
  return { shortcut, preset, range, compare: keptCompare({ shortcut, range, preset }, compare) };
}

/** A range chosen in the calendar; it takes the shortcut it matches exactly, if any. */
export function periodFromRange(
  range: DateRange,
  compare: CompareMode,
  today: string,
): GroupPeriod {
  const shortcut = matchShortcut(range, today);
  if (shortcut) return periodFromShortcut(shortcut, compare, today);
  const preset = presetFor(null, range, today);
  return {
    shortcut: null,
    preset,
    range,
    compare: keptCompare({ shortcut, range, preset }, compare),
  };
}

export function defaultGroupPeriod(now: Date = new Date()): GroupPeriod {
  return periodFromShortcut("this_month", "previous", todayIso(now));
}

// ─── Labels ─────────────────────────────────────────────────────────────────

/** "dd/mm", adding "/aa" when the year differs from today's. */
export function formatDay(iso: string, today: string): string {
  const [y, m, d] = iso.split("-");
  return y === today.slice(0, 4) ? `${d}/${m}` : `${d}/${m}/${y.slice(2)}`;
}

/** "29/10" for one day, "01/10 a 29/10" for a range. */
export function formatRange(range: DateRange, today: string): string {
  return range.from === range.to
    ? formatDay(range.from, today)
    : `${formatDay(range.from, today)} a ${formatDay(range.to, today)}`;
}

/** "29/10/2026". */
export const fullDate = (iso: string) => iso.split("-").reverse().join("/");

/** The calendar footer: "01/10/2026 a 29/10/2026 · 29 dias". */
export function calendarFooter(range: DateRange): string {
  const days = rangeDays(range);
  return `${fullDate(range.from)} a ${fullDate(range.to)} · ${days} ${days === 1 ? "dia" : "dias"}`;
}

/** The Período field: the option's name and its dates. */
export function periodLabel(period: GroupPeriod, today: string): { name: string; dates: string } {
  return {
    name: period.shortcut ? SHORTCUT_LABELS[period.shortcut] : "Personalizado",
    dates: formatRange(period.range, today),
  };
}

/** The Comparar com field: the option picked (the first one when not offered). */
export function compareLabel(period: GroupPeriod, today: string): CompareOption {
  const options = compareOptions(period, today);
  return options.find((option) => option.mode === period.compare) ?? options[0];
}
