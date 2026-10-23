// PG6-03: the 5-minute reconcile job runs the billing health check as an
// isolated stage after the reconcile itself, success or failure, and that
// stage never changes the job's own response.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));

const mocks = vi.hoisted(() => ({
  reconcilePendingCharges: vi.fn(),
  runBillingHealthStage: vi.fn(),
  order: [] as string[],
}));

vi.mock("@/lib/billing/payment-charges.server", () => ({
  reconcilePendingCharges: mocks.reconcilePendingCharges,
}));
vi.mock("@/lib/billing/billing-health.server", () => ({
  runBillingHealthStage: mocks.runBillingHealthStage,
}));
vi.mock("@/lib/observability/job-monitor.server", () => ({
  withJobRun: async (_job: string, _meta: unknown, fn: (run: unknown) => Promise<unknown>) => {
    const value = await fn({ progress: () => undefined });
    mocks.order.push("job-finished");
    return value;
  },
}));

import { Route } from "./hooks/billing-reconcile";

type Handler = (input: { request: Request }) => Promise<Response>;
const POST = (Route as unknown as { options: { server: { handlers: Record<string, Handler> } } })
  .options.server.handlers.POST;

function post() {
  return POST({
    request: new Request("https://app.example.test/api/public/hooks/billing-reconcile", {
      method: "POST",
      headers: { authorization: "Bearer cron-secret-test" },
    }),
  });
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-secret-test");
  mocks.order.length = 0;
  mocks.reconcilePendingCharges.mockReset().mockImplementation(async () => {
    mocks.order.push("reconcile");
    return { checked: 1, credited: 1, expired: 0, errors: 0 };
  });
  mocks.runBillingHealthStage.mockReset().mockImplementation(async () => {
    mocks.order.push("health");
    return { ok: true, checkedAt: "x", windowHours: 1, findings: [] };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/public/hooks/billing-reconcile", () => {
  it("runs the health stage after the reconcile run is closed", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, credited: 1, health_ok: true });
    expect(mocks.order).toEqual(["reconcile", "job-finished", "health"]);
  });

  it("still runs the health stage when the reconcile fails, keeping the 500", async () => {
    mocks.reconcilePendingCharges.mockRejectedValue(new Error("db down"));
    const response = await post();
    expect(response.status).toBe(500);
    expect(mocks.runBillingHealthStage).toHaveBeenCalledTimes(1);
  });

  it("a throwing health stage never breaks the job response", async () => {
    mocks.runBillingHealthStage.mockRejectedValue(new Error("unexpected"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, health_ok: null });
    errorSpy.mockRestore();
  });

  it("rejects without the cron secret and runs nothing", async () => {
    const response = await POST({
      request: new Request("https://app.example.test/api/public/hooks/billing-reconcile", {
        method: "POST",
      }),
    });
    expect(response.status).toBe(401);
    expect(mocks.reconcilePendingCharges).not.toHaveBeenCalled();
    expect(mocks.runBillingHealthStage).not.toHaveBeenCalled();
  });
});
