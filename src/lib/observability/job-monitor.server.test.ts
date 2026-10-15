import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Call = { op: "insert" | "update"; payload: Record<string, unknown>; filters: unknown[][] };

const state = vi.hoisted(() => ({
  calls: [] as Array<{ op: string; payload: Record<string, unknown>; filters: unknown[][] }>,
  insertResults: [] as Array<{ data: unknown; error: unknown } | Error>,
  updateResults: [] as Array<{ error: unknown } | Error>,
  throwOnFrom: false,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const from = () => {
    if (state.throwOnFrom) throw new Error("Missing Supabase environment variable(s)");
    return {
      insert(payload: Record<string, unknown>) {
        const call = { op: "insert", payload, filters: [] as unknown[][] };
        state.calls.push(call);
        const next = state.insertResults.shift() ?? { data: { id: 42 }, error: null };
        return {
          select: () => ({
            maybeSingle: async () => {
              if (next instanceof Error) throw next;
              return next;
            },
          }),
        };
      },
      update(payload: Record<string, unknown>) {
        const call = { op: "update", payload, filters: [] as unknown[][] };
        state.calls.push(call);
        const builder: Record<string, unknown> = {};
        for (const method of ["eq", "neq", "lt"]) {
          builder[method] = (...args: unknown[]) => {
            call.filters.push([method, ...args]);
            return builder;
          };
        }
        builder.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
          const next = state.updateResults.shift() ?? { error: null };
          if (next instanceof Error) reject(next);
          else resolve(next);
        };
        return builder;
      },
    };
  };
  return { supabaseAdmin: { from } };
});

const captureServerException = vi.hoisted(() => vi.fn());
vi.mock("@/lib/observability/sentry.server", () => ({ captureServerException }));

import {
  HEARTBEAT_MIN_INTERVAL_MS,
  HEARTBEAT_TIMER_MS,
  LEGACY_SCHEMA_RETRY_MS,
  deriveLegacyStatus,
  PROGRESS_THROTTLE_MS,
  __resetJobMonitorStateForTests,
  heartbeatEnvName,
  heartbeatUrl,
  pingHeartbeat,
  recordCompletedRun,
  startJobRun,
  withJobRun,
} from "./job-monitor.server";

