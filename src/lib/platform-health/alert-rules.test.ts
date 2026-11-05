import { describe, expect, it } from "vitest";
import type { BillingHealthReport } from "@/lib/billing/billing-health.server";
import {
  type BreakerRow,
  type JobHealthRow,
  type PlatformAlert,
  type QueueMetricRow,
  type RateStateRow,
  type RunwayRow,
  type ShortioRunRow,
  type WebhookStats,
  billingAlerts,
  jobAlerts,
  providerAlerts,
  queueAlerts,
  runwayAlerts,
  sortAlerts,
  sourceFailureAlert,
  webhookAlerts,
} from "./alert-rules";

const NOW = new Date("2026-11-05T12:00:00Z");

function minutesAgo(min: number): string {
  return new Date(NOW.getTime() - min * 60_000).toISOString();
}

function hoursAgo(h: number): string {
  return minutesAgo(h * 60);
}

function baseJobRow(overrides: Partial<JobHealthRow>): JobHealthRow {
  return {
    job: "sms_tick",
    last_started_at: minutesAgo(1),
    last_status: "success",
    seconds_since_last_start: 60,
    stale_running: 0,
    oldest_running_heartbeat_at: null,
    runs_last_hour: 60,
    failed_last_hour: 0,
    partial_last_hour: 0,
    ...overrides,
  };
}

describe("jobAlerts", () => {
  it("stale row is critical", () => {
    const rows = [
      baseJobRow({
        job: "sms_tick",
        stale_running: 1,
        oldest_running_heartbeat_at: minutesAgo(20),
      }),
    ];
    const alerts = jobAlerts(rows, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("critical");
    expect(alerts[0].key).toBe("job:sms_tick");
  });

  it("shortio_sync not started for 20 min (3x 300s = 900s) is critical (late)", () => {
    const rows = [
      baseJobRow({
        job: "shortio_sync",
        last_started_at: minutesAgo(20),
        seconds_since_last_start: 20 * 60,
      }),
    ];
    const alerts = jobAlerts(rows, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("critical");
    expect(alerts[0].key).toBe("job:shortio_sync");
  });

  it("failed_last_hour > 0 is a warning", () => {
    const rows = [baseJobRow({ job: "email_tick", failed_last_hour: 2 })];
    const alerts = jobAlerts(rows, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].key).toBe("job:email_tick");
  });

  it("sms_campaign_dispatch last started 15h ago never alerts (not in expected-period map)", () => {
    const rows = [
      baseJobRow({
        job: "sms_campaign_dispatch",
        last_started_at: hoursAgo(15),
        seconds_since_last_start: 15 * 3600,
      }),
    ];
    const alerts = jobAlerts(rows, NOW);
    expect(alerts).toHaveLength(0);
  });

  it("unknown job late never alerts", () => {
    const rows = [
      baseJobRow({
        job: "some_unknown_job",
        last_started_at: hoursAgo(99),
        seconds_since_last_start: 99 * 3600,
      }),
    ];
    const alerts = jobAlerts(rows, NOW);
    expect(alerts).toHaveLength(0);
  });
});

function baseWebhookStat(overrides: Partial<WebhookStats>): WebhookStats {
  return {
    tenantId: "t1",
    name: "ForrandoBet",
    lastEventAt: minutesAgo(5),
    eventsPerDay: 1000,
    errors24h: 0,
    ...overrides,
  };
}

describe("webhookAlerts", () => {
  it("eventsPerDay 1000, silent for 3h is critical", () => {
    const stats = [baseWebhookStat({ lastEventAt: hoursAgo(3) })];
    const alerts = webhookAlerts(stats, NOW);
    expect(alerts.some((a) => a.severity === "critical" && a.key === "webhook:t1:silence")).toBe(
      true,
    );
  });

  it("same house, last event 30 min ago has no alert", () => {
    const stats = [baseWebhookStat({ lastEventAt: minutesAgo(30) })];
    const alerts = webhookAlerts(stats, NOW);
    expect(alerts).toHaveLength(0);
  });

  it("eventsPerDay 10 (Sorte-da-Bet-like), silent 14h never alerts", () => {
    const stats = [baseWebhookStat({ eventsPerDay: 10, lastEventAt: hoursAgo(14), errors24h: 0 })];
    const alerts = webhookAlerts(stats, NOW);
    expect(alerts).toHaveLength(0);
  });

  it("eventsPerDay 200 with errors24h 20 is a warning on the :errors key", () => {
    const stats = [
      baseWebhookStat({ eventsPerDay: 200, errors24h: 20, lastEventAt: minutesAgo(1) }),
    ];
    const alerts = webhookAlerts(stats, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].key).toBe("webhook:t1:errors");
  });
});

function baseQueueRow(overrides: Partial<QueueMetricRow>): QueueMetricRow {
  return {
    tenant_id: "t1",
    channel: "sms",
    ready: 0,
    paused: 0,
    oldest_ready_age_seconds: null,
    sent_15m: 0,
    errors_15m: 0,
    ...overrides,
  };
}

describe("queueAlerts", () => {
  const names = new Map([["t1", "ForrandoBet"]]);

  it("age 2000s, ready 5, no pause is critical", () => {
    const rows = [baseQueueRow({ oldest_ready_age_seconds: 2000, ready: 5 })];
    const alerts = queueAlerts(rows, names);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("critical");
    expect(alerts[0].key).toBe("queue:t1:sms");
  });

  it("paused queue never alerts even if old", () => {
    const rows = [baseQueueRow({ oldest_ready_age_seconds: 2000, ready: 5, paused: 3 })];
    const alerts = queueAlerts(rows, names);
    expect(alerts).toHaveLength(0);
  });

  it("15 min: 30 sent, 10 errors is a warning (25% error share, 40 attempts)", () => {
    const rows = [baseQueueRow({ sent_15m: 30, errors_15m: 10 })];
    const alerts = queueAlerts(rows, names);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].key).toBe("queue:t1:sms");
  });
});

