// Stored platform alerts for the super-admin "Saúde" console (F3).
//
// `syncPlatformAlerts` is the cron's job (/api/public/hooks/platform-alerts):
// it computes the health alerts, reconciles them with the open rows of
// `platform_alerts` (alert-lifecycle.ts decides open/seen/resolve), e-mails
// the critical ones that are due and purges old history. The other exports
// back the console's server functions (behind `assertSuperAdmin`).
//
// Concurrency (two cron runs at once):
//   * Only one open row per alert_key: the partial unique index
//     `platform_alerts_one_open_per_key` rejects the second insert (23505),
//     which is ignored. PostgREST's upsert cannot target a partial index, so
//     each new alert is a single-row insert.
//   * Only one e-mail per due alert: before sending, each row is claimed by
//     an UPDATE of last_notified_at guarded by the value read (eq, or is
//     null); a concurrent run that read the same value updates nothing and
//     leaves that row out of its e-mail. The claim comes first on purpose: a
//     provider outage costs that round's e-mail (renotified after
//     CRITICAL_RENOTIFY_MS), never a duplicate.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import type { PlatformAlert } from "./alert-rules";
import {
  failedKindsFrom,
  HISTORY_DAYS,
  planAlertSync,
  shouldNotify,
  SILENCE_HOURS,
  type StoredAlert,
} from "./alert-lifecycle";
import { isPlatformAlertsEmailEnabled, notifyCriticalAlerts } from "./alert-email.server";
import { computePlatformHealth } from "./platform-health.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- platform_alerts is not in the generated Supabase types yet.
type LooseDb = any;

const db = () => supabaseAdmin as LooseDb;

const TABLE = "platform_alerts";
const COLUMNS =
  "id, alert_key, kind, severity, message, tenant_id, href, opened_at, last_seen_at, seen_count, acknowledged_at, silenced_until, last_notified_at";
const UNIQUE_VIOLATION = "23505";
const PURGE_BATCH = 500;
const HISTORY_LIMIT = 200;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

type AlertRow = {
  id: string;
  alert_key: string;
  kind: string;
  severity: StoredAlert["severity"];
  message: string;
  tenant_id: string | null;
  href: string | null;
  opened_at: string;
  last_seen_at: string;
  seen_count: number;
  acknowledged_at: string | null;
  silenced_until: string | null;
  last_notified_at: string | null;
  resolved_at?: string | null;
};

type DbError = { message: string; code?: string } | null;

function toStored(row: AlertRow): StoredAlert {
  return {
    id: row.id,
    alertKey: row.alert_key,
    kind: row.kind,
    severity: row.severity,
    message: row.message,
    tenantId: row.tenant_id ?? null,
    href: row.href ?? null,
    openedAt: row.opened_at,
    lastSeenAt: row.last_seen_at,
    seenCount: Number(row.seen_count ?? 1),
    acknowledgedAt: row.acknowledged_at ?? null,
    silencedUntil: row.silenced_until ?? null,
    lastNotifiedAt: row.last_notified_at ?? null,
  };
}

function fail(error: DbError): never {
  throw new Error(error?.message ?? "Falha ao acessar platform_alerts.");
}

/** Every open (unresolved) alert, oldest first. */
export async function loadOpenAlerts(): Promise<StoredAlert[]> {
  const { data, error } = await db()
    .from(TABLE)
    .select(COLUMNS)
    .is("resolved_at", null)
    .order("opened_at", { ascending: true });
  if (error) fail(error);
  return ((data ?? []) as AlertRow[]).map(toStored);
}

/**
 * Inserts `alert` as a new open row. Returns false when an open row of the
 * key already exists (unique violation from a concurrent run); throws on any
 * other error. `resolved_at: null` is explicit so the row is unambiguously
 * open (and the test fake models the partial index on it).
 */
async function insertOpenAlert(alert: PlatformAlert, now: Date): Promise<boolean> {
  const nowIso = now.toISOString();
  const { error } = await db().from(TABLE).insert({
    alert_key: alert.key,
    kind: alert.kind,
    severity: alert.severity,
    message: alert.message,
    tenant_id: alert.tenantId,
    href: alert.href,
    opened_at: nowIso,
    last_seen_at: nowIso,
    seen_count: 1,
    resolved_at: null,
    last_notified_at: null,
  });
  if (!error) return true;
  if ((error as DbError)?.code === UNIQUE_VIOLATION) return false;
  fail(error);
}

/**
 * Claims the right to notify `alert`: sets last_notified_at = now only if it
 * still holds the value read. True when this call won.
 */
async function claimNotification(alert: StoredAlert, now: Date): Promise<boolean> {
  let query = db()
    .from(TABLE)
    .update({ last_notified_at: now.toISOString() })
    .eq("id", alert.id)
    .is("resolved_at", null);
  query =
    alert.lastNotifiedAt === null
      ? query.is("last_notified_at", null)
      : query.eq("last_notified_at", alert.lastNotifiedAt);
  const { data, error } = await query.select("id");
  if (error) fail(error);
  return ((data ?? []) as unknown[]).length > 0;
}

