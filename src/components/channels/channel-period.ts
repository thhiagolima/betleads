import type { DateRange } from "react-day-picker";

import { brtDayEnd, brtDayKey, brtDayStart } from "@/lib/tz";

export type ChannelPeriodQuery = {
  /** First day, YYYY-MM-DD in Brasília (what the channel dashboards take). */
  from: string;
  /** Last day, YYYY-MM-DD in Brasília. */
  to: string;
  sameDay: boolean;
  includesToday: boolean;
};

/** PeriodPicker range → the {from, to} days the SMS/Email/Voz dashboards accept. */
export function periodQuery(
  range: DateRange | undefined,
  now: Date = new Date(),
): ChannelPeriodQuery {
  const fromDate = range?.from ?? now;
  const toDate = range?.to ?? fromDate;
  let from = brtDayKey(fromDate);
  let to = brtDayKey(toDate);
  if (from > to) [from, to] = [to, from];
  const today = brtDayKey(now);
  if (to > today) to = today;
  if (from > to) from = to;
  return { from, to, sameDay: from === to, includesToday: to === today };
}

/**
 * PeriodPicker range → the window the history server functions take. A
 * window that reaches today sends `to: null` (the server reads it as "now"),
 * which keeps the query key stable between renders.
 */
export function historyWindow(
  range: DateRange | undefined,
  now: Date = new Date(),
): { from: string; to: string | null; bucket: "hour" | "day" } {
  const q = periodQuery(range, now);
  const from = brtDayStart(new Date(`${q.from}T12:00:00-03:00`)).toISOString();
  const to = q.includesToday ? null : brtDayEnd(new Date(`${q.to}T12:00:00-03:00`)).toISOString();
  return { from, to, bucket: q.sameDay ? "hour" : "day" };
}