describe("providerAlerts", () => {
  it("open breaker with no_balance reason on sms is critical with the exact Short Brasil message", () => {
    const breakers: BreakerRow[] = [
      { channel: "sms", state: "open", reason: "no_balance", first_opened_at: hoursAgo(1) },
    ];
    const alerts = providerAlerts({ breakers, rateStates: [], shortioRuns: [] }, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("critical");
    expect(alerts[0].key).toBe("provider:breaker:sms");
    expect(alerts[0].message).toBe("Short Brasil sem saldo: envio de SMS suspenso");
  });

  it("breaker open/half_open with a reason other than auth/no_balance is a warning", () => {
    const breakers: BreakerRow[] = [
      { channel: "email", state: "half_open", reason: "timeout", first_opened_at: hoursAgo(2) },
    ];
    const alerts = providerAlerts({ breakers, rateStates: [], shortioRuns: [] }, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].key).toBe("provider:breaker:email");
    expect(alerts[0].since).toBe(hoursAgo(2));
    expect(alerts[0].message).toBe("Infobip: envio de e-mail suspenso pelo disjuntor (timeout)");
  });

  it("backoff_until in the future with a provider error is a warning", () => {
    const rateStates: RateStateRow[] = [
      {
        channel: "email",
        last_provider_error: "timeout",
        backoff_until: new Date(NOW.getTime() + 60_000).toISOString(),
      },
    ];
    const alerts = providerAlerts({ breakers: [], rateStates, shortioRuns: [] }, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].key).toBe("provider:rate:email");
  });

  it("6 Short.io runs with 600 claimed / 150 rate_limited (25%) is a warning", () => {
    const shortioRuns: ShortioRunRow[] = Array.from({ length: 6 }, (_, i) => ({
      started_at: hoursAgo(i),
      claimed: 100,
      rate_limited: 25,
    }));
    const alerts = providerAlerts({ breakers: [], rateStates: [], shortioRuns }, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].key).toBe("provider:shortio");
  });

  it("6 Short.io runs with 600 claimed / 30 rate_limited (5%) has no alert", () => {
    const shortioRuns: ShortioRunRow[] = Array.from({ length: 6 }, (_, i) => ({
      started_at: hoursAgo(i),
      claimed: 100,
      rate_limited: 5,
    }));
    const alerts = providerAlerts({ breakers: [], rateStates: [], shortioRuns }, NOW);
    expect(alerts).toHaveLength(0);
  });
});

describe("runwayAlerts", () => {
  it("4h is critical", () => {
    const rows: RunwayRow[] = [{ tenant_id: "t1", tenant_name: "ForrandoBet", runway_hours: 4 }];
    const alerts = runwayAlerts(rows);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("critical");
    expect(alerts[0].key).toBe("runway:t1");
  });

  it("12h is a warning", () => {
    const rows: RunwayRow[] = [{ tenant_id: "t1", tenant_name: "ForrandoBet", runway_hours: "12" }];
    const alerts = runwayAlerts(rows);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("warning");
  });

  it("30h has no alert", () => {
    const rows: RunwayRow[] = [{ tenant_id: "t1", tenant_name: "ForrandoBet", runway_hours: 30 }];
    const alerts = runwayAlerts(rows);
    expect(alerts).toHaveLength(0);
  });
});

describe("billingAlerts", () => {
  it("each finding becomes an alert with the same severity and message", () => {
    const report: BillingHealthReport = {
      ok: false,
      checkedAt: NOW.toISOString(),
      windowHours: 1,
      findings: [
        { code: "wallet_ledger_mismatch", severity: "critical", message: "Ledger não bate" },
        { code: "charge_needs_review", severity: "warning", message: "Cobrança precisa revisão" },
      ],
    };
    const alerts = billingAlerts(report);
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({
      key: "billing:wallet_ledger_mismatch",
      severity: "critical",
      message: "Ledger não bate",
      href: "/admin#faturamento",
    });
    expect(alerts[1]).toMatchObject({
      key: "billing:charge_needs_review",
      severity: "warning",
      message: "Cobrança precisa revisão",
      href: "/admin#faturamento",
    });
  });
});

describe("sourceFailureAlert", () => {
  it("builds a warning alert naming the source", () => {
    const alert = sourceFailureAlert("webhook");
    expect(alert.severity).toBe("warning");
    expect(alert.kind).toBe("source");
    expect(alert.key).toBe("source:webhook");
    expect(alert.message).toContain("webhook");
  });
});

describe("sortAlerts", () => {
  function alert(overrides: Partial<PlatformAlert>): PlatformAlert {
    return {
      key: "k",
      kind: "job",
      severity: "warning",
      message: "m",
      tenantId: null,
      since: null,
      href: "/admin",
      ...overrides,
    };
  }

  it("critical before warning; older since first; null since last", () => {
    const a = alert({ key: "a", severity: "warning", since: "2026-11-05T10:00:00Z" });
    const b = alert({ key: "b", severity: "critical", since: "2026-11-05T11:00:00Z" });
    const c = alert({ key: "c", severity: "critical", since: "2026-11-05T09:00:00Z" });
    const d = alert({ key: "d", severity: "warning", since: null });
    const sorted = sortAlerts([a, b, c, d]);
    expect(sorted.map((x) => x.key)).toEqual(["c", "b", "a", "d"]);
  });
});
