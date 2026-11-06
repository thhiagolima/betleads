// Web push (OneSignal): numbers of the /webpush channel overview. Every
// webpush table is service_role only (RLS on, no policies), so the caller
// passes the admin client and the tenant it resolved server-side; every
// query below filters on that tenant explicitly. Only counts and timestamps
// leave this module (never subscription_id, click_key or app keys).
import { brtDayKey, parseBrtDayEnd, parseBrtDayStart } from "@/lib/tz";

/* eslint-disable @typescript-eslint/no-explicit-any -- accepts the admin client or a test double (createFakeDb). */
export type WebpushOverviewDb = { from: (table: string) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

export type WebpushOverviewPeriod = {
  /** First day, YYYY-MM-DD in Brasília. */
  from: string;
  /** Last day, YYYY-MM-DD in Brasília. */
  to: string;
};

export type WebpushChannelOverview = {
  subscriptions: {
    /** Subscriptions still `ativa` (they receive campaigns). */
    active: number;
    /** Every subscription ever recorded, active or not. */
    total: number;
    /** Active subscriptions already linked to a player. */
    linked: number;
  };
  totals: {
    /** Pushes OneSignal accepted in the period (`webpush_send_logs` 'enviado'). */
    sent: number;
    /** Pushes OneSignal refused in the period ('recusado'). */
    refused: number;
    /** Pushes whose first human click happened in the period. */
    clicks: number;
  };
  by_day: Array<{ date: string; sent: number; refused: number }>;
  /** Single-day period only (empty otherwise): every attempt per hour. */
  by_hour: Array<{ t: string; count: number }>;
};

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const PAGE_SIZE = 1000;
// Same ceiling as the history timeline (getChannelDispatchTimeline); the KPI
// totals are exact counts and never depend on it.
const MAX_TIMELINE_ROWS = 50_000;

async function countRows(
  query: PromiseLike<{ count: number | null; error: { message: string } | null }>,
) {
  const { count, error } = await query;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function fetchSendLogTimes(
  db: WebpushOverviewDb,
  tenantId: string,
  fromIso: string,
  toIso: string,
): Promise<Array<{ created_at: string; status: string }>> {
  const out: Array<{ created_at: string; status: string }> = [];
  for (let offset = 0; offset < MAX_TIMELINE_ROWS; offset += PAGE_SIZE) {
    const { data, error } = await db
      .from("webpush_send_logs")
      .select("created_at,status")
      .eq("tenant_id", tenantId)
      .gte("created_at", fromIso)
      .lte("created_at", toIso)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as Array<{ created_at: string; status: string }>;
    out.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return out;
}

export async function getWebpushChannelOverview(
  db: WebpushOverviewDb,
  tenantId: string,
  period: WebpushOverviewPeriod,
  now: Date = new Date(),
): Promise<WebpushChannelOverview> {
  const start = parseBrtDayStart(period.from);
  const end = parseBrtDayEnd(period.to);
  const fromIso = start.toISOString();
  const toIso = end.toISOString();

  const sendLogs = (status: string) =>
    db
      .from("webpush_send_logs")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("status", status)
      .gte("created_at", fromIso)
      .lte("created_at", toIso);

  const [active, total, linked, sent, refused, clicks, logs] = await Promise.all([
    countRows(
      db
        .from("push_subscriptions")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("status", "ativa"),
    ),
    countRows(
      db
        .from("push_subscriptions")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId),
    ),
    countRows(
      db
        .from("push_subscriptions")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("status", "ativa")
        .not("player_id", "is", null),
    ),
    countRows(sendLogs("enviado")),
    countRows(sendLogs("recusado")),
    // Same click definition as the Links page (link_tracking_overview): a
    // dispatch with a human first-party click, stamped by trigger.
    countRows(
      db
        .from("link_dispatches")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("channel", "webpush")
        .gte("first_party_first_clicked_at", fromIso)
        .lte("first_party_first_clicked_at", toIso),
    ),
    fetchSendLogTimes(db, tenantId, fromIso, toIso),
  ]);

  const dayMap = new Map<string, { sent: number; refused: number }>();
  for (let at = start.getTime(); at <= end.getTime(); at += DAY_MS) {
    dayMap.set(brtDayKey(new Date(at)), { sent: 0, refused: 0 });
  }
  const sameDay = period.from === period.to;
  const hourMap = new Map<number, number>();
  for (const log of logs) {
    const at = new Date(log.created_at);
    const slot = dayMap.get(brtDayKey(at));
    if (slot) {
      if (log.status === "enviado") slot.sent += 1;
      else if (log.status === "recusado") slot.refused += 1;
    }
    if (sameDay) {
      // Brasília is a whole-hour offset from UTC, so UTC hour slots are BRT hours.
      const hour = Math.floor(at.getTime() / HOUR_MS) * HOUR_MS;
      hourMap.set(hour, (hourMap.get(hour) ?? 0) + 1);
    }
  }

  const by_hour: WebpushChannelOverview["by_hour"] = [];
  if (sameDay) {
    const lastHour = Math.min(end.getTime(), now.getTime());
    for (let hour = start.getTime(); hour <= lastHour; hour += HOUR_MS) {
      by_hour.push({ t: new Date(hour).toISOString(), count: hourMap.get(hour) ?? 0 });
    }
  }

  return {
    subscriptions: { active, total, linked },
    totals: { sent, refused, clicks },
    by_day: Array.from(dayMap.entries()).map(([date, counts]) => ({ date, ...counts })),
    by_hour,
  };
}
