import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

const sentry = vi.hoisted(() => ({
  active: false,
  captureServerMessage: vi.fn(),
}));
vi.mock("@/lib/observability/sentry.server", () => ({
  isServerSentryActive: () => sentry.active,
  captureServerMessage: sentry.captureServerMessage,
}));

const { pingHeartbeat } = vi.hoisted(() => ({ pingHeartbeat: vi.fn(async () => undefined) }));
vi.mock("@/lib/observability/job-monitor.server", () => ({ pingHeartbeat }));

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import {
  __resetBillingHealthStateForTests,
  adminBillingHealthFor,
  adminTestBillingAlertFor,
  BILLING_ALERT_LOG_PREFIX,
  checkBillingHealth,
  evaluateBillingHealth,
  reportBillingAlerts,
  runBillingHealthStage,
  type BillingHealthSnapshot,
} from "./billing-health.server";

const NOW = new Date("2026-10-23T12:00:00Z");
const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000dd";
const PLAIN_USER = "00000000-0000-4000-8000-0000000000ee";

function healthySnapshot(overrides: Partial<BillingHealthSnapshot> = {}): BillingHealthSnapshot {
  return {
    signals: {},
    paid_uncredited: { count: 0, oldest_paid_at: null },
    needs_review: { count: 0, oldest_at: null },
    wallet_mismatch: { count: 0, tenant_ids: [] },
    jobs_last_ok: {
      "billing-reconcile": "2026-10-23T11:57:00Z",
      "billing-cycle": "2026-10-23T11:07:00Z",
    },
    ...overrides,
  };
}

function codes(findings: { code: string }[]) {
  return findings.map((f) => f.code).sort();
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fake.admin.reset();
  fake.admin.onRpc("is_super_admin", (args) => ({
    data: args._user_id === SUPER_ADMIN,
    error: null,
  }));
  sentry.active = false;
  sentry.captureServerMessage.mockClear();
  pingHeartbeat.mockClear();
  __resetBillingHealthStateForTests();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("evaluateBillingHealth", () => {
  it("returns no findings when everything is healthy", () => {
    expect(evaluateBillingHealth(healthySnapshot(), { now: NOW, windowHours: 1 })).toEqual([]);
  });

  it("flags each problem with a stable code, a severity and a pt-BR message", () => {
    const findings = evaluateBillingHealth(
      healthySnapshot({
        signals: {
          webhook_invalid_signature: {
            count: 2,
            last_at: "2026-10-23T11:50:00Z",
            last_detail: "mismatch",
          },
          upper_feature_disabled: {
            count: 1,
            last_at: "2026-10-23T11:40:00Z",
            last_detail: "403 FEATURE_DISABLED",
          },
          upper_unauthorized: {
            count: 3,
            last_at: "2026-10-23T11:41:00Z",
            last_detail: "401 INVALID_API_KEY",
          },
        },
        paid_uncredited: { count: 1, oldest_paid_at: "2026-10-23T11:30:00Z" },
        needs_review: { count: 2, oldest_at: "2026-10-22T10:00:00Z" },
        wallet_mismatch: { count: 1, tenant_ids: ["t1"] },
      }),
      { now: NOW, windowHours: 1 },
    );
    expect(codes(findings)).toEqual([
      "charge_needs_review",
      "charge_paid_not_credited",
      "upper_feature_disabled",
      "upper_unauthorized",
      "wallet_ledger_mismatch",
      "webhook_invalid_signature",
    ]);
    const byCode = Object.fromEntries(findings.map((f) => [f.code, f]));
    expect(byCode.charge_needs_review.severity).toBe("warning");
    expect(byCode.charge_needs_review.message).toMatch(/aguardando revisão/);
    for (const code of [
      "charge_paid_not_credited",
      "upper_feature_disabled",
      "upper_unauthorized",
      "wallet_ledger_mismatch",
      "webhook_invalid_signature",
    ]) {
      expect(byCode[code].severity).toBe("critical");
    }
    expect(byCode.webhook_invalid_signature.message).toContain("assinatura não confere");
    expect(byCode.charge_paid_not_credited.message).toMatch(/10 min/);
  });

  it("flags upper_unavailable (critical) only from 3 events in the window", () => {
    const at = (count: number) =>
      evaluateBillingHealth(
        healthySnapshot({
          signals: {
            upper_unavailable: { count, last_at: "2026-10-23T11:58:00Z", last_detail: "TIMEOUT" },
          },
        }),
        { now: NOW, windowHours: 1 },
      );
    expect(at(2)).toEqual([]);
    const findings = at(3);
    expect(codes(findings)).toEqual(["upper_unavailable"]);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].message).toMatch(/fora do ar|indisponível/);
    expect(findings[0].lastAt).toBe("2026-10-23T11:58:00Z");
  });

  it("flags billing jobs whose last OK run is older than 3x their interval, or that never ran", () => {
    const fresh = evaluateBillingHealth(
      healthySnapshot({
        jobs_last_ok: {
          "billing-reconcile": "2026-10-23T11:46:00Z",
          "billing-cycle": "2026-10-23T09:01:00Z",
        },
      }),
      { now: NOW, windowHours: 1 },
    );
    expect(fresh).toEqual([]);

    const stale = evaluateBillingHealth(
      healthySnapshot({
        jobs_last_ok: { "billing-reconcile": "2026-10-23T11:44:00Z", "billing-cycle": null },
      }),
      { now: NOW, windowHours: 1 },
    );
    expect(codes(stale)).toEqual(["billing_cycle_cron_stale", "reconcile_cron_stale"]);
    expect(stale.every((f) => f.severity === "critical")).toBe(true);
    expect(stale.find((f) => f.code === "billing_cycle_cron_stale")!.message).toMatch(/nunca/);
  });
});

