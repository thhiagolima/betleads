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
  href: string;
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
  /** Estimated from the last ≤200 events of the past 7 days (see Task 3). */
  eventsPerDay: number;
  errors24h: number;
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
 * only writes a row when it claims a campaign).
 */
export const JOB_EXPECTED_PERIOD_S: Record<string, number> = {
  "billing-cycle": 3600,
  "billing-reconcile": 300,
  dashboard_metrics_refresh: 300,
  email_tick: 60,
  journey_dispatch: 60,
  journey_level_outbox: 60,
  journey_scan: 60,
  recovery: 60,
  shortio_sync: 300,
  sms_tick: 60,
  tenant_domains_verify: 600,
  webhook_replay: 300,
};

/** Readable labels for jobs where a plain name would read poorly in pt-BR. */
const JOB_LABELS: Record<string, string> = {
  sms_tick: "Disparo de SMS",
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
    if (stat.eventsPerDay >= ALERT_THRESHOLDS.webhookWarningEventsPerDay) {
      const silenceHours = stat.lastEventAt
        ? (now.getTime() - new Date(stat.lastEventAt).getTime()) / 3_600_000
        : Infinity;
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
        const normalMinutes = Math.ceil((avgIntervalHours * 60) / 1);
        alerts.push({
          key: `webhook:${stat.tenantId}:silence`,
          kind: "webhook",
          severity,
          message: `${stat.name} sem webhook há ${formatDurationFromSeconds(silenceHours * 3600)} (normal: a cada ~${normalMinutes} min)`,
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

export function queueAlerts(rows: QueueMetricRow[], names: Map<string, string>): PlatformAlert[] {
  const alerts: PlatformAlert[] = [];
  for (const row of rows) {
    if (row.paused > 0) continue;

    const houseName = names.get(row.tenant_id) ?? row.tenant_id;
    const key = `queue:${row.tenant_id}:${row.channel}`;

    if (row.oldest_ready_age_seconds !== null && row.ready > 0) {
      if (row.oldest_ready_age_seconds > ALERT_THRESHOLDS.queueCriticalAgeS) {
        alerts.push({
          key,
          kind: "queue",
          severity: "critical",
          message: `${houseName}: fila de ${row.channel} com item parado há ${formatDurationFromSeconds(row.oldest_ready_age_seconds)}`,
          tenantId: row.tenant_id,
          since: null,
          href: "/admin#canais",
        });
        continue;
      }
      if (row.oldest_ready_age_seconds > ALERT_THRESHOLDS.queueWarningAgeS) {
        alerts.push({
          key,
          kind: "queue",
          severity: "warning",
          message: `${houseName}: fila de ${row.channel} com item parado há ${formatDurationFromSeconds(row.oldest_ready_age_seconds)}`,
          tenantId: row.tenant_id,
          since: null,
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
          message: `${houseName}: fila de ${row.channel} com ${Math.round(errorShare * 100)}% de erro nos últimos 15 min`,
          tenantId: row.tenant_id,
          since: null,
          href: "/admin#canais",
        });
      }
    }
  }
  return alerts;
}

function providerLabel(channel: string): string {
  return channel === "sms" ? "Short Brasil" : "Infobip";
}

/** Readable channel label for breaker messages, e.g. "Short Brasil sem saldo: envio de SMS suspenso". */
const CHANNEL_LABELS: Record<string, string> = {
  sms: "SMS",
  email: "e-mail",
  voice: "voz",
  call: "voz",
};

function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
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
        message: `${provider}: erro no envio de ${rateState.channel} (${rateState.last_provider_error}), em espera (backoff)`,
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
    if (hours < ALERT_THRESHOLDS.runwayUrgentHours) {
      alerts.push({
        key: `runway:${row.tenant_id}`,
        kind: "runway",
        severity: "critical",
        message: `${row.tenant_name}: saldo dura menos de ${Math.round(hours)} h no ritmo atual de consumo`,
        tenantId: row.tenant_id,
        since: null,
        href: "/admin#saldo",
      });
    } else if (hours < ALERT_THRESHOLDS.runwayAlertHours) {
      alerts.push({
        key: `runway:${row.tenant_id}`,
        kind: "runway",
        severity: "warning",
        message: `${row.tenant_name}: saldo dura menos de ${Math.round(hours)} h no ritmo atual de consumo`,
        tenantId: row.tenant_id,
        since: null,
        href: "/admin#saldo",
      });
    }
  }
  return alerts;
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

export function sourceFailureAlert(source: string): PlatformAlert {
  return {
    key: `source:${source}`,
    kind: "source",
    severity: "warning",
    message: `Não foi possível verificar ${source}`,
    tenantId: null,
    since: null,
    href: "/admin",
  };
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1 };

/** Critical first, then warning; within a severity, oldest `since` first (null last). */
export function sortAlerts(alerts: PlatformAlert[]): PlatformAlert[] {
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