const fetchMock = vi.fn();
const calls = () => state.calls as Call[];
const updates = () => calls().filter((c) => c.op === "update");
const inserts = () => calls().filter((c) => c.op === "insert");
const ENV = "BETTERSTACK_HEARTBEAT_JOURNEY_DISPATCH";
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
  state.calls = [];
  state.insertResults = [];
  state.updateResults = [];
  state.throwOnFrom = false;
  captureServerException.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("ok"));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  __resetJobMonitorStateForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("heartbeat URL building", () => {
  it("maps job names to env var names", () => {
    expect(heartbeatEnvName("journey_dispatch")).toBe(ENV);
    expect(heartbeatEnvName("sms-campaign dispatch")).toBe(
      "BETTERSTACK_HEARTBEAT_SMS_CAMPAIGN_DISPATCH",
    );
  });

  it("returns the base URL on success and /fail on failure", () => {
    const env = { [ENV]: "https://uptime.betterstack.com/api/v1/heartbeat/abc123/" };
    expect(heartbeatUrl("journey_dispatch", true, env)).toBe(
      "https://uptime.betterstack.com/api/v1/heartbeat/abc123/",
    );
    expect(heartbeatUrl("journey_dispatch", false, env)).toBe(
      "https://uptime.betterstack.com/api/v1/heartbeat/abc123/fail",
    );
    expect(
      heartbeatUrl("journey_dispatch", false, {
        [ENV]: "https://uptime.betterstack.com/api/v1/heartbeat/abc123",
      }),
    ).toBe("https://uptime.betterstack.com/api/v1/heartbeat/abc123/fail");
  });

  it("is a no-op when the env var is missing or invalid", async () => {
    expect(heartbeatUrl("journey_dispatch", true, {})).toBeNull();
    expect(heartbeatUrl("journey_dispatch", true, { [ENV]: "not a url" })).toBeNull();
    expect(heartbeatUrl("journey_dispatch", true, { [ENV]: "ftp://x/y" })).toBeNull();
    await pingHeartbeat("journey_dispatch", true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pingHeartbeat", () => {
  it("throttles pings per job and outcome", async () => {
    vi.stubEnv(ENV, "https://hb.example/x");
    await pingHeartbeat("journey_dispatch", true);
    await pingHeartbeat("journey_dispatch", true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await pingHeartbeat("journey_dispatch", false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("https://hb.example/x/fail");
    vi.advanceTimersByTime(HEARTBEAT_MIN_INTERVAL_MS);
    await pingHeartbeat("journey_dispatch", true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never throws when fetch rejects or throws synchronously", async () => {
    vi.stubEnv(ENV, "https://hb.example/x");
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(pingHeartbeat("journey_dispatch", true)).resolves.toBeUndefined();
    fetchMock.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await expect(pingHeartbeat("journey_dispatch", false)).resolves.toBeUndefined();
  });

  it("passes a timeout signal to fetch", async () => {
    vi.stubEnv(ENV, "https://hb.example/x");
    await pingHeartbeat("journey_dispatch", true);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("startJobRun", () => {
  it("inserts a running row and closes it on finish", async () => {
    vi.stubEnv(ENV, "https://hb.example/x");
    const run = await startJobRun("journey_dispatch", { channel: "journey", tenantId: "t1" });
    expect(run.id).toBe(42);
    const start = inserts()[0].payload;
    expect(start).toMatchObject({
      job: "journey_dispatch",
      channel: "journey",
      kind: "tick",
      tenant_id: "t1",
      status: "running",
      finished_at: null,
    });
    expect(start.heartbeat_at).toBe(start.started_at);

    vi.advanceTimersByTime(1_500);
    await run.finish({ claimed: 10, sent: 10 });
    const finish = updates().find((u) => u.payload.status === "succeeded");
    expect(finish?.payload).toMatchObject({ claimed: 10, sent: 10, duration_ms: 1_500 });
    expect(finish?.filters).toContainEqual(["eq", "id", 42]);
    expect(fetchMock).toHaveBeenCalledWith("https://hb.example/x", expect.anything());
  });

  it("derives 'partial' when there are errors and still pings success", async () => {
    vi.stubEnv(ENV, "https://hb.example/x");
    const run = await startJobRun("journey_dispatch");
    await run.finish({ sent: 5, errors: 2 });
    expect(updates().some((u) => u.payload.status === "partial")).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("https://hb.example/x", expect.anything());
  });

  it("throttles progress writes to one per window", async () => {
    const run = await startJobRun("journey_dispatch");
    const progressWrites = () => updates().filter((u) => u.payload.status === undefined && "heartbeat_at" in u.payload);

    run.progress({ sent: 1 });
    expect(progressWrites()).toHaveLength(0); // still inside the first window

    vi.advanceTimersByTime(PROGRESS_THROTTLE_MS);
    run.progress({ sent: 2 });
    await flush();
    run.progress({ sent: 3 });
    vi.advanceTimersByTime(PROGRESS_THROTTLE_MS / 2);
    run.progress({ sent: 4 });
    expect(progressWrites()).toHaveLength(1);
    expect(progressWrites()[0].payload).toMatchObject({ sent: 2 });
    expect(progressWrites()[0].filters).toContainEqual(["eq", "status", "running"]);

    vi.advanceTimersByTime(PROGRESS_THROTTLE_MS);
    await flush();
    run.progress({ sent: 5 });
    expect(progressWrites()).toHaveLength(2);

    await run.finish();
    const finish = updates().find((u) => u.payload.status === "succeeded");
    expect(finish?.payload.sent).toBe(5); // counters accumulated across throttled calls
  });

  it("fail() records failed status, reports to Sentry and pings /fail", async () => {
    vi.stubEnv(ENV, "https://hb.example/x");
    const run = await startJobRun("journey_dispatch", { tenantId: "t9" });
    const error = new Error("rpc exploded");
    await run.fail(error);
    expect(captureServerException).toHaveBeenCalledWith(error, {
      job: "journey_dispatch",
      tenantId: "t9",
    });
    const failed = updates().find((u) => u.payload.status === "failed" && u.payload.stop_reason !== "abandoned");
    expect(failed?.payload.stop_reason).toBe("error: rpc exploded");
    expect(fetchMock).toHaveBeenCalledWith("https://hb.example/x/fail", expect.anything());
  });

  it("finish/fail are idempotent", async () => {
    const run = await startJobRun("journey_dispatch");
    await run.finish();
    await run.fail(new Error("late"));
    const closes = updates().filter((u) => "finished_at" in u.payload && u.payload.stop_reason !== "abandoned");
    expect(closes).toHaveLength(1);
    expect(captureServerException).not.toHaveBeenCalled();
  });

  it("reaps abandoned running rows of the same job", async () => {
    await startJobRun("journey_scan");
    const reap = updates().find((u) => u.payload.stop_reason === "abandoned");
    expect(reap?.filters).toEqual(
      expect.arrayContaining([
        ["eq", "job", "journey_scan"],
        ["eq", "status", "running"],
        ["neq", "id", 42],
      ]),
    );
  });

  it("falls back to legacy columns when the migration is not applied", async () => {
    state.insertResults.push({ data: null, error: { code: "PGRST204", message: "Could not find the 'heartbeat_at' column" } });
    const run = await startJobRun("journey_dispatch");
    expect(run.id).toBe(42);
    const [first, second] = inserts();
    expect(first.payload).toHaveProperty("status");
    expect(second.payload).not.toHaveProperty("status");
    expect(second.payload).not.toHaveProperty("heartbeat_at");
    expect(second.payload).not.toHaveProperty("job");
    await run.finish();
    const close = updates().at(-1)!;
    expect(close.payload).not.toHaveProperty("status");
    expect(close.payload).toHaveProperty("finished_at");
  });

  it("writes a complete row at finish when the start insert failed", async () => {
    state.insertResults.push({ data: null, error: { code: "57014", message: "timeout" } });
    const run = await startJobRun("journey_dispatch");
    expect(run.id).toBeNull();
    run.progress({ sent: 1 }); // no id -> no update
    await run.finish({ sent: 3 });
    const last = inserts().at(-1)!;
    expect(last.payload).toMatchObject({ status: "succeeded", sent: 3, job: "journey_dispatch" });
  });

  it("never throws even when the database client explodes", async () => {
    vi.stubEnv(ENV, "https://hb.example/x");
    state.throwOnFrom = true;
    captureServerException.mockImplementation(() => {
      throw new Error("sentry down");
    });
    const run = await startJobRun("journey_dispatch");
    expect(run.id).toBeNull();
    expect(() => run.progress({ sent: 1 })).not.toThrow();
    await expect(run.fail(new Error("x"))).resolves.toBeUndefined();
    await expect(
      recordCompletedRun("sms_tick", Date.now(), { channel: "sms" }, { sent: 1 }),
    ).resolves.toBeUndefined();
  });

  it("withJobRun records failures and rethrows the original error", async () => {
    const error = new Error("job broke");
    await expect(
      withJobRun("journey_dispatch", {}, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(captureServerException).toHaveBeenCalledWith(error, expect.anything());
  });
});

describe("recordCompletedRun", () => {
  it("writes one finished row with job/status and pings the heartbeat", async () => {
    vi.stubEnv("BETTERSTACK_HEARTBEAT_SMS_TICK", "https://hb.example/sms");
    const started = Date.now();
    vi.advanceTimersByTime(250);
    await recordCompletedRun("sms_tick", started, { channel: "sms" }, { sent: 4, errors: 1 });
    const row = inserts()[0].payload;
    expect(row).toMatchObject({
      job: "sms_tick",
      channel: "sms",
      kind: "tick",
      status: "partial",
      sent: 4,
      errors: 1,
      actual_rate: 4,
      duration_ms: 250,
    });
    expect(fetchMock).toHaveBeenCalledWith("https://hb.example/sms", expect.anything());
  });

  it("respects heartbeat: false", async () => {
    vi.stubEnv("BETTERSTACK_HEARTBEAT_RECOVERY", "https://hb.example/r");
    await recordCompletedRun("recovery", Date.now(), {}, {}, { heartbeat: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("liveness and status hardening", () => {
  it("timer keeps heartbeat_at fresh during a long phase without progress()", async () => {
    const run = await startJobRun("journey_dispatch");
    const heartbeats = () =>
      updates().filter((u) => u.payload.status === undefined && "heartbeat_at" in u.payload);

    // A single 5 min phase with no progress() calls (e.g. a slow claim/wave).
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(HEARTBEAT_TIMER_MS);
      await flush();
    }
    expect(heartbeats().length).toBeGreaterThanOrEqual(9);
    expect(heartbeats()[0].filters).toContainEqual(["eq", "status", "running"]);

    await run.finish();
    const before = heartbeats().length;
    vi.advanceTimersByTime(HEARTBEAT_TIMER_MS * 3);
    await flush();
    expect(heartbeats()).toHaveLength(before); // timer stopped on close
  });

  it("legacy fallback expires and the new columns are retried", async () => {
    state.insertResults.push({ data: null, error: { code: "PGRST204", message: "Could not find the 'heartbeat_at' column" } });
    await (await startJobRun("journey_dispatch")).finish();
    vi.advanceTimersByTime(LEGACY_SCHEMA_RETRY_MS);
    state.calls = [];
    await startJobRun("journey_dispatch");
    expect(inserts()[0].payload).toHaveProperty("status", "running");
  });

  it("derives failed from claim_error/error stop reasons", () => {
    expect(deriveLegacyStatus(0, "claim_error: boom")).toBe("failed");
    expect(deriveLegacyStatus(0, "error")).toBe("failed");
    expect(deriveLegacyStatus(0, "errors")).toBe("succeeded");
    expect(deriveLegacyStatus(2, "errors")).toBe("partial");
    expect(deriveLegacyStatus(0, "queue_empty")).toBe("succeeded");
  });

  it("recordCompletedRun pings /fail for a claim_error tick", async () => {
    vi.stubEnv("BETTERSTACK_HEARTBEAT_SMS_TICK", "https://hb.example/sms");
    await recordCompletedRun("sms_tick", Date.now(), {}, { stop_reason: "claim_error: rpc down" });
    expect(inserts().at(-1)!.payload.status).toBe("failed");
    expect(fetchMock.mock.calls[0][0]).toBe("https://hb.example/sms/fail");
  });
});