describe("checkBillingHealth", () => {
  it("calls billing_health_snapshot with the window and evaluates it", async () => {
    let args: Record<string, unknown> | null = null;
    fake.admin.onRpc("billing_health_snapshot", (a) => {
      args = a;
      return {
        data: healthySnapshot({ wallet_mismatch: { count: 1, tenant_ids: ["t"] } }),
        error: null,
      };
    });
    const report = await checkBillingHealth({ windowHours: 24, now: NOW });
    expect(args).toEqual({ _window_hours: 24, _now: NOW.toISOString() });
    expect(report.ok).toBe(false);
    expect(codes(report.findings)).toEqual(["wallet_ledger_mismatch"]);
    expect(report.windowHours).toBe(24);
  });

  it("is ok with only warnings", async () => {
    fake.admin.onRpc("billing_health_snapshot", () => ({
      data: healthySnapshot({ needs_review: { count: 1, oldest_at: null } }),
      error: null,
    }));
    const report = await checkBillingHealth({ now: NOW });
    expect(report.ok).toBe(true);
    expect(codes(report.findings)).toEqual(["charge_needs_review"]);
  });

  it("turns a failed snapshot into a critical finding without leaking the DB error", async () => {
    fake.admin.onRpc("billing_health_snapshot", () => ({
      data: null,
      error: { message: "permission denied for secret_table" },
    }));
    const report = await checkBillingHealth({ now: NOW });
    expect(report.ok).toBe(false);
    expect(codes(report.findings)).toEqual(["billing_health_check_failed"]);
    expect(report.findings[0].message).not.toContain("secret_table");
  });
});

