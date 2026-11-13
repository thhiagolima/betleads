// Pure alert rules for the super-admin "Saúde" console (F1, spec §5.2).
//
// Every function here is a pure read of already-fetched rows: no DB access,
// no server-only import. Task 3's loader fetches the rows and calls these;
// Task 4's UI imports the types. Keep it that way — this file may be
// imported (types only) from client components, so it must stay free of
// `*.server.ts` runtime imports.

import type { BillingHealthReport } from "@/lib/billing/billing-health.server";

export type AlertSeverity = "critical" | "warning";
export type AlertKind = "job" | "webhook" | "queue" | "provider" | "runway" | "billing" | "source";

export type PlatformAlert = {
  key: string;
  kind: AlertKind;
  severity: AlertSeverity;
  message: string;
  tenantId: string | null;
  since: string | null;
  /** Screen that fixes it; null when there is no useful screen (row is not clickable). */
  href: string | null;
};

export type JobHealthRow = {
  job: string;
  last_started_at: string | null;
  last_status: string | null;
  seconds_since_last_start: number | null;
  stale_running: number;
  oldest_running_heartbeat_at: string | null;
  runs_last_hour: number;
  failed_last_hour: number;
  partial_last_hour: number;
};

export type WebhookStats = {
  tenantId: string;
  name: string;
  lastEventAt: string | null;
  /** Estimated from the last ≤200 events of the past 7 days (see `estimateEventsPerDay`). */
  eventsPerDay: number;
  errors24h: number;
  /** The house has cadastros in the health table (current or base window). */
  hasMovement: boolean;
};

export type QueueMetricRow = {
  tenant_id: string;
  channel: string;
  ready: number;
  paused: number;
  oldest_ready_age_seconds: number | null;
  sent_15m: number;
  errors_15m: number;
};

export type BreakerRow = {
  channel: string;
  state: string;
  reason: string | null;
  first_opened_at: string | null;
};

export type RateStateRow = {
  channel: string;
  last_provider_error: string | null;
  backoff_until: string | null;
};

export type ShortioRunRow = { started_at: string; claimed: number; rate_limited: number };

export type RunwayRow = { tenant_id: string; tenant_name: string; runway_hours: number | string };

/**
 * Expected period (seconds) between starts, for jobs confirmed (05/11
 * snapshot, 48 h, every hour had a row) to run on every tick. A job missing
 * here never gets a "sem rodar" alert (e.g. `sms_campaign_dispatch`, which
 * only writes a row when it claims a campaign). `billing-cycle` and
 * `billing-reconcile` are left out on purpose: `checkBillingHealth` already
 * reports their staleness (billing alerts), so listing them here would
 * duplicate the alert.
 */
export const JOB_EXPECTED_PERIOD_S: Record<string, number> = {
  dashboard_metrics_refresh: 300,
  email_tick: 60,
  journey_dispatch: 60,
  journey_level_outbox: 60,
  journey_scan: 60,
  platform_alerts: 300,
  recovery: 60,
  shortio_sync: 300,
  sms_route_probe: 1800,
  sms_tick: 60,
  tenant_domains_verify: 600,
  webhook_replay: 300,
};

/** Readable labels for jobs where a plain name would read poorly in pt-BR. */
const JOB_LABELS: Record<string, string> = {
  sms_tick: "Disparo de SMS",
  sms_route_probe: "Teste da rota SMS",
  email_tick: "Disparo de e-mail",
};

export const ALERT_THRESHOLDS = {
  /** `seconds_since_last_start` beyond this many × the expected period is late. */
  jobLateMultiplier: 3,
  /** Webhook silence floor, in hours, regardless of volume. */
  webhookSilenceMinHours: 2,
  /** Silence threshold = max(webhookSilenceMinHours, this × average interval). */
  webhookSilenceMultiplier: 6,
  webhookCriticalEventsPerDay: 100,
  webhookWarningEventsPerDay: 20,
  webhookErrorRate: 0.05,
  webhookErrorRateMinEventsPerDay: 50,
  /** A house with movement in the table and no webhook for this many days is critical. */
  webhookDeadAfterDays: 7,
  queueCriticalAgeS: 1800,
  queueWarningAgeS: 600,
  queueErrorShare: 0.2,
  queueErrorShareMinAttempts: 20,
  shortioRunsWindow: 6,
  shortioRateLimitedShare: 0.2,
  /** Copied from src/lib/billing/wallet-alerts.server.ts RUNWAY_URGENT_HOURS. */
  runwayUrgentHours: 6,
  /** Copied from src/lib/billing/wallet-alerts.server.ts RUNWAY_ALERT_HOURS. */
  runwayAlertHours: 24,
} as const;

function jobLabel(job: string): string {
  return JOB_LABELS[job] ?? job;
}

