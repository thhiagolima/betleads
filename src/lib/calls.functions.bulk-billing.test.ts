// PG3 Task 5 (addendum e) — "Disparar agora" (bulkDispatchCalls) stops at
// the first "Saldo insuficiente": the house's wallet is empty, so every next
// target would be refused too. The rest are reported as not attempted (no
// queue item created, nothing dialed).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));
const calls = vi.hoisted(() => ({ runVoiceQueueDispatcher: vi.fn() }));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});
vi.mock("./calls.server", () => ({
  runVoiceQueueDispatcher: calls.runVoiceQueueDispatcher,
  VOICE_INSUFFICIENT_BALANCE_MESSAGE: "Saldo insuficiente",
}));
vi.mock("./infobip-voice.server", () => ({ callInfobipVoice: vi.fn(), normalizeE164BR: vi.fn() }));
vi.mock("./consent.server", () => ({ evaluateVoiceContactPolicy: vi.fn() }));
vi.mock("./tenant-access.server", () => ({
  assertTenantNotDemoForSend: vi.fn(),
  resolveCurrentTenantId: vi.fn(),
  resolveOperationalTenantId: vi.fn(async () => "00000000-0000-4000-8000-000000000001"),
}));

import { bulkDispatchCallsFor } from "./calls.functions";

const targets = ["5511900000001", "5511900000002", "5511900000003", "5511900000004"].map(
  (phone_number) => ({ lead_id: null, phone_number }),
);

beforeEach(async () => {
  // The client mock is built on first import; make sure it exists.
  await import("@/integrations/supabase/client.server");
  fake.db.reset();
  calls.runVoiceQueueDispatcher.mockReset();
});

describe("bulkDispatchCalls without balance", () => {
  it("stops at the first Saldo insuficiente and reports the rest as not attempted", async () => {
    calls.runVoiceQueueDispatcher
      .mockResolvedValueOnce({ dispatched: 1, deferred: 0, failed: 0, insufficientBalance: 0 })
      .mockResolvedValueOnce({ dispatched: 0, deferred: 0, failed: 1, insufficientBalance: 1 });

    const result = await bulkDispatchCallsFor(fake.db.client as never, {
      script_id: "00000000-0000-4000-8000-0000000000aa",
      targets,
    });

    expect(calls.runVoiceQueueDispatcher).toHaveBeenCalledTimes(2);
    // Only the two attempted targets got a queue item.
    expect(fake.db.rows("call_queue")).toHaveLength(2);
    expect(result).toMatchObject({ total: 4, queued: 1, failed: 1, notAttempted: 2 });
    expect(result.results).toEqual([
      expect.objectContaining({ ok: true, phone: "5511900000001" }),
      expect.objectContaining({ ok: false, phone: "5511900000002", error: "Saldo insuficiente" }),
      expect.objectContaining({ ok: false, phone: "5511900000003", not_attempted: true }),
      expect.objectContaining({ ok: false, phone: "5511900000004", not_attempted: true }),
    ]);
  });
});
