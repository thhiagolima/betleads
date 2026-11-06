import { describe, expect, it } from "vitest";
import type { PlatformAlert } from "./alert-rules";
import {
  CRITICAL_RENOTIFY_MS,
  RESOLVE_GRACE_MS,
  SILENCE_HOURS,
  SOURCE_KIND,
  type StoredAlert,
  failedKindsFrom,
  isSilenced,
  planAlertSync,
  shouldNotify,
} from "./alert-lifecycle";

const NOW = new Date("2026-11-05T12:00:00Z");

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3_600_000).toISOString();
}

function hoursFromNow(h: number): string {
  return new Date(NOW.getTime() + h * 3_600_000).toISOString();
}

function baseAlert(overrides: Partial<PlatformAlert> = {}): PlatformAlert {
  return {
    key: "job:sms_tick",
    kind: "job",
    severity: "critical",
    message: "Robô Disparo de SMS sem rodar",
    tenantId: null,
    since: hoursAgo(1),
    href: "/admin#canais",
    ...overrides,
  };
}

function baseStored(overrides: Partial<StoredAlert> = {}): StoredAlert {
  return {
    id: "stored-1",
    alertKey: "job:sms_tick",
    kind: "job",
    severity: "critical",
    message: "Robô Disparo de SMS sem rodar",
    tenantId: null,
    href: "/admin#canais",
    openedAt: hoursAgo(5),
    lastSeenAt: hoursAgo(1),
    seenCount: 3,
    acknowledgedAt: null,
    silencedUntil: null,
    lastNotifiedAt: null,
    ...overrides,
  };
}

describe("planAlertSync", () => {
  it("a key not stored yet goes to open", () => {
    const current = [baseAlert()];
    const plan = planAlertSync([], current, new Set(), NOW);
    expect(plan.open).toEqual(current);
    expect(plan.seen).toEqual([]);
    expect(plan.resolve).toEqual([]);
  });

  it("a stored key still present goes to seen", () => {
    const stored = [baseStored()];
    const current = [baseAlert({ message: "nova mensagem" })];
    const plan = planAlertSync(stored, current, new Set(), NOW);
    expect(plan.open).toEqual([]);
    expect(plan.resolve).toEqual([]);
    expect(plan.seen).toEqual([{ id: "stored-1", alert: current[0] }]);
  });

  it("a stored key absent now is resolved", () => {
    const stored = [baseStored()];
    const plan = planAlertSync(stored, [], new Set(), NOW);
    expect(plan.resolve).toEqual(["stored-1"]);
    expect(plan.open).toEqual([]);
    expect(plan.seen).toEqual([]);
  });

  it("a stored key absent now but of a failed kind is not resolved", () => {
    const stored = [baseStored({ kind: "job" })];
    const plan = planAlertSync(stored, [], new Set(["job"]), NOW);
    expect(plan.resolve).toEqual([]);
    expect(plan.open).toEqual([]);
    expect(plan.seen).toEqual([]);
  });

  it("a stored key absent now but last seen within RESOLVE_GRACE_MS is left untouched", () => {
    const lastSeenAt = new Date(NOW.getTime() - RESOLVE_GRACE_MS).toISOString();
    const plan = planAlertSync([baseStored({ lastSeenAt })], [], new Set(), NOW);
    expect(plan.resolve).toEqual([]);
    expect(plan.open).toEqual([]);
    expect(plan.seen).toEqual([]);
  });

  it("a stored key absent for longer than RESOLVE_GRACE_MS is resolved", () => {
    const lastSeenAt = new Date(NOW.getTime() - RESOLVE_GRACE_MS - 1).toISOString();
    const plan = planAlertSync([baseStored({ lastSeenAt })], [], new Set(), NOW);
    expect(plan.resolve).toEqual(["stored-1"]);
  });

  it("RESOLVE_GRACE_MS is 15 min", () => {
    expect(RESOLVE_GRACE_MS).toBe(15 * 60 * 1000);
  });

  it("a resolved-then-reopened alert (not in stored) is just a new open", () => {
    // The resolved row is not passed back in `stored` by the caller.
    const current = [baseAlert({ key: "job:sms_tick" })];
    const plan = planAlertSync([], current, new Set(), NOW);
    expect(plan.open).toEqual(current);
    expect(plan.resolve).toEqual([]);
  });
});

describe("isSilenced", () => {
  it("null silencedUntil is not silenced", () => {
    expect(isSilenced({ silencedUntil: null }, NOW)).toBe(false);
  });

  it("silencedUntil in the future is silenced", () => {
    expect(isSilenced({ silencedUntil: hoursFromNow(1) }, NOW)).toBe(true);
  });

  it("silencedUntil in the past is not silenced", () => {
    expect(isSilenced({ silencedUntil: hoursAgo(1) }, NOW)).toBe(false);
  });
});

