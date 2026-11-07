import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));

const mocks = vi.hoisted(() => ({
  syncPlatformAlerts: vi.fn(),
  startJobRun: vi.fn(),
  run: {
    progress: vi.fn(),
    finish: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  },
}));

vi.mock("@/lib/platform-health/alert-store.server", () => ({
  syncPlatformAlerts: mocks.syncPlatformAlerts,
}));
vi.mock("@/lib/observability/job-monitor.server", () => ({
  startJobRun: mocks.startJobRun,
}));

import { Route } from "./hooks/platform-alerts";

type Handler = (input: { request: Request }) => Promise<Response>;
const POST = (Route as unknown as { options: { server: { handlers: Record<string, Handler> } } })
  .options.server.handlers.POST;

function post(secret: string) {
  return POST({
    request: new Request("https://app.example.test/api/public/hooks/platform-alerts", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    }),
  });
}

const COUNTERS = { opened: 2, seen: 3, resolved: 1, notified: 1, purged: 4 };

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-secret-test");
  mocks.syncPlatformAlerts.mockReset().mockResolvedValue(COUNTERS);
  mocks.startJobRun.mockReset().mockResolvedValue(mocks.run);
  mocks.run.finish.mockClear();
  mocks.run.fail.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/public/hooks/platform-alerts", () => {
  it("rejects a wrong secret with 401 and does no work", async () => {
    const response = await post("wrong");
    expect(response.status).toBe(401);
    expect(mocks.startJobRun).not.toHaveBeenCalled();
    expect(mocks.syncPlatformAlerts).not.toHaveBeenCalled();
  });

  it("runs the sync inside a platform_alerts job run and returns its counters", async () => {
    const response = await post("cron-secret-test");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ...COUNTERS });
    expect(mocks.startJobRun).toHaveBeenCalledWith("platform_alerts", expect.anything());
    expect(mocks.syncPlatformAlerts).toHaveBeenCalledWith(expect.any(Date));
    expect(mocks.run.finish).toHaveBeenCalledTimes(1);
    expect(mocks.run.fail).not.toHaveBeenCalled();
  });

  it("fails the run and answers 500 when the sync throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("db down");
    mocks.syncPlatformAlerts.mockRejectedValue(error);

    const response = await post("cron-secret-test");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "db down" });
    expect(mocks.run.fail).toHaveBeenCalledWith(error);
    expect(mocks.run.finish).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