/** "~N min" up to 60 min, else "~1,2 h" (one decimal, pt-BR). */
function formatCadence(avgIntervalHours: number): string {
  const minutes = Math.ceil(avgIntervalHours * 60);
  if (minutes <= 60) return `~${minutes} min`;
  const hours = Math.round(avgIntervalHours * 10) / 10;
  return `~${hours.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} h`;
}

function formatDurationFromSeconds(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.round(minutes / 60);
  return `${hours} h`;
}

export function jobAlerts(rows: JobHealthRow[], now: Date): PlatformAlert[] {
  const alerts: PlatformAlert[] = [];
  for (const row of rows) {
    const label = jobLabel(row.job);

    if (row.stale_running > 0) {
      const minutesStuck = row.oldest_running_heartbeat_at
        ? Math.max(
            0,
            Math.round(
              (now.getTime() - new Date(row.oldest_running_heartbeat_at).getTime()) / 60_000,
            ),
          )
        : null;
      const sinceText =
        minutesStuck === null ? "" : ` há ${formatDurationFromSeconds(minutesStuck * 60)}`;
      alerts.push({
        key: `job:${row.job}`,
        kind: "job",
        severity: "critical",
        message: `Robô ${label} travado${sinceText} (execução sem heartbeat)`,
        tenantId: null,
        since: row.oldest_running_heartbeat_at,
        href: "/admin#canais",
      });
      continue;
    }

    const expectedPeriodS = JOB_EXPECTED_PERIOD_S[row.job];
    if (
      expectedPeriodS !== undefined &&
      row.seconds_since_last_start !== null &&
      row.seconds_since_last_start > ALERT_THRESHOLDS.jobLateMultiplier * expectedPeriodS
    ) {
      alerts.push({
        key: `job:${row.job}`,
        kind: "job",
        severity: "critical",
        message: `Robô ${label} sem rodar há ${formatDurationFromSeconds(row.seconds_since_last_start)} (esperado a cada ${formatDurationFromSeconds(expectedPeriodS)})`,
        tenantId: null,
        since: row.last_started_at,
        href: "/admin#canais",
      });
      continue;
    }

    const allPartial = row.runs_last_hour > 0 && row.partial_last_hour === row.runs_last_hour;
    if (row.failed_last_hour > 0 || allPartial) {
      const reason =
        row.failed_last_hour > 0
          ? `${row.failed_last_hour} execução(ões) falhou(aram) na última hora`
          : "todas as execuções da última hora ficaram parciais";
      alerts.push({
        key: `job:${row.job}`,
        kind: "job",
        severity: "warning",
        message: `Robô ${label}: ${reason}`,
        tenantId: null,
        since: row.last_started_at,
        href: "/admin#canais",
      });
    }
  }
  return alerts;
}

export function webhookAlerts(stats: WebhookStats[], now: Date): PlatformAlert[] {
  const alerts: PlatformAlert[] = [];
  for (const stat of stats) {
    const silenceHours = stat.lastEventAt
      ? (now.getTime() - new Date(stat.lastEventAt).getTime()) / 3_600_000
      : Infinity;

    // A house that stopped sending for good drops out of the 7-day rate
    // sample (rate 0), so the cadence rule below can't see it any more.
    // `lastEventAt` null (never had a webhook) is left out on purpose: a
    // house fed by another integration would be a permanent false alarm.
    if (
      stat.hasMovement &&
      stat.lastEventAt !== null &&
      silenceHours > ALERT_THRESHOLDS.webhookDeadAfterDays * 24
    ) {
      alerts.push({
        key: `webhook:${stat.tenantId}:silence`,
        kind: "webhook",
        severity: "critical",
        message: `${stat.name} sem webhook há mais de ${ALERT_THRESHOLDS.webhookDeadAfterDays} dias`,
        tenantId: stat.tenantId,
        since: stat.lastEventAt,
        href: "/webhooks",
      });
      continue;
    }

    if (stat.eventsPerDay >= ALERT_THRESHOLDS.webhookWarningEventsPerDay) {
      const avgIntervalHours = 24 / stat.eventsPerDay;
      const thresholdHours = Math.max(
        ALERT_THRESHOLDS.webhookSilenceMinHours,
        ALERT_THRESHOLDS.webhookSilenceMultiplier * avgIntervalHours,
      );
      if (silenceHours > thresholdHours) {
        const severity: AlertSeverity =
          stat.eventsPerDay >= ALERT_THRESHOLDS.webhookCriticalEventsPerDay
            ? "critical"
            : "warning";
        alerts.push({
          key: `webhook:${stat.tenantId}:silence`,
          kind: "webhook",
          severity,
          message: `${stat.name} sem webhook há ${formatDurationFromSeconds(silenceHours * 3600)} (normal: a cada ${formatCadence(avgIntervalHours)})`,
          tenantId: stat.tenantId,
          since: stat.lastEventAt,
          href: "/webhooks",
        });
      }
    }

    if (stat.eventsPerDay >= ALERT_THRESHOLDS.webhookErrorRateMinEventsPerDay) {
      const errorRate = stat.errors24h / stat.eventsPerDay;
      if (errorRate > ALERT_THRESHOLDS.webhookErrorRate) {
        alerts.push({
          key: `webhook:${stat.tenantId}:errors`,
          kind: "webhook",
          severity: "warning",
          message: `${stat.name}: ${Math.round(errorRate * 100)}% dos eventos de webhook nas últimas 24 h deram erro`,
          tenantId: stat.tenantId,
          since: null,
          href: "/webhooks",
        });
      }
    }
  }
  return alerts;
}

