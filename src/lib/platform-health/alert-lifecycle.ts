// Pure alert lifecycle rules for the super-admin "Saúde" console (F3).
//
// Reconciles the alerts computed this round (`PlatformAlert[]`, from
// alert-rules.ts) against the ones already stored, and decides which
// critical alerts deserve a new notification. No DB access, no server-only
// import — Task 3's loader/writer calls these with already-fetched rows.

import type { AlertSeverity, PlatformAlert } from "./alert-rules";

export type StoredAlert = {
  id: string;
  alertKey: string;
  kind: string;
  severity: AlertSeverity;
  message: string;
  tenantId: string | null;
  href: string | null;
  openedAt: string;
  lastSeenAt: string;
  seenCount: number;
  acknowledgedAt: string | null;
  silencedUntil: string | null;
  lastNotifiedAt: string | null;
};

export type AlertSyncPlan = {
  /** Keys not stored yet: insert as new open alerts. */
  open: PlatformAlert[];
  /** Stored and still present: update message/severity/href, last_seen_at, seen_count+1. */
  seen: Array<{ id: string; alert: PlatformAlert }>;
  /** Stored ids absent now for longer than RESOLVE_GRACE_MS (and not of a failed kind): resolved_at = now. */
  resolve: string[];
};

/** Critical alerts renotify after this long without acknowledgement/silence. */
export const CRITICAL_RENOTIFY_MS = 6 * 60 * 60 * 1000;

/** Default manual-silence duration, in hours. */
export const SILENCE_HOURS = 24;

/** How long resolved alerts are kept before being purged from history. */
export const HISTORY_DAYS = 30;

/**
 * Source name → the `AlertKind`s whose alerts it feeds. Built from the
 * sources `platform-health.server.ts` fans out to (see `sourceFailureAlert`'s
 * `SOURCE_HREFS` map there for the source name list). `tenants` is the house
 * set every per-house rule is limited to (webhook stats, queue rows, runway
 * candidates and zero-balance wallets), so its failure empties all of them;
 * `finance_days` feeds the webhook rules' "house has movement" check. A
 * source with no useful kind (e.g. `finance_activity_days`) is absent on
 * purpose: its failure never suppresses a resolve.
 */
export const SOURCE_KIND: Record<string, readonly PlatformAlert["kind"][]> = {
  observability_job_health: ["job"],
  observability_queue_metrics: ["queue"],
  provider_circuit_breakers: ["provider"],
  dispatch_rate_state: ["provider"],
  shortio_sync_runs: ["provider"],
  billing_runway_alert_candidates: ["runway"],
  tenant_wallets: ["runway"],
  billing_health: ["billing"],
  webhook_logs: ["webhook"],
  tenants: ["webhook", "queue", "runway"],
  finance_days: ["webhook"],
};

/**
 * A stored alert absent from the current round is only resolved once it has
 * not been seen for longer than this, so a key flapping for a round or two
 * keeps its row (and its notification state) instead of resolving + reopening.
 */
export const RESOLVE_GRACE_MS = 15 * 60 * 1000;

/** `source:<name>` → the source name, as used by `sourceFailureAlert`. */
function sourceNameFromKey(key: string): string | null {
  if (!key.startsWith("source:")) return null;
  return key.slice("source:".length);
}

/** `webhook_logs:<house>` (per-house failure) still maps to the webhook kind. */
function kindsForSource(source: string): readonly PlatformAlert["kind"][] {
  if (source in SOURCE_KIND) return SOURCE_KIND[source];
  if (source.startsWith("webhook_logs:")) return SOURCE_KIND.webhook_logs;
  return [];
}

/**
 * Kinds whose data source failed this round, derived from the current
 * round's `source:*` alerts. An unknown source name contributes no kind.
 */
export function failedKindsFrom(alerts: PlatformAlert[]): Set<string> {
  const kinds = new Set<string>();
  for (const alert of alerts) {
    if (alert.kind !== "source") continue;
    const source = sourceNameFromKey(alert.key);
    if (source === null) continue;
    for (const kind of kindsForSource(source)) kinds.add(kind);
  }
  return kinds;
}

/**
 * Reconciles `stored` against `current`: a key present in both is `seen`
 * (refreshed in place), a key only in `current` is `open` (new), and a
 * stored id missing from `current` is `resolve` — unless its kind's source
 * failed this round (`failedKinds`), in which case its absence proves
 * nothing and it is left alone, or it was last seen no longer than
 * `RESOLVE_GRACE_MS` before `now` (also left alone, so a flapping key keeps
 * its row). A previously resolved alert that reopens is
 * not in `stored` any more (the caller only passes still-open rows), so it
 * is just a new `open`, not a special case here.
 */
export function planAlertSync(
  stored: StoredAlert[],
  current: PlatformAlert[],
  failedKinds: Set<string>,
  now: Date,
): AlertSyncPlan {
  const storedByKey = new Map(stored.map((row) => [row.alertKey, row]));
  const currentByKey = new Map(current.map((alert) => [alert.key, alert]));

  const open: PlatformAlert[] = [];
  const seen: Array<{ id: string; alert: PlatformAlert }> = [];
  for (const alert of current) {
    const storedRow = storedByKey.get(alert.key);
    if (storedRow === undefined) open.push(alert);
    else seen.push({ id: storedRow.id, alert });
  }

  const resolve: string[] = [];
  for (const row of stored) {
    if (currentByKey.has(row.alertKey)) continue;
    if (failedKinds.has(row.kind)) continue;
    if (now.getTime() - new Date(row.lastSeenAt).getTime() <= RESOLVE_GRACE_MS) continue;
    resolve.push(row.id);
  }

  return { open, seen, resolve };
}

/** True while `silencedUntil` is set and still in the future at `now`. */
export function isSilenced(a: Pick<StoredAlert, "silencedUntil">, now: Date): boolean {
  if (a.silencedUntil === null) return false;
  return new Date(a.silencedUntil).getTime() > now.getTime();
}

/**
 * Whether a stored alert should get a (re)notification right now: severity
 * critical, not acknowledged, not silenced, and either never notified or
 * notified longer ago than `CRITICAL_RENOTIFY_MS`.
 */
export function shouldNotify(
  a: Pick<StoredAlert, "severity" | "acknowledgedAt" | "silencedUntil" | "lastNotifiedAt">,
  now: Date,
): boolean {
  if (a.severity !== "critical") return false;
  if (a.acknowledgedAt !== null) return false;
  if (isSilenced(a, now)) return false;
  if (a.lastNotifiedAt === null) return true;
  return now.getTime() - new Date(a.lastNotifiedAt).getTime() > CRITICAL_RENOTIFY_MS;
}
