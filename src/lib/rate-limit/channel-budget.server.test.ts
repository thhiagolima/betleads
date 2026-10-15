import { describe, expect, it, vi } from "vitest";

const upsert = vi.fn(async () => ({ error: null }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: vi.fn(() => ({ upsert })), rpc: vi.fn() },
}));

import {
  createChannelBudget,
  ERROR_RETRY_MS,
  pauseChannelFor,
  pauseTenantChannel,
  type ChannelBudgetRpc,
} from "./channel-budget.server";
import {
  classifyProviderFailure,
  CREDIT_DEFER_MS,
  OUTCOME_UNKNOWN_RETRY_MS,
  PROVIDER_DEFER_MS,
  ProviderSendError,
  type ProviderErrorKind,
} from "./provider-errors.server";
import { transportErrorKind } from "./transport-errors";

const TENANT = "00000000-0000-4000-8000-000000000001";

/** In-memory token bucket with the same contract as consume_channel_budget. */
function fakeBucket(perSecond: number, clock: { now: number }) {
  let tokens = perSecond;
  let refilledAt = clock.now;
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc: ChannelBudgetRpc = async (fn, args) => {
    calls.push({ fn, args });
    if (fn === "consume_channel_budget") {
      tokens = Math.min(perSecond, tokens + ((clock.now - refilledAt) / 1000) * perSecond);
      refilledAt = clock.now;
      const granted = Math.min(Number(args.p_n), Math.floor(tokens + 1e-9));
      tokens -= granted;
      const retry = granted < Number(args.p_n) ? Math.ceil(((1 - tokens) / perSecond) * 1000) : 0;
      return {
        data: [{ granted, retry_after_ms: retry, limited_by: retry ? "tenant" : null }],
        error: null,
      };
    }
    return { data: null, error: null };
  };
  return { rpc, calls };
}