/** Deletes one batch of resolved rows older than HISTORY_DAYS; returns how many. */
async function purgeOldResolved(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - HISTORY_DAYS * DAY_MS).toISOString();
  const { data, error } = await db()
    .from(TABLE)
    .select("id")
    .not("resolved_at", "is", null)
    .lt("resolved_at", cutoff)
    .limit(PURGE_BATCH);
  if (error) fail(error);
  const ids = ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
  if (ids.length === 0) return 0;
  const { error: deleteError } = await db().from(TABLE).delete().in("id", ids);
  if (deleteError) fail(deleteError);
  return ids.length;
}

/**
 * One cron round. Counters: `opened` rows actually inserted (a key a
 * concurrent run inserted first is not counted), `seen` refreshed, `resolved`
 * closed, `notified` e-mails accepted by the provider, `purged` history rows
 * deleted.
 */
export async function syncPlatformAlerts(
  now: Date,
): Promise<{ opened: number; seen: number; resolved: number; notified: number; purged: number }> {
  const health = await computePlatformHealth(now);
  const stored = await loadOpenAlerts();
  const plan = planAlertSync(stored, health.alerts, failedKindsFrom(health.alerts));
  const nowIso = now.toISOString();

  let opened = 0;
  for (const alert of plan.open) {
    if (await insertOpenAlert(alert, now)) opened += 1;
  }

  const storedById = new Map(stored.map((row) => [row.id, row]));
  for (const { id, alert } of plan.seen) {
    const previous = storedById.get(id);
    const { error } = await db()
      .from(TABLE)
      .update({
        severity: alert.severity,
        message: alert.message,
        href: alert.href,
        last_seen_at: nowIso,
        seen_count: (previous?.seenCount ?? 1) + 1,
      })
      .eq("id", id)
      .is("resolved_at", null);
    if (error) fail(error);
  }

  if (plan.resolve.length > 0) {
    const { error } = await db()
      .from(TABLE)
      .update({ resolved_at: nowIso })
      .in("id", plan.resolve)
      .is("resolved_at", null);
    if (error) fail(error);
  }

  let notified = 0;
  if (isPlatformAlertsEmailEnabled()) {
    const due = (await loadOpenAlerts()).filter((alert) => shouldNotify(alert, now));
    const claimed: StoredAlert[] = [];
    for (const alert of due) {
      if (await claimNotification(alert, now)) claimed.push(alert);
    }
    if (claimed.length > 0) notified = await notifyCriticalAlerts(claimed, now);
  }

  const purged = await purgeOldResolved(now);

  return { opened, seen: plan.seen.length, resolved: plan.resolve.length, notified, purged };
}

/**
 * Open row id for `alertKey`, inserting it from `current` first when the
 * cron has not stored it yet. Throws "Alerta não encontrado." when there is
 * no open row and no matching current alert.
 */
async function ensureOpenAlert(
  alertKey: string,
  current: PlatformAlert | null,
  now: Date,
): Promise<void> {
  const { data, error } = await db()
    .from(TABLE)
    .select("id")
    .eq("alert_key", alertKey)
    .is("resolved_at", null)
    .maybeSingle();
  if (error) fail(error);
  if (data) return;
  if (current === null || current.key !== alertKey) throw new Error("Alerta não encontrado.");
  // false = a concurrent cron run inserted it in between; it is open either way.
  await insertOpenAlert(current, now);
}

async function updateOpenAlert(alertKey: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db()
    .from(TABLE)
    .update(patch)
    .eq("alert_key", alertKey)
    .is("resolved_at", null);
  if (error) fail(error);
}

/** Marks the open alert as acknowledged by `userId` (no more e-mails for it). */
export async function acknowledgeAlert(
  alertKey: string,
  userId: string,
  current: PlatformAlert | null,
  now: Date,
): Promise<void> {
  await ensureOpenAlert(alertKey, current, now);
  await updateOpenAlert(alertKey, {
    acknowledged_at: now.toISOString(),
    acknowledged_by: userId,
  });
}

/** Silences the open alert for SILENCE_HOURS from `now`. */
export async function silenceAlert(
  alertKey: string,
  current: PlatformAlert | null,
  now: Date,
): Promise<void> {
  await ensureOpenAlert(alertKey, current, now);
  await updateOpenAlert(alertKey, {
    silenced_until: new Date(now.getTime() + SILENCE_HOURS * HOUR_MS).toISOString(),
  });
}

/** Alerts resolved in the last HISTORY_DAYS, newest first, at most 200. */
export async function listAlertHistory(
  now: Date,
): Promise<Array<StoredAlert & { resolvedAt: string }>> {
  const since = new Date(now.getTime() - HISTORY_DAYS * DAY_MS).toISOString();
  const { data, error } = await db()
    .from(TABLE)
    .select(`${COLUMNS}, resolved_at`)
    .not("resolved_at", "is", null)
    .gte("resolved_at", since)
    .order("resolved_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error) fail(error);
  return ((data ?? []) as AlertRow[]).map((row) => ({
    ...toStored(row),
    resolvedAt: String(row.resolved_at),
  }));
}
