import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));

const { runBillingCycle } = vi.hoisted(() => ({ runBillingCycle: vi.fn() }));
vi.mock("@/lib/billing/invoices.server", () => ({ runBillingCycle }));

const mocks = vi.hoisted(() => ({
  run: {
    progress: vi.fn(),
    finish: vi.fn(async () => undefined),
    fail: vi.fn(async (_error: unknown) => undefined),
  },
}));
vi.mock("@/lib/observability/job-monitor.server", () => ({
  withJobRun: vi.fn(async (_job: string, _meta: unknown, fn: (run: unknown) => Promise<unknown>) => {
    try {
      const value = await fn(mocks.run);
      await mocks.run.finish();
      return value;
    } catch (err) {
      await mocks.run.fail(err);
      throw err;
    }
  }),
}));

// requireSharedSecret (@/lib/cron-auth.server) is NOT mocked here on
// purpose: the 401 case is exactly what this test file is for.
import { Route } from "./hooks/billing-cycle";

type Handler = (input: { request: Request }) => Promise<Response>;
const POST = (Route as unknown as { options: { server: { handlers: Record<string, Handler> } } })
  .options.server.handlers.POST;

const URL = "https://betleads.io/api/public/hooks/billing-cycle";
const SECRET = "cron-secret-billing-cycle-test-0123456789";

function post(headers: Record<string, string> = {}) {
  return POST({
    request: new Request(URL, { method: "POST", headers, body: "{}" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", SECRET);
  runBillingCycle.mockResolvedValue({ generated: 2, refreshed: 10, issued: 2, errors: 0 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/public/hooks/billing-cycle", () => {
  it("answers 401 and never calls runBillingCycle without the shared secret", async () => {
    const response = await post();
    expect(response.status).toBe(401);
    expect(runBillingCycle).not.toHaveBeenCalled();
  });

  it("answers 401 with a wrong secret", async () => {
    const response = await post({ authorization: "Bearer not-the-secret" });
    expect(response.status).toBe(401);
    expect(runBillingCycle).not.toHaveBeenCalled();
  });

  it("answers 200 with the counters when the secret matches", async () => {
    const response = await post({ authorization: `Bearer ${SECRET}` });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, generated: 2, refreshed: 10, issued: 2, errors: 0 });
    expect(runBillingCycle).toHaveBeenCalledTimes(1);
    expect(runBillingCycle).toHaveBeenCalledWith({
      sendEmails: expect.any(Function),
      sendWalletAlerts: expect.any(Function),
    });
    expect(mocks.run.progress).toHaveBeenCalledWith({ claimed: 10, sent: 2, errors: 0 });
    expect(mocks.run.finish).toHaveBeenCalledTimes(1);
  });

  it("answers 500 and records a failed run when runBillingCycle throws", async () => {
    runBillingCycle.mockRejectedValue(new Error("db down"));
    const response = await post({ authorization: `Bearer ${SECRET}` });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ ok: false, error: "db down" });
    expect(mocks.run.fail).toHaveBeenCalledTimes(1);
  });

  it("also accepts the x-cron-secret header", async () => {
    const response = await post({ "x-cron-secret": SECRET });
    expect(response.status).toBe(200);
  });
});
