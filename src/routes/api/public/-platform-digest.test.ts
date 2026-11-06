import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));

const mocks = vi.hoisted(() => ({
  runDailyDigest: vi.fn(),
  startJobRun: vi.fn(),
  run: {
    progress: vi.fn(),
    finish: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  },
}));

vi.mock("@/lib/platform-health/daily-digest.server", () => ({
  runDailyDigest: mocks.runDailyDigest,
}));
vi.mock("@/lib/observability/job-monitor.server", () => ({
  startJobRun: mocks.startJobRun,
}));

import { Route } from "./hooks/platform-digest";

type Handler = (input: { request: Request }) => Promise<Response>;
const POST = (Route as unknown as { options: { server: { handlers: Record<string, Handler> } } })
  .options.server.handlers.POST;

function post(secret: string) {
  return POST({
    request: new Request("https://app.example.test/api/public/hooks/platform-digest", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    }),
  });
}

const RESULT = { sent: true, recipients: 2 };

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-secret-test");
  mocks.runDailyDigest.mockReset().mockResolvedValue(RESULT);
  mocks.startJobRun.mockReset().mockResolvedValue(mocks.run);
  mocks.run.finish.mockClear();
  mocks.run.fail.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/public/hooks/platform-digest", () => {
  it("rejects a wrong secret with 401 and does no work", async () => {
    const response = await post("wrong");
    expect(response.status).toBe(401);
    expect(mocks.startJobRun).not.toHaveBeenCalled();
    expect(mocks.runDailyDigest).not.toHaveBeenCalled();
  });

  it("runs the digest inside a platform_digest job run and returns its result", async () => {
    const response = await post("cron-secret-test");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ...RESULT });
    expect(mocks.startJobRun).toHaveBeenCalledWith("platform_digest", expect.anything());
    expect(mocks.runDailyDigest).toHaveBeenCalledWith(expect.any(Date));
    expect(mocks.run.finish).toHaveBeenCalledWith({ sent: RESULT.recipients });
    expect(mocks.run.fail).not.toHaveBeenCalled();
  });

  it("fails the run and answers 500 when the digest throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("db down");
    mocks.runDailyDigest.mockRejectedValue(error);

    const response = await post("cron-secret-test");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "db down" });
    expect(mocks.run.fail).toHaveBeenCalledWith(error);
    expect(mocks.run.finish).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