describe("channelBudget.acquire", () => {
  it("admits immediately while tokens are available", async () => {
    const clock = { now: 0 };
    const { rpc, calls } = fakeBucket(5, clock);
    const budget = createChannelBudget({ rpc, now: () => clock.now, sleep: async () => {} });
    const admission = await budget.acquire(TENANT, "sms");
    expect(admission).toMatchObject({ ok: true, permitId: null, waitedMs: 0 });
    expect(calls).toEqual([
      {
        fn: "consume_channel_budget",
        args: { p_tenant_id: TENANT, p_channel: "sms", p_n: 1, p_provider: null },
      },
    ]);
  });

  it("waits the hinted time when the bucket is empty, then admits", async () => {
    const clock = { now: 0 };
    const { rpc } = fakeBucket(5, clock);
    const sleep = vi.fn(async (ms: number) => {
      clock.now += ms;
    });
    const budget = createChannelBudget({ rpc, now: () => clock.now, sleep });
    for (let i = 0; i < 5; i++) expect((await budget.acquire(TENANT, "sms")).ok).toBe(true);
    const sixth = await budget.acquire(TENANT, "sms");
    expect(sixth.ok).toBe(true);
    expect(sleep).toHaveBeenCalledWith(200);
    expect(sixth.waitedMs).toBe(200);
  });

  it("enforces the rate over time (5/s => ~5 admissions per extra second)", async () => {
    const clock = { now: 0 };
    const { rpc } = fakeBucket(5, clock);
    const budget = createChannelBudget({
      rpc,
      now: () => clock.now,
      sleep: async (ms) => {
        clock.now += ms;
      },
    });
    let admitted = 0;
    while (clock.now < 3_000) if ((await budget.acquire(TENANT, "sms")).ok) admitted++;
    expect(admitted).toBeGreaterThanOrEqual(19);
    expect(admitted).toBeLessThanOrEqual(21); // 5 burst + 3 s * 5/s
  });

  it("returns a deferral instead of waiting past maxWaitMs or the deadline", async () => {
    const clock = { now: 0 };
    const rpc: ChannelBudgetRpc = async () => ({
      data: [{ granted: 0, retry_after_ms: 5_000, limited_by: "global" }],
      error: null,
    });
    const sleep = vi.fn(async () => {});
    const budget = createChannelBudget({ rpc, now: () => clock.now, sleep });
    expect(await budget.acquire(TENANT, "sms", { maxWaitMs: 2_000 })).toEqual({
      ok: false,
      retryAfterMs: 5_000,
      limitedBy: "global",
      waitedMs: 0,
    });
    const shortRetry: ChannelBudgetRpc = async () => ({
      data: [{ granted: 0, retry_after_ms: 100, limited_by: "tenant" }],
      error: null,
    });
    const noTime = createChannelBudget({ rpc: shortRetry, now: () => clock.now, sleep });
    expect(await noTime.acquire(TENANT, "sms", { deadline: 50 })).toMatchObject({ ok: false });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails closed when the RPC errors", async () => {
    const log = vi.fn();
    const rpc: ChannelBudgetRpc = async () => ({ data: null, error: { message: "boom" } });
    const budget = createChannelBudget({ rpc, sleep: async () => {}, log });
    expect(await budget.acquire(TENANT, "email")).toMatchObject({
      ok: false,
      retryAfterMs: ERROR_RETRY_MS,
      limitedBy: "error",
    });
    expect(await budget.consume(TENANT, "email", 3)).toEqual({
      granted: 0,
      retryAfterMs: ERROR_RETRY_MS,
      limitedBy: "error",
    });
    expect(log).toHaveBeenCalled();
  });

  it("voice takes a concurrency permit and frees it when tokens are denied", async () => {
    const calls: string[] = [];
    let consumeGrant = 0;
    const rpc: ChannelBudgetRpc = async (fn) => {
      calls.push(fn);
      if (fn === "acquire_channel_slot")
        return { data: [{ permit_id: "permit-1", retry_after_ms: 0, limited_by: null }], error: null };
      if (fn === "consume_channel_budget")
        return {
          data: [{ granted: consumeGrant, retry_after_ms: 10_000, limited_by: "global" }],
          error: null,
        };
      return { data: true, error: null };
    };
    const budget = createChannelBudget({ rpc, sleep: async () => {} });
    const denied = await budget.acquire(TENANT, "voice");
    expect(denied.ok).toBe(false);
    expect(calls).toEqual(["acquire_channel_slot", "consume_channel_budget", "release_channel_slot"]);
    consumeGrant = 1;
    calls.length = 0;
    const admitted = await budget.acquire(TENANT, "voice");
    expect(admitted).toMatchObject({ ok: true, permitId: "permit-1" });
    await budget.release(admitted);
    expect(calls).toEqual(["acquire_channel_slot", "consume_channel_budget", "release_channel_slot"]);
  });

  it("voice concurrency limit defers with the permit retry hint", async () => {
    const rpc: ChannelBudgetRpc = async (fn) =>
      fn === "acquire_channel_slot"
        ? { data: [{ permit_id: null, retry_after_ms: 30_000, limited_by: "tenant" }], error: null }
        : { data: null, error: null };
    const budget = createChannelBudget({ rpc, sleep: async () => {} });
    expect(await budget.acquire(TENANT, "voice")).toMatchObject({
      ok: false,
      retryAfterMs: 30_000,
      limitedBy: "tenant",
    });
  });

  it("release is a no-op without a permit", async () => {
    const rpc = vi.fn<ChannelBudgetRpc>(async () => ({ data: null, error: null }));
    const budget = createChannelBudget({ rpc });
    await budget.release({ ok: true, permitId: null, waitedMs: 0 });
    await budget.release(null);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("classifyProviderFailure (B1 matrix)", () => {
  const sendError = (
    status: number,
    extra: Partial<{
      body: unknown;
      temporary: boolean;
      message: string;
      errorKind: ProviderErrorKind | null;
    }> = {},
  ) =>
    new ProviderSendError({
      channel: "sms",
      message: extra.message ?? `HTTP ${status}`,
      status,
      body: extra.body,
      temporary: extra.temporary,
      errorKind: extra.errorKind,
    });

  it.each([429, 500, 502, 503, 504, 408])(
    "defers HTTP %i (provider answered) without consuming an attempt",
    (status) => {
      expect(classifyProviderFailure(sendError(status)).kind).toBe("defer");
    },
  );

  it("defers 60 s by default and honours a longer Retry-After on 429", () => {
    expect(classifyProviderFailure(sendError(503)).retryAfterMs).toBe(PROVIDER_DEFER_MS);
    expect(classifyProviderFailure(sendError(429, { body: { retry_after: 120 } })).retryAfterMs).toBe(
      120_000,
    );
    expect(classifyProviderFailure(sendError(429, { body: { retry_after: 5 } })).retryAfterMs).toBe(
      PROVIDER_DEFER_MS,
    );
  });

  it("defers results flagged temporary that carry a provider status", () => {
    expect(classifyProviderFailure(sendError(200, { temporary: true })).kind).toBe("defer");
  });

  it("402 / insufficient funds defers 15 min (no pause, resumes by itself after a recharge)", () => {
    expect(classifyProviderFailure(sendError(402))).toEqual({
      kind: "defer",
      reason: "insufficient_credit",
      retryAfterMs: CREDIT_DEFER_MS,
    });
    expect(
      classifyProviderFailure(sendError(400, { body: JSON.stringify({ code: "INSUFFICIENT_FUNDS" }) })).kind,
    ).toBe("defer");
  });

  it("timeout / reset after sending (status 0, outcome unknown) is treated as possibly sent", () => {
    for (const error of [
      sendError(0, { errorKind: "outcome_unknown", temporary: true }),
      sendError(0), // legacy result without a kind: assume possibly sent
    ]) {
      expect(classifyProviderFailure(error)).toEqual({
        kind: "unknown",
        reason: "outcome_unknown",
        retryAfterMs: OUTCOME_UNKNOWN_RETRY_MS,
      });
    }
  });

  it("missing credentials fail (no defer loop); a request that never left fails", () => {
    expect(classifyProviderFailure(sendError(0, { errorKind: "misconfigured" }))).toMatchObject({
      kind: "fail",
      reason: "provider_misconfigured",
    });
    expect(classifyProviderFailure(sendError(0, { errorKind: "not_sent", temporary: true }))).toMatchObject({
      kind: "fail",
      reason: "not_sent",
    });
  });

  it.each([400, 401, 403, 404, 422, 200])("fails permanently on HTTP %i", (status) => {
    expect(classifyProviderFailure(sendError(status)).kind).toBe("fail");
  });

  it("classifies plain (pre-provider) errors by message", () => {
    expect(classifyProviderFailure(new Error("fetch failed")).kind).toBe("defer");
    expect(classifyProviderFailure(new Error("connect ETIMEDOUT 1.2.3.4:443")).kind).toBe("defer");
    expect(classifyProviderFailure(new Error("Jogador sem e-mail")).kind).toBe("fail");
    expect(classifyProviderFailure(new Error("Template de e-mail não encontrado")).kind).toBe("fail");
    expect(classifyProviderFailure("insufficient funds")).toMatchObject({
      kind: "defer",
      reason: "insufficient_credit",
    });
  });
});

describe("transportErrorKind", () => {
  const withCause = (code: string) =>
    Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });

  it.each(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"])(
    "%s never reached the provider -> not_sent",
    (code) => {
      expect(transportErrorKind(withCause(code))).toBe("not_sent");
    },
  );

  it.each(["ECONNRESET", "UND_ERR_SOCKET", "EPIPE", "ETIMEDOUT", "UND_ERR_HEADERS_TIMEOUT"])(
    "%s may have been accepted -> outcome_unknown",
    (code) => {
      expect(transportErrorKind(withCause(code))).toBe("outcome_unknown");
    },
  );

  it("client timeouts/aborts and unknown errors are outcome_unknown", () => {
    expect(transportErrorKind(new Error("Short Brasil não respondeu em 8s"))).toBe("outcome_unknown");
    expect(transportErrorKind(new DOMException("The operation was aborted", "AbortError"))).toBe(
      "outcome_unknown",
    );
    expect(transportErrorKind(new DOMException("signal timed out", "TimeoutError"))).toBe(
      "outcome_unknown",
    );
    expect(transportErrorKind(new Error("socket hang up"))).toBe("outcome_unknown");
    expect(transportErrorKind(new Error("getaddrinfo ENOTFOUND api.example"))).toBe("not_sent");
  });
});

describe("pauseTenantChannel", () => {
  it("maps journey channels to dispatch_pause_state channels", () => {
    expect(pauseChannelFor("sms")).toBe("sms");
    expect(pauseChannelFor("email")).toBe("email");
    expect(pauseChannelFor("voice")).toBe("call");
    expect(pauseChannelFor("whatsapp")).toBeNull();
  });

  it("upserts a per-tenant pause and throttles bursts", async () => {
    upsert.mockClear();
    expect(await pauseTenantChannel(TENANT, "voice", "credit")).toBe(true);
    expect(await pauseTenantChannel(TENANT, "voice", "credit")).toBe(true);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT, channel: "call", paused: true, reason: "credit" }),
      { onConflict: "channel,tenant_id" },
    );
    expect(await pauseTenantChannel(TENANT, "whatsapp", "x")).toBe(false);
  });
});