/**
 * Per house × channel queue alerts. `names` is the loader's house set
 * (non-demo, non-canceled): a row for any other tenant is skipped, so a demo
 * house never alerts and a raw uuid is never printed. `paused` (paused /
 * priority-paused enrollments) does not gate anything: it says nothing about
 * the house's balance — zero balance has its own alert (`zeroBalanceAlerts`).
 */
export function queueAlerts(
  rows: QueueMetricRow[],
  names: Map<string, string>,
  now: Date,
): PlatformAlert[] {
  const alerts: PlatformAlert[] = [];
  for (const row of rows) {
    const houseName = names.get(row.tenant_id);
    if (houseName === undefined) continue;
    const key = `queue:${row.tenant_id}:${row.channel}`;
    const channel = channelLabel(row.channel);

    if (row.oldest_ready_age_seconds !== null && row.ready > 0) {
      const ageS = row.oldest_ready_age_seconds;
      const severity: AlertSeverity | null =
        ageS > ALERT_THRESHOLDS.queueCriticalAgeS
          ? "critical"
          : ageS > ALERT_THRESHOLDS.queueWarningAgeS
            ? "warning"
            : null;
      if (severity) {
        alerts.push({
          key,
          kind: "queue",
          severity,
          message: `${houseName}: fila de ${channel} com item parado há ${formatDurationFromSeconds(ageS)}`,
          tenantId: row.tenant_id,
          since: new Date(now.getTime() - ageS * 1000).toISOString(),
          href: "/admin#canais",
        });
        continue;
      }
    }

    const attempts = row.sent_15m + row.errors_15m;
    if (attempts >= ALERT_THRESHOLDS.queueErrorShareMinAttempts) {
      const errorShare = row.errors_15m / attempts;
      if (errorShare > ALERT_THRESHOLDS.queueErrorShare) {
        alerts.push({
          key,
          kind: "queue",
          severity: "warning",
          message: `${houseName}: fila de ${channel} com ${Math.round(errorShare * 100)}% de erro nos últimos 15 min`,
          tenantId: row.tenant_id,
          since: null,
          href: "/admin#canais",
        });
      }
    }
  }
  return alerts;
}

/** Readable channel label, e.g. "Short Brasil sem saldo: envio de SMS suspenso". */
const CHANNEL_LABELS: Record<string, string> = {
  sms: "SMS",
  email: "e-mail",
  voice: "voz",
  call: "voz",
  wait: "jornada (espera)",
};

function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

const PROVIDER_LABELS: Record<string, string> = {
  sms: "Short Brasil",
  email: "Infobip",
  voice: "Infobip",
  call: "Infobip",
};

/** Provider behind a channel; an unknown channel is named by its channel label. */
function providerLabel(channel: string): string {
  return PROVIDER_LABELS[channel] ?? channelLabel(channel);
}