describe("reportBillingAlerts", () => {
  const critical = {
    code: "wallet_ledger_mismatch" as const,
    severity: "critical" as const,
    message: "1 carteira com saldo diferente da soma do razão.",
  };
  const warning = {
    code: "charge_needs_review" as const,
    severity: "warning" as const,
    message: "1 cobrança aguardando revisão.",
  };

  it("logs critical findings with the fixed [billing-alert] prefix when Sentry is off", () => {
    expect(reportBillingAlerts([critical, warning])).toBe("log");
    const lines = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith(`${BILLING_ALERT_LOG_PREFIX} wallet_ledger_mismatch`)).toBe(true);
    expect(sentry.captureServerMessage).not.toHaveBeenCalled();
  });

  it("sends each critical finding to Sentry with a per-code fingerprint when Sentry is on", () => {
    sentry.active = true;
    expect(reportBillingAlerts([critical, warning])).toBe("sentry");
    expect(sentry.captureServerMessage).toHaveBeenCalledTimes(1);
    const [message, level, context] = sentry.captureServerMessage.mock.calls[0];
    expect(message).toContain("wallet_ledger_mismatch");
    expect(level).toBe("error");
    expect(context.fingerprint).toEqual(["billing-alert", "wallet_ledger_mismatch"]);
    expect(context.tags.alert_code).toBe("wallet_ledger_mismatch");
  });

  it("without Sentry, logs a persistent code at most once per hour per process", () => {
    const t0 = new Date("2026-10-23T12:00:00Z");
    reportBillingAlerts([critical], { now: t0 });
    reportBillingAlerts([critical], { now: new Date(t0.getTime() + 5 * 60_000) });
    reportBillingAlerts([critical], { now: new Date(t0.getTime() + 59 * 60_000) });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    reportBillingAlerts([critical], { now: new Date(t0.getTime() + 60 * 60_000) });
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it("dedupes per code, and dedupe:false always logs", () => {
    const other = { ...critical, code: "reconcile_cron_stale" as const };
    reportBillingAlerts([critical], { now: NOW });
    reportBillingAlerts([critical, other], { now: NOW });
    expect(errorSpy).toHaveBeenCalledTimes(2);
    reportBillingAlerts([critical], { now: NOW, dedupe: false });
    expect(errorSpy).toHaveBeenCalledTimes(3);
  });

  it("Sentry keeps every event (grouped by fingerprint), no in-process dedupe", () => {
    sentry.active = true;
    reportBillingAlerts([critical], { now: NOW });
    reportBillingAlerts([critical], { now: NOW });
    expect(sentry.captureServerMessage).toHaveBeenCalledTimes(2);
  });

  it("does nothing without critical findings", () => {
    expect(reportBillingAlerts([warning])).toBe("none");
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("runBillingHealthStage", () => {
  it("pings the billing-health heartbeat only when the check passes", async () => {
    fake.admin.onRpc("billing_health_snapshot", () => ({ data: healthySnapshot(), error: null }));
    const report = await runBillingHealthStage({ now: NOW });
    expect(report?.ok).toBe(true);
    expect(pingHeartbeat).toHaveBeenCalledWith("billing-health", true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("alerts and skips the heartbeat when there is a critical finding", async () => {
    fake.admin.onRpc("billing_health_snapshot", () => ({
      data: healthySnapshot({
        paid_uncredited: { count: 1, oldest_paid_at: "2026-10-23T11:00:00Z" },
      }),
      error: null,
    }));
    const report = await runBillingHealthStage({ now: NOW });
    expect(report?.ok).toBe(false);
    expect(pingHeartbeat).not.toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0][0])).toContain("charge_paid_not_credited");
  });

  it("signal findings alert but never suppress the heartbeat", async () => {
    fake.admin.onRpc("billing_health_snapshot", () => ({
      data: healthySnapshot({
        signals: {
          webhook_invalid_signature: {
            count: 1,
            last_at: "2026-10-23T11:58:00Z",
            last_detail: "mismatch",
          },
          upper_unauthorized: { count: 1, last_at: "2026-10-23T11:59:00Z", last_detail: "401" },
          upper_feature_disabled: { count: 1, last_at: "2026-10-23T11:59:30Z", last_detail: "403" },
        },
      }),
      error: null,
    }));
    const report = await runBillingHealthStage({ now: NOW });
    expect(report?.ok).toBe(false);
    expect(pingHeartbeat).toHaveBeenCalledWith("billing-health", true);
    const lines = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join(" | ");
    expect(lines).toContain("webhook_invalid_signature");
    expect(lines).toContain("upper_unauthorized");
    expect(lines).toContain("upper_feature_disabled");
  });

  it("upper_unavailable alerts but never suppresses the heartbeat", async () => {
    fake.admin.onRpc("billing_health_snapshot", () => ({
      data: healthySnapshot({
        signals: {
          upper_unavailable: { count: 5, last_at: "2026-10-23T11:59:00Z", last_detail: "503" },
        },
      }),
      error: null,
    }));
    await runBillingHealthStage({ now: NOW });
    expect(pingHeartbeat).toHaveBeenCalledWith("billing-health", true);
    expect(String(errorSpy.mock.calls[0][0])).toContain("upper_unavailable");
  });

  it("signal findings alert only on events newer than the previous run", async () => {
    let lastAt = "2026-10-23T11:40:00Z"; // older than 5 min before the first run
    fake.admin.onRpc("billing_health_snapshot", () => ({
      data: healthySnapshot({
        signals: {
          webhook_invalid_signature: { count: 1, last_at: lastAt, last_detail: "mismatch" },
        },
      }),
      error: null,
    }));
    sentry.active = true; // no log dedupe in the way: count raw alerts

    await runBillingHealthStage({ now: NOW });
    expect(sentry.captureServerMessage).not.toHaveBeenCalled();

    lastAt = "2026-10-23T12:02:00Z"; // new event between runs
    await runBillingHealthStage({ now: new Date("2026-10-23T12:05:00Z") });
    expect(sentry.captureServerMessage).toHaveBeenCalledTimes(1);

    // Same counter, no new event: still in the 1 h window, but no new alert.
    await runBillingHealthStage({ now: new Date("2026-10-23T12:10:00Z") });
    expect(sentry.captureServerMessage).toHaveBeenCalledTimes(1);
    expect(pingHeartbeat).toHaveBeenCalledTimes(3);
  });

  it("state findings keep alerting each run while signal ones are quiet", async () => {
    fake.admin.onRpc("billing_health_snapshot", () => ({
      data: healthySnapshot({
        wallet_mismatch: { count: 1, tenant_ids: ["t"] },
        signals: {
          upper_unauthorized: { count: 1, last_at: "2026-10-23T10:00:00Z", last_detail: "401" },
        },
      }),
      error: null,
    }));
    sentry.active = true;
    await runBillingHealthStage({ now: NOW });
    await runBillingHealthStage({ now: new Date("2026-10-23T12:05:00Z") });
    const sent = sentry.captureServerMessage.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sent).toHaveLength(2);
    expect(sent.every((m) => m.includes("wallet_ledger_mismatch"))).toBe(true);
    expect(pingHeartbeat).not.toHaveBeenCalled();
  });

  it("never throws, even when the RPC itself throws", async () => {
    fake.admin.onRpc("billing_health_snapshot", () => {
      throw new Error("boom");
    });
    const report = await runBillingHealthStage({ now: NOW });
    expect(report?.ok).toBe(false);
    expect(pingHeartbeat).not.toHaveBeenCalled();
  });
});

describe("admin helpers", () => {
  it("adminBillingHealthFor requires the super admin", async () => {
    await expect(adminBillingHealthFor({ userId: PLAIN_USER })).rejects.toThrow(/super admin/);
  });

  it("adminBillingHealthFor returns the 24 h report", async () => {
    let window: unknown = null;
    fake.admin.onRpc("billing_health_snapshot", (a) => {
      window = a._window_hours;
      const recent = new Date(Date.now() - 60_000).toISOString();
      return {
        data: healthySnapshot({
          jobs_last_ok: { "billing-reconcile": recent, "billing-cycle": recent },
        }),
        error: null,
      };
    });
    const report = await adminBillingHealthFor({ userId: SUPER_ADMIN });
    expect(window).toBe(24);
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(typeof report.checkedAt).toBe("string");
  });

  it("adminTestBillingAlertFor requires the super admin and emits billing_alert_test", async () => {
    await expect(adminTestBillingAlertFor({ userId: PLAIN_USER })).rejects.toThrow(/super admin/);
    expect(errorSpy).not.toHaveBeenCalled();

    const result = await adminTestBillingAlertFor({ userId: SUPER_ADMIN });
    expect(result.channel).toBe("log");
    expect(String(errorSpy.mock.calls[0][0])).toContain(
      `${BILLING_ALERT_LOG_PREFIX} billing_alert_test`,
    );

    sentry.active = true;
    const viaSentry = await adminTestBillingAlertFor({ userId: SUPER_ADMIN });
    expect(viaSentry.channel).toBe("sentry");
    expect(sentry.captureServerMessage.mock.calls[0][2].fingerprint).toEqual([
      "billing-alert",
      "billing_alert_test",
    ]);
  });
});
