// V1-01 — runVoiceQueueDispatcher with bounded concurrency.
//
// Items are dialed in a pool of VOICE_DISPATCH_CONCURRENCY (default 10,
// clamped 1..50). The serial invariants must still hold: an item is dialed
// once (per-item claim), a broke house gets no new item after its refusal,
// an expert never has two items in flight (cap gate stays serial), and an
// aborting error leaves no row in the claimed status.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));
const voice = vi.hoisted(() => ({ callInfobipVoice: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: { ...fake.db.client, storage: { from: () => ({}) } } };
});
vi.mock("./infobip-voice.server", () => ({
  callInfobipVoice: voice.callInfobipVoice,
  normalizeE164BR: (raw: string) => `+${raw.replace(/\D/g, "")}`,
}));
vi.mock("./consent.server", () => ({
  evaluateVoiceContactPolicy: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("./tenant-access.server", () => ({
  assertTenantNotDemoForSend: vi.fn(async () => undefined),
  listDemoTenantIds: vi.fn(async () => []),
}));
// The real gate, with its scope lookups stubbed: every expert is active and
// every lead is in scope, so only the cap decides.
vi.mock("./expert-voice.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./expert-voice.server")>();
  class TestGate extends actual.ExpertVoiceGate {
    constructor() {
      super({
        loadScope: async () => ({ ativo: true }) as never,
        filterVisible: async (_scope, ids) => ids,
        notifyCap: async () => undefined,
      });
    }
  }
  return { ...actual, ExpertVoiceGate: TestGate };
});

import { DemoTenantBlockedError } from "./demo-tenant";
import { resolveVoiceDispatchConcurrency, runVoiceQueueDispatcher } from "./calls.server";
import { __resetTenantChannelsCacheForTests } from "./tenant-channels.server";

type Opts = { tenantId: string; billingKey: string; expertId?: string };

const tenant = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const okCall = (key: string) => ({ ok: true, status: 200, body: {}, idempotencyKey: key, providerCallId: key });
const refusal = (errorKind: string) => ({
  ok: false,
  status: 0,
  body: {},
  idempotencyKey: "refused",
  providerCallId: null,
  errorKind,
});

let seq = 0;
function seed(tenantId: string, extra: Record<string, unknown> = {}) {
  const id = `q${++seq}`;
  fake.db.rows("call_queue").push({
    id,
    tenant_id: tenantId,
    lead_id: null,
    script_id: null,
    voice_asset_id: null,
    phone_number: `55119${String(seq).padStart(8, "0")}`,
    audio_url: "https://audio.example/a.mp3",
    status: "audio_ready",
    scheduled_at: new Date(Date.now() - 600_000 + seq * 1_000).toISOString(),
    ...extra,
  });
  return id;
}

/** Wraps a dial in a delay and tracks how many dials are in flight. */
function trackInFlight(reply: (opts: Opts) => unknown | Promise<unknown>, delayMs = 10) {
  const stats = { inFlight: 0, max: 0, calls: [] as string[] };
  voice.callInfobipVoice.mockImplementation(async (_to: string, _c: unknown, opts: Opts) => {
    stats.calls.push(opts.billingKey);
    stats.inFlight++;
    stats.max = Math.max(stats.max, stats.inFlight);
    try {
      await sleep(delayMs);
      return await reply(opts);
    } finally {
      stats.inFlight--;
    }
  });
  return stats;
}

const rows = () => fake.db.rows("call_queue");

beforeEach(() => {
  fake.db.reset();
  voice.callInfobipVoice.mockReset();
  __resetTenantChannelsCacheForTests();
  seq = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveVoiceDispatchConcurrency", () => {
  it("defaults to 10 and clamps to 1..50", () => {
    expect(resolveVoiceDispatchConcurrency({})).toBe(10);
    expect(resolveVoiceDispatchConcurrency({ VOICE_DISPATCH_CONCURRENCY: "" })).toBe(10);
    expect(resolveVoiceDispatchConcurrency({ VOICE_DISPATCH_CONCURRENCY: "abc" })).toBe(10);
    expect(resolveVoiceDispatchConcurrency({ VOICE_DISPATCH_CONCURRENCY: "4" })).toBe(4);
    expect(resolveVoiceDispatchConcurrency({ VOICE_DISPATCH_CONCURRENCY: "7.9" })).toBe(7);
    expect(resolveVoiceDispatchConcurrency({ VOICE_DISPATCH_CONCURRENCY: "0" })).toBe(1);
    expect(resolveVoiceDispatchConcurrency({ VOICE_DISPATCH_CONCURRENCY: "-5" })).toBe(1);
    expect(resolveVoiceDispatchConcurrency({ VOICE_DISPATCH_CONCURRENCY: "500" })).toBe(50);
  });
});

describe("runVoiceQueueDispatcher concurrency", () => {
  it("overlaps dials up to the configured limit and dispatches every item", async () => {
    vi.stubEnv("VOICE_DISPATCH_CONCURRENCY", "4");
    for (let i = 0; i < 12; i++) seed(tenant(1));
    const stats = trackInFlight((o) => okCall(o.billingKey));

    const result = await runVoiceQueueDispatcher(50);

    expect(stats.max).toBeGreaterThan(1);
    expect(stats.max).toBeLessThanOrEqual(4);
    expect(result).toEqual({
      due: 12,
      dispatched: 12,
      deferred: 0,
      failed: 0,
      insufficientBalance: 0,
      skippedNoBalance: 0,
      expertCapped: 0,
      notClaimed: 0,
      channelDisabled: 0,
    });
    expect(rows().every((r) => r.status === "waiting_provider")).toBe(true);
    expect(fake.db.rows("call_history")).toHaveLength(12);
  });

  it("the default limit (10) is never exceeded across many houses", async () => {
    for (let i = 0; i < 30; i++) seed(tenant(i + 1));
    const stats = trackInFlight((o) => okCall(o.billingKey));
    const result = await runVoiceQueueDispatcher(50);
    expect(stats.max).toBeGreaterThan(1);
    expect(stats.max).toBeLessThanOrEqual(10);
    expect(result.dispatched).toBe(30);
  });

  it("VOICE_DISPATCH_CONCURRENCY=1 keeps the old serial behavior", async () => {
    vi.stubEnv("VOICE_DISPATCH_CONCURRENCY", "1");
    for (let i = 0; i < 5; i++) seed(tenant(i + 1));
    const stats = trackInFlight((o) => okCall(o.billingKey));
    await runVoiceQueueDispatcher(50);
    expect(stats.max).toBe(1);
    expect(stats.calls).toEqual(["q1", "q2", "q3", "q4", "q5"]);
  });

  it("two concurrent runs never dial the same item twice", async () => {
    vi.stubEnv("VOICE_DISPATCH_CONCURRENCY", "5");
    for (let i = 0; i < 10; i++) seed(tenant((i % 3) + 1));
    const stats = trackInFlight((o) => okCall(o.billingKey), 5);

    const [a, b] = await Promise.all([runVoiceQueueDispatcher(50), runVoiceQueueDispatcher(50)]);

    expect(new Set(stats.calls).size).toBe(stats.calls.length);
    expect(stats.calls).toHaveLength(10);
    expect(a.dispatched + b.dispatched).toBe(10);
    expect(a.notClaimed + b.notClaimed).toBe(10);
    expect(fake.db.rows("call_history")).toHaveLength(10);
    expect(rows().every((r) => r.status === "waiting_provider")).toBe(true);
  });

  it("a broke house is refused once; other houses keep dialing in parallel", async () => {
    vi.stubEnv("VOICE_DISPATCH_CONCURRENCY", "10");
    const A = tenant(1);
    const B = tenant(2);
    for (let i = 0; i < 8; i++) seed(A);
    for (let i = 0; i < 4; i++) seed(B);
    const stats = trackInFlight((o) =>
      o.tenantId === A ? refusal("insufficient_balance") : okCall(o.billingKey),
    );

    const result = await runVoiceQueueDispatcher(50);

    const aCalls = voice.callInfobipVoice.mock.calls.filter((c) => c[2].tenantId === A);
    expect(aCalls).toHaveLength(1);
    expect(result).toMatchObject({
      due: 12,
      dispatched: 4,
      insufficientBalance: 1,
      skippedNoBalance: 7,
      failed: 0,
    });
    expect(stats.max).toBeGreaterThan(1);
    for (const r of rows().filter((r) => r.tenant_id === A)) {
      expect(r).toMatchObject({ status: "audio_ready", provider_status: "saldo_insuficiente" });
      expect(Date.parse(String(r.scheduled_at))).toBeGreaterThan(Date.now() + 14 * 60_000);
    }
  });

  it("once the wallet refuses mid-batch, no new item of that house starts", async () => {
    vi.stubEnv("VOICE_DISPATCH_CONCURRENCY", "4");
    const A = tenant(1);
    for (let i = 0; i < 20; i++) seed(A);
    let balance = 3;
    let closed = false;
    let startedAfterClose = 0;
    voice.callInfobipVoice.mockImplementation(async (_to: string, _c: unknown, opts: Opts) => {
      if (closed) startedAfterClose++;
      const funded = balance-- > 0;
      await sleep(10);
      if (funded) return okCall(opts.billingKey);
      // The dispatcher records the refusal in the microtasks right after
      // this resolves; anything dialed after the next macrotask is new.
      setTimeout(() => (closed = true), 0);
      return refusal("insufficient_balance");
    });

    const result = await runVoiceQueueDispatcher(50);

    expect(startedAfterClose).toBe(0);
    const calls = voice.callInfobipVoice.mock.calls.length;
    // The probe, then at most one wave of 4 in flight when the refusal lands.
    expect(calls).toBeLessThanOrEqual(1 + 4 + 3);
    expect(result.dispatched).toBe(3);
    expect(result.dispatched + result.insufficientBalance + result.skippedNoBalance).toBe(20);
    expect(result.failed).toBe(0);
    expect(rows().filter((r) => r.status === "calling")).toHaveLength(0);
    expect(rows().filter((r) => r.status === "waiting_provider")).toHaveLength(3);
    expect(rows().filter((r) => r.status === "audio_ready")).toHaveLength(17);
  });

  it("an expert never has two items in flight and stops at his cap", async () => {
    vi.stubEnv("VOICE_DISPATCH_CONCURRENCY", "10");
    const T = tenant(1);
    const EXPERT = "expert-1";
    const expertItems = Array.from({ length: 6 }, (_, i) =>
      seed(T, { expert_id: EXPERT, expert_voice_campaign_id: "camp-1", lead_id: `lead-${i}` }),
    );
    for (let i = 0; i < 6; i++) seed(tenant(i + 2));
    let expertUsed = 0;
    let expertInFlight = 0;
    let expertMax = 0;
    const stats = trackInFlight(async (o) => {
      if (!o.expertId) return okCall(o.billingKey);
      return expertUsed++ < 2 ? okCall(o.billingKey) : refusal("expert_cap");
    });
    const inner = voice.callInfobipVoice.getMockImplementation()!;
    voice.callInfobipVoice.mockImplementation(async (to: string, c: unknown, opts: Opts) => {
      if (!opts.expertId) return inner(to, c, opts);
      expertInFlight++;
      expertMax = Math.max(expertMax, expertInFlight);
      try {
        return await inner(to, c, opts);
      } finally {
        expertInFlight--;
      }
    });

    const result = await runVoiceQueueDispatcher(50);

    expect(expertMax).toBe(1);
    expect(stats.max).toBeGreaterThan(1);
    const expertCalls = voice.callInfobipVoice.mock.calls.filter((c) => c[2].expertId === EXPERT);
    // Two within the cap, one refused; the gate skips the rest.
    expect(expertCalls).toHaveLength(3);
    expect(result).toMatchObject({ dispatched: 2 + 6, expertCapped: 1, deferred: 3, failed: 0 });
    const expertRows = rows().filter((r) => expertItems.includes(String(r.id)));
    expect(expertRows.filter((r) => r.status === "waiting_provider")).toHaveLength(2);
    expect(expertRows.filter((r) => r.status === "paused")).toHaveLength(4);
  });

  it("a demo block aborts the run only after in-flight claims settle", async () => {
    vi.stubEnv("VOICE_DISPATCH_CONCURRENCY", "4");
    for (let i = 0; i < 10; i++) seed(tenant(i + 1));
    voice.callInfobipVoice.mockImplementation(async (_to: string, _c: unknown, opts: Opts) => {
      if (opts.billingKey === "q2") {
        await sleep(2);
        throw new DemoTenantBlockedError("DEMO_SEND_BLOCKED");
      }
      await sleep(30);
      return okCall(opts.billingKey);
    });

    await expect(runVoiceQueueDispatcher(50)).rejects.toBeInstanceOf(DemoTenantBlockedError);

    // No row stuck in the claimed status; the blocked one is released.
    expect(rows().filter((r) => r.status === "calling")).toHaveLength(0);
    expect(rows().find((r) => r.id === "q2")!.status).toBe("audio_ready");
    // The other in-flight items finished; nothing new started after the abort.
    const dialed = voice.callInfobipVoice.mock.calls.map((c) => c[2].billingKey);
    expect(dialed.length).toBeLessThanOrEqual(4);
    for (const id of dialed.filter((id) => id !== "q2")) {
      expect(rows().find((r) => r.id === id)!.status).toBe("waiting_provider");
    }
    expect(rows().filter((r) => r.status === "audio_ready")).toHaveLength(10 - dialed.length + 1);
    expect(fake.db.rows("call_history").map((r) => r.call_queue_id)).not.toContain("q2");
  });
});