export function providerAlerts(
  input: { breakers: BreakerRow[]; rateStates: RateStateRow[]; shortioRuns: ShortioRunRow[] },
  now: Date,
): PlatformAlert[] {
  const alerts: PlatformAlert[] = [];

  for (const breaker of input.breakers) {
    if (breaker.state === "open" || breaker.state === "half_open") {
      const provider = providerLabel(breaker.channel);
      const channel = channelLabel(breaker.channel);
      let message: string;
      let severity: AlertSeverity;
      if (breaker.reason === "no_balance") {
        severity = "critical";
        message = `${provider} sem saldo: envio de ${channel} suspenso`;
      } else if (breaker.reason === "auth") {
        severity = "critical";
        message = `${provider} recusando credencial: envio de ${channel} suspenso`;
      } else {
        severity = "warning";
        message = `${provider}: envio de ${channel} suspenso pelo disjuntor (${breaker.reason ?? "erro do provedor"})`;
      }
      alerts.push({
        key: `provider:breaker:${breaker.channel}`,
        kind: "provider",
        severity,
        message,
        tenantId: null,
        since: breaker.first_opened_at,
        href: "/admin#canais",
      });
    }
  }

  for (const rateState of input.rateStates) {
    const backoffUntil = rateState.backoff_until ? new Date(rateState.backoff_until) : null;
    if (backoffUntil && backoffUntil.getTime() > now.getTime() && rateState.last_provider_error) {
      const provider = providerLabel(rateState.channel);
      alerts.push({
        key: `provider:rate:${rateState.channel}`,
        kind: "provider",
        severity: "warning",
        message: `${provider}: erro no envio de ${channelLabel(rateState.channel)} (${rateState.last_provider_error}), em espera (backoff)`,
        tenantId: null,
        since: null,
        href: "/admin#canais",
      });
    }
  }

  const recentRuns = [...input.shortioRuns]
    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
    .slice(0, ALERT_THRESHOLDS.shortioRunsWindow);
  if (recentRuns.length > 0) {
    const claimed = recentRuns.reduce((sum, r) => sum + r.claimed, 0);
    const rateLimited = recentRuns.reduce((sum, r) => sum + r.rate_limited, 0);
    if (claimed > 0) {
      const share = rateLimited / claimed;
      if (share > ALERT_THRESHOLDS.shortioRateLimitedShare) {
        alerts.push({
          key: "provider:shortio",
          kind: "provider",
          severity: "warning",
          message: `Short.io: ${Math.round(share * 100)}% dos links adiados por limite de chamadas — todas as casas`,
          tenantId: null,
          since: null,
          href: "/admin#canais",
        });
      }
    }
  }

  return alerts;
}

export function runwayAlerts(rows: RunwayRow[]): PlatformAlert[] {
  const alerts: PlatformAlert[] = [];
  for (const row of rows) {
    const hours = Number(row.runway_hours);
    if (!Number.isFinite(hours)) continue;
    const severity: AlertSeverity | null =
      hours < ALERT_THRESHOLDS.runwayUrgentHours
        ? "critical"
        : hours < ALERT_THRESHOLDS.runwayAlertHours
          ? "warning"
          : null;
    if (!severity) continue;
    // "menos de N h" must stay true: round up, never "menos de 0 h".
    const shownHours = Math.max(1, Math.ceil(hours));
    alerts.push({
      key: `runway:${row.tenant_id}`,
      kind: "runway",
      severity,
      message: `${row.tenant_name}: saldo dura menos de ${shownHours} h no ritmo atual de consumo`,
      tenantId: row.tenant_id,
      since: null,
      href: "/admin#saldo",
    });
  }
  return alerts;
}

/** Non-exempt houses whose wallet balance is ≤ 0: SMS/voice sends are stopped. */
export function zeroBalanceAlerts(
  houses: Array<{ tenantId: string; name: string }>,
): PlatformAlert[] {
  return houses.map((house) => ({
    key: `runway:${house.tenantId}:zero`,
    kind: "runway",
    severity: "critical",
    message: `${house.name}: saldo zerado — envios parados`,
    tenantId: house.tenantId,
    since: null,
    href: "/admin#saldo",
  }));
}

export function billingAlerts(report: BillingHealthReport): PlatformAlert[] {
  return report.findings.map((finding) => ({
    key: `billing:${finding.code}`,
    kind: "billing",
    severity: finding.severity,
    message: finding.message,
    tenantId: null,
    since: finding.lastAt ?? null,
    href: "/admin#faturamento",
  }));
}

/**
 * Where a failed source is fixed. Sources with no useful screen (tenants,
 * finance, activity, webhooks) are absent: their alert row is not clickable.
 */
const SOURCE_HREFS: Record<string, string> = {
  observability_job_health: "/admin#canais",
  observability_queue_metrics: "/admin#canais",
  provider_circuit_breakers: "/admin#canais",
  dispatch_rate_state: "/admin#canais",
  shortio_sync_runs: "/admin#canais",
  billing_health: "/admin#faturamento",
  billing_runway_alert_candidates: "/admin#saldo",
  tenant_wallets: "/admin#saldo",
};

export function sourceFailureAlert(source: string): PlatformAlert {
  return {
    key: `source:${source}`,
    kind: "source",
    severity: "warning",
    message: `Não foi possível verificar ${source}`,
    tenantId: null,
    since: null,
    href: SOURCE_HREFS[source] ?? null,
  };
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1 };

/**
 * Critical first, then warning; within a severity, oldest `since` first (null last). Generic so
 * a caller carrying extra fields on each alert (Task 5/F3: `stored`) keeps them typed through
 * the sort.
 */
export function sortAlerts<T extends PlatformAlert>(alerts: T[]): T[] {
  return [...alerts].sort((a, b) => {
    if (SEVERITY_RANK[a.severity] !== SEVERITY_RANK[b.severity]) {
      return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    }
    if (a.since === null && b.since === null) return 0;
    if (a.since === null) return 1;
    if (b.since === null) return -1;
    return new Date(a.since).getTime() - new Date(b.since).getTime();
  });
}
