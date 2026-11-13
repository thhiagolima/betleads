import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));

const mocks = vi.hoisted(() => ({
  runWebpushLeadBilling: vi.fn(),
  startJobRun: vi.fn(),
  run: {
    progress: vi.fn(),
    finish: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  },
}));

vi.mock("@/lib/webpush/lead-billing.server", () => ({
  runWebpushLeadBilling: mocks.runWebpushLeadBilling,
}));
vi.mock("@/lib/observability/job-monitor.server", () => ({
  startJobRun: mocks.startJobRun,
}));

import { Route } from "./hooks/webpush-lead-billing";

type Handler = (input: { request: Request }) => Promise<Response>;
const POST = (Route as unknown as { options: { server: { handlers: Record<string, Handler> } } })
  .options.server.handlers.POST;

function post(secret: string) {
  return POST({
    request: new Request("https://app.example.test/api/public/hooks/webpush-lead-billing", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    }),
  });
}

const SUMMARY = {
  tenants: 3,
  batches: 2,
  billedUnits: 40,
  chargedAmount: 0.4,
  insufficientBalance: [{ tenantId: "t-b", pendingUnits: 5 }],
  errors: [{ tenantId: "t-c", message: "price_not_found" }],
  truncated: false,
};

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-secret-test");
  mocks.runWebpushLeadBilling.mockReset().mockResolvedValue(SUMMARY);
  mocks.startJobRun.mockReset().mockResolvedValue(mocks.run);
  mocks.run.finish.mockClear();
  mocks.run.fail.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/public/hooks/webpush-lead-billing", () => {
  it("rejects a wrong secret with 401 and does no work", async () => {
    const response = await post("wrong");
    expect(response.status).toBe(401);
    expect(mocks.startJobRun).not.toHaveBeenCalled();
    expect(mocks.runWebpushLeadBilling).not.toHaveBeenCalled();
  });

  it("runs the batch inside a webpush_lead_billing job run and returns its summary", async () => {
    const response = await post("cron-secret-test");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ...SUMMARY });
    expect(mocks.startJobRun).toHaveBeenCalledWith("webpush_lead_billing", expect.anything());
    expect(mocks.run.finish).toHaveBeenCalledWith(
      expect.objectContaining({ claimed: 3, sent: 40, errors: 1, rate_limited: 1 }),
    );
    expect(mocks.run.fail).not.toHaveBeenCalled();
  });

  it("fails the run and answers 500 when the batch throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("db down");
    mocks.runWebpushLeadBilling.mockRejectedValue(error);

    const response = await post("cron-secret-test");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "db down" });
    expect(mocks.run.fail).toHaveBeenCalledWith(error);
    expect(mocks.run.finish).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
