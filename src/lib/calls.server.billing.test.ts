// PG3 Task 4 — the voice queue and the wallet reservation.
//
// A call refused by the house's wallet (errorKind "insufficient_balance",
// status 0) must fail final with "Saldo insuficiente": status 0 alone reads as
// a transient provider failure and would re-queue the item every 5 minutes
// forever. Every dispatched call persists its billing reference.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));
const voice = vi.hoisted(() => ({ callInfobipVoice: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  const storage = {
    from: () => ({
      createSignedUrl: async (path: string) => ({
        data: { signedUrl: `https://signed.example/${path}` },
        error: null,
      }),
    }),
  };
  return { supabaseAdmin: { ...fake.db.client, storage } };
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

import { classifyVoiceDispatchResult, runVoiceQueueDispatcher } from "./calls.server";

const TENANT = "00000000-0000-4000-8000-000000000001";

function seedQueueItem() {
  fake.db.rows("call_queue").push({
    id: "q1",
    tenant_id: TENANT,
    lead_id: null,
    script_id: null,
    voice_asset_id: null,
    phone_number: "5511999999999",
    audio_url: "https://audio.example/a.mp3",
    status: "audio_ready",
    scheduled_at: new Date(Date.now() - 60_000).toISOString(),
  });
}

const queueItem = () => fake.db.rows("call_queue")[0];

beforeEach(() => {
  fake.db.reset();
  voice.callInfobipVoice.mockReset();
});

describe("classifyVoiceDispatchResult", () => {
  it("insufficient_balance wins over status 0", () => {
    expect(
      classifyVoiceDispatchResult({ ok: false, status: 0, body: {}, errorKind: "insufficient_balance" }),
    ).toBe("insufficient_balance");
  });

  it("keeps status 0 / 429 / 5xx / non-JSON as transient and 4xx as final", () => {
    expect(classifyVoiceDispatchResult({ ok: false, status: 0, body: {} })).toBe("transient");
    expect(classifyVoiceDispatchResult({ ok: false, status: 429, body: {} })).toBe("transient");
    expect(classifyVoiceDispatchResult({ ok: false, status: 502, body: {} })).toBe("transient");
    expect(classifyVoiceDispatchResult({ ok: false, status: 400, body: { non_json: true } })).toBe(
      "transient",
    );
    expect(classifyVoiceDispatchResult({ ok: false, status: 400, body: {} })).toBe("failed");
    // A provider 402 without errorKind keeps its old (final) classification.
    expect(classifyVoiceDispatchResult({ ok: false, status: 402, body: {} })).toBe("failed");
    expect(classifyVoiceDispatchResult({ ok: true, status: 200, body: {} })).toBe("ok");
  });
});

describe("runVoiceQueueDispatcher wallet refusal", () => {
  // Coordinator ruling: a wallet refusal never fails a queue item. It stays
  // untouched (audio_ready) and is dialed once the house has balance again.
  it("an insufficient_balance call stays audio_ready (pushed 15 min) and is dialed after a top-up", async () => {
    seedQueueItem();
    voice.callInfobipVoice.mockResolvedValue({
      ok: false,
      status: 0,
      body: { error: "Saldo insuficiente" },
      idempotencyKey: "key-1",
      providerCallId: null,
      errorKind: "insufficient_balance",
    });
    const result = await runVoiceQueueDispatcher(10);
    expect(result).toMatchObject({ dispatched: 0, deferred: 0, failed: 0, insufficientBalance: 1 });
    expect(queueItem()).toMatchObject({ status: "audio_ready", provider_status: "saldo_insuficiente" });
    expect(Date.parse(String(queueItem().scheduled_at))).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(fake.db.rows("call_history")).toHaveLength(0);

    // Not due again until the push expires; then dialed once there is balance.
    voice.callInfobipVoice.mockClear();
    await runVoiceQueueDispatcher(10);
    expect(voice.callInfobipVoice).not.toHaveBeenCalled();
    queueItem().scheduled_at = new Date(Date.now() - 1_000).toISOString();

    voice.callInfobipVoice.mockResolvedValue({
      ok: true,
      status: 200,
      body: {},
      idempotencyKey: "key-2",
      providerCallId: "c",
    });
    const after = await runVoiceQueueDispatcher(10);
    expect(after).toMatchObject({ dispatched: 1, failed: 0 });
    expect(queueItem().status).toBe("waiting_provider");
  });

  // PG3 final fix I3: after a house's first refusal in a tick, its other
  // items are left untouched (audio_ready) for a later tick; other houses
  // keep dialing.
  it("tenant A has no balance and tenant B dials normally: A's remaining items stay ready", async () => {
    const OTHER = "00000000-0000-4000-8000-000000000002";
    const at = (s: number) => new Date(Date.now() - 600_000 + s * 1_000).toISOString();
    const item = (id: string, tenantId: string, s: number) => ({
      id,
      tenant_id: tenantId,
      lead_id: null,
      script_id: null,
      voice_asset_id: null,
      phone_number: `55119999990${s}`,
      audio_url: "https://audio.example/a.mp3",
      status: "audio_ready",
      scheduled_at: at(s),
    });
    fake.db.rows("call_queue").push(
      item("a1", TENANT, 1),
      item("b1", OTHER, 2),
      item("a2", TENANT, 3),
      item("b2", OTHER, 4),
      item("a3", TENANT, 5),
    );
    voice.callInfobipVoice.mockImplementation(async (_to: string, _content: unknown, opts: { tenantId: string }) =>
      opts.tenantId === TENANT
        ? {
            ok: false,
            status: 0,
            body: { error: "Saldo insuficiente" },
            idempotencyKey: "key-a",
            providerCallId: null,
            errorKind: "insufficient_balance",
          }
        : { ok: true, status: 200, body: {}, idempotencyKey: `key-${Math.random()}`, providerCallId: "c" },
    );

    const byId = (id: string) => fake.db.rows("call_queue").find((r) => r.id === id)!;

    // Two ticks while A has no balance: A loses zero queue items.
    for (let tick = 1; tick <= 2; tick++) {
      voice.callInfobipVoice.mockClear();
      const result = await runVoiceQueueDispatcher(10);
      const tenantsCalled = voice.callInfobipVoice.mock.calls.map((call) => call[2].tenantId);
      if (tick === 1) {
        // One refused attempt for A, then the rest of A is skipped.
        expect(tenantsCalled.filter((t) => t === TENANT)).toHaveLength(1);
        expect(tenantsCalled.filter((t) => t === OTHER)).toHaveLength(2);
        expect(result).toMatchObject({
          dispatched: 2,
          failed: 0,
          insufficientBalance: 1,
          skippedNoBalance: 2,
        });
      } else {
        // A's items were pushed 15 min: not due in the next tick.
        expect(tenantsCalled).toHaveLength(0);
      }
      for (const id of ["a1", "a2", "a3"]) {
        expect(byId(id)).toMatchObject({ status: "audio_ready", provider_status: "saldo_insuficiente" });
      }
    }
    expect(fake.db.rows("call_queue").filter((r) => r.status === "failed")).toHaveLength(0);
    expect(byId("b1").status).toBe("waiting_provider");
    expect(byId("b2").status).toBe("waiting_provider");
  });

  // Ruling (final-2): a broke house holding >= limit due items older than
  // everyone else's must never starve the other houses.
  it("a broke house with >= limit older items never starves house B", async () => {
    const OTHER = "00000000-0000-4000-8000-000000000002";
    const LIMIT = 3;
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const item = (id: string, tenantId: string, minutesAgo: number) => ({
      id,
      tenant_id: tenantId,
      lead_id: null,
      script_id: null,
      voice_asset_id: null,
      phone_number: "5511999999999",
      audio_url: "https://audio.example/a.mp3",
      status: "audio_ready",
      scheduled_at: at(minutesAgo),
    });
    for (let i = 0; i < LIMIT + 2; i++) fake.db.rows("call_queue").push(item(`a${i}`, TENANT, 60 - i));
    fake.db.rows("call_queue").push(item("b1", OTHER, 5), item("b2", OTHER, 4));
    voice.callInfobipVoice.mockImplementation(async (_to: string, _c: unknown, opts: { tenantId: string }) =>
      opts.tenantId === TENANT
        ? {
            ok: false,
            status: 0,
            body: {},
            idempotencyKey: "k",
            providerCallId: null,
            errorKind: "insufficient_balance",
          }
        : { ok: true, status: 200, body: {}, idempotencyKey: `k-${Math.random()}`, providerCallId: "c" },
    );

    // Tick 1: the select is all A (oldest); A is refused and every due A
    // item is pushed 15 min in one update.
    await runVoiceQueueDispatcher(LIMIT);
    // Tick 2: B's items are now at the head and get dialed.
    await runVoiceQueueDispatcher(LIMIT);

    const rows = fake.db.rows("call_queue");
    expect(rows.find((r) => r.id === "b1")!.status).toBe("waiting_provider");
    expect(rows.find((r) => r.id === "b2")!.status).toBe("waiting_provider");
    const aRows = rows.filter((r) => r.tenant_id === TENANT);
    expect(aRows).toHaveLength(LIMIT + 2);
    for (const r of aRows) {
      expect(r).toMatchObject({ status: "audio_ready", provider_status: "saldo_insuficiente" });
      expect(Date.parse(String(r.scheduled_at))).toBeGreaterThan(Date.now() + 14 * 60_000);
    }
  });

  it("control: a transport status 0 without errorKind is still re-queued", async () => {
    seedQueueItem();
    voice.callInfobipVoice.mockResolvedValue({
      ok: false,
      status: 0,
      body: { error: "reset" },
      idempotencyKey: "key-1",
      providerCallId: null,
      errorKind: "outcome_unknown",
    });
    const result = await runVoiceQueueDispatcher(10);
    expect(result).toMatchObject({ deferred: 1, failed: 0 });
    expect(queueItem()).toMatchObject({ status: "audio_ready", provider_status: "provider_unavailable" });
  });

  it("persists billing_reference_id on the call_history row", async () => {
    seedQueueItem();
    voice.callInfobipVoice.mockResolvedValue({
      ok: true,
      status: 200,
      body: { callId: "call-1" },
      idempotencyKey: "key-1",
      providerCallId: "call-1",
      billing: { referenceId: "voice:key-1", units: 5 },
    });
    const result = await runVoiceQueueDispatcher(10);
    expect(result).toMatchObject({ dispatched: 1 });
    expect(fake.db.rows("call_history")).toEqual([
      expect.objectContaining({ call_queue_id: "q1", billing_reference_id: "voice:key-1" }),
    ]);
  });

  it("a failed call_history insert is logged with the reference and correlation; the dispatch still counts", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    seedQueueItem();
    voice.callInfobipVoice.mockResolvedValue({
      ok: true,
      status: 200,
      body: { callId: "call-1" },
      idempotencyKey: "key-1",
      providerCallId: "call-1",
      billing: { referenceId: "voice:key-1", units: 5 },
    });
    fake.db.failNext("call_history", "insert", "insert failed");
    const result = await runVoiceQueueDispatcher(10);
    expect(result).toMatchObject({ dispatched: 1, failed: 0 });
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("call_history"),
      expect.objectContaining({ referenceId: "voice:key-1", correlationId: "key-1" }),
    );
    expect(queueItem()).toMatchObject({ status: "waiting_provider" });
    consoleError.mockRestore();
  });
});

describe("runVoiceQueueDispatcher reservation cap (addendum d)", () => {
  it("uses the queued audio generation's duration as maxSeconds", async () => {
    seedQueueItem();
    Object.assign(queueItem(), { audio_generation_id: "gen-1" });
    fake.db.rows("call_audio_generations").push({ id: "gen-1", tenant_id: TENANT, duration_seconds: 42 });
    voice.callInfobipVoice.mockResolvedValue({
      ok: true,
      status: 200,
      body: {},
      idempotencyKey: "key-1",
      providerCallId: "call-1",
    });
    await runVoiceQueueDispatcher(10);
    expect(voice.callInfobipVoice).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ tenantId: TENANT, maxSeconds: 42 }),
    );
  });

  it("uses the library asset's duration for a fixed audio", async () => {
    seedQueueItem();
    Object.assign(queueItem(), { voice_asset_id: "asset-1" });
    fake.db.rows("journey_voice_assets").push({
      id: "asset-1",
      tenant_id: TENANT,
      storage_path: "a.mp3",
      is_archived: false,
      duration_seconds: 33,
    });
    voice.callInfobipVoice.mockResolvedValue({
      ok: true,
      status: 200,
      body: {},
      idempotencyKey: "key-1",
      providerCallId: "call-1",
    });
    await runVoiceQueueDispatcher(10);
    expect(voice.callInfobipVoice).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ maxSeconds: 33 }),
    );
  });

  it("without a known duration passes null (the env default applies)", async () => {
    seedQueueItem();
    voice.callInfobipVoice.mockResolvedValue({
      ok: true,
      status: 200,
      body: {},
      idempotencyKey: "key-1",
      providerCallId: "call-1",
    });
    await runVoiceQueueDispatcher(10);
    expect(voice.callInfobipVoice).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ maxSeconds: null }),
    );
  });
});