describe("shouldNotify", () => {
  it("warning never notifies", () => {
    expect(
      shouldNotify(
        {
          severity: "warning",
          acknowledgedAt: null,
          silencedUntil: null,
          lastNotifiedAt: null,
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("critical, never notified, notifies", () => {
    expect(
      shouldNotify(
        {
          severity: "critical",
          acknowledgedAt: null,
          silencedUntil: null,
          lastNotifiedAt: null,
        },
        NOW,
      ),
    ).toBe(true);
  });

  it("critical notified 2 h ago does not renotify", () => {
    expect(
      shouldNotify(
        {
          severity: "critical",
          acknowledgedAt: null,
          silencedUntil: null,
          lastNotifiedAt: hoursAgo(2),
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("critical notified 7 h ago renotifies", () => {
    expect(
      shouldNotify(
        {
          severity: "critical",
          acknowledgedAt: null,
          silencedUntil: null,
          lastNotifiedAt: hoursAgo(7),
        },
        NOW,
      ),
    ).toBe(true);
  });

  it("acknowledged critical does not notify", () => {
    expect(
      shouldNotify(
        {
          severity: "critical",
          acknowledgedAt: hoursAgo(1),
          silencedUntil: null,
          lastNotifiedAt: null,
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("silenced until tomorrow does not notify", () => {
    expect(
      shouldNotify(
        {
          severity: "critical",
          acknowledgedAt: null,
          silencedUntil: hoursFromNow(24),
          lastNotifiedAt: null,
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("silence already expired notifies", () => {
    expect(
      shouldNotify(
        {
          severity: "critical",
          acknowledgedAt: null,
          silencedUntil: hoursAgo(1),
          lastNotifiedAt: null,
        },
        NOW,
      ),
    ).toBe(true);
  });
});

describe("CRITICAL_RENOTIFY_MS / SILENCE_HOURS", () => {
  it("CRITICAL_RENOTIFY_MS is 6 h in ms", () => {
    expect(CRITICAL_RENOTIFY_MS).toBe(6 * 3_600_000);
  });

  it("SILENCE_HOURS is 24", () => {
    expect(SILENCE_HOURS).toBe(24);
  });
});

describe("SOURCE_KIND / failedKindsFrom", () => {
  it("maps observability_job_health to job", () => {
    expect(SOURCE_KIND.observability_job_health).toEqual(["job"]);
  });

  it("maps observability_queue_metrics to queue", () => {
    expect(SOURCE_KIND.observability_queue_metrics).toEqual(["queue"]);
  });

  it("maps provider sources to provider", () => {
    expect(SOURCE_KIND.provider_circuit_breakers).toEqual(["provider"]);
    expect(SOURCE_KIND.dispatch_rate_state).toEqual(["provider"]);
    expect(SOURCE_KIND.shortio_sync_runs).toEqual(["provider"]);
  });

  it("maps billing/runway sources", () => {
    expect(SOURCE_KIND.billing_health).toEqual(["billing"]);
    expect(SOURCE_KIND.billing_runway_alert_candidates).toEqual(["runway"]);
    expect(SOURCE_KIND.tenant_wallets).toEqual(["runway"]);
  });

  it("maps webhook_logs to webhook", () => {
    expect(SOURCE_KIND.webhook_logs).toEqual(["webhook"]);
  });

  it("maps tenants (the house set) to every per-house kind, finance_days to webhook", () => {
    expect([...SOURCE_KIND.tenants].sort()).toEqual(["queue", "runway", "webhook"]);
    expect(SOURCE_KIND.finance_days).toEqual(["webhook"]);
  });

  it("failedKindsFrom extracts kinds from source alerts, ignoring unmapped sources", () => {
    const alerts: PlatformAlert[] = [
      {
        key: "source:observability_job_health",
        kind: "source",
        severity: "warning",
        message: "x",
        tenantId: null,
        since: null,
        href: null,
      },
      {
        key: "source:finance_activity_days",
        kind: "source",
        severity: "warning",
        message: "x",
        tenantId: null,
        since: null,
        href: null,
      },
      baseAlert({ key: "job:sms_tick" }),
    ];
    expect(failedKindsFrom(alerts)).toEqual(new Set(["job"]));
  });

  it("failedKindsFrom expands a failed tenants source to webhook, queue and runway", () => {
    const alerts: PlatformAlert[] = [
      {
        key: "source:tenants",
        kind: "source",
        severity: "warning",
        message: "x",
        tenantId: null,
        since: null,
        href: null,
      },
    ];
    expect(failedKindsFrom(alerts)).toEqual(new Set(["webhook", "queue", "runway"]));
  });

  it("failedKindsFrom maps a per-house webhook_logs:<house> source to webhook", () => {
    const alerts: PlatformAlert[] = [
      {
        key: "source:webhook_logs:Casa Teste",
        kind: "source",
        severity: "warning",
        message: "x",
        tenantId: null,
        since: null,
        href: null,
      },
    ];
    expect(failedKindsFrom(alerts)).toEqual(new Set(["webhook"]));
  });
});
