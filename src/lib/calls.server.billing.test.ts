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
  return { supabaseAdmin: fake.db.client };
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
  it("does not re-queue an insufficient_balance call: fails final with Saldo insuficiente", async () => {
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
    expect(result).toMatchObject({ dispatched: 0, deferred: 0, failed: 1, insufficientBalance: 1 });
    expect(queueItem()).toMatchObject({
      status: "failed",
      provider_status: "saldo_insuficiente",
      provider_response: { error: "Saldo insuficiente" },
    });
    // The item is not picked up again on the next tick.
    voice.callInfobipVoice.mockClear();
    await runVoiceQueueDispatcher(10);
    expect(voice.callInfobipVoice).not.toHaveBeenCalled();
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
});
